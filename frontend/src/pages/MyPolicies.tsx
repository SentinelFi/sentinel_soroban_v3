import React, { useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import type { FlightData } from "oracle_aggregator"
import {
	useTravelerFlights,
	usePolicyStateBatch,
	useFlightDataBatch,
	useContractSync,
	flightPoolManagerClient,
	formatUsdc,
} from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { Badge } from "../components/ui/badge"
import { Card } from "../components/ui/card"
import { TransactionButton } from "../components/TransactionButton"
import { SampleDataNotice } from "../components/SampleDataNotice"
import { formatDate } from "../lib/utils"

type OracleStatusTag = FlightData["status"]["tag"]

type PolicyStatus =
	| "Active"
	| "Landed"
	| "ToBeSettled"
	| "SettledOnTime"
	| "SettledDelayed"
	| "SettledCancelled"

function mapOracleStatus(tag: OracleStatusTag): PolicyStatus {
	switch (tag) {
		case "NotInitiated":
		case "Active":
			return "Active"
		case "Landed":
			return "Landed"
		case "Cancelled":
		case "ToBeSettledOnTime":
		case "ToBeSettledDelayed":
		case "ToBeSettledCancelled":
			return "ToBeSettled"
		case "Settled":
			return "SettledOnTime"
		default:
			return "Active"
	}
}

type PolicySection = "active" | "claimable" | "history"

interface Policy {
	id: string
	flightId: string
	date: bigint
	dateStr: string
	status: PolicyStatus
	section: PolicySection
	payoff?: bigint
	claimed?: boolean
	eta?: string
}

function computeEta(estimatedArrival: bigint): string | undefined {
	if (estimatedArrival === 0n) return undefined
	const now = Date.now()
	const eta = Number(estimatedArrival) * 1000
	const diff = eta - now
	if (diff <= 0) return "Arriving"
	const hours = Math.floor(diff / (1000 * 60 * 60))
	const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
	return `${hours}h ${minutes}m`
}

const STATUS_CONFIG: Record<
	PolicyStatus,
	{ label: string; variant: "success" | "warning" | "destructive" | "pending" | "default" }
> = {
	Active: { label: "Active", variant: "success" },
	Landed: { label: "Landed", variant: "default" },
	ToBeSettled: { label: "To Be Settled", variant: "warning" },
	SettledOnTime: { label: "Settled — On Time", variant: "success" },
	SettledDelayed: { label: "Settled — Delayed", variant: "destructive" },
	SettledCancelled: { label: "Cancelled", variant: "destructive" },
}

const SAMPLE_POLICIES: Policy[] = [
	{
		id: "sample-1",
		flightId: "AA100",
		date: BigInt(Math.floor(Date.now() / 1000) + 86400),
		dateStr: "2025-04-01",
		status: "Active",
		section: "active",
		payoff: 500_000_0000n,
		eta: "2h 15m",
	},
	{
		id: "sample-2",
		flightId: "DL789",
		date: BigInt(Math.floor(Date.now() / 1000) - 172800),
		dateStr: "2025-03-28",
		status: "SettledDelayed",
		section: "claimable",
		payoff: 500_000_0000n,
	},
	{
		id: "sample-3",
		flightId: "UA456",
		date: BigInt(Math.floor(Date.now() / 1000) - 259200),
		dateStr: "2025-03-25",
		status: "SettledOnTime",
		section: "history",
		payoff: 500_000_0000n,
	},
]

/* ---------- Flight Arc SVG ---------- */

function FlightArc({
	origin,
	destination,
	status,
}: {
	origin: string
	destination: string
	status: PolicyStatus
}) {
	const isActive = status === "Active"
	const isArrived =
		status === "Landed" ||
		status === "SettledOnTime" ||
		status === "SettledDelayed"
	const isCancelled = status === "SettledCancelled"

	let t = 0.5
	if (isArrived) t = 1
	if (isCancelled) t = 0.35

	const bx = (1 - t) * (1 - t) * 30 + 2 * (1 - t) * t * 150 + t * t * 270
	const by = (1 - t) * (1 - t) * 70 + 2 * (1 - t) * t * 0 + t * t * 70

	const dx = 2 * (1 - t) * (150 - 30) + 2 * t * (270 - 150)
	const dy = 2 * (1 - t) * (0 - 70) + 2 * t * (70 - 0)
	const angle = (Math.atan2(dy, dx) * 180) / Math.PI

	return (
		<svg
			viewBox="0 0 300 90"
			className="w-full"
			style={{ maxWidth: 320, height: "auto" }}
		>
			<path
				d="M30 70 Q150 0 270 70"
				fill="none"
				stroke="var(--border)"
				strokeWidth="2"
				strokeDasharray="6 4"
			/>
			<path
				d="M30 70 Q150 0 270 70"
				fill="none"
				stroke="var(--primary)"
				strokeWidth="2.5"
				strokeDasharray={`${t * 320} 320`}
			/>
			<circle cx="30" cy="70" r="5" fill="var(--primary)" />
			<circle
				cx="270"
				cy="70"
				r="5"
				fill={isArrived ? "var(--success)" : "var(--border)"}
			/>
			<text
				x="30"
				y="88"
				textAnchor="middle"
				fill="var(--muted-foreground)"
				fontSize="11"
				fontWeight="600"
			>
				{origin}
			</text>
			<text
				x="270"
				y="88"
				textAnchor="middle"
				fill="var(--muted-foreground)"
				fontSize="11"
				fontWeight="600"
			>
				{destination}
			</text>
			<g
				transform={`translate(${bx}, ${by}) rotate(${angle})`}
				className={isActive ? "animate-plane-pulse" : ""}
			>
				<path
					d="M-8 0 L-3 -3 L8 0 L-3 3 Z"
					fill={isCancelled ? "var(--destructive)" : "var(--primary)"}
				/>
				<path
					d="M-2 -3 L1 -7 L3 -3"
					fill={isCancelled ? "var(--destructive)" : "var(--primary)"}
				/>
				<path
					d="M-2 3 L1 7 L3 3"
					fill={isCancelled ? "var(--destructive)" : "var(--primary)"}
				/>
			</g>
			{isCancelled && (
				<g transform={`translate(${bx + 12}, ${by - 12})`}>
					<circle r="8" fill="var(--destructive)" />
					<path
						d="M-4 -4 L4 4 M4 -4 L-4 4"
						stroke="white"
						strokeWidth="2"
						strokeLinecap="round"
					/>
				</g>
			)}
			{isActive && (
				<circle
					cx={bx}
					cy={by}
					r="10"
					fill="none"
					stroke="var(--primary)"
					strokeWidth="1.5"
					className="animate-ping-slow"
					opacity="0.5"
				/>
			)}
		</svg>
	)
}

/* ---------- Policy Card ---------- */

function PolicyCard({
	policy,
	onClaim,
	claimLoading,
}: {
	policy: Policy
	onClaim?: () => void
	claimLoading?: boolean
}) {
	const cfg = STATUS_CONFIG[policy.status]
	const isClaimable = policy.section === "claimable"

	return (
		<Card className="p-5 transition hover:border-primary/40">
			<div className="mb-4 flex justify-center">
				<FlightArc
					origin={policy.flightId.slice(0, 3).toUpperCase()}
					destination="DST"
					status={policy.status}
				/>
			</div>
			<div className="mb-4 grid grid-cols-2 gap-3 text-sm">
				<div>
					<span className="text-muted-foreground">Flight</span>
					<p className="font-semibold text-foreground">{policy.flightId}</p>
				</div>
				<div>
					<span className="text-muted-foreground">Date</span>
					<p className="font-semibold text-foreground">{policy.dateStr}</p>
				</div>
				<div>
					<span className="text-muted-foreground">Payoff</span>
					<p className="font-semibold text-foreground">
						{policy.payoff !== undefined
							? `${formatUsdc(policy.payoff)} USDC`
							: "—"}
					</p>
				</div>
				<div>
					<span className="text-muted-foreground">Status</span>
					<div className="mt-0.5 flex items-center gap-1.5">
						<Badge variant={cfg.variant}>{cfg.label}</Badge>
						{policy.claimed && <Badge variant="success">Claimed</Badge>}
					</div>
				</div>
			</div>
			{policy.status === "Active" && policy.eta && (
				<div className="mb-4 rounded-lg bg-primary/8 p-3 text-center">
					<span className="text-xs text-muted-foreground">
						Estimated Arrival
					</span>
					<p className="text-lg font-bold text-primary">
						ETA: {policy.eta}
					</p>
				</div>
			)}
			{isClaimable && onClaim && (
				<TransactionButton
					state={claimLoading ? "confirming" : "idle"}
					onClick={onClaim}
					disabled={claimLoading}
					className="bg-success text-success-foreground hover:bg-success/80"
				>
					{policy.payoff !== undefined
						? `Claim ${formatUsdc(policy.payoff)} USDC`
						: "Claim Payoff"}
				</TransactionButton>
			)}
		</Card>
	)
}

/* ---------- Main Page ---------- */

const MyPolicies: React.FC = () => {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const queryClient = useQueryClient()
	const { addNotification } = useNotification()
	const [claimingId, setClaimingId] = useState<string | null>(null)

	const { data: flights, isLoading: flightsLoading } =
		useTravelerFlights(address)
	const { data: policyStates, isLoading: policyStatesLoading } =
		usePolicyStateBatch(flights, address)
	const { data: flightData } = useFlightDataBatch(flights)

	if (!address) {
		return (
			<div className="mx-auto max-w-4xl">
				<h1 className="mb-2 text-3xl font-bold text-foreground">
					My Policies
				</h1>
				<p className="mb-8 text-muted-foreground">
					Track your flight insurance policies and claim payouts.
				</p>

				<SampleDataNotice className="mb-6">
					Displaying sample data — connect your wallet to see real policies
				</SampleDataNotice>

				<section className="mb-10">
					<h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-foreground">
						<span className="inline-block h-2.5 w-2.5 rounded-full bg-success animate-pulse" />
						Active Policies
					</h2>
					<div className="grid gap-6 md:grid-cols-2 stagger-children">
						{SAMPLE_POLICIES.filter((p) => p.section === "active").map((p) => (
							<PolicyCard key={p.id} policy={p} />
						))}
					</div>
				</section>

				<section className="mb-10">
					<h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-foreground">
						<span className="inline-block h-2.5 w-2.5 rounded-full bg-warning" />
						Ready to Claim
					</h2>
					<div className="grid gap-6 md:grid-cols-2">
						{SAMPLE_POLICIES.filter((p) => p.section === "claimable").map((p) => (
							<PolicyCard key={p.id} policy={p} />
						))}
					</div>
				</section>

				<section className="mb-10">
					<h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-foreground">
						<span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground" />
						History
					</h2>
					<div className="grid gap-6 md:grid-cols-2">
						{SAMPLE_POLICIES.filter((p) => p.section === "history").map((p) => (
							<PolicyCard key={p.id} policy={p} />
						))}
					</div>
				</section>

				<Card className="p-6 text-center">
					<p className="text-muted-foreground">
						Connect your wallet to view your real policies.
					</p>
				</Card>
			</div>
		)
	}

	const isLoading = flightsLoading || policyStatesLoading

	// Oracle live data keyed by flight identity, for ETA display on
	// still-active policies.
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

		// Section: where does this policy belong?
		let section: PolicySection
		if (!state.config || settlementTag === "Active") {
			section = "active"
		} else if (
			(settlementTag === "SettledDelayed" ||
				settlementTag === "SettledCancelled") &&
			!state.claimed &&
			nowSecs < state.config.claim_expiry
		) {
			section = "claimable"
		} else {
			section = "history"
		}

		// Display status: settled pools report their outcome; active pools
		// fall back to the oracle's live flight status.
		let status: PolicyStatus
		if (settlementTag && settlementTag !== "Active") {
			status = settlementTag
		} else {
			status = oracle
				? mapOracleStatus(oracle.status.tag)
				: "Active"
		}

		const eta =
			section === "active" && oracle
				? computeEta(oracle.estimated_arrival_time)
				: undefined

		return {
			id: `${state.flightId}-${state.date.toString()}`,
			flightId: state.flightId,
			date: state.date,
			dateStr: formatDate(state.date),
			status,
			section,
			payoff: state.config?.payoff,
			claimed: state.claimed,
			eta,
		}
	})

	const activePolicies = policies.filter((p) => p.section === "active")
	const claimablePolicies = policies.filter((p) => p.section === "claimable")
	const historyPolicies = policies.filter((p) => p.section === "history")

	const handleClaim = async (policy: Policy) => {
		if (!address || !signTransaction) return
		setClaimingId(policy.id)
		try {
			const tx = await flightPoolManagerClient.claim({
				traveler: address,
				flight_id: policy.flightId,
				date: policy.date,
			})
			await tx.signAndSend({ signTransaction })
			addNotification(
				`Payout claimed for flight ${policy.flightId}`,
				"success",
			)
			void queryClient.invalidateQueries({ queryKey: ["pool"] })
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
		<div className="mx-auto max-w-4xl">
			<h1 className="mb-2 text-3xl font-bold text-foreground">
				My Policies
			</h1>
			<p className="mb-8 text-muted-foreground">
				Track your flight insurance policies and claim payouts.
			</p>

			{isLoading && (
				<Card className="p-10 text-center">
					<p className="text-muted-foreground">Loading your policies...</p>
				</Card>
			)}

			{!isLoading && policies.length === 0 && (
				<Card className="p-10 text-center">
					<p className="mb-3 text-muted-foreground">
						No policies yet — insure your first flight.
					</p>
					<Link
						to="/buy"
						className="text-sm font-semibold text-primary hover:text-primary/80 transition-colors"
					>
						Buy Insurance →
					</Link>
				</Card>
			)}

			{!isLoading && activePolicies.length > 0 && (
				<section className="mb-10">
					<h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-foreground">
						<span className="inline-block h-2.5 w-2.5 rounded-full bg-success animate-pulse" />
						Active Policies
					</h2>
					<div className="grid gap-6 md:grid-cols-2 stagger-children">
						{activePolicies.map((p) => (
							<PolicyCard key={p.id} policy={p} />
						))}
					</div>
				</section>
			)}

			{!isLoading && claimablePolicies.length > 0 && (
				<section className="mb-10">
					<h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-foreground">
						<span className="inline-block h-2.5 w-2.5 rounded-full bg-warning" />
						Ready to Claim
					</h2>
					<div className="grid gap-6 md:grid-cols-2">
						{claimablePolicies.map((p) => (
							<PolicyCard
								key={p.id}
								policy={p}
								onClaim={() => handleClaim(p)}
								claimLoading={claimingId === p.id}
							/>
						))}
					</div>
				</section>
			)}

			{!isLoading && historyPolicies.length > 0 && (
				<section className="mb-10">
					<h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-foreground">
						<span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground" />
						History
					</h2>
					<div className="grid gap-6 md:grid-cols-2">
						{historyPolicies.map((p) => (
							<PolicyCard key={p.id} policy={p} />
						))}
					</div>
				</section>
			)}
		</div>
	)
}

export default MyPolicies
