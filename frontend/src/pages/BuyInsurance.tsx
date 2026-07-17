import React, { useState } from "react"
import { Link } from "react-router-dom"
import {
	useActiveRoutes,
	useWhitelistEnabled,
	useIsWhitelisted,
	useUsdcBalance,
	controllerClient,
	formatUsdc,
	useContractSync,
} from "../hooks/useContracts"
import type { UiRoute } from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { stellarNetwork } from "../contracts/util"
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card"
import { Select } from "../components/ui/select"
import { FlightDatePicker } from "../components/ui/date-picker"
import { TransactionButton } from "../components/TransactionButton"
import { SampleDataNotice } from "../components/SampleDataNotice"
import { FaucetButton } from "../components/FaucetButton"
import type { TxState } from "../types"

const SAMPLE_ROUTES: UiRoute[] = [
	{ flightId: "AA100", origin: "JFK", dest: "LAX", status: "Active", terms: null },
	{ flightId: "UA456", origin: "SFO", dest: "ORD", status: "Active", terms: null },
	{ flightId: "DL789", origin: "ATL", dest: "MIA", status: "Active", terms: null },
]

/** Midnight-UTC-aligned unix timestamp (u64) for a YYYY-MM-DD date string. */
function dateStrToMidnightUtc(dateStr: string): bigint {
	const [y = 0, m = 1, d = 1] = dateStr.split("-").map(Number)
	return BigInt(Date.UTC(y, m - 1, d) / 1000)
}

