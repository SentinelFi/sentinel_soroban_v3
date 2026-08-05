import { Fragment, useEffect, useMemo, useState } from "react"
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query"
import type { Session } from "@supabase/supabase-js"
import { supabase } from "../lib/supabase"
import { errorMessage } from "../lib/utils"
import { isoMinute, relTime, usdFromUnits, utcDateTime } from "../lib/format"
import { explorerTxUrl } from "../lib/explorer"
import { stellarNetwork } from "../contracts/util"
import { useDebouncedValue } from "../hooks/useDebouncedValue"
import { useWallet } from "../hooks/useWallet"
import { stagedSigner, useTxFlow } from "../hooks/useTxFlow"
import { formatUsdc, mockUsdcClient } from "../hooks/useContracts"
import { txHashOf } from "../lib/utils"
import { TxProgress } from "../components/TxProgress"
import type { TxState } from "../types"

/**
 * ROUTE CONTROL — the hidden /admin dispatch tower behind the arcade.
 * Not linked from any nav; ops and admins only.
 *
 * One world: the same pixel departure-board language as the rest of
 * FLIGHTS.FUN (panel/btn-px/board-figure system), pointed inward. The
 * signature is the control-board header: live board figures for the
 * managed fleet with a scanline sweep and a breathing board cursor.
 *
 * Everything here is identity + display; all real work happens in
 * api/admin/* (Supabase JWT → ADMIN_EMAILS allowlist → GovSubmitter
 * pipeline → actions_log). Pauses and revives go through the same
 * interventions executor every automated detector uses — an admin pause
 * is just a ledger row with cause 'admin' that nothing auto-revives.
 */

/* ── plumbing ─────────────────────────────────────────────────────── */

/**
 * Failure that still carries its response body. Most callers only ever
 * read `.message` (errorMessage/String both still work — it IS an
 * Error), but the airport hub control deliberately provokes a 400 to
 * learn its blast radius, and that number lives in the body.
 */
class ApiError extends Error {
	readonly status: number
	readonly body: unknown
	constructor(message: string, status: number, body: unknown) {
		super(message)
		this.name = "ApiError"
		this.status = status
		this.body = body
	}
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(init?.headers ?? {}),
		},
	})
	const body = (await res.json().catch(() => ({}))) as { error?: string }
	if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status, body)
	return body as T
}

const shortTx = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`
/** G… keys are 56 chars; head+tail is what an operator actually matches on. */
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`

/**
 * Account view on the explorer. lib/explorer only exposes tx links, and
 * this is the one page that shows raw G… keys — same network derivation,
 * so a mainnet redeploy moves both together.
 */
const EXPLORER_NETWORK = stellarNetwork === "PUBLIC" ? "public" : "testnet"
const explorerAccountUrl = (address: string) =>
	`https://stellar.expert/explorer/${EXPLORER_NETWORK}/account/${address}`

/* ── API payload types (mirror api/admin/*.ts responses) ──────────── */

interface AdminRoute {
	flight_id: string
	origin: string
	dest: string
	carrier: string | null
	status: string
	pinned: boolean | null
	pin_until: string | null
	base_premium_units: string | null
	base_payoff_units: string | null
	base_delay_hours: number | null
	open_intervention_id: string | null
	open_cause: string | null
	on_chain?: {
		status: string
		terms: { premium: string; payoff: string; delay_hours: number } | null
	}
}

interface RoutesResponse {
	routes: AdminRoute[]
	total: number
	fleet_total: number
	fleet_active: number
}

interface AdminIntervention {
	id: string
	cause: string
	flight_id: string
	origin: string
	dest: string
	evidence: unknown
	opened_by: string
	opened_at: string
	last_checked_at: string
	revived_at: string | null
	revived_by: string | null
}

interface InterventionsResponse {
	rows: AdminIntervention[]
	total: number
	open_count: number
}

/**
 * Cron expression → the sentence an operator actually wants.
 *
 * A raw five-field expression tells you nothing at a glance, and the
 * offset form ("2-59/5 ...") is worse — it reads like a range when it
 * means "every 5 minutes, shifted by 2 so it never collides with the
 * settler". We only write a handful of shapes, so parse those and fall
 * back to
 * the raw string rather than pretending to be a general cron parser. The
 * raw expression stays available on hover — it is the thing you paste into
 * vercel.json, so it must not disappear.
 */
function humanizeCron(expr: string): string {
	const p = expr.trim().split(/\s+/)
	if (p.length !== 5) return expr
	const [min, hour, dom, mon, dow] = p as [string, string, string, string, string]
	const at = (m: string) => (m === "0" ? "" : ` at :${m.padStart(2, "0")}`)

	// every N minutes — plain "*/5" or an offset window "2-59/5"
	const everyMin = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(min)
	if (everyMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
		const n = Number(everyMin[1])
		const offset = /^(\d+)-/.exec(min)
		return `every ${n} min${offset ? ` (offset +${offset[1]})` : ""}`
	}
	// every N hours, on a fixed minute
	const everyHour = /^\*\/(\d+)$/.exec(hour)
	if (everyHour && dom === "*" && mon === "*" && dow === "*") {
		return `every ${everyHour[1]}h${at(min)}`
	}
	if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
		return `hourly${at(min)}`
	}
	if (dom === "*" && mon === "*" && dow === "*") {
		return `daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`
	}
	if (mon === "*" && dow === "*") {
		const nth = dom === "1" ? "1st" : `day ${dom}`
		return `monthly, ${nth} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`
	}
	return expr
}

/** JOB_REGISTRY entry (api/_lib/governance/runs.ts). */
interface JobRegistryEntry {
	job: string
	path: string
	schedule: string
	intervalMinutes: number
	signer: string
	manualRunnable: boolean
	description: string
}

interface JobRun {
	job: string
	trigger: string
	ran_at: string
	duration_ms: number
	success: boolean
	error: string | null
}

interface JobsResponse {
	registry: JobRegistryEntry[]
	latest: JobRun[]
	recent: JobRun[]
	/** cron_runs rows inside the since_hours window, before `limit`. */
	total: number
	limit: number
	since_hours: number
}

interface JobRunResult {
	success: boolean
	duration_ms: number
}

interface AdminOutcome {
	id: string | number
	flight_id: string
	origin: string
	dest: string
	flight_date: string
	outcome: string
	delay_minutes: number | null
	origin_gust_kmh: number | null
	origin_snow_cm: number | null
	origin_precip_prob_pct: number | null
	dest_gust_kmh: number | null
	dest_snow_cm: number | null
	dest_precip_prob_pct: number | null
}

interface OutcomesResponse {
	rows: AdminOutcome[]
	total: number
}

interface AdminAction {
	id: string | number
	ts: string
	actor: string
	action: string
	flight_id: string | null
	origin: string | null
	dest: string | null
	tx_hash: string | null
	success: boolean
}

/** The list view never rendered before/after; the API now omits them
 *  unless ?detail=1, so the row type stays exactly as it was. */
interface ActionsResponse {
	log: AdminAction[]
	total: number
	limit: number
	offset: number
	since_hours: number
}

/** api/admin/balances.ts — one row per operational signing identity. */
interface AdminAccount {
	role: string
	address: string | null
	/** Env var that supplies it — what the operator has to go set. */
	source: string
	configured: boolean
	funded: boolean
	/** Horizon's 7-dp decimal string, or null when we couldn't read it. */
	balance_xlm: string | null
	low: boolean
	error: string | null
}

interface BalancesResponse {
	as_of: string
	horizon_url: string
	low_balance_threshold_xlm: number
	low_count: number
	accounts: AdminAccount[]
}

/** api/admin/airports.ts — the weather verdict per airport + blast radius. */
interface AdminAirport {
	iata: string
	severity: "ok" | "elevated" | "severe"
	extreme: boolean
	max_gust_kmh: number | null
	total_snow_cm: number | null
	/** Enabled fleet routes touching this airport at either end. */
	route_count: number
	forecast_ok: boolean
}

interface AirportsResponse {
	as_of: string
	horizon_days: number
	count: number
	fleet_routes: number
	airports: AdminAirport[]
}

/** Body of the deliberate 400 a hub POST returns without `confirm`. */
interface AirportQuote {
	confirm_required: true
	iata: string
	action: string
	blast_radius: number
	routes: Array<{ flight_id: string; origin: string; dest: string }>
}

/** Body of the confirmed burst. */
interface AirportBurst {
	ok: true
	dry_run?: boolean
	iata: string
	action: string
	blast_radius: number
	processed?: number
	/** Routes left over when the burst hit its time budget — re-POST continues. */
	deferred?: number
	duration_ms?: number
	routes: Array<{ flight_id: string; origin: string; dest: string; outcome?: string }>
}

