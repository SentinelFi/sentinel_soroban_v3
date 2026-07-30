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

// (SignalRow / PauseEventRow / PremiumAdjustmentRow removed 2026-08-01:
// the signals + pause_events machinery was replaced by the unified
// `interventions` ledger — see governance/interventions.ts. Historical
// DB rows remain readable in Supabase; nothing writes them anymore.)

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
