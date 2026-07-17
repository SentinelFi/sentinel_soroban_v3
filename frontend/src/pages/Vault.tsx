import React, { useState } from "react"
import { Link } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
	useTotalAssets,
	useLockedCapital,
	useFreeCapital,
	useProtocolStats,
	useVaultBalance,
	useConvertToAssets,
	useWithdrawalQueue,
	useClaimableBalance,
	useUsdcBalance,
	formatUsdc,
	parseUsdc,
	riskVaultClient,
	useContractSync,
} from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { stellarNetwork } from "../contracts/util"
import { Card } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TransactionButton } from "../components/TransactionButton"
import { SampleDataNotice } from "../components/SampleDataNotice"
import { FaucetButton } from "../components/FaucetButton"
import type { TxState } from "../types"

/* ---------- Vault Health Gauge (semicircular SVG) ---------- */

interface GaugeProps {
	ratio: number
}

function VaultHealthGauge({ ratio }: GaugeProps) {
	// For the arc, cap at 100% fill (anything >= 100% means fully healthy)
	const gaugePercent = Math.max(0, Math.min(100, ratio > 100 ? 100 : ratio))

	const cx = 120
	const cy = 110
	const r = 90
	const strokeWidth = 14

	const semicircumference = Math.PI * r
	const filledLength = (gaugePercent / 100) * semicircumference
	const gapLength = semicircumference - filledLength

	const endAngle = Math.PI - (gaugePercent / 100) * Math.PI
	const dotX = cx + r * Math.cos(endAngle)
	const dotY = cy - r * Math.sin(endAngle)

	// Color based on actual ratio (not clamped)
	let strokeColor: string
	let gradientId: string
	if (ratio >= 150) {
		strokeColor = "var(--success)"
		gradientId = "gaugeGreen"
	} else if (ratio >= 100) {
		strokeColor = "var(--warning)"
		gradientId = "gaugeYellow"
	} else {
		strokeColor = "var(--destructive)"
		gradientId = "gaugeRed"
	}

	// Display string: e.g. "3,880%" or "97%"
	const displayRatio = ratio >= 1000
		? `${Math.round(ratio / 100)}x`
		: `${ratio}%`

	const bgPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`

	return (
		<div className="flex flex-col items-center">
			<svg
				width="240"
				height="140"
				viewBox="0 0 240 140"
				aria-label={`Vault health: ${displayRatio}`}
			>
				<defs>
					<linearGradient id="gaugeGreen" x1="0" y1="0" x2="1" y2="0">
						<stop offset="0%" stopColor="#22c55e" />
						<stop offset="100%" stopColor="#4ade80" />
					</linearGradient>
					<linearGradient id="gaugeYellow" x1="0" y1="0" x2="1" y2="0">
						<stop offset="0%" stopColor="#f59e0b" />
						<stop offset="100%" stopColor="#fbbf24" />
					</linearGradient>
					<linearGradient id="gaugeRed" x1="0" y1="0" x2="1" y2="0">
						<stop offset="0%" stopColor="#ef4444" />
						<stop offset="100%" stopColor="#f87171" />
					</linearGradient>
					<filter id="gaugeGlow">
						<feGaussianBlur stdDeviation="3" result="blur" />
						<feMerge>
							<feMergeNode in="blur" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
				</defs>

				<path
					d={bgPath}
					fill="none"
					stroke="var(--muted)"
					strokeWidth={strokeWidth}
					strokeLinecap="round"
				/>

				{gaugePercent > 0 && (
					<path
						d={bgPath}
						fill="none"
						stroke={`url(#${gradientId})`}
						strokeWidth={strokeWidth}
						strokeLinecap="round"
						strokeDasharray={`${filledLength} ${gapLength}`}
						filter="url(#gaugeGlow)"
					/>
				)}

				{gaugePercent > 0 && (
					<circle
						cx={dotX}
						cy={dotY}
						r={6}
						fill={strokeColor}
						stroke="var(--background)"
						strokeWidth={2}
					/>
				)}

				<text
					x={cx}
					y={cy - 10}
					textAnchor="middle"
					fill="var(--foreground)"
					style={{ fontSize: "32px", fontWeight: 700 }}
				>
					{displayRatio}
				</text>
				<text
					x={cx}
					y={cy + 12}
					textAnchor="middle"
					fill="var(--muted-foreground)"
					style={{ fontSize: "12px" }}
				>
					Collateralisation
				</text>
			</svg>
		</div>
	)
}

