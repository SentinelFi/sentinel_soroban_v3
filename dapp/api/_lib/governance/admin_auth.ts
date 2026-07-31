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

/** Minimal shape of the fields we gate on from a Supabase auth user. */
interface AuthUserLike {
  email?: string | null;
  email_confirmed_at?: string | null;
}

/**
 * Pure allowlist decision, split out so it is unit-testable without a
 * live Supabase call. An identity is admitted only when the account has a
 * CONFIRMED email that is on the ADMIN_EMAILS allowlist.
 *
 * The email_confirmed_at gate (FSA-M02) matters because the allowlist
 * keys on the email string alone: without it, if the Supabase project
 * ever allowed a sign-in method that does not verify email (password
 * signup with confirmation off, say), an attacker could register an
 * allowlisted admin's address and pass. Magic-link and OAuth both set
 * email_confirmed_at, so this never rejects the flows in use today.
 */
export function resolveAdminEmail(
  user: AuthUserLike | null | undefined,
  adminEmailsCsv: string | undefined,
): string | null {
  const email = user?.email?.toLowerCase();
  if (!email || !user?.email_confirmed_at) return null;

  const allowlist = (adminEmailsCsv ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email) ? email : null;
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
  if (error) return null;

  const email = resolveAdminEmail(data.user, process.env.ADMIN_EMAILS);
  return email ? { email } : null;
}
