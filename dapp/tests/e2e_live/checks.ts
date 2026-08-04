/**
 * journalCheck — the shared check() (scripts/e2e/harness.ts) plus a
 * journal append, so every assertion lands in both the console tally
 * and the run's evidence trail. Conditional/skipped checks (outcome
 * didn't occur, whitelist off, …) are first-class: they render in the
 * report as "conditional", never as failures.
 */
import { check, results, summarize } from "../../scripts/e2e/harness.js";
import type { Journal } from "./journal.js";

export { results, summarize };

export function journalCheck(j: Journal, name: string, ok: boolean, detail?: string): void {
  check(name, ok, detail);
  j.append("check", name, { ok, ...(detail ? { detail } : {}) });
}

export function journalSkip(j: Journal, name: string, reason: string): void {
  console.log(`  ○ ${name} — conditional: ${reason}`);
  j.append("check", name, { ok: true, skipped: true, reason });
}
