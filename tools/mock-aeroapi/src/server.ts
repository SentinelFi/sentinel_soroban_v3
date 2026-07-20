import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Scenario {
  outcome: "on_time" | "delayed" | "cancelled" | "en_route";
  delay_minutes?: number;
  origin?: string;
  destination?: string;
  aircraft_type?: string;
  // When true, the endpoint returns two flight records for the ident/day,
  // simulating an ambiguous AeroAPI response (e.g. a flight number operated
  // more than once in the day). The fetcher must refuse to guess.
  duplicate?: boolean;
}

interface Scenarios {
  [ident: string]: Scenario;
}

interface AeroApiAirport {
  code: string;
  code_icao: string;
  code_iata: string;
  code_lid: string;
  timezone: string;
  name: string;
  city: string;
  airport_info_url: string;
}

interface AeroApiFlight {
  ident: string;
  ident_icao: string;
  ident_iata: string;
  fa_flight_id: string;
  operator: string;
  operator_icao: string;
  operator_iata: string;
  flight_number: string;
  registration: string | null;
  atc_ident: string | null;
  inbound_fa_flight_id: string | null;
  codeshares: string[];
  codeshares_iata: string[];
  blocked: boolean;
  diverted: boolean;
  cancelled: boolean;
  position_only: boolean;
  origin: AeroApiAirport;
  destination: AeroApiAirport;
  departure_delay: number | null;
  arrival_delay: number | null;
  filed_ete: number | null;
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;
  scheduled_off: string | null;
  estimated_off: string | null;
  actual_off: string | null;
  scheduled_on: string | null;
  estimated_on: string | null;
  actual_on: string | null;
  scheduled_in: string | null;
  estimated_in: string | null;
  actual_in: string | null;
  progress_percent: number | null;
  status: string;
  aircraft_type: string | null;
  route_distance: number | null;
  filed_airspeed: number | null;
  filed_altitude: number | null;
  route: string | null;
  baggage_claim: string | null;
  seats_cabin_business: number | null;
  seats_cabin_coach: number | null;
  seats_cabin_first: number | null;
  gate_origin: string | null;
  gate_destination: string | null;
  terminal_origin: string | null;
  terminal_destination: string | null;
  type: string;
}

