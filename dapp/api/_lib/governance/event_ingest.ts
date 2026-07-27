import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getDb } from "./db";

/**
 * Chain-event mirror — durable copies of the protocol events the DB
 * needs beyond RPC's ~7-day retention window:
 *
 * - `InsuranceBought`  → `policies`     (per-policy history / analytics;
 *                                        the exposure SIGNAL reads live
 *                                        chain state and does not depend
 *                                        on this)
 * - `FlightSettled`    → `settlements`  (feeds the expired-claim sweeper,
 *                                        which fires ~60 days after the
 *                                        event has left RPC retention)
 *
 * Resume via `ingest_cursors` (collector 'chain-events', last ledger).
 * Dedup: (tx_hash, event_index) on policies, (flight_id, date) PK on
 * settlements — re-ingesting a range is harmless (idempotent).
 *
 * Runs inside the hourly gov_exposure job (both are on-chain→DB mirrors);
 * failures are logged and never block the exposure signals.
 */

const CURSOR_KEY = "chain-events";
// RPC retains ~120k ledgers (~7 days at ~5s); start just inside it.
const RETENTION_LEDGERS = 118_000;
const PAGE_LIMIT = 200;

export interface IngestResult {
  policies: number;
  settlements: number;
  fromLedger: number;
  toLedger: number;
}

export function nativeTopics(topics: xdr.ScVal[]): unknown[] {
  return topics.map((t) => {
    try {
      return scValToNative(t);
    } catch {
      return null;
    }
  });
}

export async function ingestChainEvents(
  rpcUrl: string,
  controllerId: string
): Promise<IngestResult> {
  const sql = getDb();
  const server = new rpc.Server(rpcUrl);

  const latest = await server.getLatestLedger();
  const stored = (await sql`
    select cursor from ingest_cursors where name = ${CURSOR_KEY}
  `) as unknown as Array<{ cursor: string }>;
  const floor = Math.max(latest.sequence - RETENTION_LEDGERS, 1);
  const fromLedger = stored.length > 0 ? Math.max(Number(stored[0].cursor) + 1, floor) : floor;

  let policies = 0;
  let settlements = 0;
  let cursor: string | undefined;
  let lastSeen = fromLedger - 1;

  for (let page = 0; page < 20; page++) {
    const resp = await server.getEvents({
      startLedger: cursor ? undefined : fromLedger,
      cursor,
      filters: [{ type: "contract", contractIds: [controllerId] }],
      limit: PAGE_LIMIT,
    } as never);

    for (const ev of resp.events ?? []) {
      lastSeen = Math.max(lastSeen, ev.ledger);
      const topics = nativeTopics(ev.topic as xdr.ScVal[]);
      if (topics[0] !== "sentinel") continue;

      if (topics[1] === "bought") {
        // topics: [sentinel, bought, traveler, flight_id, date]; value: premium
        const [, , traveler, flightId] = topics;
        let premium: string | null = null;
        try {
          premium = String(scValToNative(ev.value as xdr.ScVal));
        } catch {
          /* keep null */
        }
        const [txHash, evIndex] = String(ev.id).split("-");
        const boughtAt = (ev as { ledgerClosedAt?: string }).ledgerClosedAt ?? new Date().toISOString();
        await sql`
          insert into policies (tx_hash, event_index, ledger, flight_id, origin, dest,
                                buyer, premium_units, bought_at)
          select ${txHash}, ${Number(evIndex ?? 0)}, ${ev.ledger}, ${String(flightId)},
                 coalesce(r.origin, ''), coalesce(r.dest, ''),
                 ${String(traveler)}, ${premium}, ${boughtAt}
          from (select 1) one
          left join routes r on r.flight_id = ${String(flightId)}
          on conflict do nothing
        `;
        policies++;
      } else if (topics[1] === "settled") {
        // topics: [sentinel, settled, flight_id, date]; value: outcome
        const [, , flightId, date] = topics;
        let outcome = "Unknown";
        try {
          const v = scValToNative(ev.value as xdr.ScVal);
          outcome = Array.isArray(v) ? String(v[0]) : typeof v === "object" && v ? Object.keys(v)[0] : String(v);
        } catch {
          /* keep Unknown */
        }
        await sql`
          insert into settlements (flight_id, date, outcome, ledger, tx_hash)
          values (${String(flightId)}, ${Number(date)}, ${outcome}, ${ev.ledger},
                  ${String(ev.id).split("-")[0]})
          on conflict (flight_id, date) do nothing
        `;
        settlements++;
      }
    }

    cursor = (resp as { cursor?: string }).cursor;
    if (!resp.events || resp.events.length < PAGE_LIMIT || !cursor) break;
  }

  const toLedger = Math.max(lastSeen, latest.sequence);
  await sql`
    insert into ingest_cursors (name, cursor, updated_at)
    values (${CURSOR_KEY}, ${String(toLedger)}, now())
    on conflict (name) do update set cursor = ${String(toLedger)}, updated_at = now()
  `;

  return { policies, settlements, fromLedger, toLedger };
}
