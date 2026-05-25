/**
 * Unit test: verify ring buffer (run_log) push, eviction, and health.
 * No external dependencies — runs standalone.
 *
 * Usage: npx tsx src/test_run_log.ts
 */

import { logRun, getLogs, getHealth } from "./run_log.js";
import type { RunLogEntry } from "./types.js";

let pass = 0;
let fail = 0;

function assert(label: string, expected: any, actual: any) {
  if (String(expected) === String(actual)) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label} — expected '${expected}', got '${actual}'`);
    fail++;
  }
}

function makeEntry(job: RunLogEntry["job"], n: number): RunLogEntry {
  const nn = n < 10 ? `0${n}` : `${n}`;
  return {
    timestamp: `2026-01-01T00:00:${nn}Z`,
    job,
    duration_ms: n * 100,
    success: true,
  };
}

// ── Test 1: Empty state ──────────────────────────────────────────
console.log("=== Test: empty state ===");
const logs = getLogs();
assert("fetcher empty", 0, logs.fetcher.length);
assert("classifier empty", 0, logs.classifier.length);
assert("settler empty", 0, logs.settler.length);
assert("queue_maintainer empty", 0, logs.queue_maintainer.length);
assert("ttl_extender empty", 0, logs.ttl_extender.length);

const health = getHealth();
assert("health fetcher null", null, health.last_run.fetcher);
assert("health classifier null", null, health.last_run.classifier);
assert("health queue_maintainer null", null, health.last_run.queue_maintainer);
assert("health uptime >= 0", true, health.uptime_seconds >= 0);
assert("health started_at present", true, health.started_at.length > 0);

// ── Test 2: Push a single entry ──────────────────────────────────
console.log("\n=== Test: push single entry ===");
logRun(makeEntry("fetcher", 1));
assert("fetcher has 1", 1, getLogs().fetcher.length);
assert("classifier still 0", 0, getLogs().classifier.length);
assert(
  "health last_run fetcher set",
  "2026-01-01T00:00:01Z",
  getHealth().last_run.fetcher?.timestamp,
);

// ── Test 3: Push multiple entries to same job ────────────────────
console.log("\n=== Test: push 3 entries ===");
logRun(makeEntry("fetcher", 2));
logRun(makeEntry("fetcher", 3));
assert("fetcher has 3", 3, getLogs().fetcher.length);
assert(
  "last entry is #3",
  "2026-01-01T00:00:03Z",
  getHealth().last_run.fetcher?.timestamp,
);

// ── Test 4: Ring buffer eviction at 10 ──────────────────────────
console.log("\n=== Test: ring buffer caps at 10 ===");
for (let i = 4; i <= 12; i++) {
  logRun(makeEntry("classifier", i));
}
// classifier should have 9 entries (i=4..12)
assert("classifier has 9", 9, getLogs().classifier.length);

// Push 2 more to go over 10
logRun(makeEntry("classifier", 13));
assert("classifier capped at 10", 10, getLogs().classifier.length);

logRun(makeEntry("classifier", 14));
assert("still 10 after overflow", 10, getLogs().classifier.length);

// Oldest should now be entry #5 (first 4 evicted: #4 was evicted when #14 pushed)
assert(
  "oldest is #5",
  "2026-01-01T00:00:05Z",
  getLogs().classifier[0].timestamp,
);
assert(
  "newest is #14",
  "2026-01-01T00:00:14Z",
  getLogs().classifier[9].timestamp,
);

// ── Test 5: Independent buffers (incl. queue_maintainer added in Phase 12) ──
console.log("\n=== Test: buffers are independent ===");
logRun(makeEntry("settler", 1));
logRun(makeEntry("queue_maintainer", 1));
logRun(makeEntry("ttl_extender", 1));
assert("settler has 1", 1, getLogs().settler.length);
assert("queue_maintainer has 1", 1, getLogs().queue_maintainer.length);
assert("ttl_extender has 1", 1, getLogs().ttl_extender.length);
assert("fetcher unchanged at 3", 3, getLogs().fetcher.length);

// ── Test 6: Health reports all jobs ──────────────────────────────
console.log("\n=== Test: health reports last run per job ===");
const h = getHealth();
assert("fetcher last set", true, h.last_run.fetcher !== null);
assert("classifier last set", true, h.last_run.classifier !== null);
assert("settler last set", true, h.last_run.settler !== null);
assert("queue_maintainer last set", true, h.last_run.queue_maintainer !== null);
assert("ttl_extender last set", true, h.last_run.ttl_extender !== null);

// ── Results ──────────────────────────────────────────────────────
console.log(`\n==============================`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log("SOME TESTS FAILED");
  process.exit(1);
}