interface AeroApiResponse {
  flights: AeroApiFlight[];
  links: { next: string | null } | null;
  num_pages: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScenarios(): Scenarios {
  const raw = readFileSync(join(__dirname, "..", "scenarios.json"), "utf-8");
  return JSON.parse(raw);
}

function makeAirport(code: string): AeroApiAirport {
  return {
    code,
    code_icao: code,
    code_iata: code.replace(/^K/, ""),
    code_lid: code,
    timezone: "America/New_York",
    name: `${code} Airport`,
    city: code,
    airport_info_url: `/airports/${code}`,
  };
}

function buildFlight(ident: string, scenario: Scenario, dateParam: string | undefined): AeroApiFlight {
  const flightDate = dateParam ?? new Date().toISOString().slice(0, 10);
  const origin = scenario.origin ?? "KJFK";
  const destination = scenario.destination ?? "KLAX";

  // Base times: departure 08:00 UTC, scheduled arrival 11:00 UTC
  const scheduledOut = `${flightDate}T08:00:00Z`;
  const scheduledIn = `${flightDate}T11:00:00Z`;
  const scheduledMs = new Date(scheduledIn).getTime();

  let status: string;
  let cancelled = false;
  let actualIn: string | null = null;
  let actualOut: string | null = null;
  let arrivalDelay: number | null = null;
  let departureDelay: number | null = null;
  let progressPercent: number | null = null;

  switch (scenario.outcome) {
    case "on_time": {
      // Arrived 5 minutes early
      const actualMs = scheduledMs - 5 * 60 * 1000;
      actualIn = new Date(actualMs).toISOString();
      actualOut = `${flightDate}T07:55:00Z`;
      arrivalDelay = -300; // -5 minutes in seconds
      departureDelay = -300;
      // Real AeroAPI returns "Arrived / Gate Arrival", not "Landed"
      status = "Arrived / Gate Arrival";
      progressPercent = 100;
      break;
    }
    case "delayed": {
      const delayMinutes = scenario.delay_minutes ?? 180;
      const actualMs = scheduledMs + delayMinutes * 60 * 1000;
      actualIn = new Date(actualMs).toISOString();
      actualOut = `${flightDate}T08:30:00Z`;
      arrivalDelay = delayMinutes * 60; // in seconds
      departureDelay = 1800; // 30 min departure delay
      // Real AeroAPI returns "Landed / Taxiing" or "Arrived / Gate Arrival"
      status = "Landed / Taxiing";
      progressPercent = 100;
      break;
    }
    case "cancelled": {
      cancelled = true;
      status = "Cancelled";
      progressPercent = 0;
      break;
    }
    case "en_route": {
      actualOut = `${flightDate}T08:05:00Z`;
      departureDelay = 300;
      status = "En Route";
      progressPercent = 55;
      break;
    }
  }

  return {
    ident,
    ident_icao: ident,
    ident_iata: ident,
    fa_flight_id: `${ident}-${flightDate.replace(/-/g, "")}-0001`,
    operator: ident.replace(/\d+/g, ""),
    operator_icao: ident.replace(/\d+/g, ""),
    operator_iata: ident.replace(/\d+/g, ""),
    flight_number: ident.replace(/\D+/g, ""),
    registration: null,
    atc_ident: null,
    inbound_fa_flight_id: null,
    codeshares: [],
    codeshares_iata: [],
    blocked: false,
    diverted: false,
    cancelled,
    position_only: false,
    origin: makeAirport(origin),
    destination: makeAirport(destination),
    departure_delay: departureDelay,
    arrival_delay: arrivalDelay,
    filed_ete: 10800, // 3 hours in seconds
    scheduled_out: scheduledOut,
    estimated_out: actualOut ?? scheduledOut,
    actual_out: actualOut,
    scheduled_off: scheduledOut,
    estimated_off: actualOut ?? scheduledOut,
    actual_off: actualOut,
    scheduled_on: scheduledIn,
    estimated_on: actualIn ?? scheduledIn,
    actual_on: actualIn,
    scheduled_in: scheduledIn,
    estimated_in: actualIn ?? scheduledIn,
    actual_in: actualIn,
    progress_percent: progressPercent,
    status,
    aircraft_type: scenario.aircraft_type ?? "B738",
    route_distance: 2475,
    filed_airspeed: 460,
    filed_altitude: 350,
    route: null,
    baggage_claim: null,
    seats_cabin_business: null,
    seats_cabin_coach: null,
    seats_cabin_first: null,
    gate_origin: "B22",
    gate_destination: "T4",
    terminal_origin: "1",
    terminal_destination: "5",
    type: "Airline",
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const app = express();
const PORT = parseInt(process.env.PORT ?? "3001", 10);

app.get("/flights/:ident", (req, res) => {
  const { ident } = req.params;
  const startParam = req.query.start as string | undefined;
  const dateParam = startParam?.slice(0, 10);

  const scenarios = loadScenarios();
  const scenario = scenarios[ident];

  let flights: AeroApiFlight[] = [];
  if (scenario) {
    flights = [buildFlight(ident, scenario, dateParam)];
    if (scenario.duplicate) {
      // Second candidate record for the same ident/day → ambiguous response.
      flights.push(buildFlight(ident, scenario, dateParam));
    }
  }

  const response: AeroApiResponse = {
    flights,
    links: null,
    num_pages: 1,
  };

  console.log(
    `[mock-aeroapi] GET /flights/${ident} → ${scenario ? scenario.outcome : "unknown (empty)"}`
  );

  res.json(response);
});

app.listen(PORT, () => {
  const scenarios = loadScenarios();
  const count = Object.keys(scenarios).length;
  console.log(`[mock-aeroapi] listening on http://localhost:${PORT}`);
  console.log(`[mock-aeroapi] ${count} scenarios loaded: ${Object.keys(scenarios).join(", ")}`);
});
