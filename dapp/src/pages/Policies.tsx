import { useState } from "react"
import { Link } from "react-router-dom"
import type { FlightData } from "oracle_aggregator"
import {
	flightPoolManagerClient,
	formatUsdc,
	useFlightDataBatch,
	usePolicyStateBatch,
	useTravelerFlights,
} from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { useFlightSchedules } from "../hooks/useFlightSchedules"
import { stagedSigner, useTxFlow } from "../hooks/useTxFlow"
import { cn, txHashOf } from "../lib/utils"
import { formatDate, localDate, localHm } from "../lib/format"
import { PixelArt } from "../components/PixelArt"
import { TxProgress } from "../components/TxProgress"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import { flightradarUrl } from "../config/airlines"
import { Plane, Trophy, Clock, Check, PlaneTakeoff } from "lucide-react"

type OracleTag = FlightData["status"]["tag"]
type PolicySection = "open" | "won" | "settled"

/** Flight ident as an external FR24 tracking link (same behaviour as the
 *  departures board); falls back to plain text when the ident cannot be
 *  mapped to an IATA flight number. */
function FlightLink({ id, className }: { id: string; className?: string }) {
	const t = useCopy()
	const url = flightradarUrl(id)
	if (!url) return <span className={className}>{id}</span>
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			title={t.markets.flightLinkTitle(id)}
			className={cn(className, "hover:text-sky hover:underline")}
		>
			{id}
		</a>
	)
}

/** Deep link to the policy's lifecycle record (/policy/:id). */
function DetailsLink({ policy, className }: { policy: Policy; className?: string }) {
	const t = useCopy()
	return (
		<Link
			to={`/policy/${policy.id}`}
			data-testid="policy-details"
			className={cn(
				"font-display text-[10px] tracking-[0.05em] text-sky hover:underline",
				className,
			)}
		>
			{t.policyDetail.detailsLink}
		</Link>
	)
}

/** Colour buckets for status badges (mapped to CSS vars via --badge). */
type BadgeKind = "tracking" | "onTime" | "claimable" | "paid" | "expired"

const BADGE_VAR: Record<BadgeKind, string> = {
	tracking: "var(--color-gold)", // amber = in the air / tracking
	onTime: "var(--color-sky)", // cyan = settled on-time
	claimable: "var(--color-win)", // green = delayed / claimable
	paid: "var(--color-win)", // green = paid out
	expired: "var(--color-mute)", // mute = expired / terminal
}

interface Policy {
	id: string
	flightId: string
	date: bigint
	dateStr: string
	section: PolicySection
	payoff?: bigint
	claimed: boolean
	outcome: string // short display label
	badge: BadgeKind
	/** why this policy is terminal (history only) */
	reason?: string
	/** claim-window expiry, for the claimable countdown line */
	claimExpiry?: bigint
	eta?: string
	/** scheduled departure "HH:MM" UTC, when the backend snapshot has it */
	depTime?: string
}

type Copy = ReturnType<typeof useCopy>

/** Live-tracking label — themed through copy.ts so serious mode doesn't
 *  leak the arcade ALL-CAPS voice. */
function liveLabel(tag: OracleTag | undefined, t: Copy): string {
	switch (tag) {
		case "Active":
			return t.policies.liveInAir
		case "Landed":
			return t.policies.liveLanded
		case "Cancelled":
		case "ToBeSettledCancelled":
			return t.policies.liveCancelled
		case "ToBeSettledDelayed":
			return t.policies.liveDelayedSettling
		case "ToBeSettledOnTime":
			return t.policies.liveOnTimeSettling
		default:
			return t.policies.liveScheduled
	}
}

function computeEta(estimatedArrival: bigint): string | undefined {
	if (estimatedArrival === 0n) return undefined
	const diff = Number(estimatedArrival) * 1000 - Date.now()
	if (diff <= 0) return "ARRIVING"
	const hours = Math.floor(diff / 3_600_000)
	const minutes = Math.floor((diff % 3_600_000) / 60_000)
	return `ETA ${hours}H ${minutes}M`
}

