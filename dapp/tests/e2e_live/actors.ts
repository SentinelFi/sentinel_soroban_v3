/**
 * The 17-actor cast (2026-08-04 sizing: 50 policies, ~20,000 USDC
 * underwriter capital = 4× headroom over the 5,000 max locked):
 *
 *   U1 anchor      mint 2×10k, deposit 10,000, HOLD the whole soak
 *   U2             deposit 5,000 → mid-soak partial withdrawal → collect
 *   U3             request 1,500 → cancel_deposit → re-deposit 1,500
 *   U4             deposit 1,200 → request → cancel_withdrawal → re-request → collect
 *   U5             deposit 1,000 → full exit late (net-gain assertion)
 *   U6             deposit 800 → withdrawal in the SAME check as U2/U5 (FIFO)
 *   T1..T10        50 policies: 8,7,6,6,6,5,4(T7 hybrid, also deposits 500),6,1,1
 *   N1             negatives only (0-USDC buy, min-lead refusal, on-time claim)
 *
 * Keypairs are random, friendbot-funded, persisted to .actors.json
 * (gitignored) and reused across runs.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@stellar/stellar-sdk";

const ACTORS_FILE = join(dirname(fileURLToPath(import.meta.url)), ".actors.json");

export type Role = "underwriter" | "traveler" | "hybrid" | "negative";

export interface ActorSpec {
  name: string;
  role: Role;
  /** USDC to deposit into the vault (0 for pure travelers). */
  depositUsdc: number;
  /** Target successful policy count. */
  policies: number;
  /** Faucet clicks needed (10k USDC each). */
  mintClicks: number;
}

export const CAST: ActorSpec[] = [
  { name: "U1", role: "underwriter", depositUsdc: 10_000, policies: 0, mintClicks: 2 },
  { name: "U2", role: "underwriter", depositUsdc: 5_000, policies: 0, mintClicks: 1 },
  { name: "U3", role: "underwriter", depositUsdc: 1_500, policies: 0, mintClicks: 1 },
  { name: "U4", role: "underwriter", depositUsdc: 1_200, policies: 0, mintClicks: 1 },
  { name: "U5", role: "underwriter", depositUsdc: 1_000, policies: 0, mintClicks: 1 },
  { name: "U6", role: "underwriter", depositUsdc: 800, policies: 0, mintClicks: 1 },
  { name: "T1", role: "traveler", depositUsdc: 0, policies: 8, mintClicks: 1 },
  { name: "T2", role: "traveler", depositUsdc: 0, policies: 7, mintClicks: 1 },
  { name: "T3", role: "traveler", depositUsdc: 0, policies: 6, mintClicks: 1 },
  { name: "T4", role: "traveler", depositUsdc: 0, policies: 6, mintClicks: 1 },
  { name: "T5", role: "traveler", depositUsdc: 0, policies: 6, mintClicks: 1 },
  { name: "T6", role: "traveler", depositUsdc: 0, policies: 5, mintClicks: 1 },
  { name: "T7", role: "hybrid", depositUsdc: 500, policies: 4, mintClicks: 1 },
  { name: "T8", role: "traveler", depositUsdc: 0, policies: 6, mintClicks: 1 },
  { name: "T9", role: "traveler", depositUsdc: 0, policies: 1, mintClicks: 1 },
  { name: "T10", role: "traveler", depositUsdc: 0, policies: 1, mintClicks: 1 },
  { name: "N1", role: "negative", depositUsdc: 0, policies: 0, mintClicks: 0 },
];

export const TOTAL_PLANNED_BUYS = CAST.reduce((n, a) => n + a.policies, 0); // 50

export interface Actor extends ActorSpec {
  address: string;
  secret: string;
}

export function loadOrCreateActors(): Actor[] {
  let saved: Record<string, { address: string; secret: string }> = {};
  if (existsSync(ACTORS_FILE)) {
    saved = JSON.parse(readFileSync(ACTORS_FILE, "utf8")) as typeof saved;
  }
  const actors = CAST.map((spec) => {
    let kp = saved[spec.name];
    if (!kp) {
      const fresh = Keypair.random();
      kp = { address: fresh.publicKey(), secret: fresh.secret() };
      saved[spec.name] = kp;
    }
    return { ...spec, ...kp };
  });
  writeFileSync(ACTORS_FILE, JSON.stringify(saved, null, 2));
  return actors;
}

/** Friendbot with spacing + backoff; 400 = already funded (fine). */
export async function fundActor(horizonUrl: string, address: string): Promise<"funded" | "already"> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
    if (r.ok) return "funded";
    if (r.status === 400) return "already";
    if (attempt >= 4) throw new Error(`friendbot failed for ${address}: ${r.status}`);
    await new Promise((res) => setTimeout(res, attempt * 2000));
  }
}

export async function isFunded(horizonUrl: string, address: string): Promise<boolean> {
  const r = await fetch(`${horizonUrl}/accounts/${address}`);
  return r.ok;
}
