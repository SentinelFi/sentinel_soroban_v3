import { useQuery } from "@tanstack/react-query"
import { relTime } from "../lib/utils"

/**
 * SYSTEM STATUS — public job-health board (linked from the footer).
 *
 * Same departure-board language as the rest of the site: one lamp per
 * automated job, when it last ran, how long it took. Data comes from
 * the sanitized /api/status/runs feed — pass/fail and timing only, no
 * internals. Answers one question for the public: is the machine that
 * settles policies actually turning?
 */

interface JobStatus {
	job: string
	description: string
	schedule: string
	last_run_at: string | null
	duration_ms: number | null
	success: boolean | null
}

export default function Status() {
	const q = useQuery({
		queryKey: ["public-status"],
		queryFn: async (): Promise<{ jobs: JobStatus[]; as_of: string }> => {
			const res = await fetch("/api/status/runs")
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return res.json()
		},
		refetchInterval: 60_000,
	})

	const jobs = q.data?.jobs ?? []
	const ran = jobs.filter((j) => j.last_run_at !== null)
	const failing = ran.filter((j) => j.success === false).length
	// Inline colors — the serious theme's .board-figure override outranks
	// Tailwind color utilities, so the tone must be set on the element.
	const overall =
		q.isLoading || jobs.length === 0
			? { word: "READING…", color: "var(--color-mute)" }
			: failing > 0
				? { word: "ISSUES DETECTED", color: "var(--color-loss)" }
				: ran.length === 0
					? { word: "STANDBY", color: "var(--color-gold)" }
					: { word: "OPERATIONAL", color: "var(--color-win)" }

	return (
		<div className="mx-auto max-w-4xl px-4 py-10">
			<header className="panel-raised relative mb-8 overflow-hidden px-5 py-4">
				<div aria-hidden="true" className="scanlines absolute inset-0" />
				<p className="label-px mb-1">flights.fun / automation</p>
				<h1 className="font-display text-[18px] leading-tight text-ink sm:text-[22px]">
					SYSTEM STATUS
				</h1>
				<div className="mt-3 flex flex-wrap items-end justify-between gap-3">
					<p className="board-figure" style={{ color: overall.color }}>
						{overall.word}
					</p>
					{q.data && (
						<p className="font-body text-[12px] text-mute">
							as of {new Date(q.data.as_of).toUTCString().slice(5, 25)} UTC
						</p>
					)}
				</div>
			</header>

			<div className="panel overflow-x-auto">
				<table className="w-full border-collapse text-left">
					<thead>
						<tr className="border-b-2 border-line">
							{["", "Job", "Schedule (UTC)", "Last run", "Took"].map((h, i) => (
								<th key={i} className="label-px px-3 py-2 whitespace-nowrap">
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="font-body text-[13px]">
						{q.isLoading && (
							<tr>
								<td colSpan={5} className="px-3 py-4 text-mute">
									Reading the board…
								</td>
							</tr>
						)}
						{q.error != null && (
							<tr>
								<td colSpan={5} className="px-3 py-4 text-loss">
									Status feed unavailable.
								</td>
							</tr>
						)}
						{jobs.map((j) => (
							<tr key={j.job} className="border-b border-line/60 last:border-b-0">
								<td className="w-8 px-3 py-2.5">
									<span
										aria-hidden="true"
										className={`inline-block h-[9px] w-[9px] ${
											j.success === false
												? "bg-loss"
												: j.success === true
													? "bg-win"
													: "bg-line-strong"
										}`}
									/>
								</td>
								<td className="px-3 py-2.5">
									<span className="font-board text-[17px] text-ink">{j.job}</span>
									<span className="block text-[12px] text-mute">{j.description}</span>
								</td>
								<td className="px-3 py-2.5 whitespace-nowrap">
									<span className="font-board text-[16px] text-sky">{j.schedule}</span>
								</td>
								<td className="px-3 py-2.5 whitespace-nowrap text-dim">
									{relTime(j.last_run_at)}
								</td>
								<td className="px-3 py-2.5 whitespace-nowrap text-mute">
									{j.duration_ms != null ? `${j.duration_ms}ms` : "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<p className="mt-4 font-body text-[12px] text-mute">
				Automated keepers for the Soroban testnet deployment — flight status,
				settlement, and route governance. Times are UTC.
			</p>
		</div>
	)
}
