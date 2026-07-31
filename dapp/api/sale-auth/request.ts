import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../_lib/config";
import { allowRequest, clientIp } from "../_lib/rate_limit";
import { authorizeSale } from "../_lib/sale_auth";

// One AeroAPI call + up to two oracle txs (window or tombstone) + an
// occasional 2-call route sweep — well under a minute, but not instant.
export const config = { maxDuration: 60 };

/**
 * POST /api/sale-auth/request — { flight_id, date } (UTC-midnight unix
 * seconds, the on-chain bucket key).
 *
 * THE buy-click endpoint (replaces the polled sale-authorizer cron and
 * the old /warm demand breadcrumb): verifies the flight just-in-time and
 * opens the on-chain sale window the purchase gate requires. The frontend
 * calls this right before building the buy transaction:
 *
 *   { authorized: true, expires_at, scheduled_out, scheduled_in }
 *     → proceed with the buy tx (window is live until expires_at)
 *   { authorized: false, reason }
 *     → show the reason; the contract would reject the buy anyway.
 *
 * Deliberately unauthenticated — it is the public storefront gate.
 * Abuse is bounded: a live window or recorded outcome short-circuits to
 * a free chain read, refusals write nothing, and the worst case equals
 * what the retired cron burned unconditionally every run.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // OCA-M02: each novel (flight, date) can cost a billed AeroAPI call and
  // oracle-signed chain writes — throttle anonymous callers. A real buyer
  // clicks a handful of times a minute; 10/min/IP is generous for humans
  // and starves a flight×date space walk.
  if (!(await allowRequest("sale-auth", clientIp(req), 10))) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "rate limit exceeded — retry in a minute" });
    return;
  }
  const { flight_id, date } = (req.body ?? {}) as { flight_id?: unknown; date?: unknown };
  const dateNum = Number(date);
  if (
    typeof flight_id !== "string" ||
    !/^[A-Z0-9]{2,10}$/.test(flight_id) ||
    !Number.isInteger(dateNum) ||
    dateNum <= 0 ||
    dateNum % 86_400 !== 0
  ) {
    res.status(400).json({ error: "expected { flight_id: string, date: UTC-midnight unix seconds }" });
    return;
  }

  try {
    const result = await authorizeSale(loadConfig(), flight_id, BigInt(dateNum));
    res.status(200).json({
      authorized: result.authorized,
      reason: result.reason,
      ...(result.expiresAt !== undefined ? { expires_at: result.expiresAt } : {}),
      ...(result.scheduledOut !== undefined ? { scheduled_out: result.scheduledOut } : {}),
      ...(result.scheduledIn !== undefined ? { scheduled_in: result.scheduledIn } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
