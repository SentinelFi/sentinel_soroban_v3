/**
 * Self-contained HTML report — template literals, screenshots inlined
 * base64 (downscaled not attempted — soak shots are small), no deps.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { LiveConfig } from "../config.js";
import type { Journal } from "../journal.js";
import { reconcile, type Verdict } from "./reconcile.js";

const BADGE: Record<Verdict, string> = {
  pass: "#22c55e",
  fail: "#ef4444",
  conditional: "#eab308",
  info: "#3b82f6",
};

function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function buildReport(cfg: LiveConfig, j: Journal): Promise<string> {
  const r = await reconcile(cfg, j);
  const state = j.state();
  const entries = j.entries();
  const shots = entries.filter((e) => e.kind === "screenshot");

  const shotImgs = shots
    .map((s) => {
      const p = s.event;
      if (!existsSync(p)) return "";
      const b64 = readFileSync(p).toString("base64");
      return `<figure><img src="data:image/png;base64,${b64}" loading="lazy"/><figcaption>${esc(s.actor ?? "")} ${esc(p.split("/").pop())}</figcaption></figure>`;
    })
    .join("\n");

  const findingRows = r.findings
    .map(
      (f) =>
        `<tr><td>${esc(f.section)}</td><td>${esc(f.name)}</td><td><span class="badge" style="background:${BADGE[f.verdict]}">${f.verdict}</span></td><td>${esc(f.detail)}</td></tr>`,
    )
    .join("\n");

  const ledgerRows = r.ledgers
    .map(
      (l) =>
        `<tr class="${l.exact ? "" : "bad"}"><td>${l.actor}</td><td>${l.role}</td><td>${l.mintedUsdc}</td><td>${l.depositsUsdc}</td><td>${l.premiumsUsdc}</td><td>${l.collectedUsdc.toFixed(2)}</td><td>${l.claimsUsdc}</td><td>${l.expectedFinalUsdc.toFixed(2)}</td><td>${l.chainFinalUsdc.toFixed(2)}</td><td>${l.exact ? "✓" : "✗"}</td></tr>`,
    )
    .join("\n");

  const timelineBlocks = r.flightTimelines
    .map(
      (t) => `<details><summary>${esc(t.flight)} — ${esc(t.actor)} (${t.entries.length} entries)</summary><pre>${esc(
        t.entries.map((e) => `${e.at} [${e.kind}] ${e.event} ${JSON.stringify(e.data ?? {})}`).join("\n"),
      )}</pre></details>`,
    )
    .join("\n");

  const cronRows = r.cronGrid
    ? Object.entries(r.cronGrid)
        .map(([job, n]) => `<tr><td>${esc(job)}</td><td>${n}</td></tr>`)
        .join("\n")
    : "<tr><td colspan=2>DB unavailable</td></tr>";

  const html = `<!doctype html><meta charset="utf-8"><title>soak ${esc(state.runId)}</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#111}
h1,h2{border-bottom:2px solid #eee;padding-bottom:.3rem}
table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{border:1px solid #ddd;padding:.35rem .6rem;text-align:left;font-size:13px}
tr.bad{background:#fee2e2}
.badge{color:#fff;padding:.1rem .5rem;border-radius:4px;font-size:12px}
.tally{font-size:1.2rem;margin:1rem 0}
figure{display:inline-block;margin:.5rem;max-width:320px}
img{max-width:100%;border:1px solid #ccc}
figcaption{font-size:11px;color:#666}
pre{background:#f7f7f7;padding:.6rem;overflow-x:auto;font-size:11px}
</style>
<h1>Soak run ${esc(state.runId)}</h1>
<p>phase <b>${esc(state.phase)}</b> · started ${esc(state.startedAt)} · window ends ${esc(state.soakEndsAt)} · buys ${state.buysPlaced}/${state.buysPlanned}</p>
<p class="tally">✓ ${r.checks.passed} passed · ✗ ${r.checks.failed} failed · ○ ${r.checks.conditional} conditional</p>
<h2>Config fingerprint</h2>
<pre>${esc(JSON.stringify({ app: cfg.appUrl, rpc: cfg.rpcUrl, contracts: cfg.contracts }, null, 2))}</pre>
<h2>Assertions matrix</h2>
<table><tr><th>section</th><th>assertion</th><th>verdict</th><th>detail</th></tr>${findingRows}</table>
<h2>Per-actor ledgers (USDC)</h2>
<table><tr><th>actor</th><th>role</th><th>minted</th><th>deposits</th><th>premiums</th><th>collected</th><th>claims</th><th>expected final</th><th>chain final</th><th>exact</th></tr>${ledgerRows}</table>
<h2>Per-flight timelines</h2>
${timelineBlocks || "<p>no buys yet</p>"}
<h2>Cron runs during window</h2>
<table><tr><th>job</th><th>runs</th></tr>${cronRows}</table>
<h2>Screenshot gallery</h2>
${shotImgs || "<p>none</p>"}
<h2>Raw journal (${entries.length} entries)</h2>
<details><summary>expand</summary><pre>${esc(entries.map((e) => JSON.stringify(e)).join("\n"))}</pre></details>
`;
  const out = join(j.dir, "report.html");
  writeFileSync(out, html);
  return out;
}
