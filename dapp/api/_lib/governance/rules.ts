import type { OnChainRoute } from "./submitter";
import type { RouteRow, SignalRow } from "./model";

/**
 * PURE decision rules for the hourly reconciler (no I/O — same posture
 * as ../route_rules.ts). The reconciler feeds each route's DB state,
 * matching signals, and on-chain status through decideReconcileAction
 * and executes whatever comes back.
 *
 * 2026-07-30 simplification: the reconciler is now a PAUSE ENGINE ONLY.
 * Premiums are owned elsewhere — the ML base is set at seeding / the
 * monthly admin repricing ritual, and the flat weather surcharge is the
 * stateless jobs/weather.ts loop. The old multiplier stacking
 * (elevated signals × 1.25, premium_adjustments, drift thresholds,
 * daily-change caps) is deleted; an 'elevated' signal is now advisory
 * (visible in the DB and run logs, no action).
 *
 * Priority order:
 * 1. Admin pin wins — pinned routes are untouchable until the pin
 *    expires; the engine never undoes an admin decision.
 * 2. Pause scopes expand — any active severe signal targeting the
 *    route, its origin, or its dest closes the route. Reactivation
 *    only when the system's own pause_event exists and every pause
 *    signal has been clear for the hysteresis window.
 */

// Signals must be clear this long before the engine re-enables a route
// (2 consecutive hourly checks).
export const HYSTERESIS_HOURS = 2;

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

// ── decision ───────────────────────────────────────────────────────

export interface ReconcileInput {
  route: RouteRow;
  onChain: OnChainRoute;
  pauses: SignalRow[];
  /** True if any signal for this scope ended < HYSTERESIS_HOURS ago. */
  recentlyCleared: boolean;
  /** True if the system (not an admin) opened a pause_event still open. */
  hasOpenPauseEvent: boolean;
}

export type ReconcileAction =
  | { kind: "noop"; reason: string }
  | { kind: "disable"; reason: string; signalIds: string[] }
  | { kind: "enable"; reason: string }
  | { kind: "flag"; reason: string };

export function decideReconcileAction(input: ReconcileInput): ReconcileAction {
  const { route, onChain, pauses } = input;

  // ── 1. Admin pin wins — do not touch, ever ─────────────────────────
  if (route.pinned && (!route.pin_until || new Date(route.pin_until) > new Date())) {
    return { kind: "noop", reason: `pinned (${route.pin_reason ?? "no reason"})` };
  }

  // Not on-chain yet: whitelisting is the manual admin pipeline's job.
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
    // Hysteresis: every pause signal clear for N consecutive checks.
    if (input.recentlyCleared) {
      return { kind: "noop", reason: `pause cleared < ${HYSTERESIS_HOURS}h ago (hysteresis)` };
    }
    return { kind: "enable", reason: "all pause signals cleared" };
  }

  return { kind: "noop", reason: "active, no pause signals" };
}
