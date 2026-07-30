import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyAdmin } from "../_lib/governance/admin_auth";
import { getDb } from "../_lib/governance/db";

/**
 * Admin API — the governance freeze switch (ops_flags.gov_frozen).
 *
 * GET  → { frozen, note, updated_at }   (absent row = not frozen)
 * POST → { frozen: boolean, note?: string } — upsert. The interventions
 * executor checks this flag before every automated pause/revive and takes
 * NO action while frozen — the runtime kill switch that, unlike
 * GOV_DRY_RUN, needs no env change or redeploy. Every toggle records the
 * admin email.
 */
/** Optional dependency injection seam — tests pass a fake verifyAdmin, production omits. */
export interface FreezeDeps {
  verifyAdmin?: typeof verifyAdmin;
}

export async function handler(
  req: VercelRequest,
  res: VercelResponse,
  deps: FreezeDeps = {}
): Promise<void> {
  const admin = await (deps.verifyAdmin ?? verifyAdmin)(req);
  if (!admin) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const sql = getDb();

    if (req.method === "GET") {
      const rows = (await sql`
        select value, note, updated_at from ops_flags where key = 'gov_frozen'
      `) as unknown as Array<{ value: boolean; note: string | null; updated_at: string }>;
      res.status(200).json({
        frozen: rows[0]?.value ?? false,
        note: rows[0]?.note ?? null,
        updated_at: rows[0]?.updated_at ?? null,
      });
      return;
    }

    if (req.method === "POST") {
      const { frozen, note } = (req.body ?? {}) as { frozen?: unknown; note?: unknown };
      if (typeof frozen !== "boolean") {
        res.status(400).json({ error: "body must include frozen: boolean" });
        return;
      }
      const stamped = `${typeof note === "string" && note ? note + " — " : ""}${admin.email}`;
      await sql`
        insert into ops_flags (key, value, note, updated_at)
        values ('gov_frozen', ${frozen}, ${stamped}, now())
        on conflict (key) do update
          set value = ${frozen}, note = ${stamped}, updated_at = now()
      `;
      console.log(`[admin-freeze] gov_frozen = ${frozen} by ${admin.email}`);
      res.status(200).json({ frozen, note: stamped });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export default function (req: VercelRequest, res: VercelResponse): Promise<void> {
  return handler(req, res);
}
