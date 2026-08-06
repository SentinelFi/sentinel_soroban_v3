import {
  Account,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Secret-free read-only contract calls for admin endpoints — simulation
 * only, nothing signed or submitted. Unlike SorobanClient.readContract
 * (which derives its source from a configured secret), this uses a fixed
 * public source account, so endpoints that hold no keys can still read.
 */

// Any funded account works as a read-simulation source; the protocol
// owner is a stable public default (deployments/testnet.json).
export const SIM_SOURCE =
  process.env.CONTRACT_OWNER_ADDRESS ??
  "GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD";

export async function simulateRead(
  server: rpc.Server,
  passphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(SIM_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error.slice(0, 200));
  return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
}

/** Bounded-concurrency map for balance probes and similar fan-outs. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (i >= items.length || item === undefined) return;
        out[i] = await fn(item);
      }
    })
  );
  return out;
}
