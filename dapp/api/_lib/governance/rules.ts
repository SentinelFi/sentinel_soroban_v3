import { clampPremium, applyMultiplier } from "../route_rules";
import type { RouteRails } from "../routes_config";
import type { OnChainRoute } from "./submitter";
import type { RouteRow, SignalRow } from "./model";

/**
 * PURE decision rules for the hourly reconciler (no I/O — same posture
 * as ../route_rules.ts). The reconciler feeds each route's DB state,
 * matching signals, and on-chain status through decideReconcileAction
 * and executes whatever comes back.
 *
 * Priority order (decided in the governance architecture):
 * 1. Admin pin wins — pinned routes are untouchable until the pin
 *    expires; the engine never undoes an admin decision.
 * 2. Pause scopes expand — any active severe signal targeting the
 *    route, its origin, or its dest closes the route. Reactivation
 *    only when the system's own pause_event exists and every pause
 *    signal has been clear for the hysteresis window.
 * 3. Premium multipliers stack multiplicatively over the base terms,
 *    clamped to the rails, validated against payoff before submit.
 * 4. Hysteresis — re-enable/lowering waits HYSTERESIS_HOURS after the
 *    last signal cleared; max 1 premium change per route per day.
 */

// Signals must be clear this long before the engine re-enables a route
// or lowers a premium (2 consecutive hourly checks).
export const HYSTERESIS_HOURS = 2;

/** Premium writes below this drift are skipped — no churn txs (1 USDC). */
export const DRIFT_THRESHOLD_BASE_UNITS = 10_000_000n;

// ── signal scope matching ──────────────────────────────────────────

export function signalMatchesRoute(sig: SignalRow, route: RouteRow): boolean {
  switch (sig.scope_kind) {
    case "route":
      return (
        sig.flight_id === route.flight_id &&
        sig.origin === route.origin &&
        sig.dest === route.dest
      );
    case "origin":
      return sig.origin === route.origin;
    case "dest":
      return sig.dest === route.dest;
  }
}

/** A pause signal is any active signal at 'severe'. */
export function isPause(sig: SignalRow): boolean {
  return sig.severity === "severe";
}

/** An adjuster contributes a premium multiplier: active + 'elevated'. */
export function isAdjuster(sig: SignalRow): boolean {
  return sig.severity === "elevated";
}

/** Multiplier factor for an adjuster signal. payload.factor wins. */
export function signalFactor(sig: SignalRow, rails: RouteRails): number {
  const raw = (sig.payload as { factor?: unknown }).factor;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  return rails.elevatedWeatherMultiplier;
}

// ── decision ───────────────────────────────────────────────────────

export interface ReconcileInput {
  route: RouteRow;
  onChain: OnChainRoute;
  /** Active signals already filtered to this route's scope. */
  pauses: SignalRow[];
  adjusters: SignalRow[];
  /** True if any pause/adjuster signal for this scope ended < HYSTERESIS_HOURS ago. */
  recentlyCleared: boolean;
  /** True if the system (not an admin) opened a pause_event still open. */
  hasOpenPauseEvent: boolean;
  /** True if an unreverted premium_adjustment row exists. */
  hasOpenAdjustment: boolean;
  /** True if any premium_adjustment was applied in the last 24h. */
  adjustedToday: boolean;
  /** Base premium after the fallback chain (route row → file defaults). */
  basePremium: bigint;
  /**
   * ML pricing anchor from an active `pricing` signal (route_agent's
   * daily XGBoost baseline, already rails-clamped by the reconciler).
   * When present it REPLACES basePremium as the multiplier base; absent
   * or expired → admin/file base applies (model outage degrades safely).
   */
  anchorPremium?: bigint | null;
  rails: RouteRails;
}

export type ReconcileAction =
  | { kind: "noop"; reason: string }
  | { kind: "disable"; reason: string; signalIds: string[] }
  | { kind: "enable"; reason: string }
  | {
      kind: "set_premium";
      target: bigint;
      multipliers: Array<{ kind: string; factor: number; signal_id: number }>;
      reason: string;
    }
  | { kind: "revert_premium"; reason: string }
  | { kind: "flag"; reason: string };