/** Small themed status badge. FUN = pixel chip, SERIOUS = soft pill. */
function StatusBadge({ kind, label }: { kind: BadgeKind; label: string }) {
	return (
		<span
			data-testid="policy-status"
			className="w3-badge"
			style={{ ["--badge" as string]: BADGE_VAR[kind] }}
		>
			<span className="w3-badge-dot" aria-hidden="true" />
			{label}
		</span>
	)
}

export default function Policies() {
	const { address, signTransaction, networkMismatch } = useWallet()
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const [claimingId, setClaimingId] = useState<string | null>(null)
	const claimFlow = useTxFlow({
		invalidateKeys: [["pool"], ["usdc"]],
		errorFallback: "Claim failed",
		notifyError: true,
		resetDelayMs: 2000,
		onSettled: () => setClaimingId(null),
	})

	const {
		data: flights,
		isLoading: flightsLoading,
		isError: flightsError,
		refetch: refetchFlights,
	} = useTravelerFlights(address)
	const {
		data: policyStates,
		isLoading: statesLoading,
		isError: statesError,
		refetch: refetchStates,
	} = usePolicyStateBatch(flights, address)
	const { data: flightData } = useFlightDataBatch(flights)
	// Scheduled departures from the sale-auth snapshot table — every policy
	// went through sale-auth at buy time, so rows normally exist. Missing
	// data (DB-optional backend) just leaves the time off the row.
	const { data: depTimes } = useFlightSchedules(
		(flights ?? []).map(([flightId, date]) => ({ flightId, date })),
	)

	if (!address) {
		return (
			<div
				data-tour="policies"
				className="mx-auto max-w-3xl px-4 py-16 text-center"
			>
				{serious ? (
					<Plane className="mx-auto h-14 w-14 text-highlight" strokeWidth={1.6} />
				) : (
					<PixelArt name="avatar-pilot" className="mx-auto h-24 w-24" />
				)}
				<h1 className={`h-display mt-6 ${serious ? "text-[26px]" : "text-[18px]"}`}>
					{t.policies.title}
				</h1>
				<p className={`mt-4 font-body ${serious ? "text-[17px]" : "text-body"} leading-relaxed text-dim`}>
					{t.policies.connectSub}
				</p>
				<p className={`mt-6 font-board ${serious ? "text-[22px]" : "text-[20px]"} text-gold`}>
					{!serious && <span className="blink">▶</span>}{" "}
					{t.policies.connectPrompt}
				</p>
			</div>
		)
	}

	const isLoading = flightsLoading || statesLoading
	// An RPC failure must NEVER masquerade as "no policies yet" — for an
	// insurance product that's a trust-destroying message.
	const loadFailed = flightsError || statesError

	const oracleByFlight = new Map(
		(flightData ?? []).map((entry) => [
			`${entry.flightId}:${entry.date.toString()}`,
			entry.data,
		]),
	)
	const nowSecs = BigInt(Math.floor(Date.now() / 1000))

	const policies: Policy[] = (policyStates ?? []).map((state) => {
		const oracle = oracleByFlight.get(
			`${state.flightId}:${state.date.toString()}`,
		)
		const settlementTag = state.config?.status.tag
		const claimExpiry = state.config?.claim_expiry
		// window is open while now < claim_expiry
		const windowOpen =
			claimExpiry !== undefined && nowSecs < claimExpiry

		// ── section ──
		// ACTIVE: no config yet, or still Active (flight hasn't settled).
		// WON: settled delayed/cancelled, not claimed, window still open.
		// HISTORY (settled): everything terminal.
		let section: PolicySection
		if (!state.config || settlementTag === "Active") {
			section = "open"
		} else if (
			(settlementTag === "SettledDelayed" ||
				settlementTag === "SettledCancelled") &&
			!state.claimed &&
			windowOpen
		) {
			section = "won"
		} else {
			section = "settled"
		}

		// ── badge + short label + terminal reason ──
		let outcome: string
		let badge: BadgeKind
		let reason: string | undefined

		if (section === "open") {
			outcome = liveLabel(oracle?.status.tag, t)
			badge = "tracking"
		} else if (section === "won") {
			outcome =
				settlementTag === "SettledCancelled"
					? t.policies.outcomeCancelledPays
					: t.policies.outcomeDelayedPays
			badge = "claimable"
		} else {
			// terminal — derive the eligibility reason string
			if (settlementTag === "SettledOnTime") {
				outcome = t.policies.outcomeOnTime
				badge = "onTime"
				reason = t.policies.reasonOnTime
			} else if (state.claimed) {
				// delayed/cancelled and already claimed → paid out
				outcome =
					settlementTag === "SettledCancelled"
						? t.policies.outcomeCancelledPaid
						: t.policies.outcomeDelayedPaid
				badge = "paid"
				reason =
					settlementTag === "SettledCancelled"
						? t.policies.reasonCancelledPaid
						: t.policies.reasonDelayedPaid
			} else {
				// delayed/cancelled, unclaimed, window closed → expired
				outcome =
					settlementTag === "SettledCancelled"
						? t.policies.outcomeCancelledExpired
						: t.policies.outcomeDelayedExpired
				badge = "expired"
				reason = t.policies.reasonExpired
			}
		}

		const eta =
			section === "open" && oracle
				? computeEta(oracle.estimated_arrival_time)
				: undefined

		const depSecs = depTimes?.get(
			`${state.flightId}:${state.date.toString()}`,
		)

		return {
			id: `${state.flightId}-${state.date.toString()}`,
			flightId: state.flightId,
			date: state.date,
			// The date follows the departure INSTANT whenever we have one, so
			// date and time on a row are always the same local moment. Without
			// a schedule the only thing available is the contract's UTC date
			// bucket — a calendar label, which must not be shifted into the
			// viewer's zone or the flight moves a day for everyone west of UTC.
			dateStr:
				depSecs !== undefined ? localDate(depSecs) : formatDate(state.date),
			depTime: depSecs !== undefined ? localHm(depSecs) : undefined,
			section,
			payoff: state.config?.payoff,
			claimed: state.claimed,
			outcome,
			badge,
			reason,
			claimExpiry,
			eta,
		}
	})

	const openPolicies = policies.filter((b) => b.section === "open")
	const wonPolicies = policies.filter((b) => b.section === "won")
	const settledPolicies = policies.filter((b) => b.section === "settled")

	const handleClaim = (policy: Policy) => {
		if (!address || claimingId) return
		setClaimingId(policy.id)
		void claimFlow.run(async (step) => {
			step("verifying")
			const tx = await flightPoolManagerClient.claim({
				traveler: address,
				flight_id: policy.flightId,
				date: policy.date,
			})
			const sent = await tx.signAndSend({
				signTransaction: stagedSigner(step, signTransaction),
			})
			return {
				message: t.notify.claimed(policy.flightId),
				txHash: txHashOf(sent),
			}
		})
	}

	return (
		<div
			data-tour="policies"
			className="mx-auto max-w-4xl space-y-10 px-4 py-8"
		>
			<div>
				{/* serious: Outfit renders optically far smaller than the pixel face,
				    so the page title takes a larger size there */}
				<h1 className={`h-display ${serious ? "text-[28px]" : "text-[20px]"}`}>
					{t.policies.title}
				</h1>
				<p className={`mt-2 font-body ${serious ? "text-body" : "text-meta"} text-dim`}>
					{t.policies.intro}
				</p>
				{!isLoading && !loadFailed && policies.length > 0 && (
					<p
						data-testid="policies-total"
						className={`mt-1 font-body ${serious ? "text-body" : "text-meta"} text-mute`}
					>
						{t.policies.total(policies.length)}
					</p>
				)}
			</div>

			{isLoading && (
				<div className="panel p-8 text-center">
					<span className={`font-board ${serious ? "text-[24px]" : "text-[22px]"} text-gold`}>
						{t.policies.loading}
						{!serious && <span className="blink">…</span>}
					</span>
				</div>
			)}

			{!isLoading && loadFailed && (
				<div role="alert" className="panel p-8 text-center">
					<p className={`font-board ${serious ? "text-[24px]" : "text-[22px]"} text-loss`}>
						{t.policies.loadError}
					</p>
					<p className={`mt-2 font-body ${serious ? "text-body" : "text-meta"} text-mute`}>
						{t.policies.loadErrorSub}
					</p>
					<button
						type="button"
						className="btn-px btn-gold mt-4"
						onClick={() => {
							void refetchFlights()
							void refetchStates()
						}}
					>
						{t.policies.retry}
					</button>
				</div>
			)}

			{!isLoading && !loadFailed && policies.length === 0 && (
				<div className="panel p-8 text-center">
					{serious ? (
						<Plane
							className="mx-auto h-14 w-14 text-highlight"
							strokeWidth={1.6}
						/>
					) : (
						<PixelArt
							name="avatar-pilot"
							className="mx-auto h-24 w-24"
						/>
					)}
					<p className={`mt-4 font-board ${serious ? "text-[24px]" : "text-[22px]"} text-mute`}>
						{t.policies.empty}
					</p>
					<Link to="/" className="btn-px btn-loss mt-4">
						{t.policies.emptyCta}
					</Link>
				</div>
			)}

			{/* READY TO CLAIM — delayed / cancelled, window still open */}
			{!isLoading && wonPolicies.length > 0 && (
				<section>
					<h2 className="h-section mb-1 flex items-center gap-2 text-gold">
						{serious && (
							<Trophy className="h-5 w-5" strokeWidth={1.7} />
						)}
						{t.policies.claim}
					</h2>
					<p className={`mb-3 font-body ${serious ? "text-body" : "text-meta"} text-mute`}>
						{t.policies.claimSub}
					</p>
					<div className="grid gap-4 sm:grid-cols-2">
						{wonPolicies.map((policy) => (
							<div
								key={policy.id}
								data-testid="policy-row"
								data-flight-id={policy.flightId}
								className="claim-card win-flash border-2 border-gold bg-surface p-5 text-center"
							>
								{serious ? (
									<Trophy
										className="mx-auto h-12 w-12 text-gold"
										strokeWidth={1.6}
									/>
								) : (
									<PixelArt
										name="trophy-win"
										className="mx-auto h-16 w-16"
									/>
								)}
								<p className={`h-display mt-3 ${serious ? "text-[18px]" : "text-[16px]"} text-gold`}>
									{t.policies.claimWin}
								</p>
								<p className={`mt-1 font-board ${serious ? "text-[22px]" : "text-[20px]"} text-dim`}>
									<FlightLink id={policy.flightId} /> · {policy.dateStr}
									{policy.depTime
										? ` · ${t.policies.depTime(policy.depTime)}`
										: ""}
								</p>
								<div className="mt-2 flex justify-center">
									<StatusBadge
										kind="claimable"
										label={t.policies.badgeClaimable}
									/>
								</div>
								<p className="board-figure mt-2 text-[30px] text-win">
									{policy.payoff !== undefined
										? `${formatUsdc(policy.payoff)} USDC`
										: "—"}
								</p>
								{policy.claimExpiry !== undefined && (
									<p className={`mt-1 font-body ${serious ? "text-meta" : "text-fine"} text-mute`}>
										{/* a real deadline instant, so local */}
										{t.policies.claimWindow(
											localDate(Number(policy.claimExpiry)),
										)}
									</p>
								)}
								<button
									type="button"
									data-testid="policy-claim"
									onClick={() => handleClaim(policy)}
									disabled={claimingId !== null || networkMismatch}
									className={cn(
										"btn-px btn-win mt-4 w-full",
										claimingId === null && "claim-btn-pulse",
									)}
								>
									{claimingId === policy.id
										? t.policies.claiming
										: t.policies.claimBtn}
								</button>
								{claimingId === policy.id && (
									<TxProgress
										state={claimFlow.state}
										steps={["verifying", "awaiting", "confirming"]}
										error={claimFlow.error}
										stamps={{ success: "stamp-paid" }}
									/>
								)}
								<DetailsLink policy={policy} className="mt-3 inline-block" />
							</div>
						))}
					</div>
				</section>
			)}

			{/* ACTIVE — scheduled or in the air */}
			{!isLoading && openPolicies.length > 0 && (
				<section>
					<h2 className="h-section mb-1 flex items-center gap-2">
						{serious ? (
							<PlaneTakeoff className="h-5 w-5" strokeWidth={1.7} />
						) : (
							<span className="breathe inline-block h-2 w-2 bg-win align-middle" />
						)}
						{t.policies.active}
					</h2>
					<p className={`mb-3 font-body ${serious ? "text-body" : "text-meta"} text-mute`}>
						{t.policies.activeSub}
					</p>
					<div className="space-y-2">
						{openPolicies.map((policy) => (
							<div
								key={policy.id}
								data-testid="policy-row"
								data-flight-id={policy.flightId}
								className="w3-policy"
							>
								<FlightLink
									id={policy.flightId}
									className="board-figure text-[24px]"
								/>
								<span className={`font-board ${serious ? "text-[21px]" : "text-[19px]"} text-dim`}>
									{policy.dateStr}
									{policy.depTime
										? ` · ${t.policies.depTime(policy.depTime)}`
										: ""}
								</span>
								<StatusBadge
									kind="tracking"
									label={t.policies.badgeTracking}
								/>
								<span className={`font-body ${serious ? "text-body" : "text-meta"} text-dim`}>
									{policy.outcome}
									{policy.eta ? ` · ${policy.eta}` : ""}
								</span>
								<span className={`ml-auto font-board ${serious ? "text-[21px]" : "text-[19px]"} text-dim`}>
									{t.policies.payoutLabel}{" "}
									<span className="text-win">
										{policy.payoff !== undefined
											? `${formatUsdc(policy.payoff)} USDC`
											: "—"}
									</span>
								</span>
								<DetailsLink policy={policy} />
							</div>
						))}
					</div>
				</section>
			)}

			{/* HISTORY — terminal, with an eligibility reason each */}
			{!isLoading && settledPolicies.length > 0 && (
				<section>
					<h2 className="h-section mb-1 flex items-center gap-2 text-mute">
						{serious && (
							<Clock className="h-5 w-5" strokeWidth={1.7} />
						)}
						{t.policies.history}
					</h2>
					<p className={`mb-3 font-body ${serious ? "text-body" : "text-meta"} text-mute`}>
						{t.policies.historySub}
					</p>
					<div className="space-y-2">
						{settledPolicies.map((policy) => (
							<div
								key={policy.id}
								data-testid="policy-row"
								data-flight-id={policy.flightId}
								className="w3-policy w3-policy-terminal"
							>
								<FlightLink
									id={policy.flightId}
									className="font-board text-[20px] text-dim"
								/>
								<span className={`font-board ${serious ? "text-[20px]" : "text-[18px]"} text-mute`}>
									{policy.dateStr}
									{policy.depTime
										? ` · ${t.policies.depTime(policy.depTime)}`
										: ""}
								</span>
								<StatusBadge
									kind={policy.badge}
									label={
										policy.badge === "paid"
											? t.policies.badgePaid
											: policy.badge === "onTime"
												? t.policies.badgeOnTime
												: t.policies.badgeExpired
									}
								/>
								<span className="w3-reason flex items-center gap-1.5">
									{serious && policy.badge === "paid" && (
										<Check
											className="h-3.5 w-3.5 text-win"
											strokeWidth={2.2}
										/>
									)}
									{policy.reason}
								</span>
								<span className={`ml-auto font-board ${serious ? "text-[20px]" : "text-[18px]"} text-mute`}>
									{policy.payoff !== undefined
										? `${formatUsdc(policy.payoff)} USDC`
										: "—"}
								</span>
								<DetailsLink policy={policy} />
							</div>
						))}
					</div>
				</section>
			)}
		</div>
	)
}
