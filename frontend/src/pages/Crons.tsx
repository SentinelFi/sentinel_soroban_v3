import React, { useState, useCallback, useEffect } from "react"
import {
	useKeeper,
	useAuthorizedOracle,
} from "../hooks/useContracts"
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card"
import { Button } from "../components/ui/button"
import { fetchBalances } from "../util/wallet"
import { getFriendbotUrl } from "../util/friendbot"
import { executorUrl as EXECUTOR_BASE_URL } from "../contracts/util"

// ── Types mirroring executor API ────────────────────────────────

interface FetcherAction {
	flight: string
	transition?: string
	skipped?: string
	error?: string
}

interface TTLResult {
	contract: string
	success: boolean
	error?: string
}

interface RunLogEntry {
	timestamp: string
	job: string
	duration_ms: number
	success: boolean
	error?: string | null
	active_flights?: number
	actions?: FetcherAction[]
	tx_hash?: string
	results?: TTLResult[]
}

interface HealthStatus {
	uptime_seconds: number
	started_at: string
	last_run: Record<string, RunLogEntry | null>
	ttl_extender_address?: string
}

type Logs = Record<string, RunLogEntry[]>

// ── Constants ───────────────────────────────────────────────────

const JOB_LABELS: Record<string, { name: string; description: string }> = {
	fetcher: {
		name: "Flight Data Fetcher",
		description: "Reads active flights from the oracle, calls AeroAPI for arrival data, and updates on-chain status.",
	},
	classifier: {
		name: "Flight Classifier",
		description: "Calls Controller.classify_flights() to compute delay vs threshold and set ToBeSettled* status.",
	},
	settler: {
		name: "Settlement Executor",
		description: "Calls Controller.execute_settlements() to process payouts.",
	},
	queue_maintainer: {
		name: "Queue Maintainer",
		description: "Calls Controller.run_queue_maintenance() to process the vault withdrawal queue and take the daily share-price snapshot. Runs every 5 min, offset from the other jobs.",
	},
	ttl_extender: {
		name: "TTL Extender",
		description: "Renews instance storage TTL on all long-lived contracts to keep them alive.",
	},
}

const JOB_KEYS = ["fetcher", "classifier", "settler", "queue_maintainer", "ttl_extender"]

// ── Helpers ─────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

function formatUptime(seconds: number): string {
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return `${h}h ${m}m`
}

