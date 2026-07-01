/**
 * Test script: verify AeroApiClient parses mock-api responses correctly.
 * Requires `executor/mock-api/` running on localhost:$AEROAPI_BASE_URL.
 *
 * Usage:
 *   AEROAPI_BASE_URL=http://localhost:3099 npx tsx src/test_aeroapi.ts
 *
 * Or via test.sh, which boots the mock-api on a free port and tears it down.
 */

import { AeroApiClient } from "./aeroapi_client.js";

const client = new AeroApiClient({
  aeroApiBaseUrl: process.env.AEROAPI_BASE_URL ?? "http://localhost:3001",
  aeroApiKey: "",
});

let pass = 0;
let fail = 0;

function assert(label: string, expected: any, actual: any) {
  if (String(expected) === String(actual)) {
    console.log(`  PASS: ${label} = ${expected}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label} — expected '${expected}', got '${actual}'`);
    fail++;
  }
}

console.log("=== Test: on_time flight (AA100) ===");
const f1 = await client.getFlightData("AA100", "2026-03-20");
assert("cancelled", false, f1?.cancelled);
assert("actual_in present", true, f1?.actual_in !== null);
// 2026-03-20T11:00:00Z = 1774004400 unix
assert("scheduled_in timestamp", 1774004400n, client.parseTimestamp(f1?.scheduled_in ?? null));
// actual_in should be parseable and earlier than scheduled (5 min early)
const f1_actual = client.parseTimestamp(f1?.actual_in ?? null);
const f1_scheduled = client.parseTimestamp(f1?.scheduled_in ?? null);
assert("arrived early", true, f1_actual < f1_scheduled);

console.log("\n=== Test: delayed flight (UAL456) ===");
const f2 = await client.getFlightData("UAL456", "2026-03-20");
assert("cancelled", false, f2?.cancelled);
assert("actual_in present", true, f2?.actual_in !== null);
const eta = client.parseTimestamp(f2?.scheduled_in ?? null);
const actual = client.parseTimestamp(f2?.actual_in ?? null);
assert("delay = 3hr", 10800n, actual - eta);

console.log("\n=== Test: cancelled flight (DL789) ===");
const f3 = await client.getFlightData("DL789", "2026-03-20");
assert("cancelled", true, f3?.cancelled);
assert("actual_in", null, f3?.actual_in);

console.log("\n=== Test: en_route flight (SW333) ===");
const f4 = await client.getFlightData("SW333", "2026-03-20");
assert("cancelled", false, f4?.cancelled);
assert("actual_in", null, f4?.actual_in);

console.log("\n=== Test: unknown flight ===");
const f5 = await client.getFlightData("FAKE999", "2026-03-20");
assert("result", null, f5);

console.log("\n=== Test: ambiguous (multiple same-day candidates) (DUP777) ===");
// Two candidate records for one ident/day must NOT be silently resolved to one
// — the fetcher returns null so the flight stays unresolved rather than being
// settled against the wrong physical flight.
const f6 = await client.getFlightData("DUP777", "2026-03-20");
assert("ambiguous → null", null, f6);

console.log(`\n==============================`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log("SOME TESTS FAILED");
  process.exit(1);
}
