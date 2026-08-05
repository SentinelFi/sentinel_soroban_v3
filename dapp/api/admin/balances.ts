import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Keypair } from "@stellar/stellar-sdk";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";

/**
 * Admin API — the OPERATIONAL WALLET board.
 *
 * Nothing watched the fuel gauge before: every cron in this deployment
 * signs with one of four keys, and an unfunded signer does not fail
 * loudly — it fails as "[submission] …: txInsufficientBalance" buried in
 * a run log, while the settle sweep quietly stops paying travelers. This
 * endpoint answers the one question an operator has before a demo or a
 * soak window: WHO IS ABOUT TO RUN DRY?
 *
 *   oracle       ORACLE_SECRET_KEY          set_estimated_arrival/landed/cancelled
 *   keeper       KEEPER_SECRET_KEY          classify/settle/queue maintenance
 *   ttl-extender TTL_EXTENDER_SECRET_KEY    extend_ttl + prune (permissionless)
 *   gov-admin    GOVERNANCE_ADMIN_SECRET_KEY whitelist/disable/enable/terms
 *   owner        CONTRACT_OWNER_ADDRESS     owner-only calls (address only —
 *                                           the secret lives in a local
 *                                           stellar identity, never in env)
 *
 * SECRETS NEVER LEAVE THE FUNCTION: each secret is used exactly once, to
 * derive its G… public key (Keypair.fromSecret — the same derivation
 * SorobanClient/GovSubmitter do; SorobanClient itself is not reused here
 * because its constructor demands a full Config and would throw on the
 * very "key is unset" case this board exists to surface). The response
 * carries public addresses and balances only.
 *
 * Balances come from Horizon, not Soroban RPC: RPC's getAccount returns a
 * sequence number, not balances, and Horizon's /accounts/<G…> is one
 * keyless GET. A 404 is the NORMAL answer for a never-funded key and is
 * reported as balance 0 + low, never as an error.
 *
 * GET → { accounts: [{ role, address, balance_xlm, low, … }] }
 */

// Five keyless HTTP GETs — nowhere near the cron endpoints' 300s, but
// generous enough that a sluggish Horizon degrades to per-account errors
// instead of a platform kill.
export const config = { maxDuration: 30 };

/**
 * "Top me up" line, XLM. A Soroban invoke on testnet costs well under
 * 1 XLM all-in, so 10 XLM is still hundreds of txs — early enough to be
 * a warning rather than an incident, late enough not to cry wolf. The
 * owner address is held to the same line (it pays for the rare
 * owner-only call).
 */
const LOW_BALANCE_XLM = 10;

const HORIZON_URL = (
  process.env.STELLAR_HORIZON_URL ??
  process.env.PUBLIC_STELLAR_HORIZON_URL ??
  "https://horizon-testnet.stellar.org"
).replace(/\/+$/, "");

/** Signing identities, in the order an operator reads them. */
const SIGNERS: Array<{ role: string; env: string }> = [
  { role: "oracle", env: "ORACLE_SECRET_KEY" },
  { role: "keeper", env: "KEEPER_SECRET_KEY" },
  { role: "ttl-extender", env: "TTL_EXTENDER_SECRET_KEY" },
  { role: "gov-admin", env: "GOVERNANCE_ADMIN_SECRET_KEY" },
];

interface AccountBalance {
  role: string;
  /** Public key, or null when the key/address is not configured. */
  address: string | null;
  /** Env var that supplies it — so the operator knows what to set. */
  source: string;
  configured: boolean;
  /** False for a never-funded (404) account. */
  funded: boolean;
  /** XLM as a decimal string (Horizon's own 7-dp representation). */
  balance_xlm: string | null;
  low: boolean;
  error: string | null;
}

/** Native balance for one address. Never throws — 404 → unfunded. */
async function fetchBalance(
  role: string,
  source: string,
  address: string,
): Promise<AccountBalance> {
  const base = { role, address, source, configured: true };
  try {
    const resp = await fetch(`${HORIZON_URL}/accounts/${address}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 404) {
      // Never funded — the account does not exist on the network yet.
      return { ...base, funded: false, balance_xlm: "0", low: true, error: null };
    }
    if (!resp.ok) {
      return {
        ...base,
        funded: false,
        balance_xlm: null,
        low: false,
        error: `Horizon HTTP ${resp.status}`,
      };
    }
    const data = (await resp.json()) as {
      balances?: Array<{ asset_type?: string; balance?: string }>;
    };
    const native = (data.balances ?? []).find((b) => b.asset_type === "native");
    const balance = native?.balance ?? "0";
    return {
      ...base,
      funded: true,
      balance_xlm: balance,
      low: Number(balance) < LOW_BALANCE_XLM,
      error: null,
    };
  } catch (err) {
    // Horizon unreachable/slow: report it per account rather than 500 the
    // whole board — one bad row must not hide the other four.
    return {
      ...base,
      funded: false,
      balance_xlm: null,
      low: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // 1. Resolve every operational identity to a public key. An unset (or
    //    malformed) key is a REPORTED row, not a failure — "the gov key
    //    isn't configured" is exactly the kind of thing this surfaces.
    const targets: Array<{ role: string; source: string; address: string | null; error: string | null }> = [];
    for (const { role, env } of SIGNERS) {
      const secret = process.env[env];
      if (!secret) {
        targets.push({ role, source: env, address: null, error: null });
        continue;
      }
      try {
        targets.push({ role, source: env, address: Keypair.fromSecret(secret).publicKey(), error: null });
      } catch {
        targets.push({ role, source: env, address: null, error: "malformed secret key" });
      }
    }
    // 2. The owner is an ADDRESS, not a secret — same board, no derivation.
    targets.push({
      role: "owner",
      source: "CONTRACT_OWNER_ADDRESS",
      address: process.env.CONTRACT_OWNER_ADDRESS ?? null,
      error: null,
    });

    // 3. One Horizon GET each, in parallel (five requests).
    const accounts: AccountBalance[] = await Promise.all(
      targets.map((t) =>
        t.address
          ? fetchBalance(t.role, t.source, t.address)
          : Promise.resolve<AccountBalance>({
              role: t.role,
              address: null,
              source: t.source,
              configured: false,
              funded: false,
              balance_xlm: null,
              low: false,
              error: t.error,
            }),
      ),
    );

    res.status(200).json({
      as_of: new Date().toISOString(),
      horizon_url: HORIZON_URL,
      low_balance_threshold_xlm: LOW_BALANCE_XLM,
      low_count: accounts.filter((a) => a.low).length,
      accounts,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