const BuyInsurance: React.FC = () => {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const { data: usdcBalance } = useUsdcBalance(address)
	const [selectedRouteIdx, setSelectedRouteIdx] = useState("")
	const [flightDate, setFlightDate] = useState("")
	const [txState, setTxState] = useState<TxState>("idle")
	const [error, setError] = useState<string | null>(null)

	const { data: routes, isLoading: routesLoading } = useActiveRoutes()
	const { data: whitelistEnabled } = useWhitelistEnabled()
	const { data: isWhitelisted } = useIsWhitelisted(address)

	const isSampleRoutes = !routesLoading && (!routes || routes.length === 0)
	const displayRoutes = isSampleRoutes ? SAMPLE_ROUTES : routes

	const selectedRoute =
		selectedRouteIdx !== "" && displayRoutes
			? displayRoutes[Number(selectedRouteIdx)]
			: undefined

	const terms = selectedRoute?.terms ?? null
	const premium = terms?.premium
	const payoff = terms?.payoff
	const delayHours = terms?.delay_hours

	const isSampleTerms = !!selectedRoute && !terms
	const showingSampleData = isSampleRoutes || isSampleTerms

	const whitelistBlocked =
		whitelistEnabled === true && !!address && isWhitelisted === false

	const handleBuy = async () => {
		if (!address || !selectedRoute || !flightDate || whitelistBlocked) return
		setTxState("awaiting")
		setError(null)
		try {
			const tx = await controllerClient.buy_insurance({
				traveler: address,
				flight_id: selectedRoute.flightId,
				origin: selectedRoute.origin,
				dest: selectedRoute.dest,
				date: dateStrToMidnightUtc(flightDate),
			})
			setTxState("confirming")
			await tx.signAndSend({ signTransaction })
			setTxState("success")
			setTimeout(() => setTxState("idle"), 3000)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Transaction failed")
			setTxState("error")
			setTimeout(() => setTxState("idle"), 3000)
		}
	}

	return (
		<div className="mx-auto max-w-2xl">
			<h1 className="mb-2 text-3xl font-bold text-foreground">
				Buy Insurance
			</h1>
			<p className="mb-8 text-muted-foreground">
				Protect your trip with fixed-premium flight delay coverage.
			</p>

			{address && (
				<div className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
					<span className="text-sm text-muted-foreground">Your USDC Balance:</span>
					<span className="font-mono text-sm font-semibold text-foreground">
						{usdcBalance != null ? `${formatUsdc(usdcBalance)} USDC` : "..."}
					</span>
					{stellarNetwork === "TESTNET" && <FaucetButton />}
				</div>
			)}

			{showingSampleData && (
				<SampleDataNotice className="mb-6">
					Displaying sample data — connect to testnet for live routes &amp; terms
				</SampleDataNotice>
			)}

			{/* Route Picker */}
			<Card className="mb-6">
				<CardContent className="pt-6">
					<label className="mb-2 block text-sm font-medium text-muted-foreground">
						Flight Route
					</label>
					<Select
						value={selectedRouteIdx}
						onChange={(e) => setSelectedRouteIdx(e.target.value)}
						disabled={routesLoading}
					>
						<option value="">
							{routesLoading ? "Loading routes..." : "Select a flight route"}
						</option>
						{displayRoutes?.map((r, idx) => (
							<option key={`${r.flightId}-${r.origin}-${r.dest}`} value={idx}>
								{r.flightId} — {r.origin} to {r.dest}
							</option>
						))}
					</Select>
				</CardContent>
			</Card>

			{/* Flight Date */}
			<Card className="mb-6">
				<CardContent className="pt-6">
					<label className="mb-2 block text-sm font-medium text-muted-foreground">
						Flight Date
					</label>
					<FlightDatePicker
						onDateChange={(dateStr) => setFlightDate(dateStr)}
						placeholder="Pick your departure date"
					/>
				</CardContent>
			</Card>

			{/* Terms Display */}
			{selectedRoute && (
				<Card className="mb-6">
					<CardHeader>
						<CardTitle className="text-lg">Coverage Terms</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="mb-4 flex items-center gap-3 text-muted-foreground">
							<span className="text-sm">{selectedRoute.origin}</span>
							<svg
								width="80"
								height="20"
								viewBox="0 0 80 20"
								className="text-primary"
							>
								<path
									d="M5 10 H65"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeDasharray="4 3"
									fill="none"
								/>
								<polygon points="65,6 75,10 65,14" fill="currentColor" />
							</svg>
							<span className="text-sm">{selectedRoute.dest}</span>
						</div>
						<div className="grid grid-cols-3 gap-4">
							<div className="rounded-lg bg-primary/8 p-4 text-center">
								<p className="stat-label mb-1">
									Premium
								</p>
								<p className="stat-value text-xl text-primary">
									{premium !== undefined ? formatUsdc(premium) : "10.00"} USDC
								</p>
							</div>
							<div className="rounded-lg bg-success/8 p-4 text-center">
								<p className="stat-label mb-1">
									Payoff
								</p>
								<p className="stat-value text-xl text-success">
									{payoff !== undefined ? formatUsdc(payoff) : "50.00"} USDC
								</p>
							</div>
							<div className="rounded-lg bg-warning/8 p-4 text-center">
								<p className="stat-label mb-1">
									Delay Threshold
								</p>
								<p className="stat-value text-xl text-warning">
									{delayHours ?? 2}h
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Buy Button */}
			<div className="mt-8">
				<TransactionButton
					state={txState}
					onClick={handleBuy}
					disabled={!address || !selectedRoute || !flightDate || whitelistBlocked}
				>
					{`Buy Coverage for ${premium !== undefined ? formatUsdc(premium) : "10.00"} USDC`}
				</TransactionButton>
				<p className="mt-3 text-center text-xs text-muted-foreground/70">
					By purchasing coverage you agree to the{" "}
					<Link to="/terms" className="underline decoration-border underline-offset-2 hover:text-foreground transition-colors">
						Terms of Service
					</Link>
					.
				</p>
			</div>

			{error && (
				<p className="mt-3 text-center text-sm text-destructive">
					{error}
				</p>
			)}

			{whitelistBlocked && (
				<p className="mt-3 text-center text-sm text-warning">
					Purchases are currently limited to approved buyers.
				</p>
			)}

			{!address && (
				<p className="mt-3 text-center text-sm text-warning">
					Connect your wallet to purchase coverage.
				</p>
			)}
		</div>
	)
}

export default BuyInsurance
