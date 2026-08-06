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
import {
	Address,
	BASE_FEE,
	Operation,
	TransactionBuilder,
	rpc,
	xdr,
} from "@stellar/stellar-sdk"
import { explorerAccountUrl, explorerContractUrl, explorerTxUrl } from "../lib/explorer"
import { allowHttpRpc, networkPassphrase, rpcUrl, stellarNetwork } from "../contracts/util"
import { CONTRACT_IDS } from "../contracts/ids"
import { useDebouncedValue } from "../hooks/useDebouncedValue"
import { useWallet } from "../hooks/useWallet"
import { stagedSigner, useTxFlow } from "../hooks/useTxFlow"
import { formatUsdc, mockUsdcClient, useFlightDataBatch } from "../hooks/useContracts"
import oracleClient from "../contracts/oracle_aggregator"
import controllerClient from "../contracts/controller"
import riskVaultClient from "../contracts/risk_vault"
import flightPoolManagerClient from "../contracts/flight_pool_manager"
import governanceClient from "../contracts/governance_module"
import type { FlightData } from "oracle_aggregator"
import type { FlightConfig as PoolFlightConfig } from "flight_pool_manager"
import { fetchBalances } from "../util/wallet"
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
					onClick={() => onPageChange(1)}
					aria-label="First page"
				>
					« First
				</button>
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
				<button
					type="button"
					className="btn-px btn-ghost btn-sm"
					disabled={page >= pageCount}
					onClick={() => onPageChange(pageCount)}
					aria-label="Last page"
				>
					Last »
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
								name="email"
								autoComplete="email"
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
	| "oracle"
	| "funnel"
	| "diagnostics"
	| "exposure"
	| "security"
	| "users"
	| "solvency"
	| "ttl"

