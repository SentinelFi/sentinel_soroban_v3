import React, { useState } from "react"
import type { FlightStatus as OracleFlightStatus } from "oracle_aggregator"
import { useActiveFlights, useFlightDataBatch } from "../hooks/useContracts"
import { Badge } from "../components/ui/badge"
import { Card } from "../components/ui/card"
import { SampleDataNotice } from "../components/SampleDataNotice"
import { formatDate } from "../lib/utils"
import { CANDIDATE_ROUTES } from "../config/routes"

type FlightStatus = OracleFlightStatus["tag"]

interface FlightEntry {
	flightId: string
	date: bigint
	dateStr: string
	status: FlightStatus
	estimatedArrival: bigint
	actualArrival: bigint
}

type FilterTab = "All" | "Active" | "Settled"

const statusBadgeVariant: Record<FlightStatus, "default" | "success" | "warning" | "pending"> = {
	NotInitiated: "pending",
	Active: "default",
	Landed: "default",
	Cancelled: "warning",
	ToBeSettledOnTime: "warning",
	ToBeSettledDelayed: "warning",
	ToBeSettledCancelled: "warning",
	Settled: "success",
}

const statusLabel: Record<FlightStatus, string> = {
	NotInitiated: "Not Initiated",
	Active: "Active",
	Landed: "Landed",
	Cancelled: "Cancelled",
	ToBeSettledOnTime: "To Be Settled",
	ToBeSettledDelayed: "To Be Settled",
	ToBeSettledCancelled: "To Be Settled",
	Settled: "Settled",
}

const routeByFlightId = new Map(
	CANDIDATE_ROUTES.map((r) => [r.flightId, `${r.origin} \u2192 ${r.dest}`]),
)

/** Link a flight number to a public flight-status page. */
function flightInfoUrl(flightId: string): string {
	return `https://www.flightaware.com/live/flight/${flightId}`
}

function StatusBadge({ status }: { status: FlightStatus }) {
	return (
		<Badge variant={statusBadgeVariant[status]}>
			{statusLabel[status]}
		</Badge>
	)
}

function filterFlights(flights: FlightEntry[], tab: FilterTab): FlightEntry[] {
	if (tab === "All") return flights
	if (tab === "Active")
		return flights.filter((f) =>
			[
				"Active",
				"Landed",
				"Cancelled",
				"ToBeSettledOnTime",
				"ToBeSettledDelayed",
				"ToBeSettledCancelled",
			].includes(f.status),
		)
	return flights.filter((f) => f.status === "Settled")
}

const SAMPLE_FLIGHTS: FlightEntry[] = [
	{ flightId: "AA100", date: 0n, dateStr: "2025-04-01", status: "Active", estimatedArrival: BigInt(Math.floor(Date.now() / 1000) + 7200), actualArrival: 0n },
	{ flightId: "UA456", date: 0n, dateStr: "2025-04-01", status: "Landed", estimatedArrival: 0n, actualArrival: BigInt(Math.floor(Date.now() / 1000) - 3600) },
	{ flightId: "DL789", date: 0n, dateStr: "2025-03-30", status: "Settled", estimatedArrival: 0n, actualArrival: 0n },
	{ flightId: "SW321", date: 0n, dateStr: "2025-04-02", status: "Active", estimatedArrival: BigInt(Math.floor(Date.now() / 1000) + 14400), actualArrival: 0n },
	{ flightId: "BA555", date: 0n, dateStr: "2025-03-29", status: "ToBeSettledDelayed", estimatedArrival: 0n, actualArrival: 0n },
]

