import type { JobName, RunLogEntry, HealthStatus } from "./types.js";

const MAX_ENTRIES = 10;

const buffers: Record<JobName, RunLogEntry[]> = {
  sale_authorizer: [],
  fetcher: [],
  classifier: [],
  settler: [],
  queue_maintainer: [],
  ttl_extender: [],
};

const startedAt = new Date();

export function logRun(entry: RunLogEntry): void {
  const buf = buffers[entry.job];
  buf.push(entry);
  if (buf.length > MAX_ENTRIES) buf.shift();
}

export function getLogs(): Record<JobName, RunLogEntry[]> {
  return buffers;
}

export function getHealth(): HealthStatus {
  const uptimeMs = Date.now() - startedAt.getTime();
  return {
    uptime_seconds: Math.floor(uptimeMs / 1000),
    started_at: startedAt.toISOString(),
    last_run: {
      sale_authorizer: buffers.sale_authorizer.at(-1) ?? null,
      fetcher: buffers.fetcher.at(-1) ?? null,
      classifier: buffers.classifier.at(-1) ?? null,
      settler: buffers.settler.at(-1) ?? null,
      queue_maintainer: buffers.queue_maintainer.at(-1) ?? null,
      ttl_extender: buffers.ttl_extender.at(-1) ?? null,
    },
  };
}
