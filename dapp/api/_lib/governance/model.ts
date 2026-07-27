/**
 * Row types for the governance DB (Supabase Postgres — see
 * supabase/migrations/*_governance_core.sql for the authoritative
 * schema and the access model: RLS deny-all, server-side only).
 *
 * bigint columns arrive as strings from postgres.js — kept as strings
 * here so rows JSON-serialize cleanly into actions_log payloads;
 * convert with BigInt(...) at arithmetic sites.
 */

/** On-chain route key: (flight_id, origin, dest) Symbols. */
export interface RouteKey {
  flightId: string;
  origin: string;
  dest: string;
}

export type RouteLifecycle = "candidate" | "active" | "disabled" | "removed";

export interface RouteRow {
  id: string;
  flight_id: string;
  origin: string;
  dest: string;
  carrier: string | null;
  base_premium_units: string | null;
  base_payoff_units: string | null;
  base_delay_hours: number | null;
  sched_dep_local: string | null; // 'HH:MM:SS'
  sched_arr_local: string | null;
  dep_tz: string | null;
  arr_tz: string | null;
  distance_mi: number | null;
  status: RouteLifecycle;
  pinned: boolean;
  pin_until: string | null;
  pin_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type SignalType =
  | "weather"
  | "geopolitical"
  | "exposure"
  | "schedule_drift"
  | "manual"
  // Added by migration 20260727140000_gov_guardrails:
  | "ops" // non-weather airport delay categories (traffic, equipment)
  | "pricing"; // ML baseline-premium anchors (route_agent collector)
export type SignalScope = "route" | "origin" | "dest";
export type SignalSeverity = "info" | "elevated" | "severe";

export interface SignalRow {
  id: string;
  type: SignalType;
  scope_kind: SignalScope;
  flight_id: string | null;
  origin: string | null;
  dest: string | null;
  severity: SignalSeverity;
  payload: Record<string, unknown>;
  source: string;
  expires_at: string | null;
  cleared_at: string | null;
  created_at: string;
}

export interface PauseEventRow {
  id: string;
  flight_id: string;
  origin: string;
  dest: string;
  signal_id: string | null;
  reason: string;
  actor: string;
  started_at: string;
  ended_at: string | null;
}

export interface PremiumAdjustmentRow {
  id: string;
  flight_id: string;
  origin: string;
  dest: string;
  base_premium_units: string;
  multipliers: Array<{ kind: string; factor: number; signal_id?: number }>;
  final_premium_units: string;
  reason: string;
  applied_at: string;
  reverted_at: string | null;
}

export interface ActionLogRow {
  id: string;
  ts: string;
  actor: string;
  action: string;
  flight_id: string | null;
  origin: string | null;
  dest: string | null;
  tx_hash: string | null;
  before: unknown;
  after: unknown;
  success: boolean;
  error: string | null;
}

export interface PolicyRow {
  id: string;
  tx_hash: string;
  event_index: number;
  ledger: number;
  flight_id: string;
  origin: string;
  dest: string;
  buyer: string;
  premium_units: string | null;
  payoff_units: string | null;
  bought_at: string;
  ingested_at: string;
}
