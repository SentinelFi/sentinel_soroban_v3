import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Scenario {
  outcome:
    | "on_time"
    | "delayed"
    | "cancelled"
    | "en_route"
    // Diverted mid-flight: diverted=true with an actual_in at the DIVERSION
    // airport — the fetcher must NOT attest a normal landing from it.
    | "diverted"
    // AeroAPI's cancelled flag without an airline cancellation: the spec
    // says `cancelled` means "no longer being tracked ... not always the
    // case [that the airline cancelled]". status stays non-cancelled text.
    | "tracking_lost"
    // Future flight: published schedule only, no actuals yet.
    | "scheduled";
  delay_minutes?: number;
  origin?: string;
  destination?: string;
  aircraft_type?: string;
  // When true, the endpoint returns two flight records for the ident/day,
  // simulating an ambiguous AeroAPI response (e.g. a flight number operated
  // more than once in the day). The fetcher must refuse to guess.
  duplicate?: boolean;
  // When set, /flights/{ident} responds with this HTTP status instead of
  // data — exercises the client's retry (429/5xx) and permanent-error paths.
  error?: number;
  // Days MISSING from the /schedules response for this ident — simulates
  // the airline not publishing the flight for those dates. Entries are
  // either absolute "YYYY-MM-DD" or relative "+N" (= today + N days, UTC),
  // so tests with dynamic dates can script schedule gaps.
  unscheduled_days?: string[];
  // When true, /schedules returns two instances per day for this ident —
  // ambiguous published schedule; the authorizer must fail closed.
  schedules_duplicate?: boolean;
  // When set, /flights builds scheduled_in as (now + offset) instead of the
  // requested date's 11:00Z — lets real-chain E2E tests place a flight's
  // schedule in the past so the fetcher's watch window (ETA − 6h) and
  // landed gate (ETA + 1h) open immediately, regardless of wall clock.
  // scheduled_out tracks 3h earlier; actual_* derive from these as usual.
  sched_in_offset_secs?: number;
  // Absolute variant (unix seconds) — takes precedence over the offset.
  // Real-chain tests pin this to a value the on-chain oracle accepts
  // (date ≤ eta ≤ date+3d) and reuse the SAME value across the buy-day
  // and flight-day phases so the mock's actual_in stays consistent with
  // the ETA already written on-chain.
  sched_in_epoch_secs?: number;
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

interface AeroApiScheduledFlight {
  ident: string;
  ident_icao: string | null;
  ident_iata: string | null;
  actual_ident: string | null;
  scheduled_out: string;
  scheduled_in: string;
  origin: string;
  destination: string;
  fa_flight_id: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Runtime scenario overrides (POST /__scenarios) — merged over the file on
// every request, cleared by /__reset. Lets a test register fresh idents and
// flip an ident's outcome mid-test (e.g. healthy at purchase time, cancelled
// by the time the fetcher looks) without touching the committed fixture.
let scenarioOverrides: Scenarios = {};

function loadScenarios(): Scenarios {
  const raw = readFileSync(join(__dirname, "..", "scenarios.json"), "utf-8");
  return { ...JSON.parse(raw), ...scenarioOverrides };
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

/** Match an ICAO-or-IATA airport filter against a scenario airport code. */
function airportMatches(filter: string, code: string): boolean {
  return (
    filter === code ||
    filter === code.replace(/^K/, "") ||
    `K${filter}` === code
  );
}

/** Split "UA100"/"UAL100" into airline + number; null if not that shape. */
function parseIdent(ident: string): { airline: string; flightNumber: string } | null {
  const m = ident.match(/^([A-Z]{2,3})(\d{1,4})$/);
  if (!m) return null;
  return { airline: m[1], flightNumber: m[2] };
}

function buildFlight(ident: string, scenario: Scenario, dateParam: string | undefined): AeroApiFlight {
  const flightDate = dateParam ?? new Date().toISOString().slice(0, 10);
  const origin = scenario.origin ?? "KJFK";
  const destination = scenario.destination ?? "KLAX";

  // Base times: departure 08:00 UTC, scheduled arrival 11:00 UTC — unless
  // the scenario pins the schedule relative to NOW (sched_in_offset_secs).
  let scheduledOut = `${flightDate}T08:00:00Z`;
  let scheduledIn = `${flightDate}T11:00:00Z`;
  if (scenario.sched_in_epoch_secs !== undefined) {
    const inMs = scenario.sched_in_epoch_secs * 1000;
    scheduledIn = new Date(inMs).toISOString();
    scheduledOut = new Date(inMs - 3 * 3600 * 1000).toISOString();
  } else if (scenario.sched_in_offset_secs !== undefined) {
    const inMs = Date.now() + scenario.sched_in_offset_secs * 1000;
    scheduledIn = new Date(inMs).toISOString();
    scheduledOut = new Date(inMs - 3 * 3600 * 1000).toISOString();
  }
  const scheduledMs = new Date(scheduledIn).getTime();

  let status: string;
  let cancelled = false;
  let diverted = false;
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
    case "diverted": {
      // Landed — but at the diversion airport. actual_in is set (that is
      // exactly the trap: naive code would attest a normal landing).
      const delayMinutes = scenario.delay_minutes ?? 45;
      const actualMs = scheduledMs + delayMinutes * 60 * 1000;
      actualIn = new Date(actualMs).toISOString();
      actualOut = `${flightDate}T08:05:00Z`;
      arrivalDelay = delayMinutes * 60;
      departureDelay = 300;
      diverted = true;
      status = "Diverted";
      progressPercent = 100;
      break;
    }
    case "tracking_lost": {
      // The cancelled=true / non-cancelled-status combination from the spec:
      // "no longer being tracked ... but that will not always be the case".
      cancelled = true;
      status = "result unknown";
      progressPercent = null;
      break;
    }
    case "scheduled": {
      // Published schedule only — nothing has happened yet.
      status = "Scheduled";
      progressPercent = 0;
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
    diverted,
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

// Call counters — lets tests assert the executors' API call economy.
const stats = {
  flights: 0,
  schedules: 0,
  airport_delays: 0,
  byIdent: {} as Record<string, number>,
};

app.get("/flights/:ident", (req, res) => {
  const { ident } = req.params;
  const startParam = req.query.start as string | undefined;
  const dateParam = startParam?.slice(0, 10);

  stats.flights++;
  stats.byIdent[ident] = (stats.byIdent[ident] ?? 0) + 1;

  const scenarios = loadScenarios();
  const scenario = scenarios[ident];

  if (scenario?.error) {
    console.log(`[mock-aeroapi] GET /flights/${ident} → HTTP ${scenario.error} (scripted)`);
    res.status(scenario.error).json({
      title: "Mock error",
      reason: "SCRIPTED",
      detail: `scenarios.json configured error=${scenario.error} for ${ident}`,
      status: scenario.error,
    });
    return;
  }

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

// Published-schedule window — the far-horizon complement to /flights.
// Mirrors GET /schedules/{date_start}/{date_end}: date_end is EXCLUSIVE,
// filters airline + flight_number (+ origin/destination). Every scenario
// ident is "published" for every requested day unless listed in its
// unscheduled_days; schedules_duplicate doubles each day's rows.
app.get("/schedules/:date_start/:date_end", (req, res) => {
  const { date_start, date_end } = req.params;
  const airline = req.query.airline as string | undefined;
  const flightNumber = req.query.flight_number as string | undefined;
  const originFilter = req.query.origin as string | undefined;
  const destinationFilter = req.query.destination as string | undefined;

  stats.schedules++;

  const startMs = new Date(`${date_start.slice(0, 10)}T00:00:00Z`).getTime();
  const endMs = new Date(`${date_end.slice(0, 10)}T00:00:00Z`).getTime();

  const scenarios = loadScenarios();
  const rows: AeroApiScheduledFlight[] = [];

  for (const [ident, scenario] of Object.entries(scenarios)) {
    const parsed = parseIdent(ident);
    if (airline && parsed?.airline !== airline) continue;
    if (flightNumber && parsed?.flightNumber !== flightNumber) continue;

    const origin = scenario.origin ?? "KJFK";
    const destination = scenario.destination ?? "KLAX";
    if (originFilter && !airportMatches(originFilter, origin)) continue;
    if (destinationFilter && !airportMatches(destinationFilter, destination)) continue;

    const unscheduled = new Set(
      (scenario.unscheduled_days ?? []).map((d) => {
        if (!d.startsWith("+")) return d;
        const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
        return new Date(todayMs + Number(d.slice(1)) * 86_400_000)
          .toISOString()
          .slice(0, 10);
      })
    );

    for (let ms = startMs; ms < endMs; ms += 86_400_000) {
      const day = new Date(ms).toISOString().slice(0, 10);
      if (unscheduled.has(day)) continue;

      const row: AeroApiScheduledFlight = {
        ident,
        ident_icao: ident,
        ident_iata: ident,
        actual_ident: null,
        scheduled_out: `${day}T08:00:00Z`,
        scheduled_in: `${day}T11:00:00Z`,
        origin,
        destination,
        fa_flight_id: null,
      };
      rows.push(row);
      if (scenario.schedules_duplicate) rows.push({ ...row });
    }
  }

  console.log(
    `[mock-aeroapi] GET /schedules/${date_start}..${date_end}` +
      `${airline ? ` airline=${airline}` : ""}${flightNumber ? ` fn=${flightNumber}` : ""}` +
      ` → ${rows.length} row(s)`
  );

  res.json({ scheduled: rows, links: null, num_pages: 1 });
});

// Airport-wide delay conditions — feeds the gov_signals collector. Edit
// airport_delays.json while running to script conditions; missing file =
// empty feed.
app.get("/airports/delays", (_req, res) => {
  stats.airport_delays++;
  let delays: unknown[] = [];
  try {
    delays = JSON.parse(readFileSync(join(__dirname, "..", "airport_delays.json"), "utf-8"));
  } catch {
    /* no file → no delays */
  }
  console.log(`[mock-aeroapi] GET /airports/delays → ${delays.length} airport(s)`);
  res.json({ delays, links: null, num_pages: 1 });
});

// Test instrumentation — call counters for API-economy assertions.
// `instance` echoes MOCK_INSTANCE so a harness can verify it is talking to
// the process IT spawned, not a stale survivor squatting on the port.
app.get("/__stats", (_req, res) => {
  res.json({ ...stats, instance: process.env.MOCK_INSTANCE ?? null });
});
app.post("/__reset", (_req, res) => {
  stats.flights = 0;
  stats.schedules = 0;
  stats.airport_delays = 0;
  stats.byIdent = {};
  scenarioOverrides = {};
  res.json({ ok: true });
});
// Runtime scenario registration/override — body is a Scenarios map, merged
// over any previous overrides (which are merged over the file).
app.post("/__scenarios", express.json(), (req, res) => {
  scenarioOverrides = { ...scenarioOverrides, ...(req.body as Scenarios) };
  console.log(`[mock-aeroapi] scenario overrides: ${Object.keys(scenarioOverrides).join(", ")}`);
  res.json({ ok: true, overrides: Object.keys(scenarioOverrides) });
});

app.listen(PORT, () => {
  const scenarios = loadScenarios();
  const count = Object.keys(scenarios).length;
  console.log(`[mock-aeroapi] listening on http://localhost:${PORT}`);
  console.log(`[mock-aeroapi] ${count} scenarios loaded: ${Object.keys(scenarios).join(", ")}`);
});