/* ── board atoms ──────────────────────────────────────────────────── */

/** Square board lamp — pixel-world status light. */
function Lamp({ tone, blink }: { tone: "win" | "loss" | "gold" | "blip"; blink?: boolean }) {
	const bg =
		tone === "win"
			? "bg-win"
			: tone === "loss"
				? "bg-loss"
				: tone === "gold"
					? "bg-gold"
					: "bg-blip"
	return (
		<span
			aria-hidden="true"
			className={`inline-block h-[9px] w-[9px] ${bg} ${blink ? "blink" : ""}`}
		/>
	)
}

function chainTone(status: string): "win" | "loss" | "gold" {
	return status === "Active" ? "win" : status === "Disabled" ? "loss" : "gold"
}

/** Same three-lamp language as chainTone, for the weather classifiers. */
function severityTone(severity: AdminAirport["severity"]): "win" | "loss" | "gold" {
	return severity === "ok" ? "win" : severity === "severe" ? "loss" : "gold"
}

/** Lookback windows for the run/audit logs — the API caps at 720h. */
const SINCE_WINDOWS: Array<{ hours: number; label: string }> = [
	{ hours: 24, label: "24h" },
	{ hours: 168, label: "7d" },
	{ hours: 720, label: "30d" },
]

function SinceWindow({
	value,
	onChange,
}: {
	value: number
	onChange: (hours: number) => void
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="label-px mr-1">Window</span>
			{SINCE_WINDOWS.map((w) => (
				<button
					key={w.hours}
					type="button"
					className={`btn-px btn-sm ${value === w.hours ? "btn-gold" : "btn-ghost"}`}
					onClick={() => onChange(w.hours)}
				>
					{w.label}
				</button>
			))}
		</div>
	)
}

/** Shared prev/next pager — the markup every paginated panel already
 *  had, hoisted once so a fifth board doesn't mean a fifth copy. Each
 *  caller keeps its own count wording via `label`. */
function Pager({
	page,
	onPageChange,
	total,
	limit,
	label,
}: {
	page: number
	onPageChange: (page: number) => void
	total: number
	limit: number
	label: string
}) {
	const pageCount = Math.max(1, Math.ceil(total / limit))
	if (total <= 0) return null
	return (
		<div className="mt-2 flex flex-wrap items-center justify-between gap-3">
			<span className="font-body text-[13px] text-mute">{label}</span>
			<div className="flex items-center gap-3">
				<button
					type="button"
					className="btn-px btn-ghost btn-sm"
					disabled={page <= 1}
					onClick={() => onPageChange(page - 1)}
				>
					‹ Prev
				</button>
				<span className="font-body text-[13px] text-mute">
					Page {page} / {pageCount}
				</span>
				<button
					type="button"
					className="btn-px btn-ghost btn-sm"
					disabled={page >= pageCount}
					onClick={() => onPageChange(page + 1)}
				>
					Next ›
				</button>
			</div>
		</div>
	)
}

/* ── auth shell ───────────────────────────────────────────────────── */

export default function Admin() {
	const [session, setSession] = useState<Session | null>(null)
	const [ready, setReady] = useState(false)

	useEffect(() => {
		if (!supabase) {
			setReady(true)
			return
		}
		supabase.auth.getSession().then(({ data }) => {
			setSession(data.session)
			setReady(true)
		})
		const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s))
		return () => sub.subscription.unsubscribe()
	}, [])

	if (!supabase) {
		return (
			<Shell>
				<p className="font-body text-[14px] text-loss">
					PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY are not configured.
				</p>
			</Shell>
		)
	}
	if (!ready) return <Shell />
	if (!session) return <SignIn />
	return <Console session={session} />
}

function Shell({ children }: { children?: React.ReactNode }) {
	return (
		<div className="mx-auto max-w-6xl px-4 py-10">
			<BoardHeader figures={null} />
			{children}
		</div>
	)
}

/** Live board clock — the seconds actually tick. */
function BoardClock() {
	const [now, setNow] = useState(() => new Date())
	useEffect(() => {
		const t = setInterval(() => setNow(new Date()), 1000)
		return () => clearInterval(t)
	}, [])
	return (
		<p className="board-figure ml-auto text-[16px] text-dim">
			{now.toUTCString().slice(17, 25)} UTC<span className="blink text-sky">█</span>
		</p>
	)
}

/** Signature: the control board masthead. */
function BoardHeader({
	figures,
}: {
	figures: { routes: number; onchain: number; pauses: number } | null
}) {
	return (
		<header className="panel-raised relative mb-8 overflow-hidden px-5 py-4">
			{/* CRT sweep — overlay child (serious mode hides .scanlines) */}
			<div aria-hidden="true" className="scanlines absolute inset-0" />
			<p className="label-px mb-1">flights.fun / internal</p>
			<h1 className="font-display text-[18px] leading-tight text-ink sm:text-[22px]">
				ROUTE CONTROL
			</h1>
			<div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-2">
				<BoardStat label="Routes" value={figures ? String(figures.routes) : "--"} />
				<BoardStat label="On-chain" value={figures ? String(figures.onchain) : "--"} />
				<BoardStat label="Open pauses" value={figures ? String(figures.pauses) : "--"} tone={figures && figures.pauses > 0 ? "loss" : undefined} />
				<BoardClock />
			</div>
		</header>
	)
}

function BoardStat({ label, value, tone }: { label: string; value: string; tone?: "loss" }) {
	return (
		<div>
			<p className="label-px">{label}</p>
			{/* inline color: serious theme's .board-figure override beats utilities */}
			<p className="board-figure" style={tone === "loss" ? { color: "var(--color-loss)" } : undefined}>
				{value}
			</p>
		</div>
	)
}

/* ── sign-in ──────────────────────────────────────────────────────── */

function SignIn() {
	const [email, setEmail] = useState("")
	const [sent, setSent] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function send(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		const { error } = await supabase!.auth.signInWithOtp({
			email,
			options: { emailRedirectTo: window.location.href },
		})
		if (error) setError(error.message)
		else setSent(true)
	}

	return (
		<Shell>
			<div data-testid="admin-gate" className="panel mx-auto max-w-md px-6 py-6">
				<h2 className="h-section mb-4">Tower access</h2>
				{sent ? (
					<p className="font-body text-[14px] text-dim">
						Access link sent to <span className="text-ink">{email}</span>. Open it on
						this device.
					</p>
				) : (
					<form onSubmit={send} className="space-y-3">
						<label className="block">
							<span className="label-px mb-1 block">Admin email</span>
							<input
								type="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="field-px"
								placeholder="you@sentinel.fi"
							/>
						</label>
						<button type="submit" className="btn-px btn-gold w-full">
							Send access link
						</button>
						{error && <p className="font-body text-[13px] text-loss">{error}</p>}
					</form>
				)}
			</div>
		</Shell>
	)
}

/* ── console ──────────────────────────────────────────────────────── */

/** EVERY tab query is lazy — each fetches only while its own tab is the
 *  active one, so an admin sitting on one tab isn't silently paying for
 *  six background pollers. The header dashboard is fed by its own cheap
 *  DB-only query (`admin-header`) rather than by the routes page: the
 *  routes page carries ?chain=1, which is 50 SERIAL on-chain reads, and
 *  polling that from the Jobs tab was pure waste. */
type AdminTab =
	| "jobs"
	| "routes"
	| "airports"
	| "interventions"
	| "outcomes"
	| "log"
	| "accounts"

const ADMIN_TABS: Array<{ key: AdminTab; label: string }> = [
	{ key: "jobs", label: "Jobs" },
	{ key: "routes", label: "Routes" },
	{ key: "airports", label: "Airports" },
	{ key: "interventions", label: "Interventions" },
	{ key: "outcomes", label: "Outcomes" },
	{ key: "log", label: "Action log" },
	{ key: "accounts", label: "Accounts" },
]

