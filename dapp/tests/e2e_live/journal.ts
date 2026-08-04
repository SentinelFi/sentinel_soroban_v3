/**
 * Append-only run journal (JSONL) + run state machine (state.json).
 *
 * The journal is the "expected" side of every reconciliation assertion:
 * each harness action lands here at action time with tx hashes and
 * expectations; `check` appends observations; `report` replays the lot.
 * Timeline truth comes from chain events + DB cron_runs — journal
 * timestamps only order the harness's own actions.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { RUNS_DIR } from "./config.js";

export type EntryKind = "action" | "expectation" | "observation" | "check" | "screenshot" | "note";

export interface JournalEntry {
  at: string; // ISO
  kind: EntryKind;
  actor?: string;
  event: string;
  data?: Record<string, unknown>;
}

export type RunPhase =
  | "created"
  | "preflight_ok"
  | "actors_ready"
  | "underwriting"
  | "buying"
  | "soaking"
  | "reported";

export interface RunState {
  runId: string;
  phase: RunPhase;
  startedAt: string;
  soakEndsAt?: string;
  eventCursor?: string; // rpc getEvents paging cursor
  buysPlaced: number;
  buysPlanned: number;
  /** actor -> per-actor progress markers (deposits done, policies bought…) */
  progress: Record<string, Record<string, unknown>>;
}

export class Journal {
  readonly dir: string;
  readonly shotsDir: string;
  private readonly journalPath: string;
  private readonly statePath: string;

  constructor(readonly runId: string) {
    this.dir = join(RUNS_DIR, runId);
    this.shotsDir = join(this.dir, "shots");
    mkdirSync(this.shotsDir, { recursive: true });
    this.journalPath = join(this.dir, "journal.jsonl");
    this.statePath = join(this.dir, "state.json");
  }

  append(kind: EntryKind, event: string, data?: Record<string, unknown>, actor?: string): void {
    const entry: JournalEntry = { at: new Date().toISOString(), kind, event, ...(actor && { actor }), ...(data && { data }) };
    appendFileSync(this.journalPath, JSON.stringify(entry) + "\n");
  }

  entries(): JournalEntry[] {
    if (!existsSync(this.journalPath)) return [];
    return readFileSync(this.journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JournalEntry);
  }

  state(): RunState {
    return JSON.parse(readFileSync(this.statePath, "utf8")) as RunState;
  }

  saveState(s: RunState): void {
    writeFileSync(this.statePath, JSON.stringify(s, null, 2));
  }

  static create(buysPlanned: number, soakHours: number): Journal {
    const runId = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const j = new Journal(runId);
    j.saveState({
      runId,
      phase: "created",
      startedAt: new Date().toISOString(),
      soakEndsAt: new Date(Date.now() + soakHours * 3600_000).toISOString(),
      buysPlaced: 0,
      buysPlanned,
      progress: {},
    });
    j.append("note", "run created", { buysPlanned, soakHours });
    return j;
  }

  static latest(): Journal | null {
    if (!existsSync(RUNS_DIR)) return null;
    const runs = readdirSync(RUNS_DIR)
      .filter((d) => existsSync(join(RUNS_DIR, d, "state.json")))
      .sort();
    const last = runs[runs.length - 1];
    return last ? new Journal(last) : null;
  }

  static open(runId?: string): Journal {
    const j = runId ? new Journal(runId) : Journal.latest();
    if (!j || !existsSync(join(j.dir, "state.json"))) {
      throw new Error(runId ? `no run ${runId}` : "no runs yet — use `start`");
    }
    return j;
  }
}
