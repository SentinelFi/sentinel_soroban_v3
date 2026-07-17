import { useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import type { FlightData } from "oracle_aggregator"
import {
	flightPoolManagerClient,
	formatUsdc,
	useContractSync,
	useFlightDataBatch,
	usePolicyStateBatch,
	useTravelerFlights,
} from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { formatDate } from "../lib/utils"
import { PixelArt } from "../components/PixelArt"

type OracleTag = FlightData["status"]["tag"]
type BetSection = "open" | "won" | "settled"

interface Bet {
	id: string
	flightId: string
	date: bigint
	dateStr: string
	section: BetSection
	payoff?: bigint
	claimed: boolean
	outcome: string // display label
	outcomeColor: string
	eta?: string
}

function liveLabel(tag: OracleTag | undefined): string {
	switch (tag) {
		case "Active":
			return "IN AIR"
		case "Landed":
			return "LANDED"
		case "Cancelled":
		case "ToBeSettledCancelled":
			return "CANCELLED"
		case "ToBeSettledDelayed":
			return "DELAYED — SETTLING"
		case "ToBeSettledOnTime":
			return "ON TIME — SETTLING"
		default:
			return "SCHEDULED"
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

export default function MyBets() {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const queryClient = useQueryClient()
	const { addNotification } = useNotification()
	const [claimingId, setClaimingId] = useState<string | null>(null)

	const { data: flights, isLoading: flightsLoading } =
		useTravelerFlights(address)
	const { data: policyStates, isLoading: statesLoading } =
		usePolicyStateBatch(flights, address)
	const { data: flightData } = useFlightDataBatch(flights)

	if (!address) {
		return (
			<div className="mx-auto max-w-3xl px-4 py-16 text-center">
				<PixelArt name="avatar-pilot" className="mx-auto h-24 w-24" />
				<h1 className="h-display mt-6 text-[18px]">MY POLICIES</h1>
				<p className="mt-4 font-body text-[15px] leading-relaxed text-dim">
					Connect your wallet to see your active cover, payouts to
					claim, and settled slips.
				</p>
				<p className="mt-6 font-board text-[20px] text-gold">
					<span className="blink">▶</span> INSERT COIN — CONNECT WALLET
					(TOP RIGHT)
				</p>
			</div>
		)
	}

	const isLoading = flightsLoading || statesLoading

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

		let section: BetSection
		if (!state.config || settlementTag === "Active") {
			section = "open"
		} else if (
			(settlementTag === "SettledDelayed" ||
				settlementTag === "SettledCancelled") &&
			!state.claimed &&
			nowSecs < state.config.claim_expiry
		) {
			section = "won"
		} else {
			section = "settled"
		}

		let outcome: string
		let outcomeColor: string
		if (section === "open") {
			outcome = liveLabel(oracle?.status.tag)
			outcomeColor = "text-sky"
		} else if (settlementTag === "SettledDelayed") {
			outcome = state.claimed ? "DELAYED — PAID" : section === "won" ? "DELAYED — PAYS OUT" : "DELAYED — EXPIRED"
			outcomeColor = state.claimed || section === "won" ? "text-win" : "text-mute"
		} else if (settlementTag === "SettledCancelled") {
			outcome = state.claimed ? "CANCELLED — PAID" : section === "won" ? "CANCELLED — PAYS OUT" : "CANCELLED — EXPIRED"
			outcomeColor = "text-gold"
		} else {
			outcome = "ON TIME — NO PAYOUT"
			outcomeColor = "text-loss"
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
			outcomeColor,
			eta,
		}
	})

	const openBets = bets.filter((b) => b.section === "open")
	const wonBets = bets.filter((b) => b.section === "won")
	const settledBets = bets.filter((b) => b.section === "settled")

	const handleClaim = async (bet: Bet) => {
		if (!address || claimingId) return
		setClaimingId(bet.id)
		try {
			const tx = await flightPoolManagerClient.claim({
				traveler: address,
				flight_id: bet.flightId,
				date: bet.date,
			})
			await tx.signAndSend({ signTransaction })
			addNotification(
				`Payout claimed for flight ${bet.flightId}!`,
				"success",
			)
			void queryClient.invalidateQueries({ queryKey: ["pool"] })
			void queryClient.invalidateQueries({ queryKey: ["usdc"] })
		} catch (err) {
			console.error("Claim failed:", err)
			addNotification(
				err instanceof Error ? err.message : "Claim failed",
				"error",
			)
		} finally {
			setClaimingId(null)
		}
	}

	return (
		<div className="mx-auto max-w-4xl space-y-10 px-4 py-8">
			<div>
				<h1 className="h-display text-[20px]">MY POLICIES</h1>
				<p className="mt-2 font-body text-[14px] text-dim">
					Your slips: active cover in the air, payouts to claim, and
					settled history.
				</p>
			</div>

			{isLoading && (
				<div className="panel p-8 text-center">
					<span className="font-board text-[22px] text-gold">
						PULLING YOUR SLIPS<span className="blink">…</span>
					</span>
				</div>
			)}

			{!isLoading && bets.length === 0 && (
				<div className="panel p-8 text-center">
					<PixelArt name="avatar-pilot" className="mx-auto h-24 w-24" />
					<p className="mt-4 font-board text-[22px] text-mute">
						NO POLICIES YET
					</p>
					<Link to="/" className="btn-px btn-loss mt-4">
						HIT THE BOARD ✈
					</Link>
				</div>
			)}

			{/* DELAYED — claim payout */}
			{!isLoading && wonBets.length > 0 && (
				<section>
					<h2 className="h-section mb-3 text-gold">
						★ DELAYED — CLAIM YOUR PAYOUT
					</h2>
					<div className="grid gap-4 sm:grid-cols-2">
						{wonBets.map((bet) => (
							<div
								key={bet.id}
								className="win-flash border-2 border-gold bg-surface p-5 text-center"
							>
								<PixelArt
									name="trophy-win"
									className="mx-auto h-16 w-16"
								/>
								<p className="h-display mt-3 text-[16px] text-gold">
									DELAYED — YOU WIN!
								</p>
								<p className="mt-1 font-board text-[20px] text-dim">
									{bet.flightId} · {bet.dateStr} · {bet.outcome}
								</p>
								<p className="board-figure mt-2 text-[30px] text-win">
									{bet.payoff !== undefined
										? `${formatUsdc(bet.payoff)} USDC`
										: "—"}
								</p>
								<button
									type="button"
									onClick={() => void handleClaim(bet)}
									disabled={claimingId !== null}
									className="btn-px btn-win mt-4 w-full"
								>
									{claimingId === bet.id
										? "CLAIMING…"
										: "CLAIM PAYOUT ★"}
								</button>
							</div>
						))}
					</div>
				</section>
			)}

			{/* active policies */}
			{!isLoading && openBets.length > 0 && (
				<section>
					<h2 className="h-section mb-3">
						<span className="blink mr-2 inline-block h-2 w-2 bg-win align-middle" />
						ACTIVE POLICIES
					</h2>
					<div className="space-y-2">
						{openBets.map((bet) => (
							<div
								key={bet.id}
								className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3"
							>
								<span className="board-figure text-[24px]">
									{bet.flightId}
								</span>
								<span className="font-board text-[19px] text-dim">
									{bet.dateStr}
								</span>
								<span
									className={`status-px ${bet.outcomeColor}`}
								>
									{bet.outcome}
									{bet.eta ? ` · ${bet.eta}` : ""}
								</span>
								<span className="ml-auto font-board text-[19px] text-dim">
									PAYOUT{" "}
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

			{/* settled */}
			{!isLoading && settledBets.length > 0 && (
				<section>
					<h2 className="h-section mb-3 text-mute">SETTLED</h2>
					<div className="space-y-2">
						{settledBets.map((bet) => (
							<div
								key={bet.id}
								className="flex flex-wrap items-center gap-x-6 gap-y-2 border-2 border-line bg-inset px-4 py-3"
							>
								<span className="font-board text-[20px] text-dim">
									{bet.flightId}
								</span>
								<span className="font-board text-[18px] text-mute">
									{bet.dateStr}
								</span>
								<span
									className={`status-px ${bet.outcomeColor}`}
								>
									{bet.outcome}
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