function timeAgo(timestamp: string): string {
	const diff = Date.now() - new Date(timestamp).getTime()
	const secs = Math.floor(diff / 1000)
	if (secs < 60) return `${secs}s ago`
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
	return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`
}

// ── Log Entry Component ─────────────────────────────────────────

const LogEntry: React.FC<{ entry: RunLogEntry }> = ({ entry }) => {
	const [open, setOpen] = useState(false)

	return (
		<div className="rounded-lg border border-border bg-muted/50">
			<button
				onClick={() => setOpen(!open)}
				className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/80 transition-colors rounded-lg"
			>
				<span
					className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
						entry.success ? "bg-success" : "bg-destructive"
					}`}
				/>
				<span className="text-xs text-muted-foreground flex-shrink-0 font-mono">
					{new Date(entry.timestamp).toLocaleTimeString()}
				</span>
				<span className="text-sm text-foreground flex-1 truncate">
					{entry.success ? "OK" : "Failed"}
					{entry.active_flights != null && ` — ${entry.active_flights} flight(s)`}
					{entry.results && ` — ${entry.results.filter(r => r.success).length}/${entry.results.length} contracts`}
					{entry.error && ` — ${entry.error}`}
				</span>
				<span className="text-xs text-muted-foreground flex-shrink-0">
					{formatDuration(entry.duration_ms)}
				</span>
				<svg
					className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={2}
				>
					<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{open && (
				<div className="border-t border-border px-3 py-2 text-xs space-y-1.5">
					<div className="flex gap-4 text-muted-foreground">
						<span>Time: <span className="text-foreground">{new Date(entry.timestamp).toLocaleString()}</span></span>
						<span>Duration: <span className="text-foreground">{formatDuration(entry.duration_ms)}</span></span>
						<span>Status: <span className={entry.success ? "text-success" : "text-destructive"}>{entry.success ? "Success" : "Failed"}</span></span>
					</div>

					{entry.error && (
						<div className="rounded bg-destructive/10 border border-destructive/20 px-2 py-1 text-destructive">
							{entry.error}
						</div>
					)}

					{/* Fetcher actions */}
					{entry.actions && entry.actions.length > 0 && (
						<div className="space-y-1">
							<p className="font-medium text-muted-foreground">Flight Actions:</p>
							{entry.actions.map((a, i) => (
								<div key={i} className="flex items-center gap-2 pl-2">
									<span className="font-mono text-foreground">{a.flight}</span>
									{a.transition && (
										<span className="rounded bg-success/10 border border-success/20 px-1.5 py-0.5 text-success">
											{a.transition}
										</span>
									)}
									{a.skipped && (
										<span className="text-muted-foreground">Skipped: {a.skipped}</span>
									)}
									{a.error && (
										<span className="text-destructive">Error: {a.error}</span>
									)}
								</div>
							))}
						</div>
					)}

					{/* TTL results */}
					{entry.results && entry.results.length > 0 && (
						<div className="space-y-1">
							<p className="font-medium text-muted-foreground">Contract Results:</p>
							{entry.results.map((r, i) => (
								<div key={i} className="flex items-center gap-2 pl-2">
									<span
										className={`inline-block h-1.5 w-1.5 rounded-full ${
											r.success ? "bg-success" : "bg-destructive"
										}`}
									/>
									<span className="font-mono text-foreground">{r.contract}</span>
									{r.error && <span className="text-destructive">{r.error}</span>}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	)
}

// ── Job Card Component ──────────────────────────────────────────

const JobCard: React.FC<{
	jobKey: string
	lastRun: RunLogEntry | null
	logs: RunLogEntry[]
	executorUrl: string
	onTriggered: () => void
}> = ({ jobKey, lastRun, logs, executorUrl, onTriggered }) => {
	const [triggering, setTriggering] = useState(false)
	const [logsOpen, setLogsOpen] = useState(false)
	const label = JOB_LABELS[jobKey]!
	const recentLogs = logs.slice(-5).reverse()

	const handleTrigger = async () => {
		if (!executorUrl.trim()) return
		setTriggering(true)
		try {
			const resp = await fetch(`${executorUrl.replace(/\/$/, "")}/api/trigger/${jobKey}`, {
				method: "POST",
				signal: AbortSignal.timeout(30000),
			})
			if (!resp.ok) {
				console.error(`Trigger failed: ${resp.status}`)
			}
			onTriggered()
		} catch (err) {
			console.error("Trigger error:", err)
		} finally {
			setTriggering(false)
		}
	}

	return (
		<div className="rounded-xl border border-border bg-card p-4">
			<div className="flex items-start justify-between mb-2">
				<div className="flex items-center gap-2.5">
					<span
						className={`inline-block h-2.5 w-2.5 rounded-full ${
							!lastRun
								? "bg-muted-foreground/30"
								: lastRun.success
									? "bg-success"
									: "bg-destructive"
						}`}
					/>
					<h3 className="text-sm font-semibold text-foreground">{label.name}</h3>
				</div>
				<Button
					onClick={() => void handleTrigger()}
					disabled={!executorUrl.trim() || triggering}
					variant="outline"
					size="sm"
					className="h-7 px-2 text-xs"
				>
					{triggering ? "Running..." : "Trigger"}
				</Button>
			</div>

			<p className="text-xs text-muted-foreground mb-3">{label.description}</p>

			{/* Last run summary */}
			{lastRun ? (
				<div className="flex gap-4 text-xs text-muted-foreground mb-3">
					<span>Last: <span className="text-foreground">{timeAgo(lastRun.timestamp)}</span></span>
					<span>Duration: <span className="text-foreground">{formatDuration(lastRun.duration_ms)}</span></span>
					<span>
						Status:{" "}
						<span className={lastRun.success ? "text-success" : "text-destructive"}>
							{lastRun.success ? "OK" : "Failed"}
						</span>
					</span>
				</div>
			) : (
				<p className="text-xs text-muted-foreground mb-3">No runs recorded yet.</p>
			)}

			{/* Collapsible logs */}
			{recentLogs.length > 0 && (
				<div>
					<button
						onClick={() => setLogsOpen(!logsOpen)}
						className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-2"
					>
						<svg
							className={`h-3.5 w-3.5 transition-transform ${logsOpen ? "rotate-180" : ""}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={2}
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
						</svg>
						Recent Logs ({recentLogs.length})
					</button>

					{logsOpen && (
						<div className="space-y-1.5">
							{recentLogs.map((entry, i) => (
								<LogEntry key={`${entry.timestamp}-${i}`} entry={entry} />
							))}
						</div>
					)}
				</div>
			)}
		</div>
	)
}

// ── Main Page ───────────────────────────────────────────────────

const Crons: React.FC = () => {
	const { data: keeperAddr } = useKeeper()
	const { data: oracleAddr } = useAuthorizedOracle()

	// Executor state
	const executorUrl = EXECUTOR_BASE_URL.replace(/\/$/, "")
	const [health, setHealth] = useState<HealthStatus | null>(null)
	const [logs, setLogs] = useState<Logs | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	// XLM balances
	const [oracleXlm, setOracleXlm] = useState<string | null>(null)
	const [keeperXlm, setKeeperXlm] = useState<string | null>(null)
	const [ttlExtenderXlm, setTtlExtenderXlm] = useState<string | null>(null)
	const [fundingOracle, setFundingOracle] = useState(false)
	const [fundingKeeper, setFundingKeeper] = useState(false)
	const [fundingTtlExtender, setFundingTtlExtender] = useState(false)

	const refreshBalances = useCallback(async (ttlAddr?: string) => {
		if (oracleAddr) {
			const balances = await fetchBalances(oracleAddr)
			setOracleXlm(balances.xlm?.balance ?? "0")
		}
		if (keeperAddr) {
			const balances = await fetchBalances(keeperAddr)
			setKeeperXlm(balances.xlm?.balance ?? "0")
		}
		const addr = ttlAddr || health?.ttl_extender_address
		if (addr) {
			const balances = await fetchBalances(addr)
			setTtlExtenderXlm(balances.xlm?.balance ?? "0")
		}
	}, [oracleAddr, keeperAddr, health?.ttl_extender_address])

	useEffect(() => {
		void refreshBalances()
	}, [refreshBalances])

	const fundAccount = async (address: string, setFunding: (v: boolean) => void) => {
		setFunding(true)
		try {
			const resp = await fetch(getFriendbotUrl(address))
			if (!resp.ok) {
				console.error("Friendbot failed:", resp.status)
			}
			await refreshBalances()
		} catch (err) {
			console.error("Friendbot error:", err)
		} finally {
			setFunding(false)
		}
	}

	const fetchStatus = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const [healthRes, logsRes] = await Promise.all([
				fetch(`${executorUrl}/api/health`, { signal: AbortSignal.timeout(5000) }),
				fetch(`${executorUrl}/api/logs`, { signal: AbortSignal.timeout(5000) }),
			])
			if (!healthRes.ok || !logsRes.ok) {
				setError(`Server returned ${healthRes.status}/${logsRes.status}`)
				return
			}
			const healthData = await healthRes.json() as HealthStatus
			setHealth(healthData)
			setLogs(await logsRes.json())
			// Refresh TTL extender balance now that we have the address
			if (healthData.ttl_extender_address) {
				void refreshBalances(healthData.ttl_extender_address)
			}
		} catch {
			setError(`Cannot reach executor at ${executorUrl}`)
		} finally {
			setLoading(false)
		}
	}, [executorUrl])

	// Auto-fetch executor status on mount
	useEffect(() => {
		void fetchStatus()
	}, [fetchStatus])

	return (
		<div className="mx-auto max-w-3xl">
			<h1 className="mb-2 text-3xl font-bold text-foreground">Cron Jobs</h1>
			<p className="mb-8 text-muted-foreground">
				Monitor and trigger the off-chain executor cron jobs.
			</p>

			{/* Authorized Addresses */}
			<Card className="mb-6">
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle className="text-lg">Authorized Addresses</CardTitle>
						<Button
							onClick={() => void refreshBalances()}
							variant="outline"
							size="sm"
						>
							Refresh Balances
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-1">Authorized Oracle</p>
							<p className="break-all font-mono text-sm text-foreground">
								{oracleAddr ?? "Loading..."}
							</p>
							<div className="mt-2 flex items-center gap-3">
								<span className="text-xs text-muted-foreground">
									XLM:{" "}
									<span className={`font-mono font-medium ${
										oracleXlm && parseFloat(oracleXlm.replace(/,/g, "")) < 10
											? "text-destructive"
											: "text-foreground"
									}`}>
										{oracleXlm ?? "..."}
									</span>
								</span>
								{oracleAddr && (
									<Button
										onClick={() => void fundAccount(oracleAddr, setFundingOracle)}
										disabled={fundingOracle}
										variant="outline"
										size="sm"
										className="h-6 px-2 text-xs"
									>
										{fundingOracle ? "Funding..." : "Fund"}
									</Button>
								)}
							</div>
							<p className="mt-2 text-xs text-muted-foreground">
								Writes flight data to the OracleAggregator. Used by the Fetcher cron.
							</p>
						</div>
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-1">Authorized Keeper</p>
							<p className="break-all font-mono text-sm text-foreground">
								{keeperAddr ?? "Loading..."}
							</p>
							<div className="mt-2 flex items-center gap-3">
								<span className="text-xs text-muted-foreground">
									XLM:{" "}
									<span className={`font-mono font-medium ${
										keeperXlm && parseFloat(keeperXlm.replace(/,/g, "")) < 10
											? "text-destructive"
											: "text-foreground"
									}`}>
										{keeperXlm ?? "..."}
									</span>
								</span>
								{keeperAddr && (
									<Button
										onClick={() => void fundAccount(keeperAddr, setFundingKeeper)}
										disabled={fundingKeeper}
										variant="outline"
										size="sm"
										className="h-6 px-2 text-xs"
									>
										{fundingKeeper ? "Funding..." : "Fund"}
									</Button>
								)}
							</div>
							<p className="mt-2 text-xs text-muted-foreground">
								Calls classify_flights(), execute_settlements(), and run_queue_maintenance(). Used by the Classifier, Settler, and Queue Maintainer crons.
							</p>
						</div>
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-1">TTL Extender</p>
							<p className="break-all font-mono text-sm text-foreground">
								{health?.ttl_extender_address ?? "Connect executor to load"}
							</p>
							<div className="mt-2 flex items-center gap-3">
								<span className="text-xs text-muted-foreground">
									XLM:{" "}
									<span className={`font-mono font-medium ${
										ttlExtenderXlm && parseFloat(ttlExtenderXlm.replace(/,/g, "")) < 10
											? "text-destructive"
											: "text-foreground"
									}`}>
										{ttlExtenderXlm ?? "..."}
									</span>
								</span>
								{health?.ttl_extender_address && (
									<Button
										onClick={() => void fundAccount(health.ttl_extender_address!, setFundingTtlExtender)}
										disabled={fundingTtlExtender}
										variant="outline"
										size="sm"
										className="h-6 px-2 text-xs"
									>
										{fundingTtlExtender ? "Funding..." : "Fund"}
									</Button>
								)}
							</div>
							<p className="mt-2 text-xs text-muted-foreground">
								Throwaway account for extend_ttl() calls. No on-chain auth required, just needs XLM for fees.
							</p>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Executor Connection */}
			<Card className="mb-6">
				<CardHeader>
					<div className="flex items-center justify-between">
						<CardTitle className="text-lg">Executor Status</CardTitle>
						<div className="flex items-center gap-2">
							{health && (
								<span className="text-xs text-muted-foreground">
									Uptime: {formatUptime(health.uptime_seconds)}
								</span>
							)}
							<Button
								onClick={() => void fetchStatus()}
								disabled={loading}
								variant="outline"
								size="sm"
							>
								{loading ? "Checking..." : "Refresh"}
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<p className="text-xs text-muted-foreground mb-4">
						Executor endpoint: <span className="font-mono text-foreground">{executorUrl}</span>
					</p>

					{error && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive mb-4">
							{error}
						</div>
					)}

					{health && (
						<p className="text-xs text-muted-foreground mb-4">
							Connected to executor started at {new Date(health.started_at).toLocaleString()}.
							All 5 crons run every 5 minutes for testing.
						</p>
					)}

					{/* Job cards */}
					<div className="space-y-3">
						{JOB_KEYS.map((key) => (
							<JobCard
								key={key}
								jobKey={key}
								lastRun={health?.last_run[key] ?? null}
								logs={logs?.[key] ?? []}
								executorUrl={executorUrl}
								onTriggered={() => {
									// Re-fetch after a short delay to pick up the new log
									setTimeout(() => void fetchStatus(), 500)
								}}
							/>
						))}
					</div>
				</CardContent>
			</Card>
		</div>
	)
}

export default Crons
