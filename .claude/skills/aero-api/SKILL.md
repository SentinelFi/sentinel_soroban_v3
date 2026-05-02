---
description: AeroAPI reference for flight status fetching. Trigger when writing HTTP calls to FlightAware AeroAPI, parsing flight status responses, deriving OnTime/Delayed/Cancelled outcomes, or working on the CRE workflow HTTP fetch section.
---

# Skill: AeroAPI — Flight Status

## Layer 1 — Quick Reference (always read this)

**Base URL:** `https://aeroapi.flightaware.com/aeroapi`
**Auth header:** `x-apikey: <value>` — never a username, always this header

### The one endpoint we use

```
GET /flights/{ident}?start={date}T00:00:00Z&end={date}T23:59:59Z
Header: x-apikey: <AEROAPI_KEY>
```

`ident` = ICAO callsign e.g. `AA123`, `UAL1211`. IATA format also resolves.

### The 5 fields that matter

| Field | Type | What it means |
|---|---|---|
| `cancelled` | boolean | Flight cancelled — treat same as Delayed for payout |
| `status` | string | Human-readable: `"Landed"`, `"En Route"`, `"Scheduled"`, `"Cancelled"` |
| `actual_in` | string \| null | Actual gate arrival time (ISO 8601 UTC). Null = not yet arrived |
| `scheduled_in` | string \| null | Scheduled gate arrival time (ISO 8601 UTC) |
| `arrival_delay` | number \| null | Arrival delay in **seconds** (negative = early) |

### Status derivation — 45-minute threshold

```typescript
const DELAY_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes

function deriveStatus(data: AeroApiResponse, flightDate: bigint): FlightStatus {
  const flights = data.flights;
  if (!flights || flights.length === 0) return FlightStatus.Unknown;

  const flight    = flights[flights.length - 1]; // most recent entry
  const scheduled = new Date(flight.scheduled_in).getTime();
  const actual    = flight.actual_in
    ? new Date(flight.actual_in).getTime()
    : null;

  if (flight.status === "Cancelled") return FlightStatus.Cancelled;

  if (flight.status === "Landed" && actual !== null) {
    return (actual - scheduled) > DELAY_THRESHOLD_MS
      ? FlightStatus.Delayed
      : FlightStatus.OnTime;
  }

  return FlightStatus.Unknown; // Scheduled / En Route — not final yet, retry next tick
}
```

### Decision table

| AeroAPI state | `deriveStatus` returns | CRE action |
|---|---|---|
| `status = "Cancelled"` | `Cancelled` | Write to OracleAggregator |
| `status = "Landed"`, delay > 45 min | `Delayed` | Write to OracleAggregator |
| `status = "Landed"`, delay ≤ 45 min | `OnTime` | Write to OracleAggregator |
| `status = "En Route"` or `"Scheduled"` | `Unknown` | Skip, retry next tick |
| `flights` array empty or missing | `Unknown` | Skip, retry next tick |
| HTTP error / exception | `Unknown` | Catch silently, retry next tick |

**Never revert on API failure.** Catch all exceptions, leave status as `Unknown`, let the workflow retry on the next 10-minute tick.

---

## Layer 2 — TypeScript types

> Only read this if you need the full `FlightResult` interface or the base client setup.
> Read: `docs/aero_api.md` — section **TypeScript Code Snippets**

Key types defined there: `FlightResult`, `FlightAirportRef`, `FlightsResponse`, `aeroGet<T>()` base client.

---

## Layer 3 — Error handling and status codes

> Only read this if you're handling HTTP errors, 429 rate limits, or 401 auth failures.
> Read: `docs/aero_api.md` — section **Error Responses**

Key statuses: 401 = bad key, 403 = endpoint not on your tier, 404 = flight not found (treat as Unknown), 429 = rate limited.

---

## Layer 4 — Other endpoints

> Only read this if you need airport-level queries, alerts, pagination, or any endpoint other than `GET /flights/{ident}`.
> Read: `docs/aero_api.md` — sections **Airports**, **Alerts**, **Pagination**
