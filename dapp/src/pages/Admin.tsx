import { Fragment, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Session } from "@supabase/supabase-js"
import { supabase } from "../lib/supabase"
import { relTime } from "../lib/utils"
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

async function api(path: string, token: string, init?: RequestInit) {
	const res = await fetch(path, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(init?.headers ?? {}),
		},
	})
	const body = await res.json().catch(() => ({}))
	if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
	return body
}

const usd = (units: string | null | undefined) =>
	units == null ? "—" : `$${(Number(units) / 1e7).toLocaleString()}`

const shortTx = (h: string) => `${h.slice(0, 4)}…${h.slice(-4)}`

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
			<div className="panel mx-auto max-w-md px-6 py-6">
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

/** Only routes/interventions poll unconditionally — they feed the
 *  always-visible header dashboard. Jobs/outcomes/log are lazy: each
 *  fetches only while its own tab is the active one, so an admin sitting
 *  on one tab isn't silently paying for four background pollers. */
type AdminTab = "jobs" | "routes" | "interventions" | "outcomes" | "log"

const ADMIN_TABS: Array<{ key: AdminTab; label: string }> = [
	{ key: "jobs", label: "Jobs" },
	{ key: "routes", label: "Routes" },
	{ key: "interventions", label: "Interventions" },
	{ key: "outcomes", label: "Outcomes" },
	{ key: "log", label: "Action log" },
]

function Console({ session }: { session: Session }) {
	const token = session.access_token
	const qc = useQueryClient()
	const invalidate = () => qc.invalidateQueries()
	const [activeTab, setActiveTab] = useState<AdminTab>("jobs")

	const jobsQ = useQuery({
		queryKey: ["admin-jobs"],
		queryFn: () => api("/api/admin/jobs", token),
		enabled: activeTab === "jobs",
		staleTime: 30_000,
		refetchInterval: 60_000,
	})
	const [routeQuery, setRouteQuery] = useState("")
	const [routePage, setRoutePage] = useState(1)
	const [adminPausedOnly, setAdminPausedOnly] = useState(false)
	const routeLimit = 50

	const routesQ = useQuery({
		queryKey: ["admin-routes", routeQuery, routePage, adminPausedOnly],
		queryFn: () => {
			const params = new URLSearchParams({
				chain: "1",
				page: String(routePage),
				limit: String(routeLimit),
			})
			if (routeQuery) params.set("q", routeQuery)
			if (adminPausedOnly) params.set("cause", "admin")
			return api(`/api/admin/routes?${params}`, token)
		},
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
			return api(`/api/admin/interventions?${params}`, token)
		},
		staleTime: 30_000,
		refetchInterval: 60_000,
	})
	const logQ = useQuery({
		queryKey: ["admin-log"],
		queryFn: () => api("/api/admin/actions?limit=100", token),
		enabled: activeTab === "log",
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
			return api(`/api/admin/outcomes?${params}`, token)
		},
		enabled: activeTab === "outcomes",
		staleTime: 30_000,
		refetchInterval: 60_000,
	})

	const unauthorized = [routesQ, interventionsQ, logQ, outcomesQ].some(
		(q) => q.error instanceof Error && q.error.message === "Unauthorized"
	)

	const routes: any[] = routesQ.data?.routes ?? []
	const interventions: any[] = interventionsQ.data?.rows ?? []
	// Fleet-wide, DB-only counts (never a full chain scan or the current
	// tab/filter) so the header stays a whole-fleet summary.
	const figures = useMemo(
		() => ({
			routes: routesQ.data?.fleet_total ?? 0,
			onchain: routesQ.data?.fleet_active ?? 0,
			pauses: interventionsQ.data?.open_count ?? 0,
		}),
		[routesQ.data, interventionsQ.data]
	)

	return (
		<div className="mx-auto max-w-6xl px-4 py-10">
			<BoardHeader figures={routesQ.isLoading ? null : figures} />

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
						<ActionLog log={logQ.data?.log ?? []} loading={logQ.isLoading} />
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
	last: { ran_at: string; success: boolean } | undefined,
	intervalMinutes: number
): { tone: "win" | "loss" | "gold"; word: string } {
	if (!last) return { tone: "gold", word: "no runs" }
	if (!last.success) return { tone: "loss", word: "failed" }
	const ageMin = (Date.now() - new Date(last.ran_at).getTime()) / 60_000
	if (ageMin > 2 * intervalMinutes) return { tone: "gold", word: "stale" }
	return { tone: "win", word: "ok" }
}

