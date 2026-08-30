/**
 * IANA zone per fleet airport, for surfacing origin-local departure info
 * on the board (policies stay keyed by the UTC departure date — see
 * sale_auth.ts).
 *
 * Mirrors the pricing run's map (scripts/price_routes.ts); the seeded
 * fleet only touches these 14 airports. An unmapped origin resolves to
 * null and the UI omits the local-time hint entirely — an incomplete map
 * degrades to less disclosure, never to a wrong time. Extend this
 * together with the airports table before widening the route matrix.
 */
const AIRPORT_TZ: Record<string, string> = {
  JFK: "America/New_York",
  EWR: "America/New_York",
  LGA: "America/New_York",
  BOS: "America/New_York",
  PHL: "America/New_York",
  MIA: "America/New_York",
  ORD: "America/Chicago",
  DFW: "America/Chicago",
  IAH: "America/Chicago",
  SEA: "America/Los_Angeles",
  PDX: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  LAX: "America/Los_Angeles",
  LAS: "America/Los_Angeles",
};

export function airportTz(iata: string): string | null {
  return AIRPORT_TZ[iata] ?? null;
}
