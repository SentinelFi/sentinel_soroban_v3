import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/status/version — what commit production is ACTUALLY running.
 *
 * Exists because "merged" and "deployed" are independent here: the live
 * project deploys only from an explicit `vercel --prod` (or the deploy
 * workflow), while the Vercel check on every PR belongs to a DIFFERENT
 * project. Production once sat 11 commits behind `main` for four days with
 * every signal looking green.
 *
 * The frontend bundle carries the same commit (see `resolveCommitSha` in
 * vite.config.ts), but a bundle constant cannot be diffed by CI. This can:
 * the drift check compares it against the head of `main` and fails when
 * they diverge.
 *
 * Never cached — a stale answer here defeats the entire purpose.
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Vercel sets VERCEL_GIT_COMMIT_SHA only on its own git-triggered builds;
  // COMMIT_SHA is what the deploy workflow injects. `||` not `??`: a CLI
  // deploy sets the Vercel var to an empty string, which `??` passes through.
  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || "unknown";

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    commit,
    short: commit === "unknown" ? "unknown" : commit.slice(0, 7),
    env: process.env.VERCEL_ENV ?? "unknown",
    deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    built_at: process.env.VERCEL_DEPLOYMENT_CREATED_AT ?? null,
    as_of: new Date().toISOString(),
  });
}
