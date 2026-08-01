/**
 * Local /api dev server — mounts every api/**\/*.ts handler (excluding
 * _lib/) as a plain HTTP route, invoked the same way Vercel's Node
 * runtime would: `export default handler(req, res)`.
 *
 * Exists because `vercel dev` does not correctly execute these functions
 * in this repo — it always falls through to the Vite dev-command proxy
 * instead of routing /api/** to the function runtime (confirmed on
 * Vercel CLI 58.4.0: requests return the handler's transpiled source
 * instead of running it). This script replaces that dependency entirely.
 *
 * `vite.config.ts`'s `server.proxy` forwards /api/* here from the main
 * `npm run dev` (port 5175) instance — see README "Run locally".
 *
 *   npm run dev:api            # serves on :3000 (or $PORT)
 */
import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { readdirSync, statSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadDotEnv } from "./env";

loadDotEnv(); // dapp/.env; real env vars always win

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../api");
const PORT = Number(process.env.PORT) || 3000;

type Handler = (req: VercelRequest, res: VercelResponse) => unknown;

function collectRoutes(dir: string, base = ""): Map<string, string> {
  const routes = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    if (entry === "_lib") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [route, file] of collectRoutes(full, `${base}/${entry}`)) routes.set(route, file);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    routes.set(`/api${base}/${entry.slice(0, -3)}`, full);
  }
  return routes;
}

const routes = collectRoutes(API_DIR);
console.log(
  `[dev:api] ${routes.size} routes:\n${[...routes.keys()]
    .sort()
    .map((r) => `  ${r}`)
    .join("\n")}`,
);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => res(data));
    req.on("error", reject);
  });
}

async function toVercelRequest(req: IncomingMessage): Promise<VercelRequest> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  const raw = await readBody(req);
  let body: unknown = raw;
  if (raw && (req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      body = JSON.parse(raw);
    } catch {
      // leave as raw text — the handler's own validation will reject it
    }
  }
  return Object.assign(req, { query, body, cookies: {} }) as unknown as VercelRequest;
}

function toVercelResponse(res: ServerResponse): VercelResponse {
  const vres = res as unknown as VercelResponse;
  vres.status = (code: number) => {
    res.statusCode = code;
    return vres;
  };
  vres.json = (body: unknown) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
    return vres;
  };
  vres.send = (body: unknown) => {
    res.end(typeof body === "string" ? body : JSON.stringify(body));
    return vres;
  };
  return vres;
}

const server = createServer((req, res) => {
  void (async () => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = routes.get(pathname);
    if (!file) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: `No route for ${pathname}` }));
      return;
    }
    try {
      // Cache-bust on mtime so edits are picked up without restarting.
      const mod: { default: Handler } = await import(
        `${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`
      );
      const vreq = await toVercelRequest(req);
      const vres = toVercelResponse(res);
      await mod.default(vreq, vres);
    } catch (err) {
      console.error(`[dev:api] ${pathname} threw:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
  })();
});

server.listen(PORT, () => {
  console.log(`[dev:api] listening on http://localhost:${PORT}`);
});
