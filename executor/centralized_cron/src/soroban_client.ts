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
import type { Config } from "./types.js";

const TX_TIMEOUT = 30; // seconds

// Retries per invoke when the network rejects our sequence number. One
// rebuild is normally enough (the refetched account reflects the consumed
// sequence); a second absorbs a race with a submitter outside this process.
const MAX_BAD_SEQ_RETRIES = 2;

// Per-source-account submission locks, shared by EVERY SorobanClient
// instance in the process (each job constructs its own client, so the
// registry must be module-global). Jobs sharing one signer — the classifier
// and settler both use the keeper key, and an HTTP-triggered run can overlap
// a scheduled one — would otherwise fetch the same account sequence and
// build two transactions of which at most one can succeed. The lock covers
// the whole getAccount → build → simulate → sign → submit → poll lifecycle,
// so the next caller always observes a consumed sequence.
const accountLocks = new Map<string, Promise<void>>();

async function withAccountLock<T>(publicKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = accountLocks.get(publicKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Chain before waiting so later callers queue behind this one.
  accountLocks.set(
    publicKey,
    previous.then(() => current)
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function isBadSeqError(err: unknown): boolean {
  return String(err).includes("txBadSeq");
}

export class SorobanClient {
  private server: rpc.Server;
  private networkPassphrase: string;

  constructor(private config: Config) {
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
   * The full lifecycle runs under the signer's account lock (see
   * `withAccountLock`), and a sequence-number rejection triggers a bounded
   * retry that refetches the account and rebuilds/re-simulates from scratch —
   * a stale sequence invalidates the old envelope entirely.
   */
  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signerSecret: string
  ): Promise<any> {
    const signerKeypair = Keypair.fromSecret(signerSecret);
    return withAccountLock(signerKeypair.publicKey(), async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.submitInvocation(contractId, method, args, signerKeypair);
        } catch (err) {
          if (attempt < MAX_BAD_SEQ_RETRIES && isBadSeqError(err)) {
            console.warn(
              `[soroban] ${method}: bad sequence (attempt ${attempt + 1}) — refetching account and rebuilding`
            );
            continue;
          }
          throw err;
        }
      }
    });
  }

  // Single submission attempt: fetch the account, build, simulate, sign,
  // submit, and poll to a terminal status. Callers hold the account lock.
  private async submitInvocation(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signerKeypair: Keypair
  ): Promise<any> {
    const contract = new Contract(contractId);
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
      // Surface the transaction-level result code (e.g. txBadSeq) in the
      // message — the retry logic matches on it, and JSON.stringify does not
      // reliably render the XDR union's discriminant.
      let code = "";
      try {
        code = (sendResult as any).errorResult?.result().switch().name ?? "";
      } catch {
        // leave code empty — the raw payload below still identifies the failure
      }
      throw new Error(
        `Send failed for ${method}: code=${code} ${JSON.stringify(sendResult)}`
      );
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

  /** Helper: convert a u64 bigint to an ScVal. */
  u64ToScVal(val: bigint): xdr.ScVal {
    return nativeToScVal(val, { type: "u64" });
  }

  /** Helper: convert a u32 number to an ScVal. */
  u32ToScVal(val: number): xdr.ScVal {
    return nativeToScVal(val, { type: "u32" });
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
