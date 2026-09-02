import { FlightStatus } from "../types.js";
import { loadRoutesConfig, usdcToBaseUnits } from "../routes_config.js";
import type { getDb } from "./db.js";

type Sql = ReturnType<typeof getDb>;

/**
 * SQL fragments shared by every reader that pairs the `policies` mirror
 * with the `settlements` mirror to answer "did this policy pay out, and
 * how much?" (leaderboard, admin metrics, admin security). One place for
 * the two facts that are easy to get wrong:
 *
 * 1. `settlements.outcome` holds the controller's FlightSettled payload
 *    VERBATIM — the oracle FlightStatus variant name, so a paying
 *    settlement reads 'ToBeSettledDelayed' / 'ToBeSettledCancelled', not
 *    the bare 'Delayed' / 'Cancelled' the settlements migration comment
 *    suggests. Filtering on the bare names silently matches nothing.
 *
 * 2. The `bought` event carries only the premium, so the ingest never
 *    fills `policies.payoff_units`. The payout a win is worth resolves
 *    the way the sale did: the policy row's own payoff if one was ever
 *    recorded, else the route's admin-set base payoff, else the
 *    routes-file default. Good enough for boards and trend lines; not
 *    accounting — the on-chain FlightConfig is the authority.
 *
 * Every fragment assumes the caller's aliases: `p` = policies, `s` =
 * settlements, `r` = routes (joined via {@link routesForPolicy}), `w` =
 * the policy's paying settlement (joined via {@link paidSettlementForPolicy}).
 */

/** Settlement outcomes that pay the traveler. */
export const PAID_OUTCOMES = [
  FlightStatus.ToBeSettledDelayed,
  FlightStatus.ToBeSettledCancelled,
] as const;

/** `s` is a settlement that paid out. */
export function settlementPaid(sql: Sql) {
  return sql`s.outcome in (${PAID_OUTCOMES[0]}, ${PAID_OUTCOMES[1]})`;
}

/**
 * `s` is the settlement of policy `p`'s flight. Exact (flight_id, date)
 * match first; policy rows ingested before the mirror stored `date`
 * fall back to "settled within four days of purchase". Callers must
 * already constrain `s.flight_id = p.flight_id`.
 */
export function settlementMatchesPolicy(sql: Sql) {
  return sql`(s.date = p.date
              or (p.date is null
                  and s.settled_at >= p.bought_at
                  and s.settled_at <  p.bought_at + interval '4 days'))`;
}

/**
 * `left join lateral (...) w` — the settlement that paid policy `p`, or
 * null columns when nothing did. At most ONE row per policy: the
 * four-day fallback can see several settlements of the same flight
 * number (flights run daily), and a policy pays once, so the earliest
 * wins. Readers that count or sum paid policies must go through this
 * rather than joining settlements directly, or dateless rows double up.
 */
export function paidSettlementForPolicy(sql: Sql) {
  return sql`left join lateral (
        select s.flight_id, s.date, s.settled_at
        from settlements s
        where s.flight_id = p.flight_id
          and ${settlementPaid(sql)}
          and ${settlementMatchesPolicy(sql)}
        order by s.settled_at
        limit 1
      ) w on true`;
}

/** `left join routes r` on policy `p`'s on-chain route key. */
export function routesForPolicy(sql: Sql) {
  return sql`left join routes r
        on r.flight_id = p.flight_id
       and r.origin = p.origin
       and r.dest = p.dest`;
}

/** Payout policy `p` is worth if its flight pays, base units (bigint). */
export function resolvedPayoff(sql: Sql) {
  return sql`coalesce(p.payoff_units, r.base_payoff_units, ${defaultPayoffUnits()}::bigint)`;
}

function defaultPayoffUnits(): string {
  return usdcToBaseUnits(loadRoutesConfig().defaults.payoffUsdc).toString();
}