const FlightMarkets: React.FC = () => {
	const [tab, setTab] = useState<FilterTab>("All")
	const [search, setSearch] = useState("")

	const { data: activeFlights, isLoading: flightsLoading } = useActiveFlights()
	const { data: flightDataEntries, isLoading: dataLoading } =
		useFlightDataBatch(activeFlights)

	const isLoading = flightsLoading || dataLoading

	const flights: FlightEntry[] = (flightDataEntries ?? []).map((entry) => {
		const status = entry.data
			? (entry.data.status.tag as FlightStatus)
			: "NotInitiated"
		return {
			flightId: entry.flightId,
			date: entry.date,
			dateStr: formatDate(entry.date),
			status,
			estimatedArrival: entry.data?.estimated_arrival_time ?? 0n,
			actualArrival: entry.data?.actual_arrival_time ?? 0n,
		}
	})

	const showingSampleData = !isLoading && flights.length === 0
	const displayFlights = showingSampleData ? SAMPLE_FLIGHTS : flights
	const searched = search.trim()
		? displayFlights.filter((f) =>
				f.flightId.toLowerCase().includes(search.trim().toLowerCase()),
			)
		: displayFlights
	const filtered = filterFlights(searched, tab)
	const tabs: FilterTab[] = ["All", "Active", "Settled"]

	return (
		<div className="mx-auto max-w-6xl">
			{/* Header */}
			<h1 className="mb-1 text-2xl font-bold text-foreground">
				Flight Markets
			</h1>
			<p className="mb-6 text-sm text-muted-foreground">
				Browse all insurable flights and their current status.
			</p>

			{showingSampleData && (
				<SampleDataNotice className="mb-6">
					Displaying sample data — connect to testnet for live flight status
				</SampleDataNotice>
			)}

			{/* Filter Tabs + search */}
			<div className="mb-6 flex flex-wrap items-center gap-2">
				{tabs.map((t) => (
					<button
						key={t}
						onClick={() => setTab(t)}
						className={`relative rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
							tab === t
								? "bg-primary text-primary-foreground"
								: "bg-card text-muted-foreground hover:bg-accent"
						}`}
					>
						{t}
						{tab === t && (
							<span className="absolute bottom-0 left-2 right-2 h-0.5 bg-gradient-to-r from-primary to-highlight rounded-full" />
						)}
					</button>
				))}
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search flight #"
					aria-label="Search by flight number"
					className="ml-auto h-9 w-44 rounded-lg border border-input bg-background/60 px-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/40 focus:outline-none transition-all"
				/>
				<span className="w-full text-xs text-muted-foreground sm:w-auto sm:pl-2">
					{filtered.length} flight{filtered.length === 1 ? "" : "s"}
				</span>
			</div>

			{isLoading && (
				<Card className="p-10 text-center">
					<p className="text-muted-foreground">Loading flights...</p>
				</Card>
			)}

			{!isLoading && (
				<>
					{/* Desktop Table */}
					<Card className="hidden overflow-hidden md:block">
						<table className="w-full text-left text-sm">
							<thead>
								<tr className="border-b border-border text-muted-foreground">
									<th className="px-5 py-3 font-medium">Flight</th>
									<th className="px-5 py-3 font-medium">Route</th>
									<th className="px-5 py-3 font-medium">Date</th>
									<th className="px-5 py-3 font-medium">Status</th>
									<th className="px-5 py-3 font-medium">ETA</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((flight) => (
									<tr
										key={`${flight.flightId}-${flight.date.toString()}`}
										className="border-b border-border/50 last:border-0 hover:bg-accent/40 transition-colors"
									>
										<td className="px-5 py-4 font-mono font-semibold">
											<a
												href={flightInfoUrl(flight.flightId)}
												target="_blank"
												rel="noopener noreferrer"
												className="text-foreground hover:text-primary transition-colors"
												title="View live status on FlightAware"
											>
												{flight.flightId}
											</a>
										</td>
										<td className="px-5 py-4 text-muted-foreground">
											{routeByFlightId.get(flight.flightId) ?? "\u2014"}
										</td>
										<td className="px-5 py-4 text-muted-foreground">
											{flight.dateStr}
										</td>
										<td className="px-5 py-4">
											<StatusBadge status={flight.status} />
										</td>
										<td className="px-5 py-4 text-muted-foreground">
											{flight.estimatedArrival > 0n
												? new Date(
														Number(flight.estimatedArrival) * 1000,
													).toLocaleTimeString()
												: "\u2014"}
										</td>
									</tr>
								))}
								{filtered.length === 0 && (
									<tr>
										<td
											colSpan={5}
											className="px-5 py-10 text-center text-muted-foreground"
										>
											No flights match the current filter.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</Card>

					{/* Mobile Cards */}
					<div className="flex flex-col gap-3 md:hidden">
						{filtered.map((flight) => (
							<Card
								key={`${flight.flightId}-${flight.date.toString()}`}
								className="p-4"
							>
								<div className="mb-3 flex items-center justify-between">
									<a
										href={flightInfoUrl(flight.flightId)}
										target="_blank"
										rel="noopener noreferrer"
										className="font-mono text-lg font-semibold text-foreground hover:text-primary transition-colors"
									>
										{flight.flightId}
									</a>
									<StatusBadge status={flight.status} />
								</div>
								<div className="grid grid-cols-2 gap-y-2 text-sm">
									<span className="text-muted-foreground">Route</span>
									<span className="text-right text-foreground">
										{routeByFlightId.get(flight.flightId) ?? "\u2014"}
									</span>
									<span className="text-muted-foreground">Date</span>
									<span className="text-right text-foreground">
										{flight.dateStr}
									</span>
									<span className="text-muted-foreground">ETA</span>
									<span className="text-right text-foreground">
										{flight.estimatedArrival > 0n
											? new Date(
													Number(flight.estimatedArrival) * 1000,
												).toLocaleTimeString()
											: "\u2014"}
									</span>
								</div>
							</Card>
						))}
						{filtered.length === 0 && (
							<p className="py-10 text-center text-muted-foreground">
								No flights match the current filter.
							</p>
						)}
					</div>
				</>
			)}
		</div>
	)
}

export default FlightMarkets
