import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Trophy } from "lucide-react"
import { formatUsdc } from "../hooks/useContracts"
import { explorerAccountUrl, explorerLabel } from "../lib/explorer"
import { PixelArt } from "../components/PixelArt"
import { SkeletonRows } from "../components/Skeleton"
import { useTheme } from "../providers/ThemeProvider"
import { useWallet } from "../hooks/useWallet"
import { useCopy } from "../copy"

/**
 * Seatbelters — the travelers' leaderboard. Buyers ranked by net P&L
 * (payouts collected minus premiums paid) from GET /api/leaderboard; all
 * four time windows arrive in one cached blob, so the window filter flips
 * with zero extra requests. The seat number is the server's P&L rank and
 * travels with its row: the column headers re-sort the view, they never
 * re-rank the board. Podium rows get medals and a shine; below twenty
 * entrants the board shows how many seats are still open rather than
 * padding with placeholders. A connected wallet gets its own row under
 * the board — same columns, plus the seat it holds even when that is
 * below the cut — from the endpoint's ?buyer= lookup.
 */

const WINDOWS = ["24h", "7d", "30d", "all"] as const
type LeaderWindow = (typeof WINDOWS)[number]

interface LeaderRow {
	buyer: string
	policies: number
	premium_units: string
	wins: number
	payout_units: string
	pnl_units: string
}

interface LeaderboardResponse {
	db: boolean
	top_n: number
	windows: Record<LeaderWindow, LeaderRow[]>
}

/** A row plus the seat it holds on the server-ranked board. */
interface SeatedRow extends LeaderRow {
	seat: number
}

interface SeatResponse {
	db: boolean
	buyer: string
	windows: Record<LeaderWindow, SeatedRow | null>
}

/** Sortable columns; null = the board's own P&L order. */
type SortKey = "seat" | "policies" | "premium" | "wins" | "pnl"
type SortState = { key: SortKey; dir: 1 | -1 } | null

const MEDALS = ["🥇", "🥈", "🥉"] as const


/** "GABCD…VWXYZ" — first and last five characters. */
function shortAddr(a: string): string {
	return a.length <= 12 ? a : `${a.slice(0, 5)}…${a.slice(-5)}`
}

/** BigInt-safe three-way compare for base-unit strings. */
function compareUnits(a: string, b: string): number {
	const x = BigInt(a)
	const y = BigInt(b)
	return x < y ? -1 : x > y ? 1 : 0
}

/** Ascending comparator per column; ties fall back to the board's seat. */
function compareRows(a: SeatedRow, b: SeatedRow, key: SortKey): number {
	switch (key) {
		case "seat":
			return a.seat - b.seat
		case "policies":
			return a.policies - b.policies || a.seat - b.seat
		case "premium":
			return compareUnits(a.premium_units, b.premium_units) || a.seat - b.seat
		case "wins":
			return a.wins - b.wins || a.seat - b.seat
		case "pnl":
			return compareUnits(a.pnl_units, b.pnl_units) || a.seat - b.seat
	}
}

/** "+12.00" / "-160.00" / "0.00" — P&L reads as a signed figure. */
function formatSigned(units: bigint): string {
	return units > 0n ? `+${formatUsdc(units)}` : formatUsdc(units)
}

async function fetchLeaderboard(): Promise<LeaderboardResponse> {
	const res = await fetch("/api/leaderboard")
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return (await res.json()) as LeaderboardResponse
}

async function fetchMySeat(address: string): Promise<SeatResponse> {
	const res = await fetch(`/api/leaderboard?buyer=${encodeURIComponent(address)}`)
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return (await res.json()) as SeatResponse
}

/** Medal for the podium, plain number below it, dash for no seat. */
function SeatCell({ seat }: { seat: number | null }) {
	if (seat === null)
		return <span className="font-board text-[18px] text-mute">—</span>
	if (seat <= 3)
		return (
			<span className="text-[18px]" role="img" aria-label={`Rank ${seat}`}>
				{MEDALS[seat - 1]}
			</span>
		)
	return <span className="font-board text-[18px] text-mute">{seat}</span>
}

