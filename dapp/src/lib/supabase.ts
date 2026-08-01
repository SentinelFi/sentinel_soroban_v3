import { createClient } from "@supabase/supabase-js"

/**
 * Browser Supabase client — ADMIN IDENTITY ONLY. The anon key can read
 * nothing (RLS deny-all, zero policies); it exists so /admin can sign in
 * and hand its JWT to the server-side api/admin/* routes, which do the
 * actual work over the pooler connection.
 */

const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined
const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined

export const supabase =
	url && key
		? createClient(url, key, {
				auth: {
					// The admin JWT is the whole credential for api/admin/*.
					// sessionStorage keeps it out of the long-lived
					// localStorage surface: it survives reloads but dies with
					// the tab. Trade-off: the magic-link tab gets the session
					// (Supabase detects it from the URL there) but other
					// already-open tabs won't — admins work in the link's tab.
					storage: window.sessionStorage,
				},
			})
		: null
