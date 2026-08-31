import { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Trophy } from "lucide-react"
import { formatUsdc } from "../hooks/useContracts"
import { explorerAccountUrl, explorerLabel } from "../lib/explorer"
import { PixelArt } from "../components/PixelArt"
import { SkeletonRows } from "../components/Skeleton"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"

/**
 * Seatbelters — the travelers' leaderboard. Top premium buyers from
 * GET /api/leaderboard (all four time windows arrive in one cached blob,
 * so the window filter flips with zero extra requests). Podium rows get
 * medals and a shine; below twenty entrants the board shows how many
 * seats are still open rather than padding with placeholders.
 */

const WINDOWS = ["24h", "7d", "30d", "all"] as const
type LeaderWindow = (typeof WINDOWS)[number]

interface LeaderRow {
	buyer: string
	policies: number
	premium_units: string
	wins: number
}

interface LeaderboardResponse {
	db: boolean
	top_n: number
	windows: Record<LeaderWindow, LeaderRow[]>
}

const MEDALS = ["🥇", "🥈", "🥉"] as const

/** "GABCD…VWXYZ" — first and last five characters. */
function shortAddr(a: string): string {
	return a.length <= 12 ? a : `${a.slice(0, 5)}…${a.slice(-5)}`
}

async function fetchLeaderboard(): Promise<LeaderboardResponse> {
	const res = await fetch("/api/leaderboard")
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return (await res.json()) as LeaderboardResponse
}

