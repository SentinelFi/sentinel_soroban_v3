import {
  Contract,
  Keypair,
  TransactionBuilder,
  xdr,
  nativeToScVal,
  scValToNative,
  Address,
  rpc,
} from "@stellar/stellar-sdk";
import type { Config } from "./types";

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

    // Simulate to get resource estimates and auth
    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error for ${method}: ${sim.error}`);
    }

    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`Simulation failed for ${method}`);
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
      throw new Error(`Send failed for ${method}: ${JSON.stringify(sendResult)}`);
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

    throw new Error(`Transaction failed for ${method}: status=${getResult.status}`);
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
