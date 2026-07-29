/**
 * ICAO ↔ IATA for the nine insured carriers — the single source of truth.
 *
 * There is no algorithmic conversion between the two registries (SWA↔WN,
 * JBU↔B6 follow no rule), so conversion is a lookup table. The domain is
 * CLOSED by design: discovery drops every carrier not listed here, so a
 * miss downstream is an upstream bug — callers must fail loud on null,
 * never guess.
 *
 * Where each standard is used (see spec/architecture.md — Airline code
 * standards): `flight_id` keeps the ICAO operating ident (AeroAPI
 * attestation key, on-chain identity); every stored `carrier` field is
 * IATA (the BTS/ML standard the prediction service was trained on).
 */

export const CARRIERS = [
  { icao: "AAL", iata: "AA", name: "American" },
  { icao: "DAL", iata: "DL", name: "Delta" },
  { icao: "UAL", iata: "UA", name: "United" },
  { icao: "ASA", iata: "AS", name: "Alaska" },
  { icao: "SWA", iata: "WN", name: "Southwest" },
  { icao: "JBU", iata: "B6", name: "JetBlue" },
  { icao: "FFT", iata: "F9", name: "Frontier" },
  { icao: "NKS", iata: "NK", name: "Spirit" },
  { icao: "HAL", iata: "HA", name: "Hawaiian" },
] as const;

const ICAO_TO_IATA = new Map<string, string>(CARRIERS.map((c) => [c.icao, c.iata]));
const IATA_TO_ICAO = new Map<string, string>(CARRIERS.map((c) => [c.iata, c.icao]));
const NAME_BY_CODE = new Map<string, string>(
  CARRIERS.flatMap((c) => [
    [c.icao, c.name],
    [c.iata, c.name],
  ])
);

/** ICAO→IATA for a tracked carrier; IATA input passes through. Null = untracked. */
export function toIata(code: string): string | null {
  return ICAO_TO_IATA.get(code) ?? (IATA_TO_ICAO.has(code) ? code : null);
}

/** IATA→ICAO for a tracked carrier; ICAO input passes through. Null = untracked. */
export function toIcao(code: string): string | null {
  return IATA_TO_ICAO.get(code) ?? (ICAO_TO_IATA.has(code) ? code : null);
}

/** Display name for a tracked carrier code in either standard. */
export function carrierName(code: string): string | null {
  return NAME_BY_CODE.get(code) ?? null;
}
