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
import { stagedSigner, useTxFlow } from "../hooks/useTxFlow"
import { cn, txHashOf } from "../lib/utils"
import { formatDate } from "../lib/format"
import { PixelArt } from "../components/PixelArt"
import { TxProgress } from "../components/TxProgress"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import { Plane, Trophy, Clock, Check, PlaneTakeoff } from "lucide-react"

type OracleTag = FlightData["status"]["tag"]
type BetSection = "open" | "won" | "settled"

/** Colour buckets for status badges (mapped to CSS vars via --badge). */
type BadgeKind = "tracking" | "onTime" | "claimable" | "paid" | "expired"

const BADGE_VAR: Record<BadgeKind, string> = {
	tracking: "var(--color-gold)", // amber = in the air / tracking
	onTime: "var(--color-sky)", // cyan = settled on-time
	claimable: "var(--color-win)", // green = delayed / claimable
	paid: "var(--color-win)", // green = paid out
	expired: "var(--color-mute)", // mute = expired / terminal
}

interface Bet {
	id: string
	flightId: string
	date: bigint
	dateStr: string
	section: BetSection
	payoff?: bigint
	claimed: boolean
	outcome: string // short display label
	badge: BadgeKind
	/** why this policy is terminal (history only) */
	reason?: string
	/** claim-window expiry, for the claimable countdown line */
	claimExpiry?: bigint
	eta?: string
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
				<h1 className="h-display mt-6 text-[18px]">{t.policies.title}</h1>
				<p className="mt-4 font-body text-[15px] leading-relaxed text-dim">
					{t.policies.connectSub}
				</p>
				<p className="mt-6 font-board text-[20px] text-gold">
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