export default function Seatbelters() {
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const [timeWindow, setTimeWindow] = useState<LeaderWindow>("all")

	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: ["leaderboard"],
		queryFn: fetchLeaderboard,
		staleTime: 60_000,
		retry: 1,
	})

	// A DB outage must not masquerade as "no seatbelters yet" — same rule
	// the Policies page applies to RPC failures. `db: false` is the
	// endpoint's own "I couldn't look" signal.
	const boardUnavailable = isError || (data !== undefined && !data.db)
	const rows = data?.windows[timeWindow] ?? []
	// Distinguish "board is empty" from "this window is empty".
	const boardHasAnyRows = (data?.windows.all.length ?? 0) > 0
	const topN = data?.top_n ?? 20
	const seatsOpen = Math.max(0, topN - rows.length)

	const windowLabels: Record<LeaderWindow, string> = {
		"24h": t.seatbelters.window24h,
		"7d": t.seatbelters.window7d,
		"30d": t.seatbelters.window30d,
		all: t.seatbelters.windowAll,
	}

	return (
		<div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
			<div className="text-center">
				{serious ? (
					<Trophy
						className="mx-auto h-14 w-14 text-gold"
						strokeWidth={1.6}
					/>
				) : (
					<PixelArt name="trophy-win" className="mx-auto h-20 w-20" />
				)}
				<h1 className={`h-display mt-4 ${serious ? "text-[28px]" : "text-[20px]"}`}>
					{t.seatbelters.title}
				</h1>
				<p className={`mt-2 font-body ${serious ? "text-body" : "text-meta"} text-dim`}>
					{t.seatbelters.sub}
				</p>
			</div>

			<div className="flex flex-wrap items-center justify-center gap-2">
				<span className="label-px">{t.seatbelters.windowLabel}</span>
				{WINDOWS.map((w) => (
					<button
						key={w}
						type="button"
						data-testid={`lb-window-${w}`}
						aria-pressed={timeWindow === w}
						aria-label={`${t.seatbelters.windowAria}: ${windowLabels[w]}`}
						onClick={() => setTimeWindow(w)}
						className={`btn-px btn-sm ${timeWindow === w ? "btn-gold" : "btn-ghost"}`}
					>
						{windowLabels[w]}
					</button>
				))}
			</div>

			{isLoading && (
				<>
					<p role="status" className="sr-only">
						{t.seatbelters.loading}
					</p>
					<SkeletonRows rows={6} />
				</>
			)}

			{!isLoading && boardUnavailable && (
				<div role="alert" className="panel p-8 text-center">
					<p className={`font-board ${serious ? "text-[22px]" : "text-[20px]"} text-loss`}>
						{t.seatbelters.loadError}
					</p>
					<button
						type="button"
						className="btn-px btn-gold mt-4"
						onClick={() => void refetch()}
					>
						{t.policies.retry}
					</button>
				</div>
			)}

			{/* this window is empty, but the board isn't — say that, not
			    "no seatbelters yet" */}
			{!isLoading &&
				!boardUnavailable &&
				rows.length === 0 &&
				boardHasAnyRows && (
					<div className="panel p-8 text-center">
						<p className={`font-board ${serious ? "text-[22px]" : "text-[20px]"} text-mute`}>
							{t.seatbelters.emptyWindow}
						</p>
					</div>
				)}

			{!isLoading && !boardUnavailable && rows.length === 0 && !boardHasAnyRows && (
				<div className="panel p-8 text-center">
					{serious ? (
						<Trophy
							className="mx-auto h-12 w-12 text-mute"
							strokeWidth={1.5}
						/>
					) : (
						<PixelArt name="avatar-pilot" className="mx-auto h-20 w-20" />
					)}
					<p className={`mt-4 font-board ${serious ? "text-[22px]" : "text-[20px]"} text-mute`}>
						{t.seatbelters.empty}
					</p>
					<Link to="/" className="btn-px btn-loss mt-4">
						{t.seatbelters.emptyCta}
					</Link>
				</div>
			)}

			{!isLoading && !boardUnavailable && rows.length > 0 && (
				<div className="panel overflow-x-auto p-3">
					<table className="w-full border-collapse" data-testid="lb-table">
						<thead>
							<tr className="border-b-2 border-line text-left">
								<th scope="col" className="label-px px-2 py-2">
									{t.seatbelters.colRank}
								</th>
								<th scope="col" className="label-px px-2 py-2">
									{t.seatbelters.colWho}
								</th>
								<th scope="col" className="label-px px-2 py-2 text-right">
									{t.seatbelters.colPolicies}
								</th>
								<th scope="col" className="label-px px-2 py-2 text-right">
									{t.seatbelters.colPremium}
								</th>
								<th
									scope="col"
									className="label-px px-2 py-2 text-right"
									title={t.seatbelters.winsTitle}
								>
									{t.seatbelters.colWins}
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row, i) => (
								<tr
									key={row.buyer}
									data-testid="lb-row"
									className="border-b border-line/40 last:border-b-0"
								>
									<td className="px-2 py-2">
										{i < 3 ? (
											<span
												className="text-[18px]"
												role="img"
												aria-label={`Rank ${i + 1}`}
											>
												{MEDALS[i]}
											</span>
										) : (
											<span className="font-board text-[18px] text-mute">
												{i + 1}
											</span>
										)}
									</td>
									<td className="px-2 py-2">
										<a
											href={explorerAccountUrl(row.buyer)}
											target="_blank"
											rel="noopener noreferrer"
											title={t.seatbelters.explorerTitle(explorerLabel())}
											className={`board-figure text-[17px] hover:underline ${
												i < 3 ? "lb-shine" : "text-ink hover:text-sky"
											}`}
										>
											{shortAddr(row.buyer)}
										</a>
									</td>
									<td className="board-figure px-2 py-2 text-right text-[17px] text-dim">
										{row.policies}
									</td>
									<td className="board-figure px-2 py-2 text-right text-[17px] text-ink">
										{formatUsdc(BigInt(row.premium_units))}{" "}
										<span className="text-meta text-mute">USDC</span>
									</td>
									<td className="board-figure px-2 py-2 text-right text-[17px] text-win">
										{row.wins}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{!isLoading && !boardUnavailable && rows.length > 0 && seatsOpen > 0 && (
				<p
					data-testid="lb-seats-open"
					className={`text-center font-body ${serious ? "text-meta" : "text-fine"} text-mute`}
				>
					{t.seatbelters.seatsOpen(seatsOpen)}
				</p>
			)}

			<p className={`text-center font-body ${serious ? "text-meta" : "text-fine"} text-mute`}>
				{t.seatbelters.fineprint}
			</p>
		</div>
	)
}
