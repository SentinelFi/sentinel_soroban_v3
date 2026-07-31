import { FlightStatus } from "./types";

// Map enum index to FlightStatus (matches on-chain enum order in
// sentinel_types/src/lib.rs — LOAD-BEARING, do not reorder).
export const STATUS_BY_INDEX: FlightStatus[] = [
  FlightStatus.NotInitiated,
  FlightStatus.Active,
  FlightStatus.Landed,
  FlightStatus.Cancelled,
  FlightStatus.ToBeSettledOnTime,
  FlightStatus.ToBeSettledDelayed,
  FlightStatus.ToBeSettledCancelled,
  FlightStatus.Settled,
];

/**
 * scValToNative returns enum variants in different shapes depending on
 * SDK version: an index (number), a variant name (string), a one-element
 * array, or an object whose key is the variant. Handle all four.
 *
 * OCA-M07: an unrecognized shape (or out-of-range index) returns
 * FlightStatus.Unknown — never NotInitiated, which is the most PERMISSIVE
 * value (it reads as "fresh, sellable, sweepable" at every money gate).
 * Unknown fails closed everywhere: sale-auth refuses, the settle sweep
 * skips, TTL's Settled* check misses. Strings pass through unvalidated on
 * purpose — this parser is also used on the pool's SettlementStatus enum
 * (SettledDelayed/SettledCancelled), whose variants are not in
 * STATUS_BY_INDEX.
 */
export function parseFlightStatus(raw: any): FlightStatus {
  if (typeof raw === "number") {
    if (STATUS_BY_INDEX[raw] === undefined) {
      console.warn(`[status] Out-of-range status index ${raw} — treating as Unknown (fail closed)`);
      return FlightStatus.Unknown;
    }
    return STATUS_BY_INDEX[raw];
  }
  if (typeof raw === "string") {
    return raw as FlightStatus;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0] as FlightStatus;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length > 0) return keys[0] as FlightStatus;
  }
  console.warn(`[status] Unknown status format: ${JSON.stringify(raw)} — treating as Unknown (fail closed)`);
  return FlightStatus.Unknown;
}
