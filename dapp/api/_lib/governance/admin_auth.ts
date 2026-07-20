import type { VercelRequest } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * Admin authentication for the governance API routes.
 *
 * The admin UI signs in through Supabase Auth (magic link / Google) and
 * sends the session JWT as `Authorization: Bearer <jwt>`. Server-side we
 * verify the token against Supabase (auth.getUser — a live check, not
 * just a signature check) and then gate on the ADMIN_EMAILS allowlist.
 * Supabase Auth is used ONLY for identity: data access stays on the
 * deny-all pooler connection, and actions_log records which admin acted.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (publishable key), ADMIN_EMAILS
 * (comma-separated, case-insensitive).
 */

export interface AdminIdentity {
  email: string;
}

export async function verifyAdmin(req: VercelRequest): Promise<AdminIdentity | null> {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return null;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing required env vars: SUPABASE_URL / SUPABASE_ANON_KEY");
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.email) return null;

  const allowlist = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = data.user.email.toLowerCase();
  return allowlist.includes(email) ? { email } : null;
}