function Console({ session }: { session: Session }) {
	const token = session.access_token
	const qc = useQueryClient()
	// Scoped: every console query key starts with "admin-"; an admin
	// action must not force a refetch of every chain query in the app.
	const invalidate = () =>
		void qc.invalidateQueries({
			predicate: (q) => String(q.queryKey[0]).startsWith("admin-"),
		})
	const [activeTab, setActiveTab] = useState<AdminTab>("jobs")

	// The masthead's three figures and nothing else: fleet_total /
	// fleet_active off a 1-row routes page (no ?chain=1, so DB counts
	// only) and open_count off a 1-row interventions page. This is the
	// ONE query allowed to poll on every tab.
	const headerQ = useQuery({
		queryKey: ["admin-header"],
		queryFn: async () => {
			const [fleet, holds] = await Promise.all([
				api<RoutesResponse>("/api/admin/routes?limit=1", token),
				api<InterventionsResponse>("/api/admin/interventions?state=open&limit=1", token),
			])
			return {
				routes: fleet.fleet_total,
				onchain: fleet.fleet_active,
				pauses: holds.open_count,
			}
		},
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	// Jobs: `limit` is deliberately the API max so a 30d window actually
	// has history to spread across the ~10 jobs; the per-job strip is
	// capped separately at render time.
	const [jobsSinceHours, setJobsSinceHours] = useState(24)
	const jobsLimit = 200

	const jobsQ = useQuery({
		queryKey: ["admin-jobs", jobsSinceHours],
		queryFn: () => {
			const params = new URLSearchParams({
				limit: String(jobsLimit),
				since_hours: String(jobsSinceHours),
			})
			return api<JobsResponse>(`/api/admin/jobs?${params}`, token)
		},
		enabled: activeTab === "jobs",
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		refetchInterval: 60_000,
	})
	const [routeQuery, setRouteQuery] = useState("")
	// Debounced into the query key: typing "JFK" issues one request, and
	// keepPreviousData holds the current table instead of flashing the
	// loading row on every keystroke / page turn.
	const debouncedRouteQuery = useDebouncedValue(routeQuery, 300)
	const [routePage, setRoutePage] = useState(1)
	const [adminPausedOnly, setAdminPausedOnly] = useState(false)
	const routeLimit = 50

	const routesQ = useQuery({
		queryKey: ["admin-routes", debouncedRouteQuery, routePage, adminPausedOnly],
		queryFn: () => {
			const params = new URLSearchParams({
				chain: "1",
				page: String(routePage),
				limit: String(routeLimit),
			})
			if (debouncedRouteQuery) params.set("q", debouncedRouteQuery)
			if (adminPausedOnly) params.set("cause", "admin")
			return api<RoutesResponse>(`/api/admin/routes?${params}`, token)
		},
		// Gated: ?chain=1 fans out to one on-chain read PER ROW (50 serial
		// RPC round-trips a poll). It must not run from another tab.
		enabled: activeTab === "routes",
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		refetchInterval: 60_000,
	})
	const [interventionState, setInterventionState] = useState<"open" | "closed">("open")
	const [interventionCause, setInterventionCause] = useState("")
	const [interventionPage, setInterventionPage] = useState(1)
	const interventionLimit = 25

	const interventionsQ = useQuery({
		queryKey: ["admin-interventions", interventionState, interventionCause, interventionPage],
		queryFn: () => {
			const params = new URLSearchParams({
				state: interventionState,
				page: String(interventionPage),
				limit: String(interventionLimit),
			})
			if (interventionCause) params.set("cause", interventionCause)
			return api<InterventionsResponse>(`/api/admin/interventions?${params}`, token)
		},
		// Gated for the same reason as routes — the header no longer reads
		// open_count from here, so nothing off-tab depends on it.
		enabled: activeTab === "interventions",
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	const [logPage, setLogPage] = useState(1)
	const [logSinceHours, setLogSinceHours] = useState(24)
	const logLimit = 50

	const logQ = useQuery({
		queryKey: ["admin-log", logPage, logSinceHours],
		queryFn: () => {
			// offset-paged (not page-numbered) — actions.ts speaks offset.
			const params = new URLSearchParams({
				limit: String(logLimit),
				offset: String((logPage - 1) * logLimit),
				since_hours: String(logSinceHours),
			})
			return api<ActionsResponse>(`/api/admin/actions?${params}`, token)
		},
		enabled: activeTab === "log",
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	const airportsQ = useQuery({
		queryKey: ["admin-airports"],
		queryFn: () => api<AirportsResponse>("/api/admin/airports", token),
		enabled: activeTab === "airports",
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	const balancesQ = useQuery({
		queryKey: ["admin-balances"],
		queryFn: () => api<BalancesResponse>("/api/admin/balances", token),
		enabled: activeTab === "accounts",
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	const [outcomeFilter, setOutcomeFilter] = useState("")
	const [outcomePage, setOutcomePage] = useState(1)
	const outcomeLimit = 50

	const outcomesQ = useQuery({
		queryKey: ["admin-outcomes", outcomeFilter, outcomePage],
		queryFn: () => {
			const params = new URLSearchParams({ page: String(outcomePage), limit: String(outcomeLimit) })
			if (outcomeFilter) params.set("outcome", outcomeFilter)
			return api<OutcomesResponse>(`/api/admin/outcomes?${params}`, token)
		},
		enabled: activeTab === "outcomes",
		placeholderData: keepPreviousData,
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	// headerQ leads: it's the only query that runs on every tab, so it is
	// the one that always catches an allowlist rejection.
	const unauthorized = [
		headerQ,
		routesQ,
		interventionsQ,
		logQ,
		outcomesQ,
		airportsQ,
		balancesQ,
	].some((q) => q.error instanceof Error && q.error.message === "Unauthorized")

	const routes = routesQ.data?.routes ?? []
	const interventions = interventionsQ.data?.rows ?? []
	// Fleet-wide, DB-only counts (never a full chain scan or the current
	// tab/filter) so the header stays a whole-fleet summary.
	const figures = useMemo(
		() => ({
			routes: headerQ.data?.routes ?? 0,
			onchain: headerQ.data?.onchain ?? 0,
			pauses: headerQ.data?.pauses ?? 0,
		}),
		[headerQ.data]
	)

	return (
		<div className="mx-auto max-w-6xl px-4 py-10">
			<BoardHeader figures={headerQ.isLoading ? null : figures} />

			<div className="mb-6 flex items-center justify-between gap-3">
				<p className="font-body text-[13px] text-mute">
					Signed in as <span className="text-ink">{session.user.email}</span>
				</p>
				<button className="btn-px btn-ghost btn-sm" onClick={() => supabase!.auth.signOut()}>
					Sign out
				</button>
			</div>

			{unauthorized ? (
				<div className="panel px-5 py-5">
					<p className="font-body text-[14px] text-loss">
						{session.user.email} is not on the admin allowlist (ADMIN_EMAILS).
					</p>
				</div>
			) : (
				<div>
					<div className="mb-6 flex flex-wrap gap-1.5">
						{ADMIN_TABS.map((tab) => (
							<button
								key={tab.key}
								type="button"
								className={`btn-px btn-sm ${activeTab === tab.key ? "btn-gold" : "btn-ghost"}`}
								onClick={() => setActiveTab(tab.key)}
							>
								{tab.label}
							</button>
						))}
					</div>

					{activeTab === "jobs" && (
						<JobsBoard
							registry={jobsQ.data?.registry ?? []}
							latest={jobsQ.data?.latest ?? []}
							recent={jobsQ.data?.recent ?? []}
							loading={jobsQ.isLoading}
							token={token}
							onDone={invalidate}
							sinceHours={jobsSinceHours}
							onSinceHoursChange={setJobsSinceHours}
							total={jobsQ.data?.total ?? 0}
						/>
					)}
					{activeTab === "airports" && (
						<AirportsPanel
							airports={airportsQ.data?.airports ?? []}
							fleetRoutes={airportsQ.data?.fleet_routes ?? 0}
							horizonDays={airportsQ.data?.horizon_days ?? 0}
							loading={airportsQ.isLoading}
							token={token}
							onDone={invalidate}
						/>
					)}
					{activeTab === "routes" && (
						<RoutesBoard
							routes={routes}
							loading={routesQ.isLoading}
							token={token}
							onDone={invalidate}
							query={routeQuery}
							onQueryChange={(q) => {
								setRouteQuery(q)
								setRoutePage(1)
							}}
							adminPausedOnly={adminPausedOnly}
							onAdminPausedOnlyChange={(v) => {
								setAdminPausedOnly(v)
								setRoutePage(1)
							}}
							page={routePage}
							onPageChange={setRoutePage}
							total={routesQ.data?.total ?? 0}
							limit={routeLimit}
						/>
					)}
					{activeTab === "interventions" && (
						<InterventionsPanel
							interventions={interventions}
							loading={interventionsQ.isLoading}
							token={token}
							onDone={invalidate}
							state={interventionState}
							onStateChange={(s) => {
								setInterventionState(s)
								setInterventionPage(1)
							}}
							cause={interventionCause}
							onCauseChange={(c) => {
								setInterventionCause(c)
								setInterventionPage(1)
							}}
							page={interventionPage}
							onPageChange={setInterventionPage}
							total={interventionsQ.data?.total ?? 0}
							limit={interventionLimit}
						/>
					)}
					{activeTab === "outcomes" && (
						<OutcomesPanel
							outcomes={outcomesQ.data?.rows ?? []}
							loading={outcomesQ.isLoading}
							filter={outcomeFilter}
							onFilterChange={(o) => {
								setOutcomeFilter(o)
								setOutcomePage(1)
							}}
							page={outcomePage}
							onPageChange={setOutcomePage}
							total={outcomesQ.data?.total ?? 0}
							limit={outcomeLimit}
						/>
					)}
					{activeTab === "log" && (
						<ActionLog
							log={logQ.data?.log ?? []}
							loading={logQ.isLoading}
							sinceHours={logSinceHours}
							onSinceHoursChange={(h) => {
								setLogSinceHours(h)
								setLogPage(1)
							}}
							page={logPage}
							onPageChange={setLogPage}
							total={logQ.data?.total ?? 0}
							limit={logLimit}
						/>
					)}
					{activeTab === "accounts" && (
						<>
							<FaucetPanel />
							<AccountsPanel data={balancesQ.data ?? null} loading={balancesQ.isLoading} />
						</>
					)}
				</div>
			)}
		</div>
	)
}

/* ── jobs board ───────────────────────────────────────────────────── */

/** Lamp logic: red = last run failed, gold = stale (2× interval with no
 *  run) or never ran, green = on schedule and passing. */
function jobTone(
	last: JobRun | undefined,
	intervalMinutes: number
): { tone: "win" | "loss" | "gold"; word: string } {
	if (!last) return { tone: "gold", word: "no runs" }
	if (!last.success) return { tone: "loss", word: "failed" }
	const ageMin = (Date.now() - new Date(last.ran_at).getTime()) / 60_000
	if (ageMin > 2 * intervalMinutes) return { tone: "gold", word: "stale" }
	return { tone: "win", word: "ok" }
}

/** Per-job history strip cap. The WINDOW decides what is fetched; this
 *  only decides how much of it one row is allowed to draw. */
const JOB_HISTORY_CAP = 12

function JobsBoard({
	registry,
	latest,
	recent,
	loading,
	token,
	onDone,
	sinceHours,
	onSinceHoursChange,
	total,
}: {
	registry: JobRegistryEntry[]
	latest: JobRun[]
	recent: JobRun[]
	loading: boolean
	token: string
	onDone: () => void
	sinceHours: number
	onSinceHoursChange: (hours: number) => void
	total: number
}) {
	const [busy, setBusy] = useState<string | null>(null)
	const [note, setNote] = useState<string | null>(null)
	const [runTxState, setRunTxState] = useState<TxState>("idle")
	const [expanded, setExpanded] = useState<string | null>(null)
	const byJob = new Map(latest.map((r) => [r.job, r]))

	async function runNow(job: string) {
		setBusy(job)
		setNote(null)
		setRunTxState("confirming")
		try {
			const entry = await api<JobRunResult>("/api/admin/jobs", token, {
				method: "POST",
				body: JSON.stringify({ job }),
			})
			setNote(`${job}: ${entry.success ? "completed" : "FAILED"} in ${entry.duration_ms}ms`)
			setRunTxState(entry.success ? "success" : "error")
			onDone()
		} catch (err) {
			setNote(`${job}: ${errorMessage(err)}`)
			setRunTxState("error")
		} finally {
			setTimeout(() => {
				setBusy(null)
				setRunTxState("idle")
			}, 1800)
		}
	}

	return (
		<section>
			<h2 className="h-section mb-3">Crons · job board</h2>
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<SinceWindow value={sinceHours} onChange={onSinceHoursChange} />
				<span className="font-body text-[13px] text-mute">
					{total.toLocaleString()} run{total === 1 ? "" : "s"} in window
				</span>
			</div>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["", "Job", "Schedule", "Signer", "Last run", "Took", "Trigger", ""].map((h, i) => (
								<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{loading && (
							<tr>
								<td colSpan={8} className="px-3 py-4 text-mute">
									Reading the job board…
								</td>
							</tr>
						)}
						{registry.map((info) => {
							const last = byJob.get(info.job)
							const { tone, word } = jobTone(last, info.intervalMinutes)
							const isOpen = expanded === info.job
							const history = recent
								.filter((r) => r.job === info.job)
								.slice(0, JOB_HISTORY_CAP)
							return (
								<Fragment key={info.job}>
									<tr className="border-b border-line/60 last:border-b-0">
										<td className="px-3 py-2">
											<span className="flex items-center gap-2">
												<Lamp tone={tone} blink={tone === "loss"} />
												<span className="status-px text-mute">{word}</span>
											</span>
										</td>
										<td className="px-3 py-2">
											<span className="font-board text-[17px] text-ink">{info.job}</span>
											<span className="block text-[12px] text-mute">{info.description}</span>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span
												className="font-board text-[16px] text-sky"
												title={`cron: ${info.schedule} (UTC)`}
											>
												{humanizeCron(info.schedule)}
											</span>
										</td>
										<td className="px-3 py-2 text-dim">{info.signer}</td>
										<td className="px-3 py-2 whitespace-nowrap text-dim">{relTime(last?.ran_at ?? null)}</td>
										<td className="px-3 py-2 whitespace-nowrap text-mute">
											{last ? `${last.duration_ms}ms` : "—"}
										</td>
										<td className="px-3 py-2 text-mute">{last?.trigger ?? "—"}</td>
										<td className="px-3 py-2">
											<div className="flex flex-wrap gap-1.5">
												{info.manualRunnable && (
													<button
														className="btn-px btn-blip btn-sm"
														disabled={busy !== null}
														onClick={() => runNow(info.job)}
													>
														{busy === info.job ? "Running…" : "Run"}
													</button>
												)}
												<button
													className="btn-px btn-ghost btn-sm"
													onClick={() => setExpanded(isOpen ? null : info.job)}
												>
													{isOpen ? "Hide" : "Details"}
												</button>
											</div>
											{busy === info.job && (
												<TxProgress state={runTxState} steps={["confirming"]} />
											)}
										</td>
									</tr>
									{isOpen && (
										<tr className="border-b border-line/60 last:border-b-0">
											<td colSpan={8} className="px-3 py-3">
												{last?.success === false && (
													<p className="mb-2 font-body text-[12px] text-loss">
														Last error: {last.error ?? "(no message recorded)"}
													</p>
												)}
												{history.length === 0 ? (
													<p className="font-body text-[12px] text-mute">
														No run history in the last {sinceHours}h.
													</p>
												) : (
													<div className="flex flex-wrap items-center gap-2">
														<span className="label-px text-mute">Recent runs</span>
														{history.map((r) => (
															<span
																key={r.ran_at}
																className={`status-px ${r.success ? "text-mute" : "text-loss"}`}
																title={`${r.trigger} · ${new Date(r.ran_at).toISOString()}${r.error ? ` · ${r.error}` : ""}`}
															>
																{r.duration_ms}ms
															</span>
														))}
													</div>
												)}
											</td>
										</tr>
									)}
								</Fragment>
							)
						})}
					</tbody>
				</table>
			</div>
			{note && <p className="mt-2 font-body text-[13px] text-dim">{note}</p>}
		</section>
	)
}

/* ── routes board ─────────────────────────────────────────────────── */

function RoutesBoard({
	routes,
	loading,
	token,
	onDone,
	query,
	onQueryChange,
	adminPausedOnly,
	onAdminPausedOnlyChange,
	page,
	onPageChange,
	total,
	limit,
}: {
	routes: AdminRoute[]
	loading: boolean
	token: string
	onDone: () => void
	query: string
	onQueryChange: (q: string) => void
	adminPausedOnly: boolean
	onAdminPausedOnlyChange: (v: boolean) => void
	page: number
	onPageChange: (page: number) => void
	total: number
	limit: number
}) {
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	async function act(label: string, fn: () => Promise<unknown>) {
		setBusy(label)
		setError(null)
		try {
			await fn()
			onDone()
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setBusy(null)
		}
	}

	const post = (body: object) =>
		api<unknown>("/api/admin/actions", token, { method: "POST", body: JSON.stringify(body) })
	const patch = (body: object) =>
		api<unknown>("/api/admin/routes", token, { method: "PATCH", body: JSON.stringify(body) })
	const intervene = (body: object) =>
		api<unknown>("/api/admin/interventions", token, { method: "POST", body: JSON.stringify(body) })
	const revive = (id: string) =>
		api<unknown>("/api/admin/interventions", token, { method: "PATCH", body: JSON.stringify({ id }) })

	function halt(r: AdminRoute, id: string, key: object) {
		const reason = window.prompt(`Reason for pausing ${r.flight_id} ${r.origin}→${r.dest}:`)
		if (!reason) return
		void act(id, () => intervene({ ...key, reason }))
	}

	function resume(r: AdminRoute, id: string, key: object) {
		// Prefer reviving the open intervention row (audited, cause-tracked);
		// fall back to the raw on-chain enable for routes disabled before the
		// interventions ledger existed (no open row to revive).
		const openId = r.open_intervention_id
		if (openId) {
			void act(id, () => revive(openId))
		} else {
			void act(id, () => post({ op: "enable", ...key }))
		}
	}

	return (
		<section>
			<h2 className="h-section mb-3">Departures · managed routes</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<input
					type="text"
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					placeholder="Search flight / origin / dest / carrier…"
					className="field-px w-64 px-2 py-1 text-[13px]"
					aria-label="Search routes"
				/>
				<label className="flex items-center gap-1.5 font-body text-[13px] text-dim">
					<input
						type="checkbox"
						checked={adminPausedOnly}
						onChange={(e) => onAdminPausedOnlyChange(e.target.checked)}
					/>
					Admin-paused only
				</label>
			</div>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["Flight", "Route", "Lifecycle", "Chain", "Premium", "Payoff", "Delay", ""].map(
								(h) => (
									<th key={h} className="label-px px-3 py-2 whitespace-nowrap">
										{h}
									</th>
								)
							)}
						</tr>
					</thead>
					<tbody className="font-board text-[18px]">
						{loading && (
							<tr>
								<td colSpan={8} className="px-3 py-4 font-body text-[13px] text-mute">
									Reading the board…
								</td>
							</tr>
						)}
						{!loading && routes.length === 0 && (
							<tr>
								<td colSpan={8} className="px-3 py-4 font-body text-[13px] text-mute">
									No routes registered. Add one below.
								</td>
							</tr>
						)}
						{routes.map((r) => {
							const key = { flight_id: r.flight_id, origin: r.origin, dest: r.dest }
							const id = `${r.flight_id}-${r.origin}-${r.dest}`
							const chain = r.on_chain?.status ?? "Unknown"
							const pinned = r.pinned && (!r.pin_until || new Date(r.pin_until) > new Date())
							return (
								<tr key={id} className="border-b border-line/60 last:border-b-0">
									<td className="px-3 py-2 text-ink">{r.flight_id}</td>
									<td className="px-3 py-2 text-dim">
										{r.origin}→{r.dest}
									</td>
									<td className="px-3 py-2">
										<span className="status-px text-dim">
											{r.status}
											{pinned && <span className="text-gold"> ·PIN</span>}
										</span>
									</td>
									<td className="px-3 py-2">
										<span className="flex items-center gap-2">
											<Lamp tone={chainTone(chain)} />
											<span className="status-px text-dim">
												{chain}
												{r.open_cause && (
													<span className="text-mute"> ·{r.open_cause}</span>
												)}
											</span>
										</span>
									</td>
									<td className="px-3 py-2 text-gold">{usdFromUnits(r.on_chain?.terms?.premium)}</td>
									<td className="px-3 py-2 text-gold">{usdFromUnits(r.on_chain?.terms?.payoff)}</td>
									<td className="px-3 py-2 text-dim">
										{r.on_chain?.terms ? `${r.on_chain.terms.delay_hours}h` : "—"}
									</td>
									<td className="px-3 py-2">
										<div className="flex flex-wrap gap-1.5">
											{chain === "Unknown" && (
												<button
													className="btn-px btn-gold btn-sm"
													disabled={busy !== null}
													onClick={() =>
														act(id, () =>
															post({
																op: "whitelist",
																...key,
																premium_units: r.base_premium_units,
																payoff_units: r.base_payoff_units,
																delay_hours: r.base_delay_hours,
															})
														)
													}
												>
													{busy === id ? "…" : "List"}
												</button>
											)}
											{chain === "Active" && (
												<button
													className="btn-px btn-loss btn-sm"
													disabled={busy !== null}
													onClick={() => halt(r, id, key)}
												>
													{busy === id ? "…" : "Halt"}
												</button>
											)}
											{chain === "Disabled" && (
												<button
													className="btn-px btn-win btn-sm"
													disabled={busy !== null}
													onClick={() => resume(r, id, key)}
												>
													{busy === id ? "…" : "Resume"}
												</button>
											)}
											{chain === "Active" && (
												<button
													className="btn-px btn-ghost btn-sm"
													disabled={busy !== null}
													onClick={() => act(id, () => post({ op: "revert", ...key }))}
												>
													Revert
												</button>
											)}
											<button
												className="btn-px btn-ghost btn-sm"
												disabled={busy !== null}
												onClick={() =>
													act(id, () => patch({ action: pinned ? "unpin" : "pin", ...key }))
												}
											>
												{pinned ? "Unpin" : "Pin"}
											</button>
										</div>
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
			<Pager
				page={page}
				onPageChange={onPageChange}
				total={total}
				limit={limit}
				label={`${total.toLocaleString()} route${total === 1 ? "" : "s"}`}
			/>
			{error && <p className="mt-2 font-body text-[13px] text-loss">{error}</p>}
			<AddRoute token={token} onDone={onDone} />
		</section>
	)
}

function AddRoute({ token, onDone }: { token: string; onDone: () => void }) {
	const [form, setForm] = useState({ flight_id: "", origin: "", dest: "", carrier: "" })
	const m = useMutation({
		mutationFn: () =>
			api<unknown>("/api/admin/routes", token, {
				method: "POST",
				body: JSON.stringify({
					...form,
					carrier: form.carrier || null,
				}),
			}),
		onSuccess: onDone,
	})
	const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
		setForm((f) => ({ ...f, [k]: e.target.value.toUpperCase().trim() }))

	return (
		<form
			className="mt-3 flex flex-wrap items-end gap-2"
			onSubmit={(e) => {
				e.preventDefault()
				m.mutate()
			}}
		>
			{(
				[
					["flight_id", "Flight", "AA100"],
					["origin", "From", "JFK"],
					["dest", "To", "LAX"],
					["carrier", "Carrier", "AA"],
				] as const
			).map(([k, label, ph]) => (
				<label key={k} className="block">
					<span className="label-px mb-1 block">{label}</span>
					<input
						className="field-px w-28"
						required={k !== "carrier"}
						value={form[k]}
						onChange={set(k)}
						placeholder={ph}
					/>
				</label>
			))}
			<button type="submit" className="btn-px btn-blip" disabled={m.isPending}>
				{m.isPending ? "…" : "Add route"}
			</button>
			{m.error && (
				<p className="w-full font-body text-[13px] text-loss">{String(m.error)}</p>
			)}
		</form>
	)
}

/* ── interventions (the unified pause ledger) ─────────────────────── */

const INTERVENTION_CAUSES = ["cancellation", "exposure", "weather", "pricing", "admin"]

function InterventionsPanel({
	interventions,
	loading,
	token,
	onDone,
	state,
	onStateChange,
	cause,
	onCauseChange,
	page,
	onPageChange,
	total,
	limit,
}: {
	interventions: AdminIntervention[]
	loading: boolean
	token: string
	onDone: () => void
	state: "open" | "closed"
	onStateChange: (state: "open" | "closed") => void
	cause: string
	onCauseChange: (cause: string) => void
	page: number
	onPageChange: (page: number) => void
	total: number
	limit: number
}) {
	const [expanded, setExpanded] = useState<string | null>(null)
	const revive = useMutation({
		mutationFn: (id: string) =>
			api<unknown>("/api/admin/interventions", token, { method: "PATCH", body: JSON.stringify({ id }) }),
		onSuccess: onDone,
	})

	return (
		<section>
			<h2 className="h-section mb-3">Interventions · what's paused &amp; why</h2>
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<div className="flex gap-1.5">
					{(["open", "closed"] as const).map((s) => (
						<button
							key={s}
							type="button"
							className={`btn-px btn-sm ${state === s ? "btn-gold" : "btn-ghost"}`}
							onClick={() => onStateChange(s)}
						>
							{s === "open" ? "Open" : "History"}
						</button>
					))}
				</div>
				<div className="flex flex-wrap gap-1.5">
					<button
						type="button"
						className={`btn-px btn-sm ${cause === "" ? "btn-gold" : "btn-ghost"}`}
						onClick={() => onCauseChange("")}
					>
						All
					</button>
					{INTERVENTION_CAUSES.map((c) => (
						<button
							key={c}
							type="button"
							className={`btn-px btn-sm ${cause === c ? "btn-gold" : "btn-ghost"}`}
							onClick={() => onCauseChange(c)}
						>
							{c}
						</button>
					))}
				</div>
			</div>
			<div className="panel px-4 py-3">
				{loading && <p className="font-body text-[13px] text-mute">Reading the ledger…</p>}
				{!loading && interventions.length === 0 && (
					<p className="font-body text-[13px] text-mute">
						{state === "open"
							? "Nothing paused. Every whitelisted route is selling."
							: "No history for this filter yet."}
					</p>
				)}
				<ul className="divide-y divide-line/60">
					{interventions.map((s) => {
						const isOpen = expanded === s.id
						return (
							<li key={s.id} className="py-2.5">
								<div className="flex flex-wrap items-center gap-3">
									<Lamp tone={s.cause === "admin" ? "gold" : "loss"} blink={state === "open" && s.cause !== "admin"} />
									<span className="status-px text-ink">{s.cause}</span>
									<span className="font-board text-[17px] text-dim">
										{s.flight_id} {s.origin}→{s.dest}
									</span>
									<span className="font-body text-[12px] text-mute">by {s.opened_by}</span>
									<span className="font-body text-[12px] text-mute">
										since {utcDateTime(s.opened_at)}
									</span>
									{state === "open" ? (
										<span className="font-body text-[12px] text-mute">
											checked {utcDateTime(s.last_checked_at)}
										</span>
									) : (
										<span className="font-body text-[12px] text-mute">
											revived {s.revived_at ? utcDateTime(s.revived_at) : "—"} by {s.revived_by}
										</span>
									)}
									<button
										className="btn-px btn-ghost btn-sm"
										onClick={() => setExpanded(isOpen ? null : s.id)}
									>
										{isOpen ? "Hide evidence" : "Evidence"}
									</button>
									{state === "open" && (
										<button
											className="btn-px btn-ghost btn-sm ml-auto"
											disabled={revive.isPending}
											onClick={() => revive.mutate(s.id)}
										>
											Revive
										</button>
									)}
								</div>
								{isOpen && (
									<pre className="panel-inset mt-2 overflow-x-auto px-3 py-2 font-body text-[12px] text-dim">
										{JSON.stringify(s.evidence ?? null, null, 2)}
									</pre>
								)}
							</li>
						)
					})}
				</ul>
			</div>
			<Pager
				page={page}
				onPageChange={onPageChange}
				total={total}
				limit={limit}
				label={`${total.toLocaleString()} ${state === "open" ? "open" : "closed"}`}
			/>
			<AdminPause token={token} onDone={onDone} />
		</section>
	)
}

function AdminPause({ token, onDone }: { token: string; onDone: () => void }) {
	const [form, setForm] = useState({ flight_id: "", origin: "", dest: "", reason: "" })
	const m = useMutation({
		mutationFn: () =>
			api<unknown>("/api/admin/interventions", token, {
				method: "POST",
				body: JSON.stringify(form),
			}),
		onSuccess: onDone,
	})

	const upd = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
		setForm((f) => ({ ...f, [k]: e.target.value }))

	return (
		<form
			className="panel-inset mt-3 flex flex-wrap items-end gap-2 px-4 py-3"
			onSubmit={(e) => {
				e.preventDefault()
				m.mutate()
			}}
		>
			<span className="label-px mr-1">Pause a route (admin hold — never auto-revived)</span>
			<Txt label="Flight" value={form.flight_id} onChange={upd("flight_id")} ph="AA100" />
			<Txt label="From" value={form.origin} onChange={upd("origin")} ph="JFK" />
			<Txt label="To" value={form.dest} onChange={upd("dest")} ph="LAX" />
			<Txt label="Reason" value={form.reason} onChange={upd("reason")} ph="why" w="w-48" />
			<button type="submit" className="btn-px btn-loss" disabled={m.isPending}>
				{m.isPending ? "…" : "Pause"}
			</button>
			{m.error && <p className="w-full font-body text-[13px] text-loss">{String(m.error)}</p>}
		</form>
	)
}


function Txt({
	label,
	value,
	onChange,
	ph,
	w = "w-28",
}: {
	label: string
	value: string
	onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
	ph: string
	w?: string
}) {
	return (
		<label className="block">
			<span className="label-px mb-1 block">{label}</span>
			<input className={`field-px ${w}`} value={value} onChange={onChange} placeholder={ph} />
		</label>
	)
}

/* ── action log ───────────────────────────────────────────────────── */

const OUTCOME_FILTERS = ["ontime", "delayed", "cancelled", "diverted"]
const OUTCOME_TONE: Record<string, "win" | "loss" | "gold"> = {
	ontime: "win",
	delayed: "gold",
	cancelled: "loss",
	diverted: "loss",
}

function weatherCell(gust: number | null, snow: number | null, precip: number | null) {
	if (gust == null && snow == null && precip == null) return "—"
	const parts = []
	if (gust != null) parts.push(`${Math.round(gust)}km/h gust`)
	if (snow != null && snow > 0) parts.push(`${snow.toFixed(1)}cm snow`)
	if (precip != null) parts.push(`${Math.round(precip)}% precip`)
	return parts.join(" · ") || "—"
}

function OutcomesPanel({
	outcomes,
	loading,
	filter,
	onFilterChange,
	page,
	onPageChange,
	total,
	limit,
}: {
	outcomes: AdminOutcome[]
	loading: boolean
	filter: string
	onFilterChange: (outcome: string) => void
	page: number
	onPageChange: (page: number) => void
	total: number
	limit: number
}) {
	return (
		<section>
			<h2 className="h-section mb-3">Flight outcomes · weather-learnability log</h2>
			<div className="mb-3 flex flex-wrap gap-1.5">
				<button
					type="button"
					className={`btn-px btn-sm ${filter === "" ? "btn-gold" : "btn-ghost"}`}
					onClick={() => onFilterChange("")}
				>
					All
				</button>
				{OUTCOME_FILTERS.map((o) => (
					<button
						key={o}
						type="button"
						className={`btn-px btn-sm ${filter === o ? "btn-gold" : "btn-ghost"}`}
						onClick={() => onFilterChange(o)}
					>
						{o}
					</button>
				))}
			</div>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["Flight", "Route", "Date", "Outcome", "Delay", "Origin weather", "Dest weather"].map(
								(h) => (
									<th key={h} className="label-px px-3 py-2 whitespace-nowrap">
										{h}
									</th>
								)
							)}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{loading && (
							<tr>
								<td colSpan={7} className="px-3 py-4 text-mute">
									Reading the log…
								</td>
							</tr>
						)}
						{!loading && outcomes.length === 0 && (
							<tr>
								<td colSpan={7} className="px-3 py-4 text-mute">
									No outcomes logged for this filter yet.
								</td>
							</tr>
						)}
						{outcomes.map((o) => (
							<tr key={o.id} className="border-b border-line/60 last:border-b-0">
								<td className="px-3 py-2 text-ink">{o.flight_id}</td>
								<td className="px-3 py-2 whitespace-nowrap text-dim">
									{o.origin}→{o.dest}
								</td>
								<td className="px-3 py-2 whitespace-nowrap text-mute">{o.flight_date}</td>
								<td className="px-3 py-2">
									<span className="flex items-center gap-2">
										<Lamp tone={OUTCOME_TONE[o.outcome] ?? "gold"} />
										<span className="status-px text-dim">{o.outcome}</span>
									</span>
								</td>
								<td className="px-3 py-2 text-mute">
									{o.delay_minutes != null ? `${o.delay_minutes}m` : "—"}
								</td>
								<td className="px-3 py-2 whitespace-nowrap text-mute">
									{weatherCell(o.origin_gust_kmh, o.origin_snow_cm, o.origin_precip_prob_pct)}
								</td>
								<td className="px-3 py-2 whitespace-nowrap text-mute">
									{weatherCell(o.dest_gust_kmh, o.dest_snow_cm, o.dest_precip_prob_pct)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Pager
				page={page}
				onPageChange={onPageChange}
				total={total}
				limit={limit}
				label={`${total.toLocaleString()} outcome${total === 1 ? "" : "s"}`}
			/>
		</section>
	)
}

function ActionLog({
	log,
	loading,
	sinceHours,
	onSinceHoursChange,
	page,
	onPageChange,
	total,
	limit,
}: {
	log: AdminAction[]
	loading: boolean
	sinceHours: number
	onSinceHoursChange: (hours: number) => void
	page: number
	onPageChange: (page: number) => void
	total: number
	limit: number
}) {
	return (
		<section>
			{/* One governance sweep writes >100 rows, so the tail alone can't
			    reach yesterday — the window picks the haystack, the pager
			    walks it. */}
			<h2 className="h-section mb-3">Action log</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<SinceWindow value={sinceHours} onChange={onSinceHoursChange} />
			</div>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["Time (UTC)", "Actor", "Action", "Route", "Tx", "OK"].map((h) => (
								<th key={h} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{loading && (
							<tr>
								<td colSpan={6} className="px-3 py-4 text-mute">
									Reading the log…
								</td>
							</tr>
						)}
						{!loading && log.length === 0 && (
							<tr>
								<td colSpan={6} className="px-3 py-4 text-mute">
									No governance actions in the last {sinceHours}h.
								</td>
							</tr>
						)}
						{log.map((a) => (
							<tr key={a.id} className="border-b border-line/60 last:border-b-0">
								<td className="px-3 py-2 whitespace-nowrap text-mute">
									{isoMinute(a.ts)}
								</td>
								<td className="px-3 py-2 text-dim">{a.actor}</td>
								<td className="px-3 py-2 text-ink">{a.action}</td>
								<td className="px-3 py-2 whitespace-nowrap text-dim">
									{a.flight_id ? `${a.flight_id} ${a.origin}→${a.dest}` : "—"}
								</td>
								<td className="px-3 py-2">
									{a.tx_hash ? (
										<a
											href={explorerTxUrl(a.tx_hash)}
											target="_blank"
											rel="noopener noreferrer"
											className="footer-link font-board text-[15px]"
										>
											{shortTx(a.tx_hash)}
										</a>
									) : (
										<span className="text-mute">—</span>
									)}
								</td>
								<td className="px-3 py-2">
									<Lamp tone={a.success ? "win" : "loss"} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Pager
				page={page}
				onPageChange={onPageChange}
				total={total}
				limit={limit}
				label={`${total.toLocaleString()} action${total === 1 ? "" : "s"}`}
			/>
		</section>
	)
}

/* ── airports (weather by hub, and the hub-wide lever) ─────────────── */

/**
 * The one control on this page that moves hundreds of routes with one
 * click, so it is the one control that refuses to fire on one click.
 *
 * Click 1 POSTs WITHOUT `confirm` — the API answers 400 + blast_radius
 * and touches nothing (it is a quote, not a dry-run of a write). Only
 * the second, deliberate click sends `confirm: true`. That matters
 * because the burst is sequential on-chain writes and the resulting
 * holds carry cause `admin`, which NOTHING auto-revives — a human opened
 * it, a human has to close it.
 */
function AirportsPanel({
	airports,
	fleetRoutes,
	horizonDays,
	loading,
	token,
	onDone,
}: {
	airports: AdminAirport[]
	fleetRoutes: number
	horizonDays: number
	loading: boolean
	token: string
	onDone: () => void
}) {
	/** The armed-but-not-fired click: what we quoted, and how big it is. */
	const [pending, setPending] = useState<
		{ iata: string; action: "pause" | "unpause"; blastRadius: number } | null
	>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [burstState, setBurstState] = useState<TxState>("idle")
	const [note, setNote] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const post = (body: object) =>
		api<AirportBurst>("/api/admin/airports", token, {
			method: "POST",
			body: JSON.stringify(body),
		})

	/** Step 1 — quote only. NEVER sends confirm. */
	async function quote(iata: string, action: "pause" | "unpause") {
		setBusy(iata)
		setPending(null)
		setNote(null)
		setError(null)
		try {
			// A 200 here would mean the API stopped requiring confirmation;
			// treat it as done rather than pretending it didn't happen.
			const done = await post({ iata, action })
			setNote(describeBurst(done))
			onDone()
		} catch (err) {
			const q = airportQuote(err)
			if (q) setPending({ iata, action, blastRadius: q.blast_radius })
			else setError(errorMessage(err))
		} finally {
			setBusy(null)
		}
	}

	/** Step 2 — the deliberate one. */
	async function commit() {
		if (!pending) return
		const { iata, action } = pending
		setBusy(iata)
		setBurstState("confirming")
		setError(null)
		try {
			const done = await post({ iata, action, confirm: true })
			setNote(describeBurst(done))
			setBurstState("success")
			setPending(null)
			onDone()
		} catch (err) {
			setError(errorMessage(err))
			setBurstState("error")
		} finally {
			setBusy(null)
			setTimeout(() => setBurstState("idle"), 1800)
		}
	}

	return (
		<section>
			<h2 className="h-section mb-3">Airports · weather by hub</h2>
			<p className="mb-3 font-body text-[13px] text-mute">
				Same classifiers the weather cron decides with, over the next {horizonDays || "—"}{" "}
				days. {fleetRoutes.toLocaleString()} enabled fleet routes across {airports.length}{" "}
				airports.
			</p>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["", "Airport", "Gust", "Snow", "Routes", "Forecast", ""].map((h, i) => (
								<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{loading && (
							<tr>
								<td colSpan={7} className="px-3 py-4 text-mute">
									Reading the weather board…
								</td>
							</tr>
						)}
						{!loading && airports.length === 0 && (
							<tr>
								<td colSpan={7} className="px-3 py-4 text-mute">
									No airports in the fleet config.
								</td>
							</tr>
						)}
						{airports.map((a) => {
							const armed = pending?.iata === a.iata
							const tint =
								a.severity === "severe"
									? "bg-loss/10"
									: a.severity === "elevated"
										? "bg-gold/10"
										: ""
							return (
								<Fragment key={a.iata}>
									<tr className={`border-b border-line/60 last:border-b-0 ${tint}`}>
										<td className="px-3 py-2">
											<span className="flex items-center gap-2">
												<Lamp
													tone={severityTone(a.severity)}
													blink={a.severity === "severe"}
												/>
												<span className="status-px text-mute">{a.severity}</span>
											</span>
										</td>
										<td className="px-3 py-2">
											<span className="font-board text-[18px] text-ink">{a.iata}</span>
											{a.extreme && (
												<span className="status-px ml-2 text-loss">·EXTREME</span>
											)}
										</td>
										<td className="px-3 py-2 whitespace-nowrap text-dim">
											{a.max_gust_kmh != null ? `${Math.round(a.max_gust_kmh)} km/h` : "—"}
										</td>
										<td className="px-3 py-2 whitespace-nowrap text-dim">
											{a.total_snow_cm != null ? `${a.total_snow_cm.toFixed(1)} cm` : "—"}
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className="font-board text-[17px] text-sky">
												{a.route_count.toLocaleString()}
											</span>
										</td>
										<td className="px-3 py-2">
											{a.forecast_ok ? (
												<span className="status-px text-mute">ok</span>
											) : (
												// Fail-open, same as the cron: no forecast reads as
												// "ok", so say so rather than let it look benign.
												<span className="status-px text-gold">no data</span>
											)}
										</td>
										<td className="px-3 py-2">
											<div className="flex flex-wrap gap-1.5">
												<button
													className="btn-px btn-loss btn-sm"
													disabled={busy !== null}
													onClick={() => quote(a.iata, "pause")}
												>
													{busy === a.iata ? "…" : "Pause hub"}
												</button>
												<button
													className="btn-px btn-win btn-sm"
													disabled={busy !== null}
													onClick={() => quote(a.iata, "unpause")}
												>
													{busy === a.iata ? "…" : "Unpause"}
												</button>
											</div>
										</td>
									</tr>
									{armed && pending && (
										<tr className="border-b border-line/60 last:border-b-0">
											<td colSpan={7} className="px-3 py-3">
												<div className="panel-inset px-4 py-3">
													<p className="font-body text-[14px] text-loss">
														{pending.action === "pause"
															? `This will disable ${pending.blastRadius.toLocaleString()} routes. They will not re-enable automatically.`
															: `This will re-enable ${pending.blastRadius.toLocaleString()} routes touching ${pending.iata}.`}
													</p>
													<p className="mt-1 font-body text-[12px] text-mute">
														{pending.action === "pause"
															? "Every route touching "
															: "Every admin hold on "}
														{pending.iata} is written on-chain one at a time (~7–10s
														each) by the single gov-admin key. A large hub can exceed
														one invocation — the run reports what is left and
														re-clicking continues it.
													</p>
													<div className="mt-2 flex flex-wrap items-center gap-1.5">
														<button
															className={`btn-px btn-sm ${pending.action === "pause" ? "btn-loss" : "btn-win"}`}
															disabled={busy !== null}
															onClick={() => void commit()}
														>
															{busy === pending.iata
																? "Working…"
																: `Yes — ${pending.action} ${pending.blastRadius.toLocaleString()} routes`}
														</button>
														<button
															className="btn-px btn-ghost btn-sm"
															disabled={busy !== null}
															onClick={() => setPending(null)}
														>
															Cancel
														</button>
													</div>
													{busy === pending.iata && (
														<TxProgress state={burstState} steps={["confirming"]} />
													)}
												</div>
											</td>
										</tr>
									)}
								</Fragment>
							)
						})}
					</tbody>
				</table>
			</div>
			{note && <p className="mt-2 font-body text-[13px] text-dim">{note}</p>}
			{error && <p className="mt-2 font-body text-[13px] text-loss">{error}</p>}
		</section>
	)
}

/** Narrow a caught failure to the API's deliberate confirm-required 400. */
function airportQuote(err: unknown): AirportQuote | null {
	if (!(err instanceof ApiError)) return null
	const body = err.body as Partial<AirportQuote> | null
	return body?.confirm_required === true && typeof body.blast_radius === "number"
		? (body as AirportQuote)
		: null
}

function describeBurst(r: AirportBurst): string {
	if (r.dry_run) {
		return `${r.iata}: [dry-run] would ${r.action} ${r.blast_radius.toLocaleString()} routes (GOV_DRY_RUN is on).`
	}
	const failed = r.routes.filter((x) => x.outcome?.startsWith("error:")).length
	const parts = [
		`${r.iata}: ${r.action}d ${(r.processed ?? 0).toLocaleString()} of ${r.blast_radius.toLocaleString()} routes`,
	]
	if (r.duration_ms != null) parts.push(`in ${Math.round(r.duration_ms / 1000)}s`)
	if (failed > 0) parts.push(`· ${failed} errored`)
	if (r.deferred) parts.push(`· ${r.deferred} deferred (click again to continue)`)
	return parts.join(" ")
}

/* ── accounts (the fuel gauge) ────────────────────────────────────── */

/** Horizon's 7-dp string → "1,234.56". Display only. */
function xlmAmount(v: string | null): string {
	if (v == null) return "—"
	const n = Number(v)
	if (!Number.isFinite(n)) return v
	return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * WHO IS ABOUT TO RUN DRY? An unfunded signer doesn't fail loudly — it
 * fails as one line buried in a cron log while the settle sweep quietly
 * stops paying travelers. Low / unfunded / errored rows are tinted so an
 * operator sees the problem before the crons do.
 */

/** A Stellar account id: "G" + 55 base32 chars. */
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/

/** The contract's fixed faucet grant, in 7-decimal base units. */
const FAUCET_UNITS = 10_000n * 10_000_000n

/**
 * Mock-USDC faucet.
 *
 * The contract's `faucet(to)` is permissionless and mints a fixed 10,000 —
 * anyone can call it for any address, so this is a convenience, not a
 * privilege. It lives here because the Accounts tab is already the
 * "who needs funding" surface, and because funding a fresh test wallet
 * otherwise means connecting as that wallet just to press +MINT.
 *
 * Signed by the CONNECTED wallet (it pays the fee); the recipient is
 * whatever address is in the field. Hidden on mainnet, where mock USDC
 * does not exist.
 */
function FaucetPanel() {
	const { address, signTransaction } = useWallet()
	const [to, setTo] = useState("")
	const [result, setResult] = useState<{ hash?: string; to: string } | null>(null)
	const flow = useTxFlow({ errorFallback: "Faucet failed" })

	// Default to the connected wallet, but only until the operator types.
	const [touched, setTouched] = useState(false)
	useEffect(() => {
		if (!touched && address) setTo(address)
	}, [address, touched])

	if (stellarNetwork === "PUBLIC") return null

	const target = to.trim().toUpperCase()
	const valid = STELLAR_ADDRESS.test(target)
	const busy = flow.state !== "idle" && flow.state !== "error"

	const send = () =>
		flow.run(async (step) => {
			step("verifying")
			const tx = await mockUsdcClient.faucet({ to: target })
			const sent = await tx.signAndSend({ signTransaction: stagedSigner(step, signTransaction) })
			setResult({ hash: txHashOf(sent), to: target })
			return { message: `Sent ${formatUsdc(FAUCET_UNITS)} mock USDC` }
		})

	return (
		<section className="mb-4 border-2 border-line bg-raised p-4">
			<div className="mb-1 flex items-baseline justify-between gap-3">
				<h3 className="label-px text-gold">MOCK USDC FAUCET</h3>
				<span className="font-body text-[11px] text-mute">
					mints a fixed 10,000 · permissionless · testnet only
				</span>
			</div>
			{!address ? (
				<p className="font-body text-[13px] text-mute">
					Connect a wallet first — it signs the mint and pays the fee.
				</p>
			) : (
				<>
					<div className="flex flex-col gap-2 sm:flex-row">
						<input
							value={to}
							onChange={(e) => {
								setTouched(true)
								setTo(e.target.value)
							}}
							spellCheck={false}
							placeholder="G…"
							aria-label="Recipient address"
							className="min-w-0 flex-1 border-2 border-line bg-inset px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-gold"
						/>
						<button
							type="button"
							onClick={() => void send()}
							disabled={!valid || busy}
							className="border-2 border-line bg-inset px-4 py-2 font-display text-[10px] tracking-[0.08em] text-win uppercase hover:border-gold hover:text-gold disabled:opacity-40"
						>
							{busy ? "sending…" : "send 10,000"}
						</button>
						{to !== address && (
							<button
								type="button"
								onClick={() => {
									setTouched(false)
									setTo(address)
								}}
								className="border-2 border-line px-3 py-2 font-display text-[10px] tracking-[0.08em] text-mute uppercase hover:text-ink"
							>
								me
							</button>
						)}
					</div>
					{to.trim() && !valid && (
						<p className="mt-2 font-body text-[12px] text-loss">
							Not a Stellar account id — expected G followed by 55 characters.
						</p>
					)}
					<TxProgress state={flow.state} steps={["verifying", "awaiting", "confirming"]} error={flow.error} />
					{result?.hash && (
						<p className="mt-2 font-body text-[12px] text-mute">
							Sent to <span className="text-ink">{shortAddr(result.to)}</span> ·{" "}
							<a
								href={explorerTxUrl(result.hash)}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sky hover:text-gold"
							>
								view tx
							</a>
						</p>
					)}
				</>
			)}
		</section>
	)
}

function AccountsPanel({ data, loading }: { data: BalancesResponse | null; loading: boolean }) {
	const [copied, setCopied] = useState<string | null>(null)
	const accounts = data?.accounts ?? []

	function copy(address: string) {
		void navigator.clipboard?.writeText(address).then(
			() => {
				setCopied(address)
				setTimeout(() => setCopied(null), 1500)
			},
			() => setCopied(null)
		)
	}

	return (
		<section>
			<h2 className="h-section mb-3">Accounts · operational XLM</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Low-balance line {data?.low_balance_threshold_xlm ?? "—"} XLM
					{data ? ` · read ${relTime(data.as_of)}` : ""}
				</p>
				{data && data.low_count > 0 && (
					<span className="status-px text-loss">
						{data.low_count} account{data.low_count === 1 ? "" : "s"} need funding
					</span>
				)}
			</div>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["", "Role", "Address", "Balance (XLM)", "Source", "Note"].map((h, i) => (
								<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{loading && (
							<tr>
								<td colSpan={6} className="px-3 py-4 text-mute">
									Reading the fuel gauge…
								</td>
							</tr>
						)}
						{!loading && accounts.length === 0 && (
							<tr>
								<td colSpan={6} className="px-3 py-4 text-mute">
									No operational accounts reported.
								</td>
							</tr>
						)}
						{accounts.map((acct) => {
							// Hoisted so the copy handler closes over a narrowed
							// string rather than a re-widened property.
							const address = acct.address
							// Three distinct failures, three distinct reads: out of
							// fuel (loss), not wired up at all / unreadable (gold),
							// healthy (win).
							const bad = acct.low || acct.error != null
							const tone = acct.low
								? "loss"
								: !acct.configured || acct.error != null
									? "gold"
									: "win"
							const rowTint = acct.low
								? "bg-loss/10"
								: !acct.configured || acct.error != null
									? "bg-gold/10"
									: ""
							return (
								<tr
									key={acct.role}
									className={`border-b border-line/60 last:border-b-0 ${rowTint}`}
								>
									<td className="px-3 py-2">
										<Lamp tone={tone} blink={acct.low} />
									</td>
									<td className="px-3 py-2">
										<span className="font-board text-[17px] text-ink">{acct.role}</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										{address ? (
											<span className="flex items-center gap-2">
												<a
													href={explorerAccountUrl(address)}
													target="_blank"
													rel="noopener noreferrer"
													className="footer-link font-board text-[15px]"
													title={address}
												>
													{shortAddr(address)}
												</a>
												<button
													type="button"
													className="btn-px btn-ghost btn-sm"
													onClick={() => copy(address)}
												>
													{copied === address ? "Copied" : "Copy"}
												</button>
											</span>
										) : (
											<span className="text-mute">—</span>
										)}
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<span
											className={`font-board text-[17px] ${bad ? "text-loss" : "text-gold"}`}
										>
											{xlmAmount(acct.balance_xlm)}
										</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-mute">{acct.source}</td>
									<td className="px-3 py-2 text-mute">
										{!acct.configured
											? `not configured — set ${acct.source}`
											: acct.error
												? acct.error
												: !acct.funded
													? "never funded — account does not exist yet"
													: acct.low
														? "below the low-balance line — top up"
														: "ok"}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
			{data && (
				<p className="mt-2 font-body text-[12px] text-mute">Horizon: {data.horizon_url}</p>
			)}
		</section>
	)
}