/* ---------- Stat Card ---------- */

function StatCard({ label, value }: { label: string; value: string }) {
	return (
		<Card className="p-4 relative overflow-hidden">
			<div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
			<p className="stat-label mb-1">{label}</p>
			<p className="stat-value text-xl text-foreground">{value}</p>
		</Card>
	)
}

/* ---------- Inline error display ---------- */

function TxError({ message }: { message: string | null }) {
	if (!message) return null
	return (
		<p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive break-words">
			{message}
		</p>
	)
}

/* ---------- Main Page ---------- */

const Vault: React.FC = () => {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const queryClient = useQueryClient()
	const connected = Boolean(address)
	const { data: usdcBalance } = useUsdcBalance(address)

	const [depositAmount, setDepositAmount] = useState("")
	const [withdrawAmount, setWithdrawAmount] = useState("")

	// Independent transaction state per action
	const [depositTx, setDepositTx] = useState<TxState>("idle")
	const [redeemTx, setRedeemTx] = useState<TxState>("idle")
	const [requestTx, setRequestTx] = useState<TxState>("idle")
	const [cancelTx, setCancelTx] = useState<TxState>("idle")
	const [collectTx, setCollectTx] = useState<TxState>("idle")
	const [cancelingId, setCancelingId] = useState<bigint | null>(null)

	// Per-action error messages surfaced in the UI
	const [depositError, setDepositError] = useState<string | null>(null)
	const [withdrawError, setWithdrawError] = useState<string | null>(null)
	const [queueError, setQueueError] = useState<string | null>(null)
	const [collectError, setCollectError] = useState<string | null>(null)

	// ─── Contract reads ───
	const { data: totalAssets, isLoading: loadingTvl } = useTotalAssets()
	const { data: locked, isLoading: loadingLocked } = useLockedCapital()
	const { data: free, isLoading: loadingFree } = useFreeCapital()
	const { data: protocolStats, isLoading: loadingStats } = useProtocolStats()
	const { data: shares, isLoading: loadingShares } = useVaultBalance(address)
	const { data: positionAssets } = useConvertToAssets(shares)
	const { data: withdrawalQueue, isLoading: loadingQueue } =
		useWithdrawalQueue()
	const { data: claimable, isLoading: loadingClaimable } =
		useClaimableBalance(address)

	// ─── Parsed inputs ───
	const depositAssets = parseUsdc(depositAmount)
	const withdrawShares = parseUsdc(withdrawAmount)

	// Value of the shares typed into the withdraw box
	const { data: withdrawValue } = useConvertToAssets(
		withdrawShares > 0n ? withdrawShares : undefined,
	)

	// Shares preview for the typed deposit amount
	const { data: previewShares } = useQuery({
		queryKey: ["vault", "previewDeposit", depositAssets.toString()],
		queryFn: async () => {
			const tx = await riskVaultClient.preview_deposit({
				assets: depositAssets,
			})
			return tx.result as bigint
		},
		enabled: depositAssets > 0n,
		staleTime: 15_000,
		retry: 1,
	})

	// ─── Derived values ───
	const tvl = totalAssets !== undefined ? formatUsdc(totalAssets) : "125,000.00"
	const lockedDisplay = locked !== undefined ? formatUsdc(locked) : "40,000.00"
	const freeDisplay = free !== undefined ? formatUsdc(free) : "85,000.00"

	const solvencyRatio =
		totalAssets !== undefined && locked !== undefined
			? Number(locked) > 0
				? Math.round((Number(totalAssets) / Number(locked)) * 100)
				: 100
			: 85

	const apy =
		protocolStats !== undefined && totalAssets !== undefined && totalAssets > 0n
			? (
					(Number(protocolStats.totalPremiums) / Number(totalAssets)) *
					100
				).toFixed(1)
			: totalAssets !== undefined
				? "—"
				: "8.2"

	const sharesHeld = shares !== undefined ? formatUsdc(shares) : "0.00"

	const positionValue =
		positionAssets !== undefined ? formatUsdc(positionAssets) : "0.00"

	const unrealizedYield =
		shares !== undefined && positionAssets !== undefined
			? (() => {
					const diff = positionAssets - shares
					const prefix = diff >= 0n ? "+" : "-"
					return `${prefix}${formatUsdc(diff < 0n ? -diff : diff)} USDC`
				})()
			: "+0.00 USDC"

	const premiumIncome =
		protocolStats !== undefined
			? `+${formatUsdc(protocolStats.totalPremiums)} USDC`
			: "+0.00 USDC"

	const sharePreview =
		depositAssets > 0n
			? previewShares !== undefined
				? formatUsdc(previewShares)
				: "..."
			: "0.00"

	// Instant redemption is only possible if free capital covers the value
	const canRedeemInstant =
		withdrawShares > 0n &&
		withdrawValue !== undefined &&
		free !== undefined &&
		withdrawValue <= free

	const insufficientShares =
		shares !== undefined && withdrawShares > shares

	// ─── User's queued withdrawals ───
	const myQueueEntries =
		withdrawalQueue && address
			? withdrawalQueue.filter((entry) => entry.owner === address)
			: []

	const hasClaimable = claimable !== undefined && claimable > 0n

	const isLoading = loadingTvl || loadingLocked || loadingFree || loadingStats
	const showingSampleData = !isLoading && totalAssets === undefined

	// ─── Write helpers ───
	function invalidateVaultQueries() {
		queryClient.invalidateQueries({ queryKey: ["vault"] })
		queryClient.invalidateQueries({ queryKey: ["usdc"] })
	}

	function failTx(
		err: unknown,
		setState: (s: TxState) => void,
		setError: (m: string | null) => void,
		label: string,
	) {
		console.error(`${label} failed:`, err)
		setError(err instanceof Error ? err.message : String(err))
		setState("error")
		setTimeout(() => setState("idle"), 4000)
	}

	// ─── Write handlers ───
	async function handleDeposit() {
		if (!address || depositAssets <= 0n || depositTx !== "idle") return
		setDepositTx("awaiting")
		setDepositError(null)
		try {
			const tx = await riskVaultClient.deposit({
				assets: depositAssets,
				receiver: address,
				from: address,
				operator: address,
			})
			setDepositTx("confirming")
			await tx.signAndSend({ signTransaction })
			setDepositTx("success")
			setDepositAmount("")
			invalidateVaultQueries()
			setTimeout(() => setDepositTx("idle"), 3000)
		} catch (err) {
			failTx(err, setDepositTx, setDepositError, "Deposit")
		}
	}

	async function handleRedeem() {
		if (!address || withdrawShares <= 0n || redeemTx !== "idle") return
		setRedeemTx("awaiting")
		setWithdrawError(null)
		try {
			const tx = await riskVaultClient.redeem({
				shares: withdrawShares,
				receiver: address,
				owner: address,
				operator: address,
			})
			setRedeemTx("confirming")
			await tx.signAndSend({ signTransaction })
			setRedeemTx("success")
			setWithdrawAmount("")
			invalidateVaultQueries()
			setTimeout(() => setRedeemTx("idle"), 3000)
		} catch (err) {
			failTx(err, setRedeemTx, setWithdrawError, "Redeem")
		}
	}

	async function handleRequestWithdrawal() {
		if (!address || withdrawShares <= 0n || requestTx !== "idle") return
		setRequestTx("awaiting")
		setWithdrawError(null)
		try {
			const tx = await riskVaultClient.request_withdrawal({
				caller: address,
				shares: withdrawShares,
			})
			setRequestTx("confirming")
			await tx.signAndSend({ signTransaction })
			setRequestTx("success")
			setWithdrawAmount("")
			invalidateVaultQueries()
			setTimeout(() => setRequestTx("idle"), 3000)
		} catch (err) {
			failTx(err, setRequestTx, setWithdrawError, "Request withdrawal")
		}
	}

	async function handleCancelWithdrawal(requestId: bigint) {
		if (!address || cancelTx !== "idle") return
		setCancelTx("awaiting")
		setCancelingId(requestId)
		setQueueError(null)
		try {
			const tx = await riskVaultClient.cancel_withdrawal({
				caller: address,
				request_id: requestId,
			})
			setCancelTx("confirming")
			await tx.signAndSend({ signTransaction })
			setCancelTx("success")
			invalidateVaultQueries()
			setTimeout(() => {
				setCancelTx("idle")
				setCancelingId(null)
			}, 3000)
		} catch (err) {
			console.error("Cancel withdrawal failed:", err)
			setQueueError(err instanceof Error ? err.message : String(err))
			setCancelTx("error")
			setTimeout(() => {
				setCancelTx("idle")
				setCancelingId(null)
			}, 4000)
		}
	}

	async function handleCollect() {
		if (!address || collectTx !== "idle") return
		setCollectTx("awaiting")
		setCollectError(null)
		try {
			const tx = await riskVaultClient.collect({
				caller: address,
			})
			setCollectTx("confirming")
			await tx.signAndSend({ signTransaction })
			setCollectTx("success")
			invalidateVaultQueries()
			setTimeout(() => setCollectTx("idle"), 3000)
		} catch (err) {
			failTx(err, setCollectTx, setCollectError, "Collect")
		}
	}

	return (
		<div className="mx-auto max-w-5xl">
			{/* Header */}
			<h1 className="mb-1 text-2xl font-bold text-foreground">
				Underwriter Vault
			</h1>
			<p className="mb-6 text-sm text-muted-foreground">
				Deposit USDC to back flight delay claims and earn premium yield.
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
					Displaying sample data — connect to testnet for live vault stats
				</SampleDataNotice>
			)}

			{/* Stats Panel */}
			<div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<StatCard
					label="TVL"
					value={isLoading ? "Loading..." : `$${tvl} USDC`}
				/>
				<StatCard label="APY" value={isLoading ? "Loading..." : apy === "—" ? "—" : `${apy}%`} />
				<StatCard
					label="Locked Capital"
					value={isLoading ? "Loading..." : `$${lockedDisplay} USDC`}
				/>
				<StatCard
					label="Free Capital"
					value={isLoading ? "Loading..." : `$${freeDisplay} USDC`}
				/>
			</div>

			{/* Vault Health Gauge */}
			<Card className="mb-6 p-6">
				<h2 className="mb-2 text-center stat-label">
					Vault Health
				</h2>
				<VaultHealthGauge ratio={solvencyRatio} />
				<p className="mx-auto mt-2 max-w-xl text-center text-xs leading-relaxed text-muted-foreground/70">
					TVL is everything the vault manages. Locked capital backs live
					policies; free capital is available for new coverage and instant
					redemptions. Health compares total assets to locked payouts —
					100%+ means every policy is fully collateralised.{" "}
					<a
						href="https://stellar.expert/explorer/testnet/contract/CDW5YUJXGJWPVOQBXYVDZN7P7QQSE3U6VGIHBN24HZKKCS5QQ75OLIJE"
						target="_blank"
						rel="noopener noreferrer"
						className="underline decoration-border underline-offset-2 hover:text-foreground transition-colors"
					>
						View the vault contract
					</a>
					. Depositing carries risk: payouts to travelers are absorbed by
					the vault.
				</p>
			</Card>

			{/* Two-column layout for Deposit + Position */}
			<div className="mb-6 grid gap-6 lg:grid-cols-2">
				{/* Deposit Section */}
				<Card className="p-5">
					<h2 className="mb-4 text-lg font-semibold text-foreground">
						Deposit
					</h2>
					<div className="space-y-5">
						<div>
							<label className="mb-1.5 block text-xs text-muted-foreground">
								Amount (USDC)
							</label>
							<Input
								type="number"
								min="0"
								placeholder="0.00"
								value={depositAmount}
								onChange={(e) => setDepositAmount(e.target.value)}
								className="font-mono"
							/>
							<p className="mt-2 text-sm text-muted-foreground">
								You'll receive{" "}
								<span className="font-mono font-semibold text-highlight">
									{sharePreview}
								</span>{" "}
								shares
							</p>
						</div>
						<TransactionButton
							state={depositTx}
							onClick={handleDeposit}
							disabled={!connected || depositAssets <= 0n}
						>
							{connected ? "Deposit" : "Connect Wallet to Deposit"}
						</TransactionButton>
						<p className="text-center text-xs text-muted-foreground/70">
							By depositing you agree to the{" "}
							<Link to="/terms" className="underline decoration-border underline-offset-2 hover:text-foreground transition-colors">
								Terms of Service
							</Link>
							.
						</p>
						<TxError message={depositError} />
					</div>
				</Card>

				{/* Your Position */}
				<Card className="p-5">
					<h2 className="mb-4 text-lg font-semibold text-foreground">
						Your Position
					</h2>
					{loadingShares ? (
						<p className="text-sm text-muted-foreground">Loading...</p>
					) : (
						<div className="space-y-3">
							<div className="flex justify-between text-sm">
								<span className="text-muted-foreground">Shares Held</span>
								<span className="font-mono text-foreground">
									{sharesHeld}
								</span>
							</div>
							<div className="flex justify-between text-sm">
								<span className="text-muted-foreground">
									Current Value
								</span>
								<span className="font-mono text-foreground">
									{positionValue} USDC
								</span>
							</div>
							<div className="flex justify-between text-sm">
								<span className="text-muted-foreground">
									Unrealized Yield
								</span>
								<span className="font-mono text-success">
									{unrealizedYield}
								</span>
							</div>
						</div>
					)}

					{/* Yield Breakdown */}
					<div className="mt-5 border-t border-border pt-4">
						<h3 className="stat-label mb-3">
							Yield Breakdown
						</h3>
						{loadingStats ? (
							<p className="text-sm text-muted-foreground">Loading...</p>
						) : (
							<div className="space-y-2">
								<div className="flex justify-between text-sm">
									<span className="text-muted-foreground">
										Protocol Premiums Collected
									</span>
									<span className="font-mono text-success">
										{premiumIncome}
									</span>
								</div>
							</div>
						)}
					</div>
				</Card>
			</div>

			{/* Withdraw Section */}
			<Card className="p-5">
				<h2 className="mb-4 text-lg font-semibold text-foreground">
					Withdraw
				</h2>

				<div className="space-y-5">
					<div>
						<label className="mb-1.5 block text-xs text-muted-foreground">
							Amount (Shares)
						</label>
						<Input
							type="number"
							min="0"
							placeholder="0.00"
							value={withdrawAmount}
							onChange={(e) => setWithdrawAmount(e.target.value)}
							className="font-mono"
						/>
						<p className="mt-2 text-xs text-muted-foreground">
							Your balance:{" "}
							<span className="font-mono text-foreground">{sharesHeld}</span>{" "}
							shares (~{positionValue} USDC)
						</p>
						{withdrawShares > 0n && (
							<p className="mt-1 text-xs text-muted-foreground">
								{withdrawValue !== undefined
									? `These shares are worth ~${formatUsdc(withdrawValue)} USDC. `
									: ""}
								{canRedeemInstant
									? "Free capital covers this amount — instant redemption available."
									: "Free capital may not cover this amount — queue a withdrawal instead."}
							</p>
						)}
						{insufficientShares && (
							<p className="mt-1 text-xs text-destructive">
								Amount exceeds your share balance.
							</p>
						)}
					</div>

					<div className="grid gap-3 sm:grid-cols-2">
						<TransactionButton
							state={redeemTx}
							onClick={handleRedeem}
							disabled={
								!connected ||
								withdrawShares <= 0n ||
								insufficientShares ||
								!canRedeemInstant ||
								requestTx !== "idle"
							}
						>
							{connected ? "Redeem Now" : "Connect Wallet"}
						</TransactionButton>
						<TransactionButton
							state={requestTx}
							onClick={handleRequestWithdrawal}
							disabled={
								!connected ||
								withdrawShares <= 0n ||
								insufficientShares ||
								redeemTx !== "idle"
							}
							className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
						>
							{connected ? "Queue Withdrawal" : "Connect Wallet"}
						</TransactionButton>
					</div>
					<TxError message={withdrawError} />
				</div>

				{/* Your queued withdrawals */}
				<div className="mt-6 border-t border-border pt-4">
					<h3 className="stat-label mb-3">
						Your Queued Withdrawals
					</h3>
					{loadingQueue && !withdrawalQueue ? (
						<p className="text-sm text-muted-foreground">
							Loading withdrawal queue...
						</p>
					) : myQueueEntries.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No queued withdrawals.
						</p>
					) : (
						<div className="space-y-3">
							{myQueueEntries.map((entry) => {
								const queuePosition = withdrawalQueue
									? withdrawalQueue.findIndex(
											(e) => e.request_id === entry.request_id,
										) + 1
									: 0
								const isCanceling = cancelingId === entry.request_id
								return (
									<div
										key={entry.request_id.toString()}
										className="flex items-center justify-between rounded-lg bg-warning/10 px-4 py-3"
									>
										<div>
											<p className="text-sm font-medium text-foreground">
												<span className="font-mono">
													{formatUsdc(entry.shares)}
												</span>{" "}
												shares
											</p>
											<p className="text-xs text-muted-foreground">
												Request #{entry.request_id.toString()} · Queue
												position{" "}
												<span className="text-warning">
													{queuePosition}
												</span>{" "}
												of {withdrawalQueue ? withdrawalQueue.length : 0}
											</p>
										</div>
										<button
											disabled={cancelTx !== "idle"}
											onClick={() =>
												handleCancelWithdrawal(entry.request_id)
											}
											className="rounded-lg border border-destructive/50 px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
										>
											{isCanceling && cancelTx !== "idle"
												? "Processing..."
												: "Cancel"}
										</button>
									</div>
								)
							})}
						</div>
					)}
					<div className="mt-3">
						<TxError message={queueError} />
					</div>
				</div>

				{/* Claimable balance */}
				<div className="mt-6 border-t border-border pt-4">
					<h3 className="stat-label mb-3">
						Claimable
					</h3>
					{loadingClaimable && claimable === undefined ? (
						<p className="text-sm text-muted-foreground">
							Loading claimable balance...
						</p>
					) : hasClaimable ? (
						<div>
							<div className="mb-4 rounded-lg bg-success/10 border border-success/30 p-4">
								<p className="text-sm font-semibold text-success">
									Your withdrawal of{" "}
									{claimable !== undefined ? formatUsdc(claimable) : "0.00"}{" "}
									USDC is ready!
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Collect your funds to complete the withdrawal.
								</p>
							</div>
							<TransactionButton
								state={collectTx}
								onClick={handleCollect}
								disabled={!connected}
								className="bg-success text-success-foreground hover:bg-success/80"
							>
								Collect
							</TransactionButton>
							<div className="mt-3">
								<TxError message={collectError} />
							</div>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Nothing to collect. Processed queue withdrawals appear here.
						</p>
					)}
				</div>
			</Card>
		</div>
	)
}

export default Vault
