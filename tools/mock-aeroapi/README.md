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

# Unknown flight (empty flights array)
curl http://localhost:3001/flights/FAKE999

# With date param (uses date for timestamps)
curl 'http://localhost:3001/flights/AA100?start=2026-03-20T00:00:00Z&end=2026-03-20T23:59:59Z'
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

Supported outcomes: `on_time`, `delayed`, `cancelled`, `en_route`.

Optional fields per scenario: `delay_minutes` (default 180), `origin`, `destination`, `aircraft_type`.

Scenarios are re-read on every request — edit the file while the server is running to change behavior.

## Tests

```bash
bash test.sh
```

Starts the server on a test port, curls all scenarios, asserts key fields, and reports pass/fail.
