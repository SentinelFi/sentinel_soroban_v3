import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth.js";
import { loadGovConfig } from "../_lib/governance/config.js";
import { getDb } from "../_lib/governance/db.js";
import { GovSubmitter, type DelayOp, type PremiumOp } from "../_lib/governance/submitter.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_SINCE_HOURS = 720; // 30 days
const DEFAULT_SINCE_HOURS = 24;

/**
 * Admin API — on-chain governance operations + audit trail.
 *
 * GET  → paginated actions_log page, newest first
 *        ?limit=       default 50, max 200
 *        ?offset=      default 0
 *        ?since_hours= default 24, max 720 — filters on ts
 *        ?detail=1     also return the before/after route snapshots
 *        → { log, total, limit, offset, since_hours }
 *        A single governance sweep over the ~1k-route fleet writes more
 *        than 100 rows, so the tail alone could not reach yesterday.
 * POST → { op, flight_id, origin, dest, ...op-specific }
 *   whitelist  { premium_units?, payoff_units?, delay_hours? }  null → on-chain defaults
 *   disable    {}
 *   enable     {}
 *   remove     {}
 *   set_terms  { premium_units?, payoff_units?, delay_hours? }  omitted → Keep, "default" → UseDefault
 *   revert     {}                                                all fields → UseDefault
 *
 * Admin clicks go through the SAME GovSubmitter pipeline as the cron
 * rules — identical audit rows, actor = admin:<email>. The route's DB
 * lifecycle row is kept in step so the detectors and the UI agree.
 */

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const admin = await verifyAdmin(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sql = getDb();

  try {
    if (req.method === "GET") {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const sinceHours = Math.min(
        MAX_SINCE_HOURS,
        Math.max(1, Number(req.query.since_hours) || DEFAULT_SINCE_HOURS)
      );
      // The list view renders none of the before/after jsonb route
      // snapshots, and they are most of each row's bytes, so the default
      // select leaves them out. ?detail=1 opts back in for a drill-down.
      const detail = req.query.detail === "1" || req.query.detail === "true";
      const snapshots = detail ? sql`, before, after` : sql``;
      // count(*) over () gets the window total on this scan instead of a
      // second one; the cost is that the WindowAgg walks every filtered
      // row rather than stopping at limit — which is what since_hours
      // bounds. Note it counts the window, so an offset past the end
      // returns an empty page and total 0.
      const rows = await sql`
        select id, ts, actor, action, flight_id, origin, dest, tx_hash, success, error${snapshots},
               count(*) over () as full_count
        from actions_log
        where ts >= now() - make_interval(hours => ${sinceHours})
        order by ts desc
        limit ${limit} offset ${offset}
      `;
      const log = rows.map(({ full_count, ...r }) => r);
      res.status(200).json({
        log,
        total: Number(rows[0]?.full_count ?? 0),
        limit,
        offset,
        since_hours: sinceHours,
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const b = req.body ?? {};
    if (!b.flight_id || !b.origin || !b.dest) {
      res.status(400).json({ error: "Missing flight_id/origin/dest" });
      return;
    }
    const key = { flightId: b.flight_id, origin: b.origin, dest: b.dest };

    const config = loadGovConfig();
    const submitter = new GovSubmitter({
      rpcUrl: config.stellarRpcUrl,
      networkPassphrase: config.networkPassphrase,
      governanceId: config.governanceId,
      adminSecretKey: config.govAdminSecretKey,
      actor: `admin:${admin.email}`,
    });

    // OCA-M03: the chain write lands BEFORE this DB mirror. A mirror
    // failure must never surface as a bare 500 — the admin would have no
    // tx_hash and could plausibly resubmit a second signed governance tx.
    // Capture the error and report it alongside the confirmed tx instead.
    let dbMirrorError: string | null = null;
    const setLifecycle = async (status: string) => {
      try {
        await sql`
          update routes set status = ${status}
          where flight_id = ${b.flight_id} and origin = ${b.origin} and dest = ${b.dest}
        `;
      } catch (err) {
        dbMirrorError = err instanceof Error ? err.message : String(err);
        console.error(`[admin-actions] ${b.op} ${b.flight_id}: chain op confirmed but routes mirror failed — ${dbMirrorError}`);
      }
    };

    let outcome;
    switch (b.op) {
      case "whitelist":
        outcome = await submitter.whitelist(
          key,
          b.premium_units ? BigInt(b.premium_units) : null,
          b.payoff_units ? BigInt(b.payoff_units) : null,
          b.delay_hours ?? null
        );
        await setLifecycle("active");
        break;
      case "disable":
        outcome = await submitter.disable(key);
        await setLifecycle("disabled");
        break;
      case "enable":
        outcome = await submitter.enable(key);
        await setLifecycle("active");
        break;
      case "remove":
        outcome = await submitter.remove(key);
        await setLifecycle("removed");
        break;
      case "set_terms":
        outcome = await submitter.updateTerms(
          key,
          parseFieldOp(b.premium_units),
          parseFieldOp(b.payoff_units),
          parseDelayOp(b.delay_hours)
        );
        break;
      case "revert":
        outcome = await submitter.revertTerms(key);
        break;
      default:
        res.status(400).json({ error: `Invalid op: ${b.op}` });
        return;
    }

    res.status(200).json({
      tx_hash: outcome.txHash,
      before: jsonRoute(outcome.before),
      after: jsonRoute(outcome.after),
      ...(dbMirrorError
        ? {
            warning:
              `on-chain op confirmed (see tx_hash) but the DB routes.status mirror failed: ${dbMirrorError}. ` +
              `Do NOT resubmit the op — fix the DB status instead.`,
          }
        : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** omitted/undefined → Keep; "default" → UseDefault; value → Set. */
function parseFieldOp(v: unknown): PremiumOp {
  if (v === undefined || v === null || v === "keep") return "keep";
  if (v === "default") return "use_default";
  return BigInt(v as string | number);
}

function parseDelayOp(v: unknown): DelayOp {
  if (v === undefined || v === null || v === "keep") return "keep";
  if (v === "default") return "use_default";
  return Number(v);
}

function jsonRoute(r: { status: string; terms: { premium: bigint; payoff: bigint; delayHours: number } | null }) {
  return {
    status: r.status,
    terms: r.terms
      ? {
          premium: r.terms.premium.toString(),
          payoff: r.terms.payoff.toString(),
          delay_hours: r.terms.delayHours,
        }
      : null,
  };
}