function JobsBoard({
	registry,
	latest,
	recent,
	loading,
	token,
	onDone,
}: {
	registry: any[]
	latest: any[]
	recent: any[]
	loading: boolean
	token: string
	onDone: () => void
}) {
	const [busy, setBusy] = useState<string | null>(null)
	const [note, setNote] = useState<string | null>(null)
	const [runTxState, setRunTxState] = useState<TxState>("idle")
	const [expanded, setExpanded] = useState<string | null>(null)
	const byJob = new Map(latest.map((r: any) => [r.job, r]))

	async function runNow(job: string) {
		setBusy(job)
		setNote(null)
		setRunTxState("confirming")
		try {
			const entry = await api("/api/admin/jobs", token, {
				method: "POST",
				body: JSON.stringify({ job }),
			})
			setNote(`${job}: ${entry.success ? "completed" : "FAILED"} in ${entry.duration_ms}ms`)
			setRunTxState(entry.success ? "success" : "error")
			onDone()
		} catch (err) {
			setNote(`${job}: ${err instanceof Error ? err.message : String(err)}`)
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
						{registry.map((info: any) => {
							const last = byJob.get(info.job)
							const { tone, word } = jobTone(last, info.intervalMinutes)
							const isOpen = expanded === info.job
							const history = recent.filter((r: any) => r.job === info.job).slice(0, 8)
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
											<span className="font-board text-[16px] text-sky">{info.schedule}</span>
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
														No recent run history.
													</p>
												) : (
													<div className="flex flex-wrap items-center gap-2">
														<span className="label-px text-mute">Recent runs</span>
														{history.map((r: any, i: number) => (
															<span
																key={i}
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
	routes: any[]
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
	const pageCount = Math.max(1, Math.ceil(total / limit))

	async function act(label: string, fn: () => Promise<unknown>) {
		setBusy(label)
		setError(null)
		try {
			await fn()
			onDone()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	const post = (body: object) =>
		api("/api/admin/actions", token, { method: "POST", body: JSON.stringify(body) })
	const patch = (body: object) =>
		api("/api/admin/routes", token, { method: "PATCH", body: JSON.stringify(body) })
	const intervene = (body: object) =>
		api("/api/admin/interventions", token, { method: "POST", body: JSON.stringify(body) })
	const revive = (id: string) =>
		api("/api/admin/interventions", token, { method: "PATCH", body: JSON.stringify({ id }) })

	function halt(r: any, id: string, key: object) {
		const reason = window.prompt(`Reason for pausing ${r.flight_id} ${r.origin}→${r.dest}:`)
		if (!reason) return
		void act(id, () => intervene({ ...key, reason }))
	}

	function resume(r: any, id: string, key: object) {
		// Prefer reviving the open intervention row (audited, cause-tracked);
		// fall back to the raw on-chain enable for routes disabled before the
		// interventions ledger existed (no open row to revive).
		if (r.open_intervention_id) {
			void act(id, () => revive(r.open_intervention_id))
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
									<td className="px-3 py-2 text-gold">{usd(r.on_chain?.terms?.premium)}</td>
									<td className="px-3 py-2 text-gold">{usd(r.on_chain?.terms?.payoff)}</td>
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
			{total > 0 && (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-3">
					<span className="font-body text-[13px] text-mute">
						{total.toLocaleString()} route{total === 1 ? "" : "s"}
					</span>
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
			)}
			{error && <p className="mt-2 font-body text-[13px] text-loss">{error}</p>}
			<AddRoute token={token} onDone={onDone} />
		</section>
	)
}

function AddRoute({ token, onDone }: { token: string; onDone: () => void }) {
	const [form, setForm] = useState({ flight_id: "", origin: "", dest: "", carrier: "" })
	const m = useMutation({
		mutationFn: () =>
			api("/api/admin/routes", token, {
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
	interventions: any[]
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
	const pageCount = Math.max(1, Math.ceil(total / limit))
	const revive = useMutation({
		mutationFn: (id: string) =>
			api("/api/admin/interventions", token, { method: "PATCH", body: JSON.stringify({ id }) }),
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
										since {new Date(s.opened_at).toUTCString().slice(5, 22)}
									</span>
									{state === "open" ? (
										<span className="font-body text-[12px] text-mute">
											checked {new Date(s.last_checked_at).toUTCString().slice(5, 22)}
										</span>
									) : (
										<span className="font-body text-[12px] text-mute">
											revived {new Date(s.revived_at).toUTCString().slice(5, 22)} by {s.revived_by}
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
			{total > 0 && (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-3">
					<span className="font-body text-[13px] text-mute">
						{total.toLocaleString()} {state === "open" ? "open" : "closed"}
					</span>
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
			)}
			<AdminPause token={token} onDone={onDone} />
		</section>
	)
}

function AdminPause({ token, onDone }: { token: string; onDone: () => void }) {
	const [form, setForm] = useState({ flight_id: "", origin: "", dest: "", reason: "" })
	const m = useMutation({
		mutationFn: () =>
			api("/api/admin/interventions", token, {
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
	outcomes: any[]
	loading: boolean
	filter: string
	onFilterChange: (outcome: string) => void
	page: number
	onPageChange: (page: number) => void
	total: number
	limit: number
}) {
	const pageCount = Math.max(1, Math.ceil(total / limit))

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
			{total > 0 && (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-3">
					<span className="font-body text-[13px] text-mute">
						{total.toLocaleString()} outcome{total === 1 ? "" : "s"}
					</span>
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
			)}
		</section>
	)
}

function ActionLog({ log, loading }: { log: any[]; loading: boolean }) {
	return (
		<section>
			<h2 className="h-section mb-3">Action log</h2>
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
									No governance actions yet.
								</td>
							</tr>
						)}
						{log.map((a) => (
							<tr key={a.id} className="border-b border-line/60 last:border-b-0">
								<td className="px-3 py-2 whitespace-nowrap text-mute">
									{new Date(a.ts).toISOString().slice(0, 16).replace("T", " ")}
								</td>
								<td className="px-3 py-2 text-dim">{a.actor}</td>
								<td className="px-3 py-2 text-ink">{a.action}</td>
								<td className="px-3 py-2 whitespace-nowrap text-dim">
									{a.flight_id ? `${a.flight_id} ${a.origin}→${a.dest}` : "—"}
								</td>
								<td className="px-3 py-2">
									{a.tx_hash ? (
										<a
											href={`https://stellar.expert/explorer/testnet/tx/${a.tx_hash}`}
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
		</section>
	)
}
