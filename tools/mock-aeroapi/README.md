# Mock AeroAPI Server

Local Express server that returns FlightAware AeroAPI-shaped responses for cron-job testing. No real API key needed.

## Quick start

```bash
cd tools/mock-aeroapi
npm install
npm run dev     # hot-reload
# or
npm start       # single run
```

Server runs on `http://localhost:3001` (override with `PORT` env var).

## Usage

```bash
# On-time flight
curl http://localhost:3001/flights/AA100

# Delayed flight (3 hours)
curl http://localhost:3001/flights/UAL456

# Cancelled flight
curl http://localhost:3001/flights/DL789

# En-route flight (still in air)
curl http://localhost:3001/flights/SW333

# Diverted flight (diverted=true, actual_in set — the naive-landing trap)
curl http://localhost:3001/flights/DIV555

# Tracking lost (cancelled=true but status is NOT "Cancelled" — per the
# AeroAPI spec the flag alone is not proof of an airline cancellation)
curl http://localhost:3001/flights/LOST666

# Future flight (published schedule only, no actuals)
curl http://localhost:3001/flights/FUT111

# Scripted HTTP error (retry-path testing)
curl http://localhost:3001/flights/ERR500

# Unknown flight (empty flights array)
curl http://localhost:3001/flights/FAKE999

# With date param (uses date for timestamps)
curl 'http://localhost:3001/flights/AA100?start=2026-03-20T00:00:00Z&end=2026-03-20T23:59:59Z'

# Published-schedule window (far-horizon sale authorizer; date_end exclusive)
curl 'http://localhost:3001/schedules/2026-03-20/2026-03-23?airline=AA&flight_number=100'

# Call counters (API-economy assertions in tests) + reset
curl http://localhost:3001/__stats
curl -X POST http://localhost:3001/__reset
```

## Scenarios

Edit `scenarios.json` to add or modify flights:

```json
{
  "AA100": { "outcome": "on_time" },
  "UAL456": { "outcome": "delayed", "delay_minutes": 180 },
  "DL789": { "outcome": "cancelled" },
  "SW333": { "outcome": "en_route" }
}
```

Supported outcomes: `on_time`, `delayed`, `cancelled`, `en_route`,
`diverted`, `tracking_lost`, `scheduled`.

Optional fields per scenario: `delay_minutes` (default 180), `origin`,
`destination`, `aircraft_type`, `duplicate` (two records → ambiguity),
`error` (respond with this HTTP status), `unscheduled_days` (days missing
from `/schedules`; `"YYYY-MM-DD"` or relative `"+N"` = today+N),
`schedules_duplicate` (two schedule rows per day → ambiguity).

Scenarios are re-read on every request — edit the file while the server is running to change behavior.

## Tests

```bash
bash test.sh
```

Starts the server on a test port, curls all scenarios, asserts key fields, and reports pass/fail.