const ADMIN_TABS: Array<{ key: AdminTab; label: string }> = [
	{ key: "jobs", label: "Jobs" },
	{ key: "routes", label: "Routes" },
	{ key: "airports", label: "Airports" },
	{ key: "interventions", label: "Interventions" },
	{ key: "outcomes", label: "Outcomes" },
	{ key: "log", label: "Action log" },
	{ key: "accounts", label: "Accounts" },
	{ key: "oracle", label: "Oracle" },
	{ key: "funnel", label: "Funnel" },
	{ key: "diagnostics", label: "Diagnostics" },
	{ key: "exposure", label: "Exposure" },
	{ key: "security", label: "Security" },
	{ key: "users", label: "Users" },
	{ key: "solvency", label: "Solvency" },
	{ key: "ttl", label: "TTL" },
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

	// Also fetched on the Oracle tab: the configured-signer address is what
	// the on-chain authorization is compared against there.
	const balancesQ = useQuery({
		queryKey: ["admin-balances"],
		queryFn: () => api<BalancesResponse>("/api/admin/balances", token),
		enabled: activeTab === "accounts" || activeTab === "oracle",
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	// Oracle overview — direct chain + Horizon reads (public data). The
	// whole active-flight list is fetched up front (paged reads, joined),
	// so search and pagination are instant and client-side; per-flight
	// report data is still only read for the 20 visible rows, via the
	// same batch hook Policies uses.
	const [oraclePage, setOraclePage] = useState(1)
	const [oracleSearch, setOracleSearch] = useState("")
	const oracleNeedle = useDebouncedValue(oracleSearch, 300).trim().toUpperCase()
	const oracleQ = useQuery({
		queryKey: ["admin-oracle"],
		queryFn: fetchOracleOverview,
		enabled: activeTab === "oracle",
		staleTime: 0,
	})
	const oracleFiltered = useMemo(() => {
		const all = oracleQ.data?.flights
		if (!all) return undefined
		if (!oracleNeedle) return all
		return all.filter(([id]) => id.toUpperCase().includes(oracleNeedle))
	}, [oracleQ.data, oracleNeedle])
	const oracleVisible = useMemo(
		() =>
			oracleFiltered?.slice(
				(oraclePage - 1) * ORACLE_REPORT_PAGE,
				oraclePage * ORACLE_REPORT_PAGE
			),
		[oracleFiltered, oraclePage]
	)
	const oracleFlightsQ = useFlightDataBatch(
		activeTab === "oracle" ? oracleVisible : undefined
	)

	// Users overview — DB buyer stats + chain vault reads, re-read on
	// every tab open (staleTime 0) plus a manual Refresh.
	const usersQ = useQuery({
		queryKey: ["admin-users"],
		queryFn: () => api<UsersResponse>("/api/admin/users", token),
		enabled: activeTab === "users",
		staleTime: 0,
	})

	// Solvency — pure chain reads incl. a bounded scan of the pool's open
	// book; the heaviest tab, so strictly on-demand.
	const solvencyQ = useQuery({
		queryKey: ["admin-solvency"],
		queryFn: fetchSolvency,
		enabled: activeTab === "solvency",
		staleTime: 0,
	})

	// Lifecycle funnel — oracle statuses + pool claim windows, scanned
	// on-demand for stuck-state detection.
	const funnelQ = useQuery({
		queryKey: ["admin-funnel"],
		queryFn: fetchLifecycle,
		enabled: activeTab === "funnel",
		staleTime: 0,
	})

	// Diagnostics — the contracts' own "operator attention needed" event
	// channel, live-scanned server-side from ~24h of RPC events.
	const diagnosticsQ = useQuery({
		queryKey: ["admin-diagnostics"],
		queryFn: () => api<DiagnosticsResponse>("/api/admin/diagnostics", token),
		enabled: activeTab === "diagnostics",
		staleTime: 60_000,
	})

	// Exposure gauge — every route/airport concentration fraction, not
	// just the cron's threshold crossings.
	const exposureQ = useQuery({
		queryKey: ["admin-exposure"],
		queryFn: () => api<ExposureResponse>("/api/admin/exposure", token),
		enabled: activeTab === "exposure",
		staleTime: 60_000,
	})

	// Security — fraud-pattern signals from the durable event mirrors.
	const securityQ = useQuery({
		queryKey: ["admin-security"],
		queryFn: () => api<SecurityResponse>("/api/admin/security", token),
		enabled: activeTab === "security",
		staleTime: 60_000,
	})

	// Direct RPC reads (public chain data, no admin API involved) — fetched
	// fresh every time the tab is opened; staleTime 0 so a tab revisit is a
	// re-read, which is the whole point of a storage-expiry inspector.
	const ttlQ = useQuery({
		queryKey: ["admin-ttl"],
		queryFn: fetchContractTtls,
		enabled: activeTab === "ttl",
		staleTime: 0,
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
					<HealthMasthead
						token={token}
						pauses={headerQ.data?.pauses ?? null}
						onNavigate={setActiveTab}
					/>
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
						<>
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
							<DirectControls token={token} onDone={invalidate} />
						</>
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
					{activeTab === "oracle" && (
						<OraclePanel
							data={oracleQ.data ?? null}
							reports={oracleFlightsQ.data ?? []}
							reportsLoading={oracleFlightsQ.isLoading}
							backendOracle={
								balancesQ.data?.accounts.find((a) => a.role === "oracle")?.address ?? null
							}
							loading={oracleQ.isFetching}
							error={oracleQ.error ? errorMessage(oracleQ.error) : null}
							onRefresh={() => void oracleQ.refetch()}
							page={oraclePage}
							onPageChange={setOraclePage}
							search={oracleSearch}
							onSearchChange={(v) => {
								setOracleSearch(v)
								setOraclePage(1)
							}}
							filteredCount={oracleFiltered?.length ?? 0}
						/>
					)}
					{activeTab === "users" && (
						<UsersPanel
							data={usersQ.data ?? null}
							loading={usersQ.isFetching}
							error={usersQ.error ? errorMessage(usersQ.error) : null}
							onRefresh={() => void usersQ.refetch()}
						/>
					)}
					{activeTab === "funnel" && (
						<FunnelPanel
							data={funnelQ.data ?? null}
							loading={funnelQ.isFetching}
							error={funnelQ.error ? errorMessage(funnelQ.error) : null}
							onRefresh={() => void funnelQ.refetch()}
						/>
					)}
					{activeTab === "diagnostics" && (
						<DiagnosticsPanel
							data={diagnosticsQ.data ?? null}
							loading={diagnosticsQ.isFetching}
							error={diagnosticsQ.error ? errorMessage(diagnosticsQ.error) : null}
							onRefresh={() => void diagnosticsQ.refetch()}
						/>
					)}
					{activeTab === "exposure" && (
						<ExposurePanel
							data={exposureQ.data ?? null}
							loading={exposureQ.isFetching}
							error={exposureQ.error ? errorMessage(exposureQ.error) : null}
							onRefresh={() => void exposureQ.refetch()}
						/>
					)}
					{activeTab === "security" && (
						<SecurityPanel
							data={securityQ.data ?? null}
							loading={securityQ.isFetching}
							error={securityQ.error ? errorMessage(securityQ.error) : null}
							onRefresh={() => void securityQ.refetch()}
						/>
					)}
					{activeTab === "solvency" && (
						<SolvencyPanel
							data={solvencyQ.data ?? null}
							loading={solvencyQ.isFetching}
							error={solvencyQ.error ? errorMessage(solvencyQ.error) : null}
							onRefresh={() => void solvencyQ.refetch()}
						/>
					)}
					{activeTab === "ttl" && (
						<TtlPanel
							data={ttlQ.data ?? null}
							loading={ttlQ.isFetching}
							error={ttlQ.error ? errorMessage(ttlQ.error) : null}
							onRefresh={() => void ttlQ.refetch()}
						/>
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
													<>
														<p className="mb-2 font-body text-[12px] text-loss">
															Last error: {last.error ?? "(no message recorded)"}
														</p>
														<p className="mb-2 font-body text-[12px] text-mute">
															Full detail: Vercel → project Logs, function{" "}
															<span className="font-board text-[13px] text-sky">
																{info.path}
															</span>{" "}
															around{" "}
															{new Date(last.ran_at)
																.toISOString()
																.slice(0, 16)
																.replace("T", " ")}{" "}
															UTC — every failing step logs its own error line there.
														</p>
													</>
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
		<section id="interventions-ledger" className="scroll-mt-24">
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

/* ── contract storage TTLs ────────────────────────────────────────── */

/** Rough ledger close time — testnet and mainnet both run ≈5s ledgers;
 *  every date shown is an estimate and labelled as such. */
const LEDGER_SECS = 5

const TTL_CONTRACTS: Array<{ label: string; id: string }> = [
	{ label: "Controller", id: CONTRACT_IDS.controller },
	{ label: "Risk Vault", id: CONTRACT_IDS.riskVault },
	{ label: "Flight Pool Manager", id: CONTRACT_IDS.flightPoolManager },
	{ label: "Oracle Aggregator", id: CONTRACT_IDS.oracleAggregator },
	{ label: "Governance Module", id: CONTRACT_IDS.governanceModule },
	{ label: "Mock USDC", id: CONTRACT_IDS.mockUsdc },
]

interface ContractTtlRow {
	label: string
	id: string
	/** instance entry live-until ledger (null = not found / archived) */
	instanceLiveUntil: number | null
	/** wasm code entry live-until ledger (null = unknown) */
	codeLiveUntil: number | null
}

interface ContractTtlData {
	currentLedger: number
	rows: ContractTtlRow[]
}

/**
 * Instance + wasm-code TTLs for every deployed contract, read straight
 * from RPC (public chain data — no admin API or signer involved). The
 * instance entry's TTL covers the contract instance and all its
 * instance storage; individual Persistent keys (FlightConfig, Route,
 * TravelerFlights, …) carry their own per-key TTLs, which RPC cannot
 * enumerate — the weekly ttl_extender shard rotation keeps those alive.
 */
async function fetchContractTtls(): Promise<ContractTtlData> {
	const server = new rpc.Server(rpcUrl, { allowHttp: allowHttpRpc })
	const instanceKeys = TTL_CONTRACTS.map((c) =>
		xdr.LedgerKey.contractData(
			new xdr.LedgerKeyContractData({
				contract: new Address(c.id).toScAddress(),
				key: xdr.ScVal.scvLedgerKeyContractInstance(),
				durability: xdr.ContractDataDurability.persistent(),
			})
		)
	)
	const instRes = await server.getLedgerEntries(...instanceKeys)
	const instByKey = new Map(instRes.entries.map((e) => [e.key.toXDR("base64"), e]))

	// wasm hash per contract → one code-entry lookup per distinct hash
	const codeKeyByHash = new Map<string, xdr.LedgerKey>()
	const hashOfContract = new Map<string, string>()
	for (let i = 0; i < TTL_CONTRACTS.length; i++) {
		const entry = instByKey.get(instanceKeys[i].toXDR("base64"))
		if (!entry) continue
		const exec = entry.val.contractData().val().instance().executable()
		if (exec.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
			const hash = exec.wasmHash()
			const b64 = hash.toString("base64")
			if (!codeKeyByHash.has(b64)) {
				codeKeyByHash.set(
					b64,
					xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }))
				)
			}
			hashOfContract.set(TTL_CONTRACTS[i].id, b64)
		}
	}
	const codeKeys = [...codeKeyByHash.values()]
	const codeTtlByHash = new Map<string, number | null>()
	if (codeKeys.length > 0) {
		const codeRes = await server.getLedgerEntries(...codeKeys)
		for (const e of codeRes.entries) {
			codeTtlByHash.set(
				e.key.contractCode().hash().toString("base64"),
				e.liveUntilLedgerSeq ?? null
			)
		}
	}

	return {
		currentLedger: instRes.latestLedger,
		rows: TTL_CONTRACTS.map((c, i) => {
			const entry = instByKey.get(instanceKeys[i].toXDR("base64"))
			const hashB64 = hashOfContract.get(c.id)
			return {
				label: c.label,
				id: c.id,
				instanceLiveUntil: entry?.liveUntilLedgerSeq ?? null,
				codeLiveUntil: hashB64 != null ? (codeTtlByHash.get(hashB64) ?? null) : null,
			}
		}),
	}
}

/** "≈ 92d · 2026-11-06 · ledger 1,234,567" with an urgency tone. */
function TtlCell({ liveUntil, current }: { liveUntil: number | null; current: number }) {
	if (liveUntil == null) {
		return <span className="status-px text-loss">not found / archived</span>
	}
	const ms = (liveUntil - current) * LEDGER_SECS * 1000
	const days = ms / 86_400_000
	const tone = days < 7 ? "text-loss" : days < 30 ? "text-gold" : "text-win"
	return (
		<span className="whitespace-nowrap">
			<span className={`font-board text-[16px] ${tone}`}>
				≈ {days.toFixed(days < 10 ? 1 : 0)}d
			</span>{" "}
			<span className="text-mute">
				· {new Date(Date.now() + ms).toISOString().slice(0, 10)} · ledger{" "}
				{liveUntil.toLocaleString("en-US")}
			</span>
		</span>
	)
}

function TtlPanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: ContractTtlData | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	return (
		<section>
			<h2 className="h-section mb-3">Contracts · storage TTL</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Live-until ledgers read straight from RPC
					{data ? ` · current ledger ${data.currentLedger.toLocaleString("en-US")}` : ""} · dates
					assume ≈{LEDGER_SECS}s ledgers
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Reading…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">RPC read failed: {error}</p>
			)}
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["Contract", "Address", "Instance TTL", "Wasm code TTL"].map((h, i) => (
								<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{loading && !data && (
							<tr>
								<td colSpan={4} className="px-3 py-4 text-mute">
									Reading ledger entries…
								</td>
							</tr>
						)}
						{data?.rows.map((row) => (
							<tr key={row.id} className="border-b border-line/60 last:border-b-0">
								<td className="px-3 py-2">
									<span className="font-board text-[17px] text-ink">{row.label}</span>
								</td>
								<td className="px-3 py-2 whitespace-nowrap">
									<a
										href={explorerContractUrl(row.id)}
										target="_blank"
										rel="noopener noreferrer"
										className="footer-link font-board text-[15px]"
										title={row.id}
									>
										{shortAddr(row.id)}
									</a>
								</td>
								<td className="px-3 py-2">
									<TtlCell liveUntil={row.instanceLiveUntil} current={data.currentLedger} />
								</td>
								<td className="px-3 py-2">
									<TtlCell liveUntil={row.codeLiveUntil} current={data.currentLedger} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="mt-2 font-body text-[12px] text-mute">
				The instance TTL covers the contract instance and everything in instance storage.
				Per-key Persistent entries (flight configs, routes, traveler indexes, claimable
				balances) carry their own TTLs, which RPC cannot list — the weekly ttl_extender
				job keeps those extended on its shard rotation.
			</p>
		</section>
	)
}

/* ── oracle overview ──────────────────────────────────────────────── */

interface OracleOverview {
	/** oracle account the OracleAggregator contract trusts, read on-chain */
	authorizedOracle: string
	paused: boolean
	version: number
	activeCount: number
	pendingOutcomes: bigint
	/** oracle account's XLM (Horizon display string); null = unfunded/unreadable */
	xlm: string | null
	/** the complete active flight list — searched/paged client-side */
	flights: Array<readonly [string, bigint]>
}

const ORACLE_REPORT_PAGE = 20
// Full-list fetch cap: 50 paged reads = 1,000 listed flights. The 7-day
// prune retention keeps the real list far below this; the cap only stops
// a pathological list from turning into an RPC storm.
const ORACLE_MAX_PAGES = 50

/** Public chain + Horizon reads only — no admin API, no signer. */
async function fetchOracleOverview(): Promise<OracleOverview> {
	const [auth, paused, version, count, pending] = await Promise.all([
		oracleClient.get_authorized_oracle(),
		oracleClient.paused(),
		oracleClient.version(),
		oracleClient.get_active_flight_count(),
		oracleClient.get_pending_outcomes(),
	])
	const activeCount = Number(count.result)
	const pageCount = Math.min(Math.ceil(activeCount / ORACLE_REPORT_PAGE), ORACLE_MAX_PAGES)
	const pages = await Promise.all(
		Array.from({ length: pageCount }, (_, i) =>
			oracleClient.get_active_flights_page({
				offset: i * ORACLE_REPORT_PAGE,
				limit: ORACLE_REPORT_PAGE,
			})
		)
	)
	const authorizedOracle = auth.result
	let xlm: string | null = null
	try {
		const balances = await fetchBalances(authorizedOracle)
		xlm = balances.xlm?.displayBalance ?? null
	} catch {
		xlm = null
	}
	return {
		authorizedOracle,
		paused: paused.result,
		version: Number(version.result),
		activeCount,
		pendingOutcomes: pending.result,
		xlm,
		flights: pages.flatMap((p) => p.result),
	}
}

/** Unix seconds → "YYYY-MM-DD HH:MM UTC", or an em-dash for 0/unset. */
function utcSecs(v: bigint | number | undefined): string {
	const n = Number(v ?? 0)
	if (n <= 0) return "—"
	return `${new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

const ORACLE_STATUS_TONE: Record<string, string> = {
	NotInitiated: "text-mute",
	Active: "text-sky",
	Landed: "text-win",
	Cancelled: "text-loss",
	ToBeSettledOnTime: "text-gold",
	ToBeSettledDelayed: "text-gold",
	ToBeSettledCancelled: "text-gold",
	Settled: "text-mute",
}

function OraclePanel({
	data,
	reports,
	reportsLoading,
	backendOracle,
	loading,
	error,
	onRefresh,
	page,
	onPageChange,
	search,
	onSearchChange,
	filteredCount,
}: {
	data: OracleOverview | null
	reports: Array<{ flightId: string; date: bigint; data: FlightData | null; error: boolean }>
	reportsLoading: boolean
	backendOracle: string | null
	loading: boolean
	error: string | null
	onRefresh: () => void
	page: number
	onPageChange: (page: number) => void
	search: string
	onSearchChange: (value: string) => void
	filteredCount: number
}) {
	const keyMatch =
		data === null || backendOracle === null ? null : backendOracle === data.authorizedOracle

	return (
		<section>
			<h2 className="h-section mb-3">Oracle · identity &amp; reports</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Read straight from the OracleAggregator contract and Horizon on tab open
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Reading…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Chain read failed: {error}</p>
			)}

			<div className="panel mb-4 overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<tbody className="font-body text-[13px]">
						<tr className="border-b border-line/60">
							<td className="label-px px-3 py-2 whitespace-nowrap">Authorized oracle</td>
							<td className="px-3 py-2">
								{data ? (
									<a
										href={explorerAccountUrl(data.authorizedOracle)}
										target="_blank"
										rel="noopener noreferrer"
										className="footer-link font-board text-[15px]"
										title={data.authorizedOracle}
									>
										{data.authorizedOracle}
									</a>
								) : (
									<span className="text-mute">…</span>
								)}
							</td>
						</tr>
						<tr className="border-b border-line/60">
							<td className="label-px px-3 py-2 whitespace-nowrap">Backend signer</td>
							<td className="px-3 py-2">
								{keyMatch === null ? (
									<span className="text-mute">
										{backendOracle === null
											? "ORACLE_SECRET_KEY not readable (balances API)"
											: "…"}
									</span>
								) : (
									<span className="flex items-center gap-2">
										<Lamp tone={keyMatch ? "win" : "loss"} blink={!keyMatch} />
										<span className={keyMatch ? "text-win" : "text-loss"}>
											{keyMatch
												? "matches the on-chain authorization"
												: `MISMATCH — backend signs as ${shortAddr(backendOracle ?? "")}; its reports will be rejected`}
										</span>
									</span>
								)}
							</td>
						</tr>
						<tr className="border-b border-line/60">
							<td className="label-px px-3 py-2 whitespace-nowrap">XLM balance</td>
							<td className="px-3 py-2">
								<span className="font-board text-[17px] text-gold">
									{data ? (data.xlm ?? "unfunded") : "…"}
								</span>
								<span className="ml-2 text-[12px] text-mute">
									fee fuel for oracle-signed reports (also on the Accounts tab)
								</span>
							</td>
						</tr>
						<tr className="border-b border-line/60">
							<td className="label-px px-3 py-2 whitespace-nowrap">Aggregator state</td>
							<td className="px-3 py-2">
								{data ? (
									<span className="flex flex-wrap items-center gap-3">
										<span className="flex items-center gap-2">
											<Lamp tone={data.paused ? "loss" : "win"} blink={data.paused} />
											<span className={data.paused ? "text-loss" : "text-win"}>
												{data.paused ? "PAUSED — reports rejected" : "accepting reports"}
											</span>
										</span>
										<span className="text-mute">· contract v{data.version}</span>
									</span>
								) : (
									<span className="text-mute">…</span>
								)}
							</td>
						</tr>
						<tr>
							<td className="label-px px-3 py-2 whitespace-nowrap">Workload</td>
							<td className="px-3 py-2">
								{data ? (
									<span>
										<span className="font-board text-[17px] text-ink">
											{data.activeCount}
										</span>{" "}
										<span className="text-mute">listed flights ·</span>{" "}
										<span
											className={`font-board text-[17px] ${data.pendingOutcomes > 0n ? "text-gold" : "text-ink"}`}
										>
											{String(data.pendingOutcomes)}
										</span>{" "}
										<span className="text-mute">
											outcomes awaiting settlement
										</span>
									</span>
								) : (
									<span className="text-mute">…</span>
								)}
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<div className="mb-2 flex flex-wrap items-center justify-between gap-3">
				<h3 className="label-px text-sky">
					Reported flight state
					{data
						? search.trim()
							? ` — ${filteredCount} of ${data.activeCount} match`
							: ` — ${data.activeCount} listed`
						: ""}
				</h3>
				<input
					className="field-px w-56"
					value={search}
					onChange={(e) => onSearchChange(e.target.value)}
					placeholder="Search flight… (AA100)"
					aria-label="Search by flight number"
					spellCheck={false}
				/>
			</div>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["Flight", "Departure (UTC)", "Status", "Scheduled arrival", "Actual arrival", "Settled at"].map(
								(h, i) => (
									<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
										{h}
									</th>
								)
							)}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{(loading || reportsLoading) && reports.length === 0 && (
							<tr>
								<td colSpan={6} className="px-3 py-4 text-mute">
									Reading flight reports…
								</td>
							</tr>
						)}
						{!loading && !reportsLoading && reports.length === 0 && (
							<tr>
								<td colSpan={6} className="px-3 py-4 text-mute">
									{search.trim()
										? `No listed flight matches "${search.trim()}".`
										: "No flights listed on the aggregator right now."}
								</td>
							</tr>
						)}
						{reports.map((r) => {
							const tag = r.data?.status.tag
							return (
								<tr
									key={`${r.flightId}:${r.date}`}
									className="border-b border-line/60 last:border-b-0"
								>
									<td className="px-3 py-2">
										<span className="font-board text-[16px] text-ink">{r.flightId}</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-dim">{utcSecs(r.date)}</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<span className={`status-px ${tag ? (ORACLE_STATUS_TONE[tag] ?? "text-mute") : "text-loss"}`}>
											{r.error ? "read failed" : (tag ?? "—")}
										</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-dim">
										{utcSecs(r.data?.estimated_arrival_time)}
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-dim">
										{utcSecs(r.data?.actual_arrival_time)}
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-mute">
										{utcSecs(r.data?.settled_at)}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
			{data && (
				<Pager
					page={page}
					onPageChange={onPageChange}
					total={filteredCount}
					limit={ORACLE_REPORT_PAGE}
					label={
						search.trim()
							? `${filteredCount} match${filteredCount === 1 ? "" : "es"} of ${data.activeCount} listed`
							: `${data.activeCount} flight${data.activeCount === 1 ? "" : "s"} listed on-chain`
					}
				/>
			)}
			<p className="mt-2 font-body text-[12px] text-mute">
				Every row is on-chain state the oracle wrote: the scheduled arrival at
				activation, then landed / cancelled outcomes (the fetcher cron signs these).
				ToBeSettled* means an outcome is reported and waiting for the settler.
			</p>
		</section>
	)
}

/* ── users overview ───────────────────────────────────────────────── */

/** api/admin/users.ts — buyer stats (DB mirror) + vault reads (chain). */
interface UsersResponse {
	policy_holders: {
		unique_buyers: number
		policies: number
		premium_units_total: string
		payoff_units_total: string
		top: Array<{
			buyer: string
			policies: number
			premium_units: string
			payoff_units: string
			last_at: string
		}>
	} | null
	vault: {
		total_shares: string
		total_assets: string
		deposit_queue: { count: number; assets_units_total: string; unique_owners: number }
		withdrawal_queue: { count: number; shares_total: string; unique_owners: number }
		top_positions: Array<{ address: string; shares: string; assets_units: string }>
		holders_probed: number
		holders_with_shares: number
	}
	as_of: string
}

/** RVS shares carry 10 decimals (asset 7 + virtual offset 3). */
function sharesAmount(units: string): string {
	return (Number(units) / 1e10).toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function usdcAmount(units: string): string {
	return formatUsdc(BigInt(units))
}

function AddressCell({ address }: { address: string }) {
	return (
		<a
			href={explorerAccountUrl(address)}
			target="_blank"
			rel="noopener noreferrer"
			className="footer-link font-board text-[15px]"
			title={address}
		>
			{shortAddr(address)}
		</a>
	)
}

function UsersPanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: UsersResponse | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	const ph = data?.policy_holders ?? null
	const vault = data?.vault ?? null
	return (
		<section>
			<h2 className="h-section mb-3">Users · travelers &amp; underwriters</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Buyers from the policies event mirror · vault from chain
					{data ? ` · read ${relTime(data.as_of)}` : ""}
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Reading…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Read failed: {error}</p>
			)}
			{loading && !data && (
				<p className="font-body text-[13px] text-mute">Counting heads…</p>
			)}

			{/* ── travelers ── */}
			<h3 className="label-px mb-2 text-sky">Policy holders</h3>
			{data && ph === null && (
				<p className="mb-4 font-body text-[13px] text-gold">
					Governance DB not configured — buyer stats unavailable in this deployment.
				</p>
			)}
			{ph && (
				<>
					<div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 font-body text-[13px]">
						<span>
							<span className="font-board text-[18px] text-ink">{ph.unique_buyers}</span>{" "}
							<span className="text-mute">unique buyers</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-ink">{ph.policies}</span>{" "}
							<span className="text-mute">policies bought</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-gold">
								{usdcAmount(ph.premium_units_total)}
							</span>{" "}
							<span className="text-mute">USDC premiums paid</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-gold">
								{usdcAmount(ph.payoff_units_total)}
							</span>{" "}
							<span className="text-mute">USDC payoff written</span>
						</span>
					</div>
					<div className="panel mb-5 overflow-x-auto">
						<table className="w-full border-collapse text-left">
							<thead>
								<tr className="border-b-2 border-line">
									{["#", "Buyer", "Policies", "Premiums paid", "Payoff written", "Last purchase"].map(
										(h, i) => (
											<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
												{h}
											</th>
										)
									)}
								</tr>
							</thead>
							<tbody className="font-body text-[13px]">
								{ph.top.length === 0 && (
									<tr>
										<td colSpan={6} className="px-3 py-4 text-mute">
											No policies bought yet.
										</td>
									</tr>
								)}
								{ph.top.map((b, i) => (
									<tr key={b.buyer} className="border-b border-line/60 last:border-b-0">
										<td className="px-3 py-2 text-mute">{i + 1}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<AddressCell address={b.buyer} />
										</td>
										<td className="px-3 py-2">
											<span className="font-board text-[16px] text-ink">{b.policies}</span>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className="font-board text-[16px] text-gold">
												{usdcAmount(b.premium_units)}
											</span>{" "}
											<span className="text-mute">USDC</span>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className="font-board text-[16px] text-dim">
												{usdcAmount(b.payoff_units)}
											</span>{" "}
											<span className="text-mute">USDC</span>
										</td>
										<td className="px-3 py-2 whitespace-nowrap text-dim">{relTime(b.last_at)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			)}

			{/* ── underwriters ── */}
			<h3 className="label-px mb-2 text-sky">Underwriters (vault)</h3>
			{vault && (
				<>
					<div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 font-body text-[13px]">
						<span>
							<span className="font-board text-[18px] text-ink">
								{usdcAmount(vault.total_assets)}
							</span>{" "}
							<span className="text-mute">USDC TVL</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-ink">
								{sharesAmount(vault.total_shares)}
							</span>{" "}
							<span className="text-mute">shares outstanding</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-ink">
								{vault.holders_with_shares}
							</span>{" "}
							<span className="text-mute">
								holder{vault.holders_with_shares === 1 ? "" : "s"} found (of{" "}
								{vault.holders_probed} probed)
							</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-dim">
								{vault.deposit_queue.count}
							</span>{" "}
							<span className="text-mute">
								queued deposit{vault.deposit_queue.count === 1 ? "" : "s"} (
								{usdcAmount(vault.deposit_queue.assets_units_total)} USDC)
							</span>
						</span>
						<span>
							<span className="font-board text-[18px] text-dim">
								{vault.withdrawal_queue.count}
							</span>{" "}
							<span className="text-mute">
								queued withdrawal{vault.withdrawal_queue.count === 1 ? "" : "s"} (
								{sharesAmount(vault.withdrawal_queue.shares_total)} shares)
							</span>
						</span>
					</div>
					<div className="panel overflow-x-auto">
						<table className="w-full border-collapse text-left">
							<thead>
								<tr className="border-b-2 border-line">
									{["#", "Underwriter", "Shares", "Current value"].map((h, i) => (
										<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="font-body text-[13px]">
								{vault.top_positions.length === 0 && (
									<tr>
										<td colSpan={4} className="px-3 py-4 text-mute">
											No share balances found among known addresses.
										</td>
									</tr>
								)}
								{vault.top_positions.map((p, i) => (
									<tr key={p.address} className="border-b border-line/60 last:border-b-0">
										<td className="px-3 py-2 text-mute">{i + 1}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<AddressCell address={p.address} />
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className="font-board text-[16px] text-ink">
												{sharesAmount(p.shares)}
											</span>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className="font-board text-[16px] text-gold">
												{usdcAmount(p.assets_units)}
											</span>{" "}
											<span className="text-mute">USDC</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="mt-2 font-body text-[12px] text-mute">
						Share holders cannot be enumerated on-chain, so positions are probed across
						every address the protocol has seen (policy buyers + currently queued LPs,
						capped at 200). An underwriter who never bought a policy and has nothing
						queued right now will hold shares without appearing here.
					</p>
				</>
			)}
		</section>
	)
}

/* ── direct controls (interventions tab) ──────────────────────────── */

/** The structural surface every pausable contract client shares — the
 *  generated Client classes are distinct types, so the board talks to
 *  them through this narrowed shape. */
type WalletSignTx = ReturnType<typeof useWallet>["signTransaction"]

interface PausableClient {
	paused(): Promise<{ result: boolean }>
	pause(args: { caller: string }): Promise<{
		signAndSend(opts?: { signTransaction?: WalletSignTx }): Promise<unknown>
	}>
	unpause(args: { caller: string }): Promise<{
		signAndSend(opts?: { signTransaction?: WalletSignTx }): Promise<unknown>
	}>
}

const PAUSABLE_CONTRACTS: Array<{
	key: string
	label: string
	client: PausableClient
	note: string
}> = [
	{
		key: "controller",
		label: "Controller",
		client: controllerClient as unknown as PausableClient,
		note: "halts every purchase and settlement entry point",
	},
	{
		key: "risk_vault",
		label: "Risk Vault",
		client: riskVaultClient as unknown as PausableClient,
		note: "halts deposits, withdrawals and queue processing",
	},
	{
		key: "flight_pool_manager",
		label: "Flight Pool Manager",
		client: flightPoolManagerClient as unknown as PausableClient,
		note: "halts claims and premium flows",
	},
	{
		key: "oracle_aggregator",
		label: "Oracle Aggregator",
		client: oracleClient as unknown as PausableClient,
		note: "halts flight reports (close_sale stays pause-exempt)",
	},
	{
		key: "governance_module",
		label: "Governance Module",
		client: governanceClient as unknown as PausableClient,
		note: "CAUTION: also blocks disable/remove route while paused — routes keep selling",
	},
]

/** Buffer type as the bindings declare it — derived instead of named, the
 *  app tsconfig has no node types (see the TTL board's same constraint). */
type WasmBuffer = Parameters<(typeof controllerClient)["upgrade"]>[0]["wasm_hash"]

/** Vite's buffer polyfill provides the global at runtime. */
const toWasmBuffer = (bytes: Uint8Array): WasmBuffer =>
	(globalThis as unknown as { Buffer: { from(b: Uint8Array): WasmBuffer } }).Buffer.from(
		bytes
	)

interface UpgradableClient {
	upgrade(args: { wasm_hash: WasmBuffer }): Promise<{
		signAndSend(opts?: { signTransaction?: WalletSignTx }): Promise<unknown>
	}>
	version(): Promise<{ result: number }>
}

const UPGRADABLE_CONTRACTS: Array<{ key: string; label: string; client: UpgradableClient }> = [
	{ key: "controller", label: "Controller", client: controllerClient as unknown as UpgradableClient },
	{ key: "risk_vault", label: "Risk Vault", client: riskVaultClient as unknown as UpgradableClient },
	{ key: "flight_pool_manager", label: "Flight Pool Manager", client: flightPoolManagerClient as unknown as UpgradableClient },
	{ key: "oracle_aggregator", label: "Oracle Aggregator", client: oracleClient as unknown as UpgradableClient },
	{ key: "governance_module", label: "Governance Module", client: governanceClient as unknown as UpgradableClient },
	{ key: "mock_usdc", label: "Mock USDC", client: mockUsdcClient as unknown as UpgradableClient },
]

function DirectControls({ token, onDone }: { token: string; onDone: () => void }) {
	const { address, signTransaction } = useWallet()

	// paused() ×5 + the buyer-whitelist gate, re-read after every action
	const statusQ = useQuery({
		queryKey: ["admin-controls-status"],
		queryFn: async () => {
			const [gate, ...paused] = await Promise.all([
				controllerClient.whitelist_enabled(),
				...PAUSABLE_CONTRACTS.map((c) => c.client.paused()),
			])
			return {
				whitelistEnabled: gate.result,
				paused: Object.fromEntries(
					PAUSABLE_CONTRACTS.map((c, i) => [c.key, paused[i]?.result ?? false])
				) as Record<string, boolean>,
			}
		},
		staleTime: 0,
	})

	// owner-signed calls (contract pause + whitelist gate) — the owner
	// secret never reaches the server, so these sign with the connected
	// wallet; a non-owner wallet fails auth on-chain and surfaces here.
	const flow = useTxFlow({ errorFallback: "Owner-signed call failed", notifyError: true })
	const [busyKey, setBusyKey] = useState<string | null>(null)
	const walletBusy = flow.state !== "idle" && flow.state !== "error"

	const ownerRun = (key: string, fn: (step: (s: TxState) => void) => Promise<{ message: string; txHash?: string }>) => {
		setBusyKey(key)
		void flow
			.run(async (step) => {
				const out = await fn(step)
				await statusQ.refetch()
				onDone()
				return out
			})
			.finally(() => setBusyKey(null))
	}

	const togglePause = (c: (typeof PAUSABLE_CONTRACTS)[number]) => {
		if (!address) return
		const isPaused = statusQ.data?.paused[c.key] ?? false
		ownerRun(c.key, async (step) => {
			step("verifying")
			const tx = isPaused
				? await c.client.unpause({ caller: address })
				: await c.client.pause({ caller: address })
			const sent = await tx.signAndSend({
				signTransaction: stagedSigner(step, signTransaction),
			})
			return {
				message: `${c.label} ${isPaused ? "unpaused" : "PAUSED"}`,
				txHash: txHashOf(sent),
			}
		})
	}

	const toggleGate = () => {
		const enabled = statusQ.data?.whitelistEnabled ?? false
		ownerRun("whitelist_gate", async (step) => {
			step("verifying")
			const tx = await controllerClient.set_whitelist_enabled({ enabled: !enabled })
			const sent = await tx.signAndSend({
				signTransaction: stagedSigner(step, signTransaction),
			})
			return {
				message: `Buyer whitelist gate ${enabled ? "disabled — open to anyone" : "ENABLED — approved buyers only"}`,
				txHash: txHashOf(sent),
			}
		})
	}

	// gov-admin-signed calls (server side, audited in actions_log)
	const [buyerAddr, setBuyerAddr] = useState("")
	const [buyerNote, setBuyerNote] = useState<string | null>(null)
	const buyerTarget = buyerAddr.trim().toUpperCase()
	const buyerValid = STELLAR_ADDRESS.test(buyerTarget)
	const buyerMut = useMutation({
		mutationFn: (p: { action: "buyer_add" | "buyer_remove"; addr: string }) =>
			api<{ ok: boolean; tx_hash: string | null }>("/api/admin/controls", token, {
				method: "POST",
				body: JSON.stringify(p),
			}),
		onSuccess: (r, p) => {
			setBuyerNote(
				`${p.action === "buyer_add" ? "Added" : "Removed"} ${shortAddr(p.addr)}${r.tx_hash ? ` — tx ${r.tx_hash.slice(0, 8)}…` : ""}`
			)
			onDone()
		},
		onError: () => setBuyerNote(null),
	})
	const checkBuyer = async () => {
		try {
			const tx = await controllerClient.is_whitelisted({ addr: buyerTarget })
			setBuyerNote(
				`${shortAddr(buyerTarget)} is ${tx.result ? "WHITELISTED (valid approval)" : "not whitelisted"}`
			)
		} catch (err) {
			setBuyerNote(`Check failed: ${errorMessage(err)}`)
		}
	}

	const [rmFlight, setRmFlight] = useState("")
	const [rmOrigin, setRmOrigin] = useState("")
	const [rmDest, setRmDest] = useState("")
	const [rmNote, setRmNote] = useState<string | null>(null)
	const removeMut = useMutation({
		mutationFn: () =>
			api<{ ok: boolean; tx_hash: string | null }>("/api/admin/controls", token, {
				method: "POST",
				body: JSON.stringify({
					action: "remove_route",
					flight_id: rmFlight.trim().toUpperCase(),
					origin: rmOrigin.trim().toUpperCase(),
					dest: rmDest.trim().toUpperCase(),
				}),
			}),
		onSuccess: (r) => {
			setRmNote(
				`Route removed${r.tx_hash ? ` — tx ${r.tx_hash.slice(0, 8)}…` : ""}`
			)
			setRmFlight("")
			setRmOrigin("")
			setRmDest("")
			onDone()
		},
		onError: () => setRmNote(null),
	})
	const rmValid = rmFlight.trim() !== "" && rmOrigin.trim() !== "" && rmDest.trim() !== ""

	// ── contract upgrade (upload wasm → owner-signed upgrade) ──
	const [upgKey, setUpgKey] = useState("controller")
	const [upgFile, setUpgFile] = useState<{
		name: string
		size: number
		bytes: Uint8Array
		hashBytes: Uint8Array
		hashHex: string
	} | null>(null)
	/** null = unknown/checking; the upload step is skippable when true */
	const [upgInstalled, setUpgInstalled] = useState<boolean | null>(null)
	const [upgVersion, setUpgVersion] = useState<number | null>(null)
	const upgTarget = UPGRADABLE_CONTRACTS.find((c) => c.key === upgKey) ?? UPGRADABLE_CONTRACTS[0]!

	useEffect(() => {
		setUpgVersion(null)
		let disposed = false
		upgTarget.client
			.version()
			.then((tx) => {
				if (!disposed) setUpgVersion(Number(tx.result))
			})
			.catch(() => {
				if (!disposed) setUpgVersion(null)
			})
		return () => {
			disposed = true
		}
	}, [upgTarget])

	const onWasmChosen = async (file: File) => {
		const buf = new Uint8Array(await file.arrayBuffer())
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf))
		const hashHex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("")
		setUpgFile({ name: file.name, size: buf.length, bytes: buf, hashBytes: digest, hashHex })
		// wasm code entries are content-addressed — presence of the hash's
		// ledger entry means the upload step is already done
		setUpgInstalled(null)
		try {
			const server = new rpc.Server(rpcUrl, { allowHttp: allowHttpRpc })
			const codeKey = xdr.LedgerKey.contractCode(
				new xdr.LedgerKeyContractCode({ hash: toWasmBuffer(digest) })
			)
			const res = await server.getLedgerEntries(codeKey)
			setUpgInstalled(res.entries.length > 0)
		} catch {
			setUpgInstalled(false)
		}
	}

	const uploadWasm = () => {
		const file = upgFile
		if (!file || !address) return
		ownerRun("upgrade_upload", async (step) => {
			step("verifying")
			const server = new rpc.Server(rpcUrl, { allowHttp: allowHttpRpc })
			const account = await server.getAccount(address)
			const tx = new TransactionBuilder(account, {
				fee: (Number(BASE_FEE) * 100).toString(),
				networkPassphrase,
			})
				.addOperation(Operation.uploadContractWasm({ wasm: toWasmBuffer(file.bytes) }))
				.setTimeout(120)
				.build()
			const prepared = await server.prepareTransaction(tx)
			step("awaiting")
			const { signedTxXdr } = await signTransaction(prepared.toXDR())
			step("confirming")
			const sent = await server.sendTransaction(
				TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase)
			)
			if (sent.status === "ERROR") throw new Error("wasm upload submission rejected")
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 1000))
				const res = await server.getTransaction(sent.hash)
				if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) {
					setUpgInstalled(true)
					return { message: `Wasm installed (${file.hashHex.slice(0, 8)}…)`, txHash: sent.hash }
				}
				if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
					throw new Error(`wasm upload failed on-chain (tx ${sent.hash})`)
				}
			}
			throw new Error(`timed out waiting for upload tx ${sent.hash}`)
		})
	}

	const runUpgrade = () => {
		const file = upgFile
		if (!file) return
		ownerRun("upgrade_call", async (step) => {
			step("verifying")
			const tx = await upgTarget.client.upgrade({ wasm_hash: toWasmBuffer(file.hashBytes) })
			const sent = await tx.signAndSend({
				signTransaction: stagedSigner(step, signTransaction),
			})
			const v = await upgTarget.client.version().catch(() => null)
			if (v) setUpgVersion(Number(v.result))
			return {
				message: `${upgTarget.label} upgraded${v ? ` to v${Number(v.result)}` : ""}`,
				txHash: txHashOf(sent),
			}
		})
	}

	const inputClass =
		"min-w-0 border-2 border-line bg-inset px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-gold"

	return (
		<section className="mt-8">
			<h2 className="h-section mb-3">Direct controls</h2>
			<p className="mb-4 font-body text-[13px] text-mute">
				Route pauses live in the ledger above. These are the sharper tools: contract
				pause switches and the whitelist-gate toggle are owner-only and sign with
				your connected wallet; buyer add/remove and route removal run server-side
				with the gov-admin key and land in the action log.
			</p>

			{/* ── contract pause board ── */}
			<h3 id="contract-pause-board" className="label-px mb-2 scroll-mt-24 text-sky">
				Contract pause · owner wallet
			</h3>
			{!address && (
				<p className="mb-2 font-body text-[13px] text-gold">
					Connect the contract-owner wallet (top right) to pause or unpause.
				</p>
			)}
			<div className="panel mb-2 overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<tbody className="font-body text-[13px]">
						{PAUSABLE_CONTRACTS.map((c) => {
							const isPaused = statusQ.data?.paused[c.key]
							return (
								<tr key={c.key} className="border-b border-line/60 last:border-b-0">
									<td className="px-3 py-2">
										<span className="font-board text-[16px] text-ink">{c.label}</span>
										<span className="block text-[12px] text-mute">{c.note}</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<span className="flex items-center gap-2">
											<Lamp
												tone={isPaused === undefined ? "gold" : isPaused ? "loss" : "win"}
												blink={isPaused === true}
											/>
											<span className={isPaused ? "text-loss" : "text-win"}>
												{isPaused === undefined ? "…" : isPaused ? "PAUSED" : "live"}
											</span>
										</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<button
											type="button"
											className={`btn-px btn-sm ${isPaused ? "btn-gold" : "btn-ghost"}`}
											disabled={!address || walletBusy || isPaused === undefined}
											onClick={() => togglePause(c)}
										>
											{busyKey === c.key && walletBusy
												? "Signing…"
												: isPaused
													? "Unpause"
													: "Pause"}
										</button>
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
			{walletBusy && busyKey !== null && (
				<TxProgress state={flow.state} steps={["verifying", "awaiting", "confirming"]} />
			)}

			{/* ── buyer whitelist ── */}
			<h3 className="label-px mt-5 mb-2 text-sky">Buyer whitelist</h3>
			<p className="mb-2 font-body text-[13px]">
				<span className="text-mute">Gate:</span>{" "}
				<span
					className={
						statusQ.data?.whitelistEnabled ? "text-gold" : "text-win"
					}
				>
					{statusQ.data === undefined
						? "…"
						: statusQ.data.whitelistEnabled
							? "ENABLED — only approved buyers can purchase"
							: "disabled — anyone can purchase"}
				</span>{" "}
				<button
					type="button"
					className="btn-px btn-ghost btn-sm ml-2"
					disabled={!address || walletBusy || statusQ.data === undefined}
					onClick={toggleGate}
					title="Owner-only on-chain — signs with the connected wallet"
				>
					{busyKey === "whitelist_gate" && walletBusy
						? "Signing…"
						: statusQ.data?.whitelistEnabled
							? "Disable gate"
							: "Enable gate"}
				</button>
			</p>
			<div className="flex flex-col gap-2 sm:flex-row">
				<input
					value={buyerAddr}
					onChange={(e) => {
						setBuyerAddr(e.target.value)
						setBuyerNote(null)
					}}
					spellCheck={false}
					placeholder="G… buyer address"
					aria-label="Buyer address"
					className={`${inputClass} flex-1`}
				/>
				<button
					type="button"
					className="btn-px btn-ghost btn-sm"
					disabled={!buyerValid}
					onClick={() => void checkBuyer()}
				>
					Check
				</button>
				<button
					type="button"
					className="btn-px btn-blip btn-sm"
					disabled={!buyerValid || buyerMut.isPending}
					onClick={() => buyerMut.mutate({ action: "buyer_add", addr: buyerTarget })}
				>
					{buyerMut.isPending ? "Working…" : "Whitelist"}
				</button>
				<button
					type="button"
					className="btn-px btn-ghost btn-sm"
					disabled={!buyerValid || buyerMut.isPending}
					onClick={() => buyerMut.mutate({ action: "buyer_remove", addr: buyerTarget })}
				>
					Remove
				</button>
			</div>
			{buyerNote && <p className="mt-2 font-body text-[13px] text-dim">{buyerNote}</p>}
			{buyerMut.error != null && (
				<p className="mt-2 font-body text-[13px] text-loss">
					{errorMessage(buyerMut.error)}
				</p>
			)}
			<p className="mt-1 font-body text-[12px] text-mute">
				Add/remove signs with the gov-admin key (authorized on-chain) and is audited
				in the action log. Approvals expire after 180 dormant days; re-adding
				restarts the window.
			</p>

			{/* ── route removal ── */}
			<h3 className="label-px mt-5 mb-2 text-sky">Remove route · governance</h3>
			<p className="mb-2 font-body text-[12px] text-mute">
				Permanent: deletes the route entry from GovernanceModule. The contract
				requires the route to be DISABLED first — pause it via the ledger above,
				then remove.
			</p>
			<div className="flex flex-col gap-2 sm:flex-row">
				<input
					value={rmFlight}
					onChange={(e) => {
						setRmFlight(e.target.value)
						setRmNote(null)
					}}
					spellCheck={false}
					placeholder="Flight (AA100)"
					aria-label="Flight id"
					className={`${inputClass} sm:w-40`}
				/>
				<input
					value={rmOrigin}
					onChange={(e) => {
						setRmOrigin(e.target.value)
						setRmNote(null)
					}}
					spellCheck={false}
					placeholder="Origin (JFK)"
					aria-label="Origin"
					className={`${inputClass} sm:w-32`}
				/>
				<input
					value={rmDest}
					onChange={(e) => {
						setRmDest(e.target.value)
						setRmNote(null)
					}}
					spellCheck={false}
					placeholder="Dest (LAX)"
					aria-label="Destination"
					className={`${inputClass} sm:w-32`}
				/>
				<button
					type="button"
					className="btn-px btn-loss btn-sm"
					disabled={!rmValid || removeMut.isPending}
					onClick={() => removeMut.mutate()}
				>
					{removeMut.isPending ? "Removing…" : "Remove route"}
				</button>
			</div>
			{rmNote && <p className="mt-2 font-body text-[13px] text-dim">{rmNote}</p>}
			{removeMut.error != null && (
				<p className="mt-2 font-body text-[13px] text-loss">
					{errorMessage(removeMut.error)}
				</p>
			)}

			{/* ── contract upgrade ── */}
			<h3 className="label-px mt-5 mb-2 text-sky">Contract upgrade · owner wallet</h3>
			<p className="mb-2 font-body text-[12px] text-mute">
				Two steps, both signed by the connected wallet: install the new wasm on-chain
				(permissionless, any funded wallet), then the owner-only upgrade call that
				points the contract at it. Address and generated bindings stay unchanged;
				the on-chain version bumps by one.
			</p>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<select
					value={upgKey}
					onChange={(e) => setUpgKey(e.target.value)}
					aria-label="Contract to upgrade"
					className={`${inputClass} sm:w-56`}
				>
					{UPGRADABLE_CONTRACTS.map((c) => (
						<option key={c.key} value={c.key}>
							{c.label}
						</option>
					))}
				</select>
				<span className="font-body text-[12px] text-mute">
					current version:{" "}
					<span className="font-board text-[14px] text-ink">
						{upgVersion === null ? "…" : `v${upgVersion}`}
					</span>
				</span>
				<label className="btn-px btn-ghost btn-sm cursor-pointer">
					{upgFile ? "Change .wasm" : "Choose .wasm"}
					<input
						type="file"
						accept=".wasm"
						className="hidden"
						onChange={(e) => {
							const f = e.target.files?.[0]
							if (f) void onWasmChosen(f)
							e.target.value = ""
						}}
					/>
				</label>
			</div>
			{upgFile && (
				<div className="mt-2 border-2 border-line bg-inset p-3">
					<p className="font-body text-[13px] text-dim">
						{upgFile.name} · {(upgFile.size / 1024).toFixed(1)} KB
					</p>
					<p className="mt-1 font-mono text-[12px] break-all text-mute">
						sha256 {upgFile.hashHex}
					</p>
					<p className="mt-1 font-body text-[12px]">
						{upgInstalled === null ? (
							<span className="text-mute">checking whether this wasm is installed…</span>
						) : upgInstalled ? (
							<span className="text-win">
								already installed on-chain — skip straight to upgrade
							</span>
						) : (
							<span className="text-gold">not installed yet — upload first</span>
						)}
					</p>
					<div className="mt-2 flex flex-wrap gap-2">
						<button
							type="button"
							className="btn-px btn-blip btn-sm"
							disabled={!address || walletBusy || upgInstalled !== false}
							onClick={uploadWasm}
						>
							{busyKey === "upgrade_upload" && walletBusy
								? "Uploading…"
								: "1 · Upload wasm"}
						</button>
						<button
							type="button"
							className="btn-px btn-loss btn-sm"
							disabled={!address || walletBusy || upgInstalled !== true}
							onClick={runUpgrade}
							title={`Owner-only — upgrades ${upgTarget.label} in place`}
						>
							{busyKey === "upgrade_call" && walletBusy
								? "Upgrading…"
								: `2 · Upgrade ${upgTarget.label}`}
						</button>
					</div>
					{!address && (
						<p className="mt-2 font-body text-[12px] text-gold">
							Connect the contract-owner wallet (top right) to proceed.
						</p>
					)}
				</div>
			)}
		</section>
	)
}

/* ── solvency & money flow ────────────────────────────────────────── */

const POOL_SCAN_PAGE = 20
const POOL_SCAN_MAX_PAGES = 50
const POOL_SCAN_CONCURRENCY = 6

/** Bounded-concurrency map for the pool-book scan. */
async function mapLimitedAdmin<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const out: R[] = new Array(items.length)
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (;;) {
				const i = next++
				if (i >= items.length) return
				out[i] = await fn(items[i] as T)
			}
		})
	)
	return out
}

interface SolvencyData {
	/** vault accounting */
	tvl: bigint
	free: bigint
	locked: bigint
	tma: bigint
	withdrawable: bigint
	totalShares: bigint
	/** USDC value of exactly 1.0 share (7-dp units) */
	sharePrice: bigint
	ratioCfg: number
	/** controller lifetime counters */
	stats: { sold: number; premiums: bigint; payouts: bigint }
	/** actual token balances */
	vaultUsdc: bigint
	poolUsdc: bigint
	recovered: bigint
	depositQueueAssets: bigint
	withdrawalQueueShares: bigint
	/** pool open-book scan */
	scannedFlights: number
	scanErrors: number
	activePremiumsHeld: bigint
	expectedLocked: bigint
	/** claimable payoffs whose claim window is still open */
	owedUnclaimed: bigint
	/** claimable payoffs whose window expired (awaiting sweep) */
	expiredUnclaimed: bigint
}

/** Pure chain reads — TVL, both token balances, and a bounded scan of
 *  the pool's open book so the invariants below compare what the vault
 *  SAYS is locked against what the policies actually require. */
async function fetchSolvency(): Promise<SolvencyData> {
	const [
		tvl,
		free,
		locked,
		tma,
		withdrawable,
		supply,
		oneShare,
		ratioCfg,
		stats,
		vaultUsdc,
		poolUsdc,
		recovered,
		depQ,
		wdQ,
		poolCount,
	] = await Promise.all([
		riskVaultClient.total_assets(),
		riskVaultClient.get_free_capital(),
		riskVaultClient.get_locked_capital(),
		riskVaultClient.get_total_managed_assets(),
		riskVaultClient.get_withdrawable_capital(),
		riskVaultClient.total_supply(),
		riskVaultClient.convert_to_assets({ shares: 10_000_000_000n }),
		controllerClient.get_solvency_ratio(),
		controllerClient.get_stats(),
		mockUsdcClient.balance({ account: CONTRACT_IDS.riskVault }),
		mockUsdcClient.balance({ account: CONTRACT_IDS.flightPoolManager }),
		flightPoolManagerClient.get_recovered_balance(),
		riskVaultClient.get_deposit_queue(),
		riskVaultClient.get_withdrawal_queue(),
		flightPoolManagerClient.get_active_flight_count(),
	])

	const count = Number(poolCount.result)
	const pages = Math.min(Math.ceil(count / POOL_SCAN_PAGE), POOL_SCAN_MAX_PAGES)
	const pageResults = await Promise.all(
		Array.from({ length: pages }, (_, i) =>
			flightPoolManagerClient.get_active_flights_page({
				offset: i * POOL_SCAN_PAGE,
				limit: POOL_SCAN_PAGE,
			})
		)
	)
	const flights = pageResults.flatMap((p) => p.result)

	let scanErrors = 0
	const configs = await mapLimitedAdmin(
		flights,
		POOL_SCAN_CONCURRENCY,
		async ([flightId, date]): Promise<PoolFlightConfig | null> => {
			try {
				const tx = await flightPoolManagerClient.get_flight_config({
					flight_id: flightId,
					date,
				})
				return tx.result ?? null
			} catch {
				scanErrors++
				return null
			}
		}
	)

	const nowSecs = BigInt(Math.floor(Date.now() / 1000))
	let activePremiumsHeld = 0n
	let expectedLocked = 0n
	let owedUnclaimed = 0n
	let expiredUnclaimed = 0n
	for (const cfg of configs) {
		if (!cfg) continue
		const buyers = BigInt(cfg.buyer_count)
		const unclaimed = buyers - BigInt(cfg.claimed_count)
		if (cfg.status.tag === "Active") {
			// premium sits in the pool; the vault locked the full payoff
			activePremiumsHeld += cfg.premium * buyers
			expectedLocked += cfg.payoff * buyers
		} else if (
			cfg.status.tag === "SettledDelayed" ||
			cfg.status.tag === "SettledCancelled"
		) {
			if (unclaimed > 0n) {
				if (BigInt(cfg.claim_expiry) > nowSecs) owedUnclaimed += cfg.payoff * unclaimed
				else expiredUnclaimed += cfg.payoff * unclaimed
			}
		}
	}

	return {
		tvl: tvl.result,
		free: free.result,
		locked: locked.result,
		tma: tma.result,
		withdrawable: withdrawable.result,
		totalShares: supply.result,
		sharePrice: oneShare.result,
		ratioCfg: Number(ratioCfg.result),
		stats: {
			sold: Number(stats.result[0]),
			premiums: stats.result[1],
			payouts: stats.result[2],
		},
		vaultUsdc: vaultUsdc.result,
		poolUsdc: poolUsdc.result,
		recovered: recovered.result,
		depositQueueAssets: depQ.result.reduce((s, d) => s + d.assets, 0n),
		withdrawalQueueShares: wdQ.result.reduce((s, w) => s + w.shares, 0n),
		scannedFlights: flights.length,
		scanErrors,
		activePremiumsHeld,
		expectedLocked,
		owedUnclaimed,
		expiredUnclaimed,
	}
}

function InvariantRow({
	name,
	detail,
	pass,
	delta,
}: {
	name: string
	detail: string
	pass: boolean
	/** signed 7-dp USDC delta; 0n renders as "exact" */
	delta: bigint
}) {
	return (
		<tr className={`border-b border-line/60 last:border-b-0 ${pass ? "" : "bg-loss/10"}`}>
			<td className="px-3 py-2 whitespace-nowrap">
				<span className="flex items-center gap-2">
					<Lamp tone={pass ? "win" : "loss"} blink={!pass} />
					<span className={`status-px ${pass ? "text-win" : "text-loss"}`}>
						{pass ? "HOLDS" : "BROKEN"}
					</span>
				</span>
			</td>
			<td className="px-3 py-2">
				<span className="font-board text-[16px] text-ink">{name}</span>
				<span className="block text-[12px] text-mute">{detail}</span>
			</td>
			<td className="px-3 py-2 whitespace-nowrap">
				<span className={`font-board text-[16px] ${pass ? "text-mute" : "text-loss"}`}>
					{delta === 0n
						? "exact"
						: `${delta > 0n ? "+" : "−"}${formatUsdc(delta < 0n ? -delta : delta)} USDC`}
				</span>
			</td>
		</tr>
	)
}

function MoneyStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
	return (
		<div className="border-2 border-line bg-raised px-3 py-2">
			<p className="label-px">{label}</p>
			<p className={`font-board text-[18px] ${tone ?? "text-ink"}`}>{value}</p>
		</div>
	)
}

function SolvencyPanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: SolvencyData | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	// Invariants — integer math on 7-dp units, so "green" means EXACT.
	const inv = data
		? {
				internal: data.free + data.locked - data.tma,
				backing: data.vaultUsdc - (data.tma + data.depositQueueAssets),
				lockedBook: data.locked - data.expectedLocked,
				poolCover:
					data.poolUsdc -
					(data.activePremiumsHeld +
						data.owedUnclaimed +
						data.expiredUnclaimed +
						data.recovered),
			}
		: null
	const coverageRatio =
		data && data.locked > 0n ? Number((data.tma * 100n) / data.locked) : null

	return (
		<section>
			<h2 className="h-section mb-3">Solvency · is the money where the contracts think it is?</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Pure chain reads, including a full scan of the pool's open book
					{data
						? ` — ${data.scannedFlights} flight bucket(s)${data.scanErrors ? `, ${data.scanErrors} unreadable` : ""}`
						: ""}
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Auditing…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Chain read failed: {error}</p>
			)}
			{loading && !data && (
				<p className="font-body text-[13px] text-mute">Counting the money…</p>
			)}

			{data && inv && (
				<>
					<div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
						<MoneyStat label="TVL (total assets)" value={`${formatUsdc(data.tvl)} USDC`} />
						<MoneyStat label="Free capital" value={`${formatUsdc(data.free)} USDC`} />
						<MoneyStat
							label="Locked capital"
							value={`${formatUsdc(data.locked)} USDC`}
							tone={data.locked > 0n ? "text-gold" : "text-ink"}
						/>
						<MoneyStat
							label="Coverage vs min"
							value={
								coverageRatio === null
									? `∞ / ${data.ratioCfg}%`
									: `${coverageRatio}% / ${data.ratioCfg}%`
							}
							tone={
								coverageRatio !== null && coverageRatio < data.ratioCfg
									? "text-loss"
									: "text-win"
							}
						/>
						<MoneyStat label="Vault USDC balance" value={`${formatUsdc(data.vaultUsdc)} USDC`} />
						<MoneyStat label="Pool USDC balance" value={`${formatUsdc(data.poolUsdc)} USDC`} />
						<MoneyStat
							label="Share price"
							value={`${(Number(data.sharePrice) / 1e7).toFixed(4)} USDC`}
						/>
						<MoneyStat
							label="Lifetime premiums / payouts"
							value={`${formatUsdc(data.stats.premiums)} / ${formatUsdc(data.stats.payouts)}`}
						/>
					</div>

					<div className="panel mb-2 overflow-x-auto">
						<table className="w-full border-collapse text-left">
							<thead>
								<tr className="border-b-2 border-line">
									{["", "Invariant", "Delta"].map((h, i) => (
										<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody className="font-body text-[13px]">
								<InvariantRow
									name="Vault internal ledger"
									detail={`free ${formatUsdc(data.free)} + locked ${formatUsdc(data.locked)} = managed ${formatUsdc(data.tma)}`}
									pass={inv.internal === 0n}
									delta={inv.internal}
								/>
								<InvariantRow
									name="Vault token backing"
									detail={`USDC balance ${formatUsdc(data.vaultUsdc)} covers managed ${formatUsdc(data.tma)} + queued deposits ${formatUsdc(data.depositQueueAssets)}`}
									pass={inv.backing >= 0n}
									delta={inv.backing}
								/>
								<InvariantRow
									name="Locked = open policy book"
									detail={`vault locked ${formatUsdc(data.locked)} vs Σ payoff×buyers on unsettled flights ${formatUsdc(data.expectedLocked)}`}
									pass={inv.lockedBook === 0n}
									delta={inv.lockedBook}
								/>
								<InvariantRow
									name="Pool covers obligations"
									detail={`pool USDC ${formatUsdc(data.poolUsdc)} covers premiums held ${formatUsdc(data.activePremiumsHeld)} + open claims ${formatUsdc(data.owedUnclaimed)} + expired unswept ${formatUsdc(data.expiredUnclaimed)} + recovered ${formatUsdc(data.recovered)}`}
									pass={inv.poolCover >= 0n}
									delta={inv.poolCover}
								/>
							</tbody>
						</table>
					</div>

					<p className="font-body text-[12px] text-mute">
						{data.stats.sold} policies sold lifetime · withdrawable now{" "}
						{formatUsdc(data.withdrawable)} USDC · withdrawal queue{" "}
						{(Number(data.withdrawalQueueShares) / 1e10).toLocaleString("en-US", {
							maximumFractionDigits: 2,
						})}{" "}
						shares · shares outstanding{" "}
						{(Number(data.totalShares) / 1e10).toLocaleString("en-US", {
							maximumFractionDigits: 2,
						})}
						. Deltas are exact integer math on 7-dp units — a broken row means the
						books do NOT balance and deserves immediate attention.
					</p>
				</>
			)}
		</section>
	)
}

/* ── lifecycle funnel / stuck-flight detector ─────────────────────── */

// Fetcher promise: an insured flight is swept within scheduled arrival
// + 5h. Anything still Active past that is a flight the fetcher missed.
const FETCHER_MISS_SECS = 5 * 3600
// Classify runs hourly, the settler every 5 minutes — a ToBeSettled*
// older than an hour past its arrival means the pipeline is behind.
const SETTLER_LAG_SECS = 3600
// "About to silently lose money" horizon for open claim windows.
const CLAIM_SOON_SECS = 48 * 3600
// Per-list scan cap (matches the other scanning tabs' RPC posture).
const FUNNEL_SCAN_CAP = 200

const FUNNEL_STAGES = [
	"NotInitiated",
	"Active",
	"Landed",
	"Cancelled",
	"ToBeSettledOnTime",
	"ToBeSettledDelayed",
	"ToBeSettledCancelled",
	"Settled",
] as const

interface StuckFlight {
	flightId: string
	date: bigint
	/** seconds of overdue-ness for the relevant deadline */
	ageSecs: number
	note: string
}

interface ClaimRisk {
	flightId: string
	date: bigint
	unclaimed: number
	payoffUnits: bigint
	/** seconds until (positive) or since (negative) claim expiry */
	remainingSecs: number
}

interface LifecycleData {
	counts: Record<string, number>
	totalListed: number
	truncated: boolean
	scanErrors: number
	fetcherMissed: StuckFlight[]
	settlerLagging: StuckFlight[]
	claimsExpiringSoon: ClaimRisk[]
	claimsExpiredUnswept: ClaimRisk[]
}

/** Oracle statuses + pool claim windows in one pass — the "is anything
 *  stuck between stages?" scan. Read-only, bounded, on-demand. */
async function fetchLifecycle(): Promise<LifecycleData> {
	const nowSecs = Math.floor(Date.now() / 1000)
	let scanErrors = 0

	// ── oracle side: status funnel + age checks ──
	const oracleCount = Number((await oracleClient.get_active_flight_count()).result)
	const oraclePages = Math.min(
		Math.ceil(Math.min(oracleCount, FUNNEL_SCAN_CAP) / ORACLE_REPORT_PAGE),
		FUNNEL_SCAN_CAP / ORACLE_REPORT_PAGE
	)
	const oracleFlights = (
		await Promise.all(
			Array.from({ length: oraclePages }, (_, i) =>
				oracleClient.get_active_flights_page({
					offset: i * ORACLE_REPORT_PAGE,
					limit: ORACLE_REPORT_PAGE,
				})
			)
		)
	).flatMap((p) => p.result)

	const counts: Record<string, number> = Object.fromEntries(
		FUNNEL_STAGES.map((s) => [s, 0])
	)
	const fetcherMissed: StuckFlight[] = []
	const settlerLagging: StuckFlight[] = []

	await mapLimitedAdmin(oracleFlights, POOL_SCAN_CONCURRENCY, async ([flightId, date]) => {
		try {
			const data = (
				await oracleClient.get_flight_data({ flight_id: flightId, date })
			).result
			const tag = data.status.tag
			counts[tag] = (counts[tag] ?? 0) + 1
			const eta = Number(data.estimated_arrival_time)
			const actual = Number(data.actual_arrival_time)
			if (tag === "Active" && eta > 0 && nowSecs > eta + FETCHER_MISS_SECS) {
				fetcherMissed.push({
					flightId,
					date,
					ageSecs: nowSecs - (eta + FETCHER_MISS_SECS),
					note: `scheduled arrival ${utcSecs(data.estimated_arrival_time)}`,
				})
			}
			if (tag.startsWith("ToBeSettled")) {
				const arrived = Math.max(actual, eta)
				if (arrived > 0 && nowSecs > arrived + SETTLER_LAG_SECS) {
					settlerLagging.push({
						flightId,
						date,
						ageSecs: nowSecs - arrived,
						note: tag,
					})
				}
			}
		} catch {
			scanErrors++
		}
		return null
	})

	// ── pool side: claim windows ──
	const poolCount = Number(
		(await flightPoolManagerClient.get_active_flight_count()).result
	)
	const poolPages = Math.min(
		Math.ceil(Math.min(poolCount, FUNNEL_SCAN_CAP) / POOL_SCAN_PAGE),
		FUNNEL_SCAN_CAP / POOL_SCAN_PAGE
	)
	const poolFlights = (
		await Promise.all(
			Array.from({ length: poolPages }, (_, i) =>
				flightPoolManagerClient.get_active_flights_page({
					offset: i * POOL_SCAN_PAGE,
					limit: POOL_SCAN_PAGE,
				})
			)
		)
	).flatMap((p) => p.result)

	const claimsExpiringSoon: ClaimRisk[] = []
	const claimsExpiredUnswept: ClaimRisk[] = []
	await mapLimitedAdmin(poolFlights, POOL_SCAN_CONCURRENCY, async ([flightId, date]) => {
		try {
			const cfg = (
				await flightPoolManagerClient.get_flight_config({ flight_id: flightId, date })
			).result
			if (!cfg) return null
			if (cfg.status.tag !== "SettledDelayed" && cfg.status.tag !== "SettledCancelled") {
				return null
			}
			const unclaimed = cfg.buyer_count - cfg.claimed_count
			const expiry = Number(cfg.claim_expiry)
			if (unclaimed <= 0 || expiry <= 0) return null
			const remainingSecs = expiry - nowSecs
			const risk: ClaimRisk = {
				flightId,
				date,
				unclaimed,
				payoffUnits: cfg.payoff * BigInt(unclaimed),
				remainingSecs,
			}
			if (remainingSecs <= 0) claimsExpiredUnswept.push(risk)
			else if (remainingSecs <= CLAIM_SOON_SECS) claimsExpiringSoon.push(risk)
		} catch {
			scanErrors++
		}
		return null
	})
	claimsExpiringSoon.sort((a, b) => a.remainingSecs - b.remainingSecs)
	fetcherMissed.sort((a, b) => b.ageSecs - a.ageSecs)
	settlerLagging.sort((a, b) => b.ageSecs - a.ageSecs)

	return {
		counts,
		totalListed: oracleCount,
		truncated: oracleCount > FUNNEL_SCAN_CAP || poolCount > FUNNEL_SCAN_CAP,
		scanErrors,
		fetcherMissed,
		settlerLagging,
		claimsExpiringSoon,
		claimsExpiredUnswept,
	}
}

/** "3d 4h" / "6h 24m" / "45m" */
function fmtAge(secs: number): string {
	const h = Math.floor(secs / 3600)
	const m = Math.floor((secs % 3600) / 60)
	if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
	if (h > 0) return `${h}h ${m}m`
	return `${m}m`
}

function DetectorCard({
	title,
	hint,
	ok,
	okLabel,
	children,
}: {
	title: string
	hint: string
	ok: boolean
	okLabel: string
	children?: React.ReactNode
}) {
	return (
		<div className={`panel mb-4 p-4 ${ok ? "" : "bg-loss/10"}`}>
			<div className="mb-1 flex items-center gap-2">
				<Lamp tone={ok ? "win" : "loss"} blink={!ok} />
				<h3 className="font-board text-[17px] text-ink">{title}</h3>
			</div>
			<p className="mb-2 font-body text-[12px] text-mute">{hint}</p>
			{ok ? (
				<p className="font-body text-[13px] text-win">{okLabel}</p>
			) : (
				children
			)}
		</div>
	)
}

function FunnelPanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: LifecycleData | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	const stageTiles = data
		? ([
				["Active", data.counts.Active ?? 0],
				["Landed", data.counts.Landed ?? 0],
				["Cancelled", data.counts.Cancelled ?? 0],
				[
					"To settle",
					(data.counts.ToBeSettledOnTime ?? 0) +
						(data.counts.ToBeSettledDelayed ?? 0) +
						(data.counts.ToBeSettledCancelled ?? 0),
				],
				["Settled", data.counts.Settled ?? 0],
			] as Array<[string, number]>)
		: null

	return (
		<section>
			<h2 className="h-section mb-3">Lifecycle · stuck-flight detector</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Oracle statuses + pool claim windows, scanned on demand
					{data
						? ` — ${data.totalListed} flight(s) listed${data.truncated ? ` (first ${FUNNEL_SCAN_CAP} scanned)` : ""}${data.scanErrors ? `, ${data.scanErrors} unreadable` : ""}`
						: ""}
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Scanning…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Chain read failed: {error}</p>
			)}
			{loading && !data && (
				<p className="font-body text-[13px] text-mute">Walking the funnel…</p>
			)}

			{data && stageTiles && (
				<>
					{/* funnel counts */}
					<div className="mb-4 flex flex-wrap items-center gap-2">
						{stageTiles.map(([label, n], i) => (
							<Fragment key={label}>
								{i > 0 && (
									<span aria-hidden="true" className="text-mute">
										→
									</span>
								)}
								<div className="border-2 border-line bg-raised px-3 py-2 text-center">
									<p className="font-board text-[20px] text-ink">{n}</p>
									<p className="label-px">{label}</p>
								</div>
							</Fragment>
						))}
					</div>

					<DetectorCard
						title="Fetcher missed"
						hint={`Still Active more than 5h past scheduled arrival — the fetch sweep's promise is settlement within ETA+5h. A run of these means the fetcher cron (or AeroAPI) is failing.`}
						ok={data.fetcherMissed.length === 0}
						okLabel="No flight is past its sweep deadline."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.fetcherMissed.map((f) => (
								<li key={`${f.flightId}:${f.date}`}>
									<span className="font-board text-[15px] text-ink">{f.flightId}</span>{" "}
									<span className="text-loss">{fmtAge(f.ageSecs)} overdue</span>{" "}
									<span className="text-mute">· {f.note}</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					<DetectorCard
						title="Settler falling behind"
						hint="Outcome reported (ToBeSettled*) but unsettled more than 1h past arrival — classify runs hourly and the settler every 5 minutes, so these should clear fast."
						ok={data.settlerLagging.length === 0}
						okLabel="No reported outcome is waiting on the settler."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.settlerLagging.map((f) => (
								<li key={`${f.flightId}:${f.date}`}>
									<span className="font-board text-[15px] text-ink">{f.flightId}</span>{" "}
									<span className="text-loss">{fmtAge(f.ageSecs)} since arrival</span>{" "}
									<span className="text-mute">· {f.note}</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					<DetectorCard
						title="Claims expiring soon"
						hint="Claimable payouts whose window closes within 48h — travelers about to silently lose money (and, after expiry, the sweep's revenue)."
						ok={data.claimsExpiringSoon.length === 0}
						okLabel="No open claim window closes in the next 48h."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.claimsExpiringSoon.map((c) => (
								<li key={`${c.flightId}:${c.date}`}>
									<span className="font-board text-[15px] text-ink">{c.flightId}</span>{" "}
									<span className="text-gold">
										{fmtAge(c.remainingSecs)} left · {c.unclaimed} unclaimed ·{" "}
										{formatUsdc(c.payoffUnits)} USDC
									</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					{data.claimsExpiredUnswept.length > 0 && (
						<p className="font-body text-[13px] text-mute">
							{data.claimsExpiredUnswept.length} expired claim window(s) with{" "}
							{formatUsdc(
								data.claimsExpiredUnswept.reduce((s, c) => s + c.payoffUnits, 0n)
							)}{" "}
							USDC unclaimed await the ttl_extender's sweep (vault revenue).
						</p>
					)}
				</>
			)}
		</section>
	)
}

/* ── diagnostics feed ─────────────────────────────────────────────── */

/** api/admin/diagnostics.ts — ~24h of "operator attention needed" events. */
interface DiagnosticsResponse {
	diagnostics: Array<{
		ledger: number
		closed_at: string | null
		contract: string
		kind: string
		detail: unknown
	}>
	window: { from_ledger: number; to_ledger: number }
	as_of: string
}

/** Severity + one-line meaning per diagnostic kind (see the endpoint's
 *  header comment — these are the contracts' own attention events). */
const DIAG_KINDS: Record<string, { tone: "loss" | "gold"; meaning: string }> = {
	ttl_miss: { tone: "loss", meaning: "oracle data missing for a registered flight" },
	cfg_missing: { tone: "loss", meaning: "pool FlightConfig missing at classify/settle" },
	voided: { tone: "loss", meaning: "dataless flight voided as on-time (payouts lost)" },
	timed_out: { tone: "loss", meaning: "stuck-Active flight voided by timeout" },
	evict_settled: { tone: "gold", meaning: "evicted flight settled (runbook step)" },
	page_miss: { tone: "gold", meaning: "archived active-set page skipped" },
	prune_miss: { tone: "gold", meaning: "settlement prune could not reach its page" },
}

function DiagnosticsPanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: DiagnosticsResponse | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	const rows = data?.diagnostics ?? []
	const seriousCount = rows.filter((r) => DIAG_KINDS[r.kind]?.tone !== "gold").length

	// per-kind tally for the header strip
	const tally = rows.reduce<Record<string, number>>((acc, r) => {
		acc[r.kind] = (acc[r.kind] ?? 0) + 1
		return acc
	}, {})

	return (
		<section>
			<h2 className="h-section mb-3">Diagnostics · the contracts asking for attention</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Last ~24h of diagnostic events across oracle / controller / pool
					{data
						? ` · ledgers ${data.window.from_ledger.toLocaleString("en-US")}–${data.window.to_ledger.toLocaleString("en-US")} · read ${relTime(data.as_of)}`
						: ""}
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Scanning…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Feed failed: {error}</p>
			)}
			{loading && !data && (
				<p className="font-body text-[13px] text-mute">Listening for complaints…</p>
			)}

			{data && (
				<>
					<div className="mb-3 flex flex-wrap items-center gap-3">
						<span className="flex items-center gap-2">
							<Lamp
								tone={rows.length === 0 ? "win" : seriousCount > 0 ? "loss" : "gold"}
								blink={seriousCount > 0}
							/>
							<span
								className={`status-px ${
									rows.length === 0
										? "text-win"
										: seriousCount > 0
											? "text-loss"
											: "text-gold"
								}`}
							>
								{rows.length === 0
									? "quiet — no diagnostic events in the window"
									: `${rows.length} event(s), ${seriousCount} serious`}
							</span>
						</span>
						{Object.entries(tally).map(([kind, n]) => (
							<span
								key={kind}
								className={`status-px ${DIAG_KINDS[kind]?.tone === "gold" ? "text-gold" : "text-loss"}`}
							>
								{kind} ×{n}
							</span>
						))}
					</div>

					{rows.length > 0 && (
						<div className="panel overflow-x-auto">
							<table className="w-full border-collapse text-left">
								<thead>
									<tr className="border-b-2 border-line">
										{["When", "Contract", "Kind", "Detail"].map((h, i) => (
											<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
												{h}
											</th>
										))}
									</tr>
								</thead>
								<tbody className="font-body text-[13px]">
									{rows.map((r, i) => {
										const kindInfo = DIAG_KINDS[r.kind]
										const detail = JSON.stringify(r.detail)
										return (
											<tr
												key={`${r.ledger}:${i}`}
												className="border-b border-line/60 last:border-b-0"
											>
												<td
													className="px-3 py-2 whitespace-nowrap text-dim"
													title={r.closed_at ?? `ledger ${r.ledger}`}
												>
													{r.closed_at ? relTime(r.closed_at) : `ledger ${r.ledger}`}
												</td>
												<td className="px-3 py-2 whitespace-nowrap text-mute">
													{r.contract}
												</td>
												<td className="px-3 py-2 whitespace-nowrap">
													<span
														className={`status-px ${kindInfo?.tone === "gold" ? "text-gold" : "text-loss"}`}
														title={kindInfo?.meaning ?? ""}
													>
														{r.kind}
													</span>
													{kindInfo && (
														<span className="block text-[11px] text-mute">
															{kindInfo.meaning}
														</span>
													)}
												</td>
												<td className="px-3 py-2">
													<span
														className="font-mono text-[12px] break-all text-dim"
														title={detail}
													>
														{detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}
													</span>
												</td>
											</tr>
										)
									})}
								</tbody>
							</table>
						</div>
					)}
				</>
			)}
		</section>
	)
}

/* ── exposure gauge ───────────────────────────────────────────────── */

/** api/admin/exposure.ts — every concentration fraction, not just the
 *  cron's threshold crossings. */
interface ExposureResponse {
	total_managed_units: string
	thresholds: { elevated: number; severe: number }
	routes: Array<{
		flight_id: string
		origin: string
		dest: string
		liability_units: string
		fraction: number
	}>
	airports: Array<{ airport: string; liability_units: string; fraction: number }>
	unknown: { liability_units: string; flights: string[] }
	as_of: string
}

/** Horizontal capacity gauge: fill = fraction of vault capacity, with
 *  tick marks at the advisory and brake thresholds. */
function ExposureGauge({
	fraction,
	thresholds,
}: {
	fraction: number
	thresholds: { elevated: number; severe: number }
}) {
	const tone =
		fraction >= thresholds.severe
			? "var(--color-loss)"
			: fraction >= thresholds.elevated
				? "var(--color-gold)"
				: "var(--color-win)"
	// scale the bar so the severe threshold sits at 80% of its width —
	// headroom past the brake stays visible instead of clipping at 100%
	const scale = (f: number) => Math.min((f / thresholds.severe) * 80, 100)
	return (
		<div className="relative h-3 w-40 border border-line-mid bg-inset">
			<div
				className="absolute inset-y-0 left-0"
				style={{ width: `${scale(fraction)}%`, background: tone }}
			/>
			{[thresholds.elevated, thresholds.severe].map((t) => (
				<div
					key={t}
					className="absolute inset-y-0 w-px bg-line-strong"
					style={{ left: `${scale(t)}%` }}
					title={`${(t * 100).toFixed(0)}% threshold`}
				/>
			))}
		</div>
	)
}

function ExposureTable({
	title,
	rows,
	thresholds,
}: {
	title: string
	rows: Array<{ label: string; liability_units: string; fraction: number }>
	thresholds: { elevated: number; severe: number }
}) {
	return (
		<div className="mb-5">
			<h3 className="label-px mb-2 text-sky">{title}</h3>
			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["Scope", "Liability", "Of capacity", "Of brake trigger", ""].map((h, i) => (
								<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{rows.length === 0 && (
							<tr>
								<td colSpan={5} className="px-3 py-4 text-mute">
									No live liability in this bucket.
								</td>
							</tr>
						)}
						{rows.map((r) => {
							const toBrake = (r.fraction / thresholds.severe) * 100
							const tone =
								r.fraction >= thresholds.severe
									? "text-loss"
									: r.fraction >= thresholds.elevated
										? "text-gold"
										: "text-win"
							return (
								<tr key={r.label} className="border-b border-line/60 last:border-b-0">
									<td className="px-3 py-2 whitespace-nowrap">
										<span className="font-board text-[15px] text-ink">{r.label}</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-dim">
										{formatUsdc(BigInt(r.liability_units))} USDC
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<span className={`font-board text-[15px] ${tone}`}>
											{(r.fraction * 100).toFixed(1)}%
										</span>
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										<span className={`font-board text-[15px] ${tone}`}>
											{toBrake.toFixed(0)}%
										</span>
									</td>
									<td className="px-3 py-2">
										<ExposureGauge fraction={r.fraction} thresholds={thresholds} />
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
		</div>
	)
}

function ExposurePanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: ExposureResponse | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	const worst = data
		? Math.max(0, ...data.routes.map((r) => r.fraction), ...data.airports.map((a) => a.fraction))
		: 0
	const unknownUnits = data ? BigInt(data.unknown.liability_units) : 0n

	return (
		<section>
			<h2 className="h-section mb-3">Exposure · concentration vs vault capacity</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Live payoff liability per route / airport as a share of vault capacity
					{data
						? ` — capacity ${formatUsdc(BigInt(data.total_managed_units))} USDC · advisory at ${(data.thresholds.elevated * 100).toFixed(0)}%, brake at ${(data.thresholds.severe * 100).toFixed(0)}% · read ${relTime(data.as_of)}`
						: ""}
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Measuring…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Read failed: {error}</p>
			)}
			{loading && !data && (
				<p className="font-body text-[13px] text-mute">Weighing the book…</p>
			)}

			{data && (
				<>
					<p className="mb-4 flex items-center gap-2 font-body text-[13px]">
						<Lamp
							tone={
								worst >= data.thresholds.severe
									? "loss"
									: worst >= data.thresholds.elevated
										? "gold"
										: "win"
							}
							blink={worst >= data.thresholds.severe}
						/>
						<span
							className={
								worst >= data.thresholds.severe
									? "text-loss"
									: worst >= data.thresholds.elevated
										? "text-gold"
										: "text-win"
							}
						>
							{worst >= data.thresholds.severe
								? `BRAKE ZONE — worst bucket at ${(worst * 100).toFixed(1)}% of capacity`
								: worst >= data.thresholds.elevated
									? `advisory zone — worst bucket at ${(worst * 100).toFixed(1)}% of capacity`
									: `calm — worst bucket at ${(worst * 100).toFixed(1)}% of capacity (${((worst / data.thresholds.severe) * 100).toFixed(0)}% of the brake trigger)`}
						</span>
					</p>

					{unknownUnits > 0n && (
						<p className="mb-4 font-body text-[13px] text-loss">
							Blind spot: {formatUsdc(unknownUnits)} USDC of live liability on flight(s)
							missing from the routes file ({data.unknown.flights.join(", ")}) — excluded
							from every bucket below, exactly as the brake excludes it.
						</p>
					)}

					<ExposureTable
						title="By route"
						rows={data.routes.map((r) => ({
							label: `${r.flight_id} ${r.origin}→${r.dest}`,
							liability_units: r.liability_units,
							fraction: r.fraction,
						}))}
						thresholds={data.thresholds}
					/>
					<ExposureTable
						title="By airport"
						rows={data.airports.map((a) => ({
							label: a.airport,
							liability_units: a.liability_units,
							fraction: a.fraction,
						}))}
						thresholds={data.thresholds}
					/>
					<p className="font-body text-[12px] text-mute">
						Same math as the hourly gov_exposure brake (ceiling division — ties round
						toward action): payoff × buyers per unsettled flight, scoped via the routes
						file, divided by the vault's total managed assets. At the brake threshold
						the cron pauses every affected route; here you watch it approach.
					</p>
				</>
			)}
		</section>
	)
}

/* ── composite health masthead ────────────────────────────────────── */

interface HealthVerdict {
	tone: "win" | "loss" | "gold"
	detail: string
}

/**
 * One always-visible row of lamps above the tabs — each signal is the
 * same check its tab performs, fetched once with a long cache instead of
 * per-tab laziness. Where a masthead query shares its key with a tab
 * query (funnel, diagnostics, exposure, TTL, balances), opening the tab
 * refreshes the lamp for free. Every signal is independent: one
 * unreadable source turns ITS lamp amber, never the whole row.
 */
function HealthMasthead({
	token,
	pauses,
	onNavigate,
}: {
	token: string
	pauses: number | null
	onNavigate: (tab: AdminTab) => void
}) {
	const cheap = { staleTime: 300_000, retry: 1 } as const
	const heavy = { staleTime: 600_000, retry: 1 } as const

	const jobsQ = useQuery({
		queryKey: ["admin-health-jobs"],
		queryFn: () => api<JobsResponse>("/api/admin/jobs?since_hours=24&limit=1", token),
		...cheap,
	})
	const balancesQ = useQuery({
		queryKey: ["admin-balances"],
		queryFn: () => api<BalancesResponse>("/api/admin/balances", token),
		...cheap,
	})
	const pausedQ = useQuery({
		queryKey: ["admin-health-paused"],
		queryFn: async () => {
			const rs = await Promise.all(PAUSABLE_CONTRACTS.map((c) => c.client.paused()))
			return PAUSABLE_CONTRACTS.filter((_, i) => rs[i]?.result === true).map((c) => c.label)
		},
		...cheap,
	})
	const oracleAuthQ = useQuery({
		queryKey: ["admin-health-oracle-auth"],
		queryFn: async () => (await oracleClient.get_authorized_oracle()).result,
		...cheap,
	})
	const solvencyLightQ = useQuery({
		queryKey: ["admin-health-solvency"],
		queryFn: async () => {
			const [free, locked, tma, bal, depQ] = await Promise.all([
				riskVaultClient.get_free_capital(),
				riskVaultClient.get_locked_capital(),
				riskVaultClient.get_total_managed_assets(),
				mockUsdcClient.balance({ account: CONTRACT_IDS.riskVault }),
				riskVaultClient.get_deposit_queue(),
			])
			return {
				internal: free.result + locked.result - tma.result,
				backing:
					bal.result -
					(tma.result + depQ.result.reduce((s, d) => s + d.assets, 0n)),
			}
		},
		...cheap,
	})
	const ttlQ = useQuery({ queryKey: ["admin-ttl"], queryFn: fetchContractTtls, ...cheap })
	const funnelQ = useQuery({ queryKey: ["admin-funnel"], queryFn: fetchLifecycle, ...heavy })
	const diagQ = useQuery({
		queryKey: ["admin-diagnostics"],
		queryFn: () => api<DiagnosticsResponse>("/api/admin/diagnostics", token),
		...heavy,
	})
	const exposureQ = useQuery({
		queryKey: ["admin-exposure"],
		queryFn: () => api<ExposureResponse>("/api/admin/exposure", token),
		...heavy,
	})

	const fromQuery = <T,>(
		q: { data: T | undefined; isError: boolean },
		judge: (data: T) => HealthVerdict
	): HealthVerdict | null =>
		q.isError ? { tone: "gold", detail: "unreadable — source failed" } : q.data === undefined ? null : judge(q.data)

	const signals: Array<{
		tab: AdminTab
		label: string
		/** element id to scroll to after the tab renders */
		anchor?: string
		v: HealthVerdict | null
	}> = [
		{
			tab: "jobs",
			label: "Jobs",
			v: fromQuery(jobsQ, (d) => {
				const failing: string[] = []
				const stale: string[] = []
				for (const info of d.registry) {
					const t = jobTone(
						d.latest.find((r) => r.job === info.job),
						info.intervalMinutes
					)
					if (t.tone === "loss") failing.push(info.job)
					else if (t.tone === "gold") stale.push(info.job)
				}
				if (failing.length > 0)
					return { tone: "loss", detail: `failing: ${failing.join(", ")}` }
				if (stale.length > 0)
					return { tone: "gold", detail: `stale / never ran: ${stale.join(", ")}` }
				return { tone: "win", detail: `all ${d.registry.length} jobs on schedule` }
			}),
		},
		{
			tab: "interventions",
			label: "Route pauses",
			anchor: "interventions-ledger",
			v:
				pauses === null
					? null
					: pauses > 0
						? { tone: "gold", detail: `${pauses} open route pause(s)` }
						: { tone: "win", detail: "no open interventions" },
		},
		{
			tab: "interventions",
			label: "Contract pauses",
			anchor: "contract-pause-board",
			v: fromQuery(pausedQ, (names) =>
				names.length > 0
					? { tone: "loss", detail: `PAUSED: ${names.join(", ")}` }
					: { tone: "win", detail: "all contracts live" }
			),
		},
		{
			tab: "oracle",
			label: "Oracle",
			v: (() => {
				if (oracleAuthQ.isError)
					return { tone: "gold" as const, detail: "authorized oracle unreadable" }
				const backend = balancesQ.data?.accounts.find((a) => a.role === "oracle")?.address
				if (oracleAuthQ.data === undefined || balancesQ.data === undefined) return null
				if (!backend)
					return { tone: "gold" as const, detail: "backend oracle key not configured" }
				return backend === oracleAuthQ.data
					? { tone: "win" as const, detail: "backend signer matches on-chain authorization" }
					: { tone: "loss" as const, detail: "backend signer ≠ authorized oracle — reports will be rejected" }
			})(),
		},
		{
			tab: "accounts",
			label: "Fuel",
			v: fromQuery(balancesQ, (d) =>
				d.low_count > 0
					? { tone: "loss", detail: `${d.low_count} signer(s) below the low-balance line` }
					: { tone: "win", detail: "all signers funded" }
			),
		},
		{
			tab: "funnel",
			label: "Flights",
			v: fromQuery(funnelQ, (d) => {
				if (d.fetcherMissed.length > 0 || d.settlerLagging.length > 0)
					return {
						tone: "loss",
						detail: `${d.fetcherMissed.length} past sweep deadline, ${d.settlerLagging.length} awaiting settler`,
					}
				if (d.claimsExpiringSoon.length > 0)
					return { tone: "gold", detail: `${d.claimsExpiringSoon.length} claim window(s) close within 48h` }
				return { tone: "win", detail: "nothing stuck between stages" }
			}),
		},
		{
			tab: "diagnostics",
			label: "Diag",
			v: fromQuery(diagQ, (d) => {
				const serious = d.diagnostics.filter((r) => DIAG_KINDS[r.kind]?.tone !== "gold").length
				if (serious > 0) return { tone: "loss", detail: `${serious} serious diagnostic event(s) in 24h` }
				if (d.diagnostics.length > 0)
					return { tone: "gold", detail: `${d.diagnostics.length} informational event(s) in 24h` }
				return { tone: "win", detail: "no diagnostic events in 24h" }
			}),
		},
		{
			tab: "exposure",
			label: "Exposure",
			v: fromQuery(exposureQ, (d) => {
				const worst = Math.max(
					0,
					...d.routes.map((r) => r.fraction),
					...d.airports.map((a) => a.fraction)
				)
				if (worst >= d.thresholds.severe)
					return { tone: "loss", detail: `worst bucket ${(worst * 100).toFixed(1)}% — brake zone` }
				if (worst >= d.thresholds.elevated)
					return { tone: "gold", detail: `worst bucket ${(worst * 100).toFixed(1)}% — advisory` }
				return {
					tone: "win",
					detail: `worst bucket ${(worst * 100).toFixed(1)}% of capacity (${((worst / d.thresholds.severe) * 100).toFixed(0)}% of the brake)`,
				}
			}),
		},
		{
			tab: "solvency",
			label: "Books",
			v: fromQuery(solvencyLightQ, (d) =>
				d.internal !== 0n || d.backing < 0n
					? {
							tone: "loss",
							detail: `books off — internal Δ ${formatUsdc(d.internal < 0n ? -d.internal : d.internal)}, backing Δ ${formatUsdc(d.backing < 0n ? -d.backing : d.backing)} USDC`,
						}
					: { tone: "win", detail: "vault ledger and token backing balance exactly" }
			),
		},
		{
			tab: "ttl",
			label: "TTL",
			v: fromQuery(ttlQ, (d) => {
				const horizons = d.rows.flatMap((r) =>
					[r.instanceLiveUntil, r.codeLiveUntil].filter((v): v is number => v !== null)
				)
				if (horizons.length === 0)
					return { tone: "gold", detail: "no TTL entries readable" }
				const minDays = Math.min(
					...horizons.map((liveUntil) => ((liveUntil - d.currentLedger) * LEDGER_SECS) / 86_400)
				)
				if (minDays < 7)
					return { tone: "loss", detail: `nearest storage expiry ≈${minDays.toFixed(1)}d` }
				if (minDays < 30)
					return { tone: "gold", detail: `nearest storage expiry ≈${Math.floor(minDays)}d` }
				return { tone: "win", detail: `nearest storage expiry ≈${Math.floor(minDays)}d` }
			}),
		},
	]

	return (
		<div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-2 border-line bg-raised px-3 py-2">
			<span className="label-px text-mute">Health</span>
			{signals.map((s) => (
				<button
					key={s.label}
					type="button"
					onClick={() => {
						onNavigate(s.tab)
						// scroll after the tab's sections have rendered
						if (s.anchor) {
							const anchor = s.anchor
							setTimeout(() => {
								document
									.getElementById(anchor)
									?.scrollIntoView({ behavior: "smooth", block: "start" })
							}, 150)
						}
					}}
					title={s.v?.detail ?? "checking…"}
					className="flex items-center gap-1.5 font-body text-[12px] text-dim hover:text-ink"
				>
					{s.v === null ? (
						<span
							className="inline-block h-[9px] w-[9px] bg-line-strong"
							aria-hidden="true"
						/>
					) : (
						<Lamp tone={s.v.tone} />
					)}
					<span>{s.label}</span>
				</button>
			))}
		</div>
	)
}

/* ── security / fraud signals ─────────────────────────────────────── */

/** api/admin/security.ts — patterns worth a human look, never proof. */
interface SecurityResponse {
	baseline: { policies: number; buyers: number; global_win_rate: number }
	win_outliers: Array<{
		buyer: string
		policies: number
		wins: number
		win_rate: number
		last_at: string
	}>
	swarm_flights: Array<{
		flight_id: string
		day: string
		buyers: number
		policies: number
		premium_units: string
		payoff_units: string
	}>
	ledger_batches: Array<{ ledger: number; policies: number; buyers: number; flights: string[] }>
	manual_triggers: Array<{ job: string; trigger: string; ran_at: string; success: boolean }>
	whitelist_changes: Array<{
		actor: string
		action: string
		addr: string | null
		ts: string
		success: boolean
	}>
	actor_summary: Array<{ actor: string; actions: number; failures: number; last_at: string }>
	term_buys: Array<{
		action_ts: string
		action: string
		actor: string
		flight_id: string
		buyer: string
		bought_at: string
		delay_secs: number
		payoff_units: string
	}>
	vault_motion: {
		rows_48h: number
		latest_ts: string | null
		share_price_now: string | null
		price_change_24h: number | null
		max_step_pct: number
		coverage_now: number | null
		coverage_drop_24h: number | null
	}
	supply_violations: Array<{
		ts: string
		prev_ts: string
		total_supply: string
		prev_supply: string
	}>
	dominance: {
		top: Array<{ address: string; shares: string; fraction: number }>
		total_supply: string
	}
	flows: {
		large_requests: Array<{
			kind: "deposit" | "withdrawal"
			owner: string
			amount_units: string
			fraction: number
		}>
		both_queues: string[]
	}
	thresholds: {
		outlier_min_policies: number
		outlier_min_rate: number
		swarm_min_buyers: number
		batch_min_policies: number
		term_buy_window_min: number
		price_move_alert: number
		coverage_drop_alert: number
		dominance_pct: number
		flow_pct: number
	}
	as_of: string
}

function SecurityPanel({
	data,
	loading,
	error,
	onRefresh,
}: {
	data: SecurityResponse | null
	loading: boolean
	error: string | null
	onRefresh: () => void
}) {
	const externalTriggers = data
		? data.manual_triggers.filter((t) => t.trigger === "external").length
		: 0

	return (
		<section>
			<h2 className="h-section mb-3">Security · fraud patterns worth a look</h2>
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<p className="font-body text-[13px] text-mute">
					Signals from the durable event mirrors — patterns, never proof
					{data
						? ` · book: ${data.baseline.policies} policies / ${data.baseline.buyers} buyers, baseline win rate ${(data.baseline.global_win_rate * 100).toFixed(1)}% · read ${relTime(data.as_of)}`
						: ""}
				</p>
				<button className="btn-px btn-ghost btn-sm" disabled={loading} onClick={onRefresh}>
					{loading ? "Profiling…" : "Refresh"}
				</button>
			</div>
			{error && (
				<p className="mb-3 font-body text-[13px] text-loss">Read failed: {error}</p>
			)}
			{loading && !data && (
				<p className="font-body text-[13px] text-mute">Reading the tape…</p>
			)}

			{data && (
				<>
					<DetectorCard
						title="Win-rate outliers"
						hint={`Buyers with ≥${data.thresholds.outlier_min_policies} policies winning ≥${(data.thresholds.outlier_min_rate * 100).toFixed(0)}% of them — far above the book's baseline. Heuristic join (a policy counts as won when its flight settled delayed/cancelled within 4 days of purchase), so treat as a shortlist, not a verdict. Possible information advantage or oracle leak.`}
						ok={data.win_outliers.length === 0}
						okLabel="No buyer's hit rate stands out from the book."
					>
						<div className="overflow-x-auto">
							<table className="w-full border-collapse text-left font-body text-[13px]">
								<thead>
									<tr className="border-b border-line">
										{["Buyer", "Policies", "Wins", "Rate", "Last purchase"].map((h, i) => (
											<th key={i} className="label-px px-2 py-1 whitespace-nowrap">
												{h}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{data.win_outliers.map((b) => (
										<tr key={b.buyer} className="border-b border-line/60 last:border-b-0">
											<td className="px-2 py-1.5 whitespace-nowrap">
												<AddressCell address={b.buyer} />
											</td>
											<td className="px-2 py-1.5">{b.policies}</td>
											<td className="px-2 py-1.5">{b.wins}</td>
											<td className="px-2 py-1.5">
												<span className="font-board text-[15px] text-loss">
													{(b.win_rate * 100).toFixed(0)}%
												</span>
											</td>
											<td className="px-2 py-1.5 whitespace-nowrap text-dim">
												{relTime(b.last_at)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</DetectorCard>

					<DetectorCard
						title="Buyer swarms"
						hint={`One flight-day drawing ≥${data.thresholds.swarm_min_buyers} distinct buyers. The contract caps one policy per traveler per flight — a swarm of fresh addresses is how that cap gets bypassed (sybil ring), or how a leak that one flight is a sure thing looks on-chain.`}
						ok={data.swarm_flights.length === 0}
						okLabel="No flight-day shows unusual buyer concentration."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.swarm_flights.map((f) => (
								<li key={`${f.flight_id}:${f.day}`}>
									<span className="font-board text-[15px] text-ink">{f.flight_id}</span>{" "}
									<span className="text-mute">{f.day.slice(0, 10)} ·</span>{" "}
									<span className="text-gold">
										{f.buyers} buyers / {f.policies} policies
									</span>{" "}
									<span className="text-mute">
										· {formatUsdc(BigInt(f.premium_units))} USDC in,{" "}
										{formatUsdc(BigInt(f.payoff_units))} USDC promised
									</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					<DetectorCard
						title="Same-ledger batches"
						hint={`≥${data.thresholds.batch_min_policies} policies landing in one ledger (~5s window) — coordinated submission, usually one operator driving many keys.`}
						ok={data.ledger_batches.length === 0}
						okLabel="No coordinated purchase batches detected."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.ledger_batches.map((b) => (
								<li key={b.ledger}>
									<span className="text-mute">ledger</span>{" "}
									<span className="font-board text-[15px] text-ink">
										{b.ledger.toLocaleString("en-US")}
									</span>{" "}
									<span className="text-gold">
										{b.policies} policies from {b.buyers} address(es)
									</span>{" "}
									<span className="text-mute">· {b.flights.join(", ")}</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					<DetectorCard
						title="Term change → buy"
						hint={`Purchases landing within ${data.thresholds.term_buy_window_min} minutes of a term update / whitelist / enable on the SAME route. Insider-on-governance is the classic parametric-insurance fraud; the actor and the delay tell you who to ask.`}
						ok={data.term_buys.length === 0}
						okLabel="No purchase closely followed a governance change on its route."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.term_buys.map((t, i) => (
								<li key={`${t.action_ts}:${t.buyer}:${i}`}>
									<span className="font-board text-[15px] text-ink">{t.flight_id}</span>{" "}
									<span className="text-mute">{t.action} by {t.actor} →</span>{" "}
									<AddressCell address={t.buyer} />{" "}
									<span className="text-loss">
										bought {fmtAge(t.delay_secs)} later
									</span>{" "}
									<span className="text-mute">
										· payoff {formatUsdc(BigInt(t.payoff_units))} USDC · {relTime(t.bought_at)}
									</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					{/* ── vault motion (rate-of-change) ── */}
					<div className="panel mb-4 p-4">
						<div className="mb-1 flex items-center gap-2">
							<Lamp
								tone={
									data.vault_motion.rows_48h < 2
										? "gold"
										: (data.vault_motion.price_change_24h !== null &&
													Math.abs(data.vault_motion.price_change_24h) >=
														data.thresholds.price_move_alert) ||
												(data.vault_motion.coverage_drop_24h !== null &&
													data.vault_motion.coverage_drop_24h >=
														data.thresholds.coverage_drop_alert)
											? "loss"
											: "win"
								}
							/>
							<h3 className="font-board text-[17px] text-ink">Vault motion · 24h</h3>
						</div>
						<p className="mb-2 font-body text-[12px] text-mute">
							Share price and solvency coverage should barely move: slow upward drift
							from premiums, bounded drops from payouts. A jump beyond ±
							{(data.thresholds.price_move_alert * 100).toFixed(0)}% or a coverage drop
							over {data.thresholds.coverage_drop_alert} points in a day is either a
							genuine loss event or an accounting bug — both deserve a look.
						</p>
						{data.vault_motion.rows_48h < 2 ? (
							<p className="font-body text-[13px] text-gold">
								Collecting history — {data.vault_motion.rows_48h} sample(s) so far (the
								queue_maintainer cron appends one per run).
							</p>
						) : (
							<p className="font-body text-[13px] text-dim">
								Share price{" "}
								<span className="font-board text-[15px] text-ink">
									{data.vault_motion.share_price_now
										? (Number(data.vault_motion.share_price_now) / 1e7).toFixed(4)
										: "—"}{" "}
									USDC
								</span>{" "}
								·{" "}
								<span
									className={
										data.vault_motion.price_change_24h !== null &&
										Math.abs(data.vault_motion.price_change_24h) >=
											data.thresholds.price_move_alert
											? "text-loss"
											: "text-win"
									}
								>
									{data.vault_motion.price_change_24h === null
										? "Δ24h n/a"
										: `${data.vault_motion.price_change_24h >= 0 ? "+" : ""}${(data.vault_motion.price_change_24h * 100).toFixed(2)}% / 24h`}
								</span>{" "}
								<span className="text-mute">
									· sharpest step {(data.vault_motion.max_step_pct * 100).toFixed(2)}%
								</span>{" "}
								· coverage{" "}
								<span className="font-board text-[15px] text-ink">
									{data.vault_motion.coverage_now === null
										? "∞"
										: `${data.vault_motion.coverage_now.toFixed(0)}%`}
								</span>{" "}
								<span
									className={
										data.vault_motion.coverage_drop_24h !== null &&
										data.vault_motion.coverage_drop_24h >=
											data.thresholds.coverage_drop_alert
											? "text-loss"
											: "text-mute"
									}
								>
									{data.vault_motion.coverage_drop_24h === null
										? ""
										: `(${data.vault_motion.coverage_drop_24h >= 0 ? "−" : "+"}${Math.abs(data.vault_motion.coverage_drop_24h).toFixed(0)}pts / 24h)`}
								</span>
							</p>
						)}
					</div>

					<DetectorCard
						title="Supply conservation"
						hint="Total shares may only change when the queue_maintainer processes the deposit/withdrawal queues. A supply delta between history samples with NO queue run in the window is an impossible-mint alarm."
						ok={data.supply_violations.length === 0}
						okLabel="Every supply change matches a queue-processing run."
					>
						<ul className="space-y-1 font-body text-[13px]">
							{data.supply_violations.map((v, i) => (
								<li key={`${v.ts}:${i}`}>
									<span className="text-loss">
										{(Number(v.prev_supply) / 1e10).toFixed(2)} →{" "}
										{(Number(v.total_supply) / 1e10).toFixed(2)} shares
									</span>{" "}
									<span className="text-mute">
										between {relTime(v.prev_ts)} and {relTime(v.ts)} — no queue run in
										window
									</span>
								</li>
							))}
						</ul>
					</DetectorCard>

					{/* ── dominance & flows ── */}
					<div className="panel mb-4 p-4">
						<div className="mb-1 flex items-center gap-2">
							<Lamp
								tone={
									(data.dominance.top[0]?.fraction ?? 0) >= data.thresholds.dominance_pct ||
									data.flows.large_requests.length > 0
										? "loss"
										: data.flows.both_queues.length > 0
											? "gold"
											: "win"
								}
							/>
							<h3 className="font-board text-[17px] text-ink">Vault dominance &amp; flows</h3>
						</div>
						<p className="mb-2 font-body text-[12px] text-mute">
							A single holder above {(data.thresholds.dominance_pct * 100).toFixed(0)}%
							of shares can time the book and threatens an exit crunch; a queued
							request above {(data.thresholds.flow_pct * 100).toFixed(0)}% of
							TVL/supply moves the price at processing; an address in BOTH queues at
							once is probing the delayed-pricing mechanism. Holder shares come from
							the same known-address probe as the Users tab.
						</p>
						{data.dominance.top.length === 0 ? (
							<p className="font-body text-[13px] text-mute">
								No share balances found among known addresses.
							</p>
						) : (
							<ul className="space-y-1 font-body text-[13px]">
								{data.dominance.top.map((h) => (
									<li key={h.address}>
										<AddressCell address={h.address} />{" "}
										<span
											className={
												h.fraction >= data.thresholds.dominance_pct
													? "font-board text-[15px] text-loss"
													: "font-board text-[15px] text-dim"
											}
										>
											{(h.fraction * 100).toFixed(1)}%
										</span>{" "}
										<span className="text-mute">
											of supply ({sharesAmount(h.shares)} shares)
										</span>
									</li>
								))}
							</ul>
						)}
						{data.flows.large_requests.length > 0 && (
							<ul className="mt-2 space-y-1 font-body text-[13px]">
								{data.flows.large_requests.map((f, i) => (
									<li key={`${f.owner}:${i}`}>
										<span className="text-loss">
											large {f.kind}: {(f.fraction * 100).toFixed(0)}% of{" "}
											{f.kind === "deposit" ? "TVL" : "supply"}
										</span>{" "}
										<span className="text-mute">queued by</span>{" "}
										<AddressCell address={f.owner} />
									</li>
								))}
							</ul>
						)}
						{data.flows.both_queues.length > 0 && (
							<p className="mt-2 font-body text-[13px] text-gold">
								In both queues right now:{" "}
								{data.flows.both_queues.map((a, i) => (
									<Fragment key={a}>
										{i > 0 && ", "}
										<AddressCell address={a} />
									</Fragment>
								))}
							</p>
						)}
					</div>

					{/* ── ops surface: always-visible tables ── */}
					<div className="panel mb-4 p-4">
						<div className="mb-1 flex items-center gap-2">
							<Lamp
								tone={
									externalTriggers > 0
										? "loss"
										: data.manual_triggers.length > 0
											? "gold"
											: "win"
								}
							/>
							<h3 className="font-board text-[17px] text-ink">Out-of-schedule job runs · 7d</h3>
						</div>
						<p className="mb-2 font-body text-[12px] text-mute">
							Cron endpoints invoked outside the Vercel schedule. "manual:&lt;email&gt;"
							is the admin Run button (audited); "external" means someone used
							CRON_SECRET directly — if nobody on the team did, rotate the secret.
						</p>
						{data.manual_triggers.length === 0 ? (
							<p className="font-body text-[13px] text-win">
								Only scheduled runs in the last 7 days.
							</p>
						) : (
							<ul className="space-y-1 font-body text-[13px]">
								{data.manual_triggers.map((t, i) => (
									<li key={`${t.job}:${t.ran_at}:${i}`}>
										<span className="font-board text-[15px] text-ink">{t.job}</span>{" "}
										<span
											className={t.trigger === "external" ? "text-loss" : "text-gold"}
										>
											{t.trigger}
										</span>{" "}
										<span className="text-mute">
											· {relTime(t.ran_at)} · {t.success ? "ok" : "FAILED"}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>

					<div className="panel mb-4 p-4">
						<div className="mb-1 flex items-center gap-2">
							<Lamp tone={data.whitelist_changes.length > 0 ? "gold" : "win"} />
							<h3 className="font-board text-[17px] text-ink">Buyer-whitelist changes · 30d</h3>
						</div>
						<p className="mb-2 font-body text-[12px] text-mute">
							Who was let into (or removed from) the buyer gate, and by whom. An
							add followed shortly by an outlier win above is the pattern to chase.
						</p>
						{data.whitelist_changes.length === 0 ? (
							<p className="font-body text-[13px] text-win">No whitelist mutations.</p>
						) : (
							<ul className="space-y-1 font-body text-[13px]">
								{data.whitelist_changes.map((w, i) => (
									<li key={`${w.ts}:${i}`}>
										<span className={w.action === "add_whitelisted_buyer" ? "text-gold" : "text-dim"}>
											{w.action === "add_whitelisted_buyer" ? "added" : "removed"}
										</span>{" "}
										{w.addr ? <AddressCell address={w.addr} /> : <span className="text-mute">?</span>}{" "}
										<span className="text-mute">
											· by {w.actor} · {relTime(w.ts)}
											{w.success ? "" : " · FAILED"}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>

					<div className="panel p-4">
						<div className="mb-1 flex items-center gap-2">
							<Lamp
								tone={data.actor_summary.some((a) => a.failures > 0) ? "gold" : "win"}
							/>
							<h3 className="font-board text-[17px] text-ink">Governance actors · 7d</h3>
						</div>
						<p className="mb-2 font-body text-[12px] text-mute">
							Every identity that touched governance, with action and failure
							counts. An actor you don't recognize, or a failure spike, is the
							early smoke of a compromised key.
						</p>
						{data.actor_summary.length === 0 ? (
							<p className="font-body text-[13px] text-win">No governance actions this week.</p>
						) : (
							<ul className="space-y-1 font-body text-[13px]">
								{data.actor_summary.map((a) => (
									<li key={a.actor}>
										<span className="font-board text-[15px] text-ink">{a.actor}</span>{" "}
										<span className="text-mute">
											· {a.actions} action(s) ·{" "}
											{a.failures > 0 ? (
												<span className="text-gold">{a.failures} failed</span>
											) : (
												"none failed"
											)}{" "}
											· last {relTime(a.last_at)}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>
				</>
			)}
		</section>
	)
}
