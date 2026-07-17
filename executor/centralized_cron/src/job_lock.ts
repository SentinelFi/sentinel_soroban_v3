import type { JobName, RunLogEntry } from "./types.js";

// Single-flight guard per job. A job instance that is still running — a slow
// scheduled tick, an HTTP trigger, or both overlapping — must not be started
// again concurrently: overlapping runs double AeroAPI usage, race the same
// role key's transaction sequence (the per-account lock serializes them but
// they still queue and burn fees), and interleave their log output. Cron
// callbacks skip the tick; the HTTP server answers 409.
const running = new Set<JobName>();

export function isJobRunning(job: JobName): boolean {
  return running.has(job);
}

/**
 * Run `fn` unless the same job is already in flight, in which case return
 * `null` without running it. The guard is keyed by job name, not by trigger
 * source, so a manual trigger cannot overlap a scheduled run either.
 */
export async function tryRunExclusive(
  job: JobName,
  fn: () => Promise<RunLogEntry>
): Promise<RunLogEntry | null> {
  if (running.has(job)) {
    return null;
  }
  running.add(job);
  try {
    return await fn();
  } finally {
    running.delete(job);
  }
}
