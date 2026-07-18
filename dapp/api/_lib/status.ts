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
 */
export function parseFlightStatus(raw: any): FlightStatus {
  if (typeof raw === "number") {
    return STATUS_BY_INDEX[raw] ?? FlightStatus.NotInitiated;
  }
  if (typeof raw === "string") {
    return raw as FlightStatus;
  }
  if (Array.isArray(raw)) {
    return raw[0] as FlightStatus;
  }
  if (typeof raw === "object" && raw !== null) {
    const keys = Object.keys(raw);
    if (keys.length > 0) return keys[0] as FlightStatus;
  }
  console.warn(`[status] Unknown status format: ${JSON.stringify(raw)}, defaulting to NotInitiated`);
  return FlightStatus.NotInitiated;
}
