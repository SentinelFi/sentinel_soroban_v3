import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Session } from "@supabase/supabase-js"
import { supabase } from "../lib/supabase"

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
 * pipeline → actions_log). Declaring a signal never touches the chain
 * directly — the reconciler acts on it within the hour.
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
	figures: { routes: number; onchain: number; signals: number; pauses: number } | null
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
				<BoardStat label="Live signals" value={figures ? String(figures.signals) : "--"} />
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
			<p className={`board-figure ${tone === "loss" ? "text-loss" : ""}`}>{value}</p>
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

function Console({ session }: { session: Session }) {
	const token = session.access_token
	const qc = useQueryClient()
	const invalidate = () => qc.invalidateQueries()

	const routesQ = useQuery({
		queryKey: ["admin-routes"],
		queryFn: () => api("/api/admin/routes?chain=1", token),
		refetchInterval: 60_000,
	})
	const signalsQ = useQuery({
		queryKey: ["admin-signals"],
		queryFn: () => api("/api/admin/signals", token),
		refetchInterval: 60_000,
	})
	const logQ = useQuery({
		queryKey: ["admin-log"],
		queryFn: () => api("/api/admin/actions?limit=100", token),
		refetchInterval: 60_000,
	})

	const unauthorized = [routesQ, signalsQ, logQ].some(
		(q) => q.error instanceof Error && q.error.message === "Unauthorized"
	)

	const routes: any[] = routesQ.data?.routes ?? []
	const signals: any[] = signalsQ.data?.active ?? []
	const figures = useMemo(
		() => ({
			routes: routes.length,
			onchain: routes.filter((r) => r.on_chain?.status !== "Unknown").length,
			signals: signals.length,
			pauses: signals.filter((s) => s.severity === "severe").length,
		}),
		[routes, signals]
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
				<div className="space-y-10">
					<RoutesBoard routes={routes} loading={routesQ.isLoading} token={token} onDone={invalidate} />
					<SignalsPanel signals={signals} loading={signalsQ.isLoading} token={token} onDone={invalidate} />
					<ActionLog log={logQ.data?.log ?? []} loading={logQ.isLoading} />
				</div>
			)}
		</div>
	)
}

/* ── routes board ─────────────────────────────────────────────────── */

