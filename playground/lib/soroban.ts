// Soroban RPC helpers: read-only calls via transaction simulation and
// state-changing calls via simulate → assemble → wallet-sign → send → poll.
// Everything runs client-side; this app never touches a secret key.

import {
  Account,
  BASE_FEE,
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK, SIMULATION_SOURCE } from "@/lib/config";

const server = new rpc.Server(NETWORK.rpcUrl);

/**
 * Call a read-only contract function via simulateTransaction and decode the
 * result to native JS values. Simulations are free and never submitted, so
 * a dummy sequence number and a placeholder source account are sufficient.
 */
export async function simulateRead(
  contractAddress: string,
  method: string,
  args: xdr.ScVal[] = [],
  source: string = SIMULATION_SOURCE,
): Promise<unknown> {
  const account = new Account(source, "0");
  const contract = new Contract(contractAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(cleanRpcError(sim.error));
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}

export interface InvokeResult {
  hash: string;
  result: unknown;
}

/**
 * Simulate a state-changing call without submitting it. Returns the decoded
 * would-be result. Useful as a dry run before signing.
 */
export async function simulateWrite(
  walletAddress: string,
  contractAddress: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const account = await server.getAccount(walletAddress);
  const tx = buildInvokeTx(account, contractAddress, method, args);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(cleanRpcError(sim.error));
  }
  if (sim.restorePreamble) {
    throw new Error(
      "Some contract state this call touches is archived and must be restored first.",
    );
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}

/**
 * Full write path: build → simulate → assemble (resources + auth) →
 * sign with the connected wallet → send → poll until final.
 */
export async function invokeWrite(
  walletAddress: string,
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
  signXdr: (unsignedXdr: string) => Promise<string>,
): Promise<InvokeResult> {
  const account = await server.getAccount(walletAddress);
  const tx = buildInvokeTx(account, contractAddress, method, args);

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(cleanRpcError(sim.error));
  }
  if (sim.restorePreamble) {
    throw new Error(
      "Some contract state this call touches is archived and must be restored first.",
    );
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  const signedXdr = await signXdr(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK.passphrase);

  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(
      `Submission rejected: ${sent.errorResult?.result().switch().name ?? "unknown error"}`,
    );
  }

  // Poll for the final status (~1s ledgers on testnet, allow up to 30s).
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const res = await server.getTransaction(sent.hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: sent.hash,
        result: res.returnValue ? scValToNative(res.returnValue) : undefined,
      };
    }
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction ${sent.hash} failed on-chain.`);
    }
  }
  throw new Error(
    `Timed out waiting for transaction ${sent.hash}; check it on the explorer.`,
  );
}

function buildInvokeTx(
  account: Account,
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
) {
  const contract = new Contract(contractAddress);
  return new TransactionBuilder(account, {
    // Inclusion fee only — simulation adds the resource fee on assemble.
    fee: (Number(BASE_FEE) * 100).toString(),
    networkPassphrase: NETWORK.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();
}

/** Pull the useful part out of verbose RPC diagnostic strings. */
function cleanRpcError(message: string): string {
  const contractError = /Error\(Contract, #(\d+)\)/.exec(message);
  if (contractError) {
    return `Contract error #${contractError[1]} — the contract rejected this call (check arguments, authorization and protocol state). Full detail: ${truncate(message, 400)}`;
  }
  const authError = /Error\(Auth,([^)]*)\)/.exec(message);
  if (authError) {
    return `Authorization failed — the signing account is not allowed to make this call. Full detail: ${truncate(message, 400)}`;
  }
  return truncate(message, 600);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Native XLM balance via Horizon; null when the account is unfunded. */
export async function fetchXlmBalance(address: string): Promise<string | null> {
  const res = await fetch(`${NETWORK.horizonUrl}/accounts/${encodeURIComponent(address)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon error ${res.status}`);
  const data = (await res.json()) as {
    balances?: { asset_type: string; balance: string }[];
  };
  return data.balances?.find((b) => b.asset_type === "native")?.balance ?? "0";
}

/** Fund a testnet account via Friendbot. */
export async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(
    `${NETWORK.friendbotUrl}/?addr=${encodeURIComponent(address)}`,
  );
  if (!res.ok) {
    throw new Error(`Friendbot request failed (${res.status}); the account may already be funded.`);
  }
}
