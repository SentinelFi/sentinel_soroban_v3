/**
 * IATA airport code → coordinates for weather lookups (Open-Meteo takes
 * lat/lon, not airport codes). Curated set covering major US + international
 * hubs; routes whose airports are missing here simply skip the weather
 * check (fail-open to noop — the sale authorizer still gates real
 * insurability via AeroAPI).
 */
export interface AirportCoords {
  lat: number;
  lon: number;
}

export const AIRPORTS: Record<string, AirportCoords> = {
  // US
  ATL: { lat: 33.64, lon: -84.43 },
  BOS: { lat: 42.36, lon: -71.01 },
  BWI: { lat: 39.18, lon: -76.67 },
  CLT: { lat: 35.21, lon: -80.94 },
  DCA: { lat: 38.85, lon: -77.04 },
  DEN: { lat: 39.86, lon: -104.67 },
  DFW: { lat: 32.9, lon: -97.04 },
  DTW: { lat: 42.21, lon: -83.35 },
  EWR: { lat: 40.69, lon: -74.17 },
  IAD: { lat: 38.95, lon: -77.46 },
  IAH: { lat: 29.98, lon: -95.34 },
  JFK: { lat: 40.64, lon: -73.78 },
  LAS: { lat: 36.08, lon: -115.15 },
  LAX: { lat: 33.94, lon: -118.41 },
  LGA: { lat: 40.78, lon: -73.87 },
  MCO: { lat: 28.43, lon: -81.31 },
  MIA: { lat: 25.79, lon: -80.29 },
  MSP: { lat: 44.88, lon: -93.22 },
  ORD: { lat: 41.97, lon: -87.91 },
  PHL: { lat: 39.87, lon: -75.24 },
  PDX: { lat: 45.59, lon: -122.6 },
  PHX: { lat: 33.44, lon: -112.01 },
  SAN: { lat: 32.73, lon: -117.19 },
  SEA: { lat: 47.45, lon: -122.31 },
  SFO: { lat: 37.62, lon: -122.38 },
  SLC: { lat: 40.79, lon: -111.98 },
  TPA: { lat: 27.98, lon: -82.53 },
  // International
  AMS: { lat: 52.31, lon: 4.76 },
  CDG: { lat: 49.01, lon: 2.55 },
  DXB: { lat: 25.25, lon: 55.36 },
  FRA: { lat: 50.03, lon: 8.56 },
  HND: { lat: 35.55, lon: 139.78 },
  LHR: { lat: 51.47, lon: -0.45 },
  NRT: { lat: 35.77, lon: 140.39 },
  SIN: { lat: 1.36, lon: 103.99 },
  SYD: { lat: -33.95, lon: 151.18 },
  YYZ: { lat: 43.68, lon: -79.62 },
};

/** Great-circle distance in statute miles (haversine). */
export function distanceMiles(a: AirportCoords, b: AirportCoords): number {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
