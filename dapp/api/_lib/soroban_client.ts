import {
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
  rpc,
} from "@stellar/stellar-sdk";
import type { Config } from "./types.js";

const TX_TIMEOUT = 30; // seconds

export class SorobanClient {
  private server: rpc.Server;
  private networkPassphrase: string;
  // Explicit field (not a constructor parameter property) — the dapp
  // tsconfig enforces erasableSyntaxOnly, which forbids `private` params.
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.server = new rpc.Server(config.stellarRpcUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Read-only contract call — simulates but does not submit.
   * Returns the parsed return value.
   */
  async readContract(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<any> {
    const contract = new Contract(contractId);
    const sourceKeypair = Keypair.fromSecret(this.config.oracleSecretKey);
    const sourceAccount = await this.server.getAccount(sourceKeypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT)
      .build();

    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error for ${method}: ${sim.error}`);
    }

    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`Simulation failed for ${method}`);
    }

    if (!sim.result) {
      return undefined;
    }

    return scValToNative(sim.result.retval);
  }

  /**
   * readContract with a small bounded retry — for pre-flight probes whose
   * whole run is wasted when one public-RPC hiccup answers with a network
   * error (queue_maintainer does four probes before it may submit
   * anything; any single failure aborted the run having done nothing).
   *
   * READ-ONLY BY CONSTRUCTION, and that is what makes the retry safe:
   * readContract only simulates — nothing is signed, submitted or
   * mutated — so re-running it is idempotent. NEVER wrap invokeContract
   * this way: it already has its own txBadSeq retry, and a blind retry
   * around a submission risks double-submitting a transaction.
   *
   * Every failure mode is retried (including simulation errors, which are
   * usually deterministic but cost only the backoff to re-check) and the
   * last error is rethrown unchanged, so callers' error handling is
   * exactly as before.
   */
  async readContractWithRetry(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    attempts = 3,
    backoffMs = 400
  ): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.readContract(contractId, method, args);
      } catch (err) {
        lastErr = err;
        if (attempt === attempts) break;
        console.warn(`[soroban] read ${method} failed (attempt ${attempt}/${attempts}) — retrying: ${err}`);
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
    throw lastErr;
  }

  /**
   * Write contract call — simulates, assembles auth, signs, and submits.
   * Returns the transaction result.
   *
   * Retries ONCE on a sequence-number collision (txBadSeq): the keeper jobs
   * share one signing key on offset schedules, and a slow run can overlap
   * the next job's submission window. The retry re-fetches the account (and
   * with it the fresh sequence number) — anything else still throws.
   */
  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signerSecret: string
  ): Promise<any> {
    try {
      return await this.invokeContractOnce(contractId, method, args, signerSecret);
    } catch (err) {
      const msg = String(err);
      if (/badseq/i.test(msg)) {
        console.warn(`[soroban] ${method}: sequence collision (txBadSeq) — retrying once with a fresh sequence...`);
        await new Promise((r) => setTimeout(r, 2000));
        return await this.invokeContractOnce(contractId, method, args, signerSecret);
      }
      throw err;
    }
  }

  private async invokeContractOnce(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signerSecret: string
  ): Promise<any> {
    const contract = new Contract(contractId);
    const signerKeypair = Keypair.fromSecret(signerSecret);
    const sourceAccount = await this.server.getAccount(signerKeypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "10000000", // 1 XLM max fee for Soroban
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT)
      .build();

    // Simulate to get resource estimates and auth. SIMULATION failures are
    // tagged distinctly from submission failures: a simulation revert
    // (paused contract, failed auth, contract panic) would fail IDENTICALLY
    // on retry — "would never succeed" — while submission/confirmation
    // problems are usually transient. Monitors and run logs key off the
    // [simulation]/[submission] prefix.
    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`[simulation] ${method}: ${sim.error}`);
    }

    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`[simulation] ${method}: simulation did not succeed`);
    }

    // Assemble with simulation results, then bump resource limits by 40%.
    // Simulation underestimates for deep cross-contract calls (e.g.
    // buy_insurance: Controller → FlightPoolManager + Oracle + Vault + Token).
    const assembled = rpc.assembleTransaction(tx, sim).build();
    const envelope = assembled.toEnvelope().v1().tx();
    const sorobanData = envelope.ext().sorobanData();
    const res = sorobanData.resources();
    const bump = (n: number) => Math.ceil(n * 1.4);
    res.instructions(bump(res.instructions()));
    res.diskReadBytes(bump(res.diskReadBytes()));
    res.writeBytes(bump(res.writeBytes()));
    sorobanData.resourceFee(
      xdr.Int64.fromString(String(BigInt(Math.ceil(Number(sorobanData.resourceFee().toString()) * 1.4))))
    );
    const bumped = TransactionBuilder.cloneFrom(assembled)
      .setSorobanData(sorobanData)
      .build();
    bumped.sign(signerKeypair);

    // Submit and poll
    const sendResult = await this.server.sendTransaction(bumped);

    if (sendResult.status === "ERROR") {
      throw new Error(`[submission] ${method}: ${JSON.stringify(sendResult)}`);
    }

    // Poll for completion
    const hash = sendResult.hash;
    let getResult: rpc.Api.GetTransactionResponse;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await this.server.getTransaction(hash);
      if (getResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        break;
      }
    }

    getResult = await this.server.getTransaction(hash);

    if (getResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return getResult;
    }

    throw new Error(`[submission] ${method}: final status=${getResult.status}`);
  }

  /** Helper: convert a Stellar address string to an ScVal. */
  addressToScVal(address: string): xdr.ScVal {
    return new Address(address).toScVal();
  }

  /** Helper: convert a Symbol string to an ScVal. */
  symbolToScVal(sym: string): xdr.ScVal {
    return xdr.ScVal.scvSymbol(sym);
  }

  /** Helper: convert a number to a u32 ScVal. */
  u32ToScVal(n: number): xdr.ScVal {
    return xdr.ScVal.scvU32(n);
  }

  /** Helper: vec ScVal (e.g. a #[contracttype] enum key like Route(a,b,c)). */
  scvVec(items: xdr.ScVal[]): xdr.ScVal {
    return xdr.ScVal.scvVec(items);
  }

  /**
   * Raw ExtendFootprintTTLOp over specific PERSISTENT contract-data keys —
   * the deep TTL layer behind the instance-level extend_ttl() calls: idle
   * entries nothing reads (Route rows of never-traded routes,
   * TravelerFlights of dormant users) never get their on-access bumps and
   * would archive without this. Extends every key's liveUntil to
   * currentLedger + extendToLedgers (no-op for keys already beyond it).
   * Permissionless in effect: any funded key pays the rent.
   */
  async extendPersistentTtl(
    contractId: string,
    keys: xdr.ScVal[],
    extendToLedgers: number,
    signerSecret: string
  ): Promise<void> {
    const signerKeypair = Keypair.fromSecret(signerSecret);
    const sourceAccount = await this.server.getAccount(signerKeypair.publicKey());
    const contract = new Address(contractId).toScAddress();

    const ledgerKeys = keys.map((key) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract,
          key,
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "10000000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.extendFootprintTtl({ extendTo: extendToLedgers }))
      .setSorobanData(new SorobanDataBuilder().setReadOnly(ledgerKeys).build())
      .setTimeout(TX_TIMEOUT)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(
        `[simulation] extendFootprintTtl(${contractId.slice(0, 8)}…, ${keys.length} key(s)): ` +
          `${rpc.Api.isSimulationError(sim) ? sim.error : "did not succeed"}`
      );
    }
    const assembled = rpc.assembleTransaction(tx, sim).build();
    assembled.sign(signerKeypair);
    const sendResult = await this.server.sendTransaction(assembled);
    if (sendResult.status === "ERROR") {
      throw new Error(`[submission] extendFootprintTtl: ${JSON.stringify(sendResult)}`);
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const getResult = await this.server.getTransaction(sendResult.hash);
      if (getResult.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
      if (getResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`[submission] extendFootprintTtl: final status=FAILED`);
      }
    }
    throw new Error(`[submission] extendFootprintTtl: confirmation timeout`);
  }

  /** Helper: convert a u64 bigint to an ScVal. */
  u64ToScVal(val: bigint): xdr.ScVal {
    return nativeToScVal(val, { type: "u64" });
  }

  /** Helper: convert an i128 bigint to an ScVal. */
  i128ToScVal(val: bigint): xdr.ScVal {
    return nativeToScVal(val, { type: "i128" });
  }

  /** Get the public key for a secret key. */
  publicKeyFromSecret(secret: string): string {
    return Keypair.fromSecret(secret).publicKey();
  }
}