export default function Seatbelters() {
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const { address } = useWallet()
	const [timeWindow, setTimeWindow] = useState<LeaderWindow>("all")
	const [sort, setSort] = useState<SortState>(null)

	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: ["leaderboard"],
		queryFn: fetchLeaderboard,
		staleTime: 60_000,
		retry: 1,
	})

	// The connected traveler's own seat — a separate, per-address request
	// so the shared board blob stays cacheable at the edge.
	const mySeat = useQuery({
		queryKey: ["leaderboard", "seat", address],
		queryFn: () => fetchMySeat(address!),
		enabled: address !== undefined,
		staleTime: 60_000,
		retry: 1,
	})
	const mySeatUnavailable =
		mySeat.isError || (mySeat.data !== undefined && !mySeat.data.db)
	const myRow = mySeat.data?.windows[timeWindow] ?? null
	const myPnl = myRow ? BigInt(myRow.pnl_units) : 0n

	// A DB outage must not masquerade as "no seatbelters yet" — same rule
	// the Policies page applies to RPC failures. `db: false` is the
	// endpoint's own "I couldn't look" signal.
	const boardUnavailable = isError || (data !== undefined && !data.db)
	const rows = useMemo(() => data?.windows[timeWindow] ?? [], [data, timeWindow])
	// Distinguish "board is empty" from "this window is empty".
	const boardHasAnyRows = (data?.windows.all.length ?? 0) > 0
	const topN = data?.top_n ?? 20
	const seatsOpen = Math.max(0, topN - rows.length)

	// Seat = server rank (P&L order). Sorting reorders the view only; the
	// seat and its medal stay glued to the traveler who earned it.
	const seated = useMemo<SeatedRow[]>(
		() => rows.map((row, i) => ({ ...row, seat: i + 1 })),
		[rows],
	)
	const visible = useMemo(
		() =>
			sort
				? [...seated].sort((a, b) => compareRows(a, b, sort.key) * sort.dir)
				: seated,
		[seated, sort],
	)

	// First click on a figure column shows the biggest first (that's what
	// a leaderboard reader wants); on the seat column it's seat 1 first.
	// Second click flips it, third restores the board's own order.
	const toggleSort = (key: SortKey) => {
		const first: 1 | -1 = key === "seat" ? 1 : -1
		setSort((prev) =>
			prev?.key !== key
				? { key, dir: first }
				: prev.dir === first
					? { key, dir: -first as 1 | -1 }
					: null,
		)
	}

	const windowLabels: Record<LeaderWindow, string> = {
		"24h": t.seatbelters.window24h,
		"7d": t.seatbelters.window7d,
		"30d": t.seatbelters.window30d,
		all: t.seatbelters.windowAll,
	}

	const columns: Array<{
		label: string
		key?: SortKey
		align?: "center" | "right"
		title?: string
	}> = [
		{
			label: t.seatbelters.colRank,
			key: "seat",
			align: "center",
			title: t.seatbelters.rankTitle,
		},
		{ label: t.seatbelters.colWho },
		{ label: t.seatbelters.colPolicies, key: "policies", align: "right" },
		{ label: t.seatbelters.colPremium, key: "premium", align: "right" },
		{
			label: t.seatbelters.colWins,
			key: "wins",
			align: "right",
			title: t.seatbelters.winsTitle,
		},
		{
			label: t.seatbelters.colPnl,
			key: "pnl",
			align: "right",
			title: t.seatbelters.pnlTitle,
		},
	]

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
				<div className="lb-panel">
					{/* beam wrapper sits outside the scroll container: a ring drawn
					    on the panel itself would count as overflow and summon
					    scrollbars */}
					<div className="panel overflow-x-auto p-3">
					<table className="w-full border-collapse" data-testid="lb-table">
						<thead>
							<tr className="border-b-2 border-line text-left">
								{columns.map((col) => (
									<th
										key={col.label}
										scope="col"
										className={`label-px px-2 py-2${
											col.align === "right"
												? " text-right"
												: col.align === "center"
													? " text-center"
													: ""
										}`}
										title={col.title}
										aria-sort={
											col.key && sort?.key === col.key
												? sort.dir === 1
													? "ascending"
													: "descending"
												: undefined
										}
									>
										{col.key ? (
											<button
												type="button"
												data-testid={`lb-sort-${col.key}`}
												onClick={() => toggleSort(col.key!)}
												className="label-px inline-flex cursor-pointer items-center gap-1.5 hover:text-ink"
												aria-label={t.markets.sortAria(col.label)}
											>
												{col.label}
												<span
													aria-hidden="true"
													className={
														sort?.key === col.key ? "text-sky" : "text-mute/50"
													}
												>
													{sort?.key === col.key
														? sort.dir === 1
															? "▲"
															: "▼"
														: "↕"}
												</span>
											</button>
										) : (
											col.label
										)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{visible.map((row) => {
								const podium = row.seat <= 3
								const pnl = BigInt(row.pnl_units)
								const pnlTone =
									pnl > 0n ? "text-win" : pnl < 0n ? "text-loss" : "text-mute"
								return (
									<tr
										key={row.buyer}
										data-testid="lb-row"
										data-seat={row.seat}
										className="border-b border-line/40 last:border-b-0"
									>
										<td className="px-2 py-2 text-center">
											<SeatCell seat={row.seat} />
										</td>
										<td className="px-2 py-2">
											<a
												href={explorerAccountUrl(row.buyer)}
												target="_blank"
												rel="noopener noreferrer"
												title={t.seatbelters.explorerTitle(explorerLabel())}
												className={`board-figure text-[17px] hover:underline ${
													podium ? "lb-shine" : "text-ink hover:text-sky"
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
										<td
											className={`board-figure px-2 py-2 text-right text-[17px] ${pnlTone}`}
											data-testid="lb-pnl"
										>
											{formatSigned(pnl)}{" "}
											<span className="text-meta text-mute">USDC</span>
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
					</div>
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

			{/* the connected traveler's own row — last thing on the page, same
			    columns as the board, seat included even below the top-N cut */}
			{!isLoading && !boardUnavailable && (
				<section data-testid="lb-me" aria-labelledby="lb-me-title">
					<h2 id="lb-me-title" className="label-px mb-2 text-left">
						{t.seatbelters.youTitle}
					</h2>
					<div className="panel p-3">
					{address === undefined ? (
						<p
							className={`px-2 pb-2 font-board ${serious ? "text-[18px]" : "text-[17px]"} text-gold`}
						>
							{!serious && <span className="blink">▶</span>}{" "}
							{t.seatbelters.youConnect}
						</p>
					) : mySeat.isLoading ? (
						<SkeletonRows rows={1} />
					) : mySeatUnavailable ? (
						<p role="alert" className="px-2 pb-2 font-body text-meta text-loss">
							{t.seatbelters.youError}
						</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full border-collapse">
								<thead>
									<tr className="border-b-2 border-line text-left">
										{columns.map((col) => (
											<th
												key={col.label}
												scope="col"
												className={`label-px px-2 py-2${
													col.align === "right"
														? " text-right"
														: col.align === "center"
															? " text-center"
															: ""
												}`}
												title={col.title}
											>
												{col.label}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									<tr data-testid="lb-me-row">
										<td className="px-2 py-2 text-center">
											<SeatCell seat={myRow?.seat ?? null} />
										</td>
										<td className="px-2 py-2">
											<span className="label-px mr-2 text-gold">
												{t.seatbelters.you}
											</span>
											<a
												href={explorerAccountUrl(address)}
												target="_blank"
												rel="noopener noreferrer"
												title={t.seatbelters.explorerTitle(explorerLabel())}
												data-testid="lb-me-address"
												className={`board-figure text-[17px] hover:underline ${
													myRow && myRow.seat <= 3
														? "lb-shine"
														: "text-ink hover:text-sky"
												}`}
											>
												{shortAddr(address)}
											</a>
										</td>
										<td className="board-figure px-2 py-2 text-right text-[17px] text-dim">
											{myRow?.policies ?? 0}
										</td>
										<td className="board-figure px-2 py-2 text-right text-[17px] text-ink">
											{formatUsdc(BigInt(myRow?.premium_units ?? "0"))}{" "}
											<span className="text-meta text-mute">USDC</span>
										</td>
										<td className="board-figure px-2 py-2 text-right text-[17px] text-win">
											{myRow?.wins ?? 0}
										</td>
										<td
											className={`board-figure px-2 py-2 text-right text-[17px] ${
												myPnl > 0n ? "text-win" : myPnl < 0n ? "text-loss" : "text-mute"
											}`}
										>
											{formatSigned(myPnl)}{" "}
											<span className="text-meta text-mute">USDC</span>
										</td>
									</tr>
								</tbody>
							</table>
							{myRow === null && (
								<p className="px-2 pt-2 font-body text-fine text-mute">
									{t.seatbelters.youOffBoard}
								</p>
							)}
						</div>
					)}
					</div>
				</section>
			)}
		</div>
	)
}