export function decideReconcileAction(input: ReconcileInput): ReconcileAction {
  const { route, onChain, pauses, adjusters, rails } = input;

  // ── 1. Admin pin wins — do not touch, ever ─────────────────────────
  if (route.pinned && (!route.pin_until || new Date(route.pin_until) > new Date())) {
    return { kind: "noop", reason: `pinned (${route.pin_reason ?? "no reason"})` };
  }

  // Not on-chain yet: whitelisting is gov-onboard's / the admin's job.
  if (onChain.status === "Unknown") {
    return { kind: "noop", reason: "not whitelisted on-chain" };
  }

  // ── 2. Pause scopes expand ─────────────────────────────────────────
  if (pauses.length > 0) {
    if (onChain.status === "Active") {
      return {
        kind: "disable",
        reason: pauses.map((p) => `${p.type}:${p.source}`).join(", "),
        signalIds: pauses.map((p) => p.id),
      };
    }
    return { kind: "noop", reason: "paused; already disabled on-chain" };
  }

  // Admin lifecycle intent: 'disabled' means an admin turned it off —
  // enforce it, never auto-re-enable.
  if (route.status === "disabled") {
    if (onChain.status === "Active") {
      return { kind: "disable", reason: "admin lifecycle: disabled", signalIds: [] };
    }
    return { kind: "noop", reason: "admin lifecycle: disabled" };
  }

  // ── Reactivation: signal cleared → enable_route ────────────────────
  if (onChain.status === "Disabled") {
    // Only re-open what the system itself closed. Disabled on-chain with
    // no open pause_event = someone acted outside the engine → flag it.
    if (!input.hasOpenPauseEvent) {
      return { kind: "flag", reason: "disabled on-chain outside the engine; needs admin review" };
    }
    // 4. Hysteresis: every pause signal clear for N consecutive checks.
    if (input.recentlyCleared) {
      return { kind: "noop", reason: `pause cleared < ${HYSTERESIS_HOURS}h ago (hysteresis)` };
    }
    return { kind: "enable", reason: "all pause signals cleared" };
  }

  // ── 3. Premium multipliers stack over base, clamp, validate ────────
  const current = onChain.terms?.premium ?? null;
  const payoff = onChain.terms?.payoff ?? null;
  const base = input.anchorPremium ?? input.basePremium;

  if (adjusters.length === 0) {
    // No live adjusters: if the engine previously moved the premium,
    // walk it back to base (hysteresis-gated — lowering).
    if (input.hasOpenAdjustment && current !== null && current !== base) {
      if (input.recentlyCleared) {
        return { kind: "noop", reason: "adjusters cleared; hysteresis before revert" };
      }
      return { kind: "revert_premium", reason: "all adjuster signals cleared" };
    }
    return { kind: "noop", reason: "no active signals; premium at base" };
  }

  const multipliers = adjusters.map((s) => ({
    kind: s.type,
    factor: signalFactor(s, rails),
    signal_id: Number(s.id),
  }));

  let target = base;
  for (const m of multipliers) target = applyMultiplier(target, m.factor);
  target = clampPremium(target, current, rails);

  // terms_valid mirror: premium < payoff and payoff/premium ≤ 100 —
  // never submit something the contract will reject.
  if (payoff !== null && (target >= payoff || payoff > target * 100n)) {
    return { kind: "flag", reason: `target premium ${target} fails terms validation vs payoff ${payoff}` };
  }

  if (current !== null) {
    const drift = target > current ? target - current : current - target;
    if (drift < DRIFT_THRESHOLD_BASE_UNITS) {
      return { kind: "noop", reason: "within drift threshold" };
    }
    // 4. Hysteresis: max 1 premium change per route per day; lowering
    // additionally waits for the clear window.
    if (input.adjustedToday) {
      return { kind: "noop", reason: "premium already adjusted today" };
    }
    if (target < current && input.recentlyCleared) {
      return { kind: "noop", reason: "lowering premium; hysteresis window open" };
    }
  }

  return {
    kind: "set_premium",
    target,
    multipliers,
    reason: multipliers.map((m) => `${m.kind}×${m.factor}`).join(" "),
  };
}
