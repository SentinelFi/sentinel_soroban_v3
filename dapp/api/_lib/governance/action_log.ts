import { getDb } from "./db.js";

/**
 * Append-only audit writer for actions_log. Every on-chain governance
 * call — cron rule or admin — lands here with the tx hash and the
 * route_status before/after. There is deliberately no update/delete
 * counterpart.
 *
 * Actor convention (shared with pause_events.actor):
 *   'cron:<rule>'    e.g. 'cron:reconciler/pause-expand'
 *   'admin:<email>'  the Supabase-authenticated admin who clicked
 */

export interface ActionRecord {
  actor: string;
  /** Contract entry point: whitelist_route, disable_route, … */
  action: string;
  flightId?: string;
  origin?: string;
  dest?: string;
  txHash?: string | null;
  before?: unknown;
  after?: unknown;
  success: boolean;
  error?: string | null;
}

export async function logAction(rec: ActionRecord): Promise<void> {
  const sql = getDb();
  await sql`
    insert into actions_log
      (actor, action, flight_id, origin, dest, tx_hash, before, after, success, error)
    values
      (${rec.actor}, ${rec.action},
       ${rec.flightId ?? null}, ${rec.origin ?? null}, ${rec.dest ?? null},
       ${rec.txHash ?? null},
       ${rec.before === undefined ? null : sql.json(rec.before as any)},
       ${rec.after === undefined ? null : sql.json(rec.after as any)},
       ${rec.success}, ${rec.error ?? null})
  `;
}
