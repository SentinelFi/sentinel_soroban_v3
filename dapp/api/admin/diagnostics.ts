import type { VercelRequest, VercelResponse } from "@vercel/node";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { nativeTopics } from "../_lib/governance/event_ingest";
import { loadPublicConfig } from "../_lib/config";

/**
 * Admin API — protocol diagnostics feed.
 *
 * Nothing watched these events before: they are the contracts' "operator
 * attention needed" channel, and missing them means the 14-day void
 * timeout resolves problems the hard way (travelers lose payouts).
 * This endpoint live-scans the last ~24h of chain events (well inside RPC
 * retention — no storage needed) across oracle/controller/pool and
 * returns the diagnostic ones:
 *
 *   ttl_miss       controller — oracle data missing for a registered flight
 *   cfg_missing    controller — pool FlightConfig missing at classify/settle
 *   voided         controller — dataless flight voided as on-time (post-mortem)
 *   timed_out      controller — stuck-Active flight voided (post-mortem)
 *   evict_settled  controller — evicted flight settled (runbook step 2)
 *   page_miss      oracle/pool — archived active-set page skipped
 *   prune_miss     pool — settlement prune could not reach its page
 *
 * GET → { diagnostics: [{ledger, closed_at, contract, kind, detail}] }
 */

const DIAG_TOPICS = new Set([
  "ttl_miss",
  "cfg_missing",
  "voided",
  "timed_out",
  "evict_settled",
  "page_miss",
  "prune_miss",
]);
const LOOKBACK_LEDGERS = 17_500; // ~24h at ~5s
const PAGE_LIMIT = 200;

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
    const pub = loadPublicConfig();
    const server = new rpc.Server(pub.rpcUrl);
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(latest.sequence - LOOKBACK_LEDGERS, 1);
    const contracts: Record<string, string> = {
      [pub.contractIds.oracleAggregator]: "oracle",
      [pub.contractIds.controller]: "controller",
      [pub.contractIds.flightPoolManager]: "pool",
    };

    const diagnostics: Array<{
      ledger: number;
      closed_at: string | null;
      contract: string;
      kind: string;
      detail: unknown;
    }> = [];

    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const resp = await server.getEvents({
        startLedger: cursor ? undefined : startLedger,
        cursor,
        filters: [{ type: "contract", contractIds: Object.keys(contracts) }],
        limit: PAGE_LIMIT,
      } as never);

      for (const ev of resp.events ?? []) {
        const topics = nativeTopics(ev.topic as xdr.ScVal[]);
        if (topics[0] !== "sentinel" || !DIAG_TOPICS.has(String(topics[1]))) continue;
        let detail: unknown = topics.slice(2);
        try {
          detail = { topics: topics.slice(2), value: scValToNative(ev.value as xdr.ScVal) };
        } catch {
          /* topics only */
        }
        diagnostics.push({
          ledger: ev.ledger,
          closed_at: (ev as { ledgerClosedAt?: string }).ledgerClosedAt ?? null,
          contract: contracts[String(ev.contractId)] ?? String(ev.contractId),
          kind: String(topics[1]),
          detail,
        });
      }

      cursor = (resp as { cursor?: string }).cursor;
      if (!resp.events || resp.events.length < PAGE_LIMIT || !cursor) break;
    }

    res.status(200).json({
      diagnostics: diagnostics.reverse(), // newest first
      window: { from_ledger: startLedger, to_ledger: latest.sequence },
      as_of: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