function RoutesBoard({
	routes,
	loading,
	token,
	onDone,
}: {
	routes: any[]
	loading: boolean
	token: string
	onDone: () => void
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
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(null)
		}
	}

	const post = (body: object) =>
		api("/api/admin/actions", token, { method: "POST", body: JSON.stringify(body) })
	const patch = (body: object) =>
		api("/api/admin/routes", token, { method: "PATCH", body: JSON.stringify(body) })

	return (
		<section>
			<h2 className="h-section mb-3">Departures · managed routes</h2>
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
											<span className="status-px text-dim">{chain}</span>
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
													onClick={() => act(id, () => post({ op: "disable", ...key }))}
												>
													{busy === id ? "…" : "Halt"}
												</button>
											)}
											{chain === "Disabled" && (
												<button
													className="btn-px btn-win btn-sm"
													disabled={busy !== null}
													onClick={() => act(id, () => post({ op: "enable", ...key }))}
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

/* ── signals ──────────────────────────────────────────────────────── */

function SignalsPanel({
	signals,
	loading,
	token,
	onDone,
}: {
	signals: any[]
	loading: boolean
	token: string
	onDone: () => void
}) {
	const clear = useMutation({
		mutationFn: (id: string) =>
			api("/api/admin/signals", token, { method: "PATCH", body: JSON.stringify({ id }) }),
		onSuccess: onDone,
	})

	return (
		<section>
			<h2 className="h-section mb-3">Signals · pauses &amp; adjustments</h2>
			<div className="panel px-4 py-3">
				{loading && <p className="font-body text-[13px] text-mute">Reading signals…</p>}
				{!loading && signals.length === 0 && (
					<p className="font-body text-[13px] text-mute">
						No live signals. The reconciler is holding all routes at base terms.
					</p>
				)}
				<ul className="divide-y divide-line/60">
					{signals.map((s) => (
						<li key={s.id} className="flex flex-wrap items-center gap-3 py-2.5">
							<Lamp tone={s.severity === "severe" ? "loss" : s.severity === "elevated" ? "gold" : "blip"} blink={s.severity === "severe"} />
							<span className="status-px text-ink">{s.type}</span>
							<span className="font-board text-[17px] text-dim">
								{s.scope_kind === "route"
									? `${s.flight_id} ${s.origin}→${s.dest}`
									: s.scope_kind === "origin"
										? `${s.origin} → ✱`
										: `✱ → ${s.dest}`}
							</span>
							<span className="status-px text-mute">{s.severity}</span>
							{s.payload?.factor && (
								<span className="font-board text-[17px] text-gold">×{s.payload.factor}</span>
							)}
							<span className="font-body text-[12px] text-mute">{s.source}</span>
							{s.expires_at && (
								<span className="font-body text-[12px] text-mute">
									until {new Date(s.expires_at).toUTCString().slice(5, 22)}
								</span>
							)}
							<button
								className="btn-px btn-ghost btn-sm ml-auto"
								disabled={clear.isPending}
								onClick={() => clear.mutate(s.id)}
							>
								Clear
							</button>
						</li>
					))}
				</ul>
			</div>
			<DeclareSignal token={token} onDone={onDone} />
		</section>
	)
}

function DeclareSignal({ token, onDone }: { token: string; onDone: () => void }) {
	const [form, setForm] = useState({
		type: "geopolitical",
		severity: "severe",
		scope_kind: "dest",
		flight_id: "",
		origin: "",
		dest: "",
		factor: "1.25",
		hours: "24",
		note: "",
	})
	const m = useMutation({
		mutationFn: () =>
			api("/api/admin/signals", token, {
				method: "POST",
				body: JSON.stringify({
					type: form.type,
					severity: form.severity,
					scope_kind: form.scope_kind,
					flight_id: form.scope_kind === "route" ? form.flight_id : null,
					origin: form.scope_kind !== "dest" ? form.origin : null,
					dest: form.scope_kind !== "origin" ? form.dest : null,
					payload:
						form.severity === "elevated"
							? { factor: Number(form.factor), note: form.note }
							: { note: form.note },
					expires_at: form.hours
						? new Date(Date.now() + Number(form.hours) * 3600_000).toISOString()
						: null,
				}),
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
			<Sel label="Type" value={form.type} onChange={upd("type")} opts={["geopolitical", "weather", "manual"]} />
			<Sel
				label="Effect"
				value={form.severity}
				onChange={upd("severity")}
				opts={["severe", "elevated"]}
				names={["pause", "premium ×"]}
			/>
			<Sel
				label="Scope"
				value={form.scope_kind}
				onChange={upd("scope_kind")}
				opts={["dest", "origin", "route"]}
			/>
			{form.scope_kind === "route" && (
				<Txt label="Flight" value={form.flight_id} onChange={upd("flight_id")} ph="AA100" />
			)}
			{form.scope_kind !== "dest" && (
				<Txt label="From" value={form.origin} onChange={upd("origin")} ph="JFK" />
			)}
			{form.scope_kind !== "origin" && (
				<Txt label="To" value={form.dest} onChange={upd("dest")} ph="LAX" />
			)}
			{form.severity === "elevated" && (
				<Txt label="Factor" value={form.factor} onChange={upd("factor")} ph="1.25" w="w-20" />
			)}
			<Txt label="Expires (h)" value={form.hours} onChange={upd("hours")} ph="24" w="w-24" />
			<Txt label="Note" value={form.note} onChange={upd("note")} ph="why" w="w-40" />
			<button type="submit" className="btn-px btn-loss" disabled={m.isPending}>
				{m.isPending ? "…" : "Declare"}
			</button>
			{m.error && <p className="w-full font-body text-[13px] text-loss">{String(m.error)}</p>}
		</form>
	)
}

function Sel({
	label,
	value,
	onChange,
	opts,
	names,
}: {
	label: string
	value: string
	onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
	opts: string[]
	names?: string[]
}) {
	return (
		<label className="block">
			<span className="label-px mb-1 block">{label}</span>
			<select className="field-px w-auto" value={value} onChange={onChange}>
				{opts.map((o, i) => (
					<option key={o} value={o}>
						{names?.[i] ?? o}
					</option>
				))}
			</select>
		</label>
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