	const bets: Bet[] = (policyStates ?? []).map((state) => {
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
		let section: BetSection
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

		return {
			id: `${state.flightId}-${state.date.toString()}`,
			flightId: state.flightId,
			date: state.date,
			dateStr: formatDate(state.date),
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

	const openBets = bets.filter((b) => b.section === "open")
	const wonBets = bets.filter((b) => b.section === "won")
	const settledBets = bets.filter((b) => b.section === "settled")

	const handleClaim = (bet: Bet) => {
		if (!address || claimingId) return
		setClaimingId(bet.id)
		void claimFlow.run(async (step) => {
			step("verifying")
			const tx = await flightPoolManagerClient.claim({
				traveler: address,
				flight_id: bet.flightId,
				date: bet.date,
			})
			const sent = await tx.signAndSend({
				signTransaction: stagedSigner(step, signTransaction),
			})
			return {
				message: t.notify.claimed(bet.flightId),
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
				<h1 className="h-display text-[20px]">{t.policies.title}</h1>
				<p className="mt-2 font-body text-[14px] text-dim">
					{t.policies.intro}
				</p>
			</div>

			{isLoading && (
				<div className="panel p-8 text-center">
					<span className="font-board text-[22px] text-gold">
						{t.policies.loading}
						{!serious && <span className="blink">…</span>}
					</span>
				</div>
			)}

			{!isLoading && loadFailed && (
				<div role="alert" className="panel p-8 text-center">
					<p className="font-board text-[22px] text-loss">
						{t.policies.loadError}
					</p>
					<p className="mt-2 font-body text-[13px] text-mute">
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

			{!isLoading && !loadFailed && bets.length === 0 && (
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
					<p className="mt-4 font-board text-[22px] text-mute">
						{t.policies.empty}
					</p>
					<Link to="/" className="btn-px btn-loss mt-4">
						{t.policies.emptyCta}
					</Link>
				</div>
			)}

			{/* READY TO CLAIM — delayed / cancelled, window still open */}
			{!isLoading && wonBets.length > 0 && (
				<section>
					<h2 className="h-section mb-1 flex items-center gap-2 text-gold">
						{serious && (
							<Trophy className="h-5 w-5" strokeWidth={1.7} />
						)}
						{t.policies.claim}
					</h2>
					<p className="mb-3 font-body text-[13px] text-mute">
						{t.policies.claimSub}
					</p>
					<div className="grid gap-4 sm:grid-cols-2">
						{wonBets.map((bet) => (
							<div
								key={bet.id}
								data-testid="policy-row"
								data-flight-id={bet.flightId}
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
								<p className="h-display mt-3 text-[16px] text-gold">
									{t.policies.claimWin}
								</p>
								<p className="mt-1 font-board text-[20px] text-dim">
									{bet.flightId} · {bet.dateStr}
								</p>
								<div className="mt-2 flex justify-center">
									<StatusBadge
										kind="claimable"
										label={t.policies.badgeClaimable}
									/>
								</div>
								<p className="board-figure mt-2 text-[30px] text-win">
									{bet.payoff !== undefined
										? `${formatUsdc(bet.payoff)} USDC`
										: "—"}
								</p>
								{bet.claimExpiry !== undefined && (
									<p className="mt-1 font-body text-[12px] text-mute">
										{t.policies.claimWindow(
											formatDate(bet.claimExpiry),
										)}
									</p>
								)}
								<button
									type="button"
									data-testid="policy-claim"
									onClick={() => handleClaim(bet)}
									disabled={claimingId !== null || networkMismatch}
									className={cn(
										"btn-px btn-win mt-4 w-full",
										claimingId === null && "claim-btn-pulse",
									)}
								>
									{claimingId === bet.id
										? t.policies.claiming
										: t.policies.claimBtn}
								</button>
								{claimingId === bet.id && (
									<TxProgress
										state={claimFlow.state}
										steps={["verifying", "awaiting", "confirming"]}
										error={claimFlow.error}
										stamps={{ success: "stamp-paid" }}
									/>
								)}
							</div>
						))}
					</div>
				</section>
			)}

			{/* ACTIVE — in the air */}
			{!isLoading && openBets.length > 0 && (
				<section>
					<h2 className="h-section mb-1 flex items-center gap-2">
						{serious ? (
							<PlaneTakeoff className="h-5 w-5" strokeWidth={1.7} />
						) : (
							<span className="breathe inline-block h-2 w-2 bg-win align-middle" />
						)}
						{t.policies.active}
					</h2>
					<p className="mb-3 font-body text-[13px] text-mute">
						{t.policies.activeSub}
					</p>
					<div className="space-y-2">
						{openBets.map((bet) => (
							<div
								key={bet.id}
								data-testid="policy-row"
								data-flight-id={bet.flightId}
								className="w3-policy"
							>
								<span className="board-figure text-[24px]">
									{bet.flightId}
								</span>
								<span className="font-board text-[19px] text-dim">
									{bet.dateStr}
								</span>
								<StatusBadge
									kind="tracking"
									label={t.policies.badgeTracking}
								/>
								<span className="font-body text-[13px] text-dim">
									{bet.outcome}
									{bet.eta ? ` · ${bet.eta}` : ""}
								</span>
								<span className="ml-auto font-board text-[19px] text-dim">
									{t.policies.payoutLabel}{" "}
									<span className="text-win">
										{bet.payoff !== undefined
											? `${formatUsdc(bet.payoff)} USDC`
											: "—"}
									</span>
								</span>
							</div>
						))}
					</div>
				</section>
			)}

			{/* HISTORY — terminal, with an eligibility reason each */}
			{!isLoading && settledBets.length > 0 && (
				<section>
					<h2 className="h-section mb-1 flex items-center gap-2 text-mute">
						{serious && (
							<Clock className="h-5 w-5" strokeWidth={1.7} />
						)}
						{t.policies.history}
					</h2>
					<p className="mb-3 font-body text-[13px] text-mute">
						{t.policies.historySub}
					</p>
					<div className="space-y-2">
						{settledBets.map((bet) => (
							<div
								key={bet.id}
								data-testid="policy-row"
								data-flight-id={bet.flightId}
								className="w3-policy w3-policy-terminal"
							>
								<span className="font-board text-[20px] text-dim">
									{bet.flightId}
								</span>
								<span className="font-board text-[18px] text-mute">
									{bet.dateStr}
								</span>
								<StatusBadge
									kind={bet.badge}
									label={
										bet.badge === "paid"
											? t.policies.badgePaid
											: bet.badge === "onTime"
												? t.policies.badgeOnTime
												: t.policies.badgeExpired
									}
								/>
								<span className="w3-reason flex items-center gap-1.5">
									{serious && bet.badge === "paid" && (
										<Check
											className="h-3.5 w-3.5 text-win"
											strokeWidth={2.2}
										/>
									)}
									{bet.reason}
								</span>
								<span className="ml-auto font-board text-[18px] text-mute">
									{bet.payoff !== undefined
										? `${formatUsdc(bet.payoff)} USDC`
										: "—"}
								</span>
							</div>
						))}
					</div>
				</section>
			)}
		</div>
	)
}
