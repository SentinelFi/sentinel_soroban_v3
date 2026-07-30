import { useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
	formatUsdc,
	parseUsdc,
	riskVaultClient,
	useClaimableBalance,
	useContractSync,
	useConvertToAssets,
	useDepositQueue,
	useFreeCapital,
	useLockedCapital,
	useProtocolStats,
	useTotalAssets,
	useUsdcBalance,
	useVaultBalance,
	useWithdrawalQueue,
} from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { PixelArt } from "../components/PixelArt"
import { SeriousIcon } from "../components/SeriousIcon"
import { HowItWorksBubble } from "../components/InfoBubble"
import { TransactionButton } from "../components/TransactionButton"
import { TxProgress } from "../components/TxProgress"
import { Sparkline } from "../components/Sparkline"
import { SharePriceChart } from "../components/SharePriceChart"
import {
	useTvlSparkline,
	useApySparkline,
	useSharePriceSeries,
} from "../data"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import type { TxState } from "../types"
import { AlertTriangle } from "lucide-react"

function StatTile({
	label,
	value,
	spark,
	sparkColor,
	illustrativeLabel,
}: {
	label: string
	value: string
	/** optional illustrative sparkline series */
	spark?: number[]
	sparkColor?: string
	illustrativeLabel?: string
}) {
	return (
		<div className="panel flex flex-col p-4">
			<p className="label-px text-sky">{label}</p>
			<p className="board-figure mt-2 text-[26px]">{value}</p>
			{spark && spark.length >= 2 && (
				<div className="mt-2 flex items-center gap-2">
					<Sparkline
						data={spark}
						color={sparkColor}
						width={80}
						height={22}
					/>
					{illustrativeLabel && (
						<span className="w3-illustrative">
							{illustrativeLabel}
						</span>
					)}
				</div>
			)}
		</div>
	)
}

export default function House() {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const queryClient = useQueryClient()
	const { addNotification } = useNotification()
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const connected = Boolean(address)

	const [depositAmount, setDepositAmount] = useState("")
	const [withdrawAmount, setWithdrawAmount] = useState("")
	const [depositTx, setDepositTx] = useState<TxState>("idle")
	const [requestTx, setRequestTx] = useState<TxState>("idle")
	const [collectTx, setCollectTx] = useState<TxState>("idle")
	const [cancelingId, setCancelingId] = useState<bigint | null>(null)
	const [cancelingDepositId, setCancelingDepositId] = useState<bigint | null>(
		null,
	)
	const [txError, setTxError] = useState<string | null>(null)

	// ─── reads ───
	const { data: totalAssets } = useTotalAssets()
	const { data: locked } = useLockedCapital()
	const { data: free } = useFreeCapital()
	const { data: protocolStats } = useProtocolStats()
	const { data: usdcBalance } = useUsdcBalance(address)
	const { data: shares } = useVaultBalance(address)
	const { data: positionAssets } = useConvertToAssets(shares)
	const { data: withdrawalQueue } = useWithdrawalQueue()
	const { data: depositQueue } = useDepositQueue()
	const { data: claimable } = useClaimableBalance(address)

	// illustrative (labelled) trend series + real-where-available share price
	const tvlSpark = useTvlSparkline()
	const apySpark = useApySparkline()
	const { data: sharePrice } = useSharePriceSeries(14)

	const depositAssets = parseUsdc(depositAmount)
	const withdrawShares = parseUsdc(withdrawAmount)
	const insufficientShares = shares !== undefined && withdrawShares > shares

	const hasQueue = !!withdrawalQueue && withdrawalQueue.length > 0
	const myQueueEntries =
		withdrawalQueue && address
			? withdrawalQueue.filter((entry) => entry.owner === address)
			: []
	const myDepositEntries =
		depositQueue && address
			? depositQueue.filter((entry) => entry.owner === address)
			: []
	const hasClaimable = claimable !== undefined && claimable > 0n

	// Vault-utilization warning: a redeem would exceed available free capital
	// when capital is locked into policies and free capital can't cover them.
	// Inform (not block): a request would queue until capital frees up.
	const fullyUtilized =
		free !== undefined &&
		locked !== undefined &&
		locked > 0n &&
		free <= 0n

	const solvency =
		totalAssets !== undefined && locked !== undefined
			? Number(locked) > 0
				? Math.round((Number(totalAssets) / Number(locked)) * 100)
				: 100
			: undefined

	function invalidate() {
		void queryClient.invalidateQueries({ queryKey: ["vault"] })
		void queryClient.invalidateQueries({ queryKey: ["usdc"] })
	}

	function fail(err: unknown, setState: (s: TxState) => void, label: string) {
		console.error(`${label} failed:`, err)
		setTxError(err instanceof Error ? err.message : String(err))
		setState("error")
		setTimeout(() => setState("idle"), 4000)
	}

	// ─── writes ───
	async function handleDeposit() {
		if (!address || depositAssets <= 0n || depositTx !== "idle") return
		setDepositTx("awaiting")
		setTxError(null)
		try {
			// Two-phase LP entry: escrow assets now; the queue-maintenance
			// cron mints shares at the post-delay share price.
			const tx = await riskVaultClient.request_deposit({
				caller: address,
				assets: depositAssets,
			})
			setDepositTx("confirming")
			await tx.signAndSend({ signTransaction })
			setDepositTx("success")
			setDepositAmount("")
			addNotification(
				"Deposit queued — shares mint at the next pool pass",
				"success",
			)
			invalidate()
			setTimeout(() => setDepositTx("idle"), 3000)
		} catch (err) {
			fail(err, setDepositTx, "Deposit")
		}
	}

	async function handleCancelDeposit(requestId: bigint) {
		if (!address || cancelingDepositId !== null) return
		setCancelingDepositId(requestId)
		setTxError(null)
		try {
			const tx = await riskVaultClient.cancel_deposit({
				caller: address,
				request_id: requestId,
			})
			await tx.signAndSend({ signTransaction })
			addNotification("Deposit request cancelled", "secondary")
			invalidate()
		} catch (err) {
			console.error("Cancel deposit failed:", err)
			setTxError(err instanceof Error ? err.message : String(err))
		} finally {
			setCancelingDepositId(null)
		}
	}

	async function handleRequestWithdrawal() {
		if (!address || withdrawShares <= 0n || requestTx !== "idle") return
		setRequestTx("awaiting")
		setTxError(null)
		try {
			const tx = await riskVaultClient.request_withdrawal({
				caller: address,
				shares: withdrawShares,
			})
			setRequestTx("confirming")
			await tx.signAndSend({ signTransaction })
			setRequestTx("success")
			setWithdrawAmount("")
			addNotification("Cash-out queued", "success")
			invalidate()
			setTimeout(() => setRequestTx("idle"), 3000)
		} catch (err) {
			fail(err, setRequestTx, "Request withdrawal")
		}
	}

	async function handleCancel(requestId: bigint) {
		if (!address || cancelingId !== null) return
		setCancelingId(requestId)
		setTxError(null)
		try {
			const tx = await riskVaultClient.cancel_withdrawal({
				caller: address,
				request_id: requestId,
			})
			await tx.signAndSend({ signTransaction })
			addNotification("Cash-out request cancelled", "secondary")
			invalidate()
		} catch (err) {
			console.error("Cancel withdrawal failed:", err)
			setTxError(err instanceof Error ? err.message : String(err))
		} finally {
			setCancelingId(null)
		}
	}

	async function handleCollect() {
		if (!address || collectTx !== "idle") return
		setCollectTx("awaiting")
		setTxError(null)
		try {
			const tx = await riskVaultClient.collect({ caller: address })
			setCollectTx("confirming")
			await tx.signAndSend({ signTransaction })
			setCollectTx("success")
			addNotification("Cash-out collected", "success")
			invalidate()
			setTimeout(() => setCollectTx("idle"), 3000)
		} catch (err) {
			fail(err, setCollectTx, "Collect")
		}
	}

	return (
		<div className="mx-auto max-w-5xl space-y-8 px-4 py-8">
			{/* hero */}
			<section
				className={
					serious
						? "hero-serious relative py-6"
						: "grid items-center gap-6 md:grid-cols-[1fr_260px]"
				}
			>
				<div>
					<h1 className="h-display flex items-center gap-3 text-[22px] leading-[1.35] sm:text-[28px]">
						{serious ? (
							<span className="hero-serious-title text-[40px] font-bold tracking-[-0.02em] sm:text-[52px]">
								<span className="hero-grad">
									{t.house.heroLine1}
								</span>{" "}
								{t.house.heroLine2}
							</span>
						) : (
							t.house.heroLine1
						)}{" "}
						<HowItWorksBubble />
					</h1>
					{!serious && (
						<p className="mt-2 font-display text-[13px] leading-[1.35] text-win sm:text-[15px]">
							{t.house.heroLine2}
						</p>
					)}
					<p className="mt-4 max-w-lg font-body text-[15px] leading-relaxed text-dim sm:text-[16px]">
						{t.house.sub}
					</p>
				</div>
				{!serious && (
					<PixelArt name="vault-house" className="h-36 w-full" />
				)}
			</section>

			{/* underwriter calculator — run the numbers before you deposit */}
			<Link
				to="/calculator"
				className="calc-cta group flex flex-wrap items-center justify-between gap-3 border-2 border-gold bg-surface px-5 py-4 shadow-[0_4px_0_0_#07102a] hover:bg-raised"
			>
				<span className="h-display text-[13px] sm:text-[15px]">
					{t.house.calcCtaHead}
				</span>
				<span className="font-display text-[10px] text-gold">
					{t.house.calcCtaTail}
				</span>
			</Link>

			{/* pool stats */}
			<section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatTile
					label={t.house.statTvl}
					value={totalAssets !== undefined ? formatUsdc(totalAssets) : "…"}
					spark={tvlSpark}
					sparkColor="var(--color-win)"
					illustrativeLabel={t.house.illustrative}
				/>
				<StatTile
					label={t.house.statBacking}
					value={locked !== undefined ? formatUsdc(locked) : "…"}
				/>
				<StatTile
					label={t.house.statFree}
					value={free !== undefined ? formatUsdc(free) : "…"}
				/>
				<StatTile
					label={t.house.statHealth}
					value={solvency !== undefined ? `${solvency}%` : "…"}
					spark={apySpark}
					sparkColor="var(--color-sky)"
					illustrativeLabel={t.house.illustrative}
				/>
			</section>

			{/* share-price history — real snapshots where available, else
			    a labelled illustrative series */}
			{sharePrice && sharePrice.points.length >= 2 && (
				<section className="w3-chart-card">
					<div className="mb-3 flex items-center justify-between gap-3">
						<div>
							<p className="label-px text-sky">
								{t.house.sharePriceTitle}
							</p>
							<p className="mt-1 font-body text-[12px] text-mute">
								{t.house.sharePriceSub(sharePrice.points.length)}
							</p>
						</div>
						{sharePrice.illustrative && (
							<span className="w3-illustrative">
								{t.house.illustrative}
							</span>
						)}
					</div>
						{/* chart renders identically in both themes (no CRT overlay) */}
						<SharePriceChart points={sharePrice.points} />
				</section>
			)}

			<div className="grid gap-6 lg:grid-cols-2">
				{/* deposit */}
				<section className="panel p-5">
					<h2 className="h-section mb-4 flex items-center gap-2">
						{serious ? (
							<SeriousIcon
								name="coin"
								className="h-5 w-5 text-gold"
							/>
						) : (
							<PixelArt name="coin-usdc" icon className="h-6 w-6" />
						)}{" "}
						{t.house.deposit}
					</h2>
					<label className="block">
						<span className="label-px mb-1 block">
							{t.house.depositAmount}
						</span>
						<input
							type="number"
							name="deposit-amount"
							min="0"
							placeholder="0.00"
							className="field-px"
							value={depositAmount}
							onChange={(e) => setDepositAmount(e.target.value)}
						/>
					</label>
					<p className="mt-2 font-body text-[13px] text-mute">
						{t.house.walletBalance}{" "}
						<span className="text-dim">
							{usdcBalance != null ? formatUsdc(usdcBalance) : "…"} USDC
						</span>{" "}
						{t.house.walletHint}
					</p>
					<TransactionButton
						state={depositTx}
						onClick={() => void handleDeposit()}
						disabled={!connected || depositAssets <= 0n}
						className="btn-win mt-4 w-full"
					>
						{connected ? t.house.depositCta : t.house.connectWallet}
					</TransactionButton>
					<TxProgress state={depositTx} steps={["awaiting", "confirming"]} error={txError} />
					<p className="mt-2 font-body text-[13px] text-mute">
						{t.house.depositQueueHint}
					</p>

					{/* my escrowed deposits, cancellable until processed */}
					{myDepositEntries.length > 0 && (
						<div className="mt-3 space-y-2">
							{myDepositEntries.map((entry) => (
								<div
									key={entry.request_id.toString()}
									className="box-soft flex items-center justify-between border-2 border-line bg-inset px-3 py-2"
								>
									<span className="font-board text-[18px] text-ink">
										{t.house.depositQueued(
											formatUsdc(entry.assets),
										)}
									</span>
									<button
										type="button"
										onClick={() =>
											void handleCancelDeposit(
												entry.request_id,
											)
										}
										disabled={cancelingDepositId !== null}
										className="btn-px btn-ghost btn-sm text-loss"
									>
										{cancelingDepositId === entry.request_id
											? "…"
											: t.house.cancel}
									</button>
								</div>
							))}
						</div>
					)}
				</section>

				{/* position */}
				<section className="panel p-5">
					<h2 className="h-section mb-4">{t.house.position}</h2>
					<div className="space-y-3">
						<div className="flex items-baseline justify-between">
							<span className="label-px">{t.house.poolShares}</span>
							<span className="board-figure text-[24px] text-ink">
								{shares !== undefined ? formatUsdc(shares) : "…"}
							</span>
						</div>
						<div className="flex items-baseline justify-between">
							<span className="label-px">{t.house.currentValue}</span>
							<span className="board-figure text-[24px]">
								{positionAssets !== undefined
									? `${formatUsdc(positionAssets)} USDC`
									: "…"}
							</span>
						</div>
						<div className="flex items-baseline justify-between border-t-2 border-dashed border-line-mid pt-3">
							<span className="label-px text-win">
								{t.house.premiumsEarned}
							</span>
							<span className="board-figure text-[20px] text-win">
								{protocolStats !== undefined
									? `+${formatUsdc(protocolStats.totalPremiumsCollected)} USDC`
									: "…"}
							</span>
						</div>
					</div>
				</section>
			</div>

			{/* cash out */}
			<section className="panel p-5">
				<h2 className="h-section mb-4">{t.house.cashOut}</h2>
				<div className="grid gap-6 md:grid-cols-2">
					<div>
						<label className="block">
							<span className="label-px mb-1 block">
								{t.house.cashOutAmount}
							</span>
							<input
								type="number"
								name="withdraw-shares"
								min="0"
								placeholder="0.00"
								className="field-px"
								value={withdrawAmount}
								onChange={(e) => setWithdrawAmount(e.target.value)}
							/>
						</label>
						{insufficientShares && (
							<p className="mt-2 font-body text-[13px] text-loss">
								{t.house.insufficient}
							</p>
						)}
						{fullyUtilized && (
							<div className="w3-util-warn mt-3">
								{serious ? (
									<AlertTriangle
										className="h-5 w-5 flex-none text-gold"
										strokeWidth={1.8}
									/>
								) : (
									<span
										className="w3-util-warn-glyph"
										aria-hidden="true"
									>
										▲
									</span>
								)}
								<p className="font-body text-[13px] leading-snug text-dim">
									{t.house.utilWarn}
								</p>
							</div>
						)}
						<TransactionButton
							state={requestTx}
							onClick={() => void handleRequestWithdrawal()}
							disabled={
								!connected || withdrawShares <= 0n || insufficientShares
							}
							className="btn-blip mt-4 w-full"
						>
							{connected ? t.house.queueCta : t.house.connectWallet}
						</TransactionButton>
						<TxProgress state={requestTx} steps={["awaiting", "confirming"]} error={txError} />
						<p className="mt-2 font-body text-[13px] text-mute">
							{t.house.queueHint}
						</p>
					</div>

					<div>
						<h3 className="label-px mb-2">{t.house.queueRail}</h3>
						{!hasQueue ? (
							<p className="font-board text-[18px] text-mute">
								{t.house.queueRailEmpty}
							</p>
						) : (
							<>
								{/* the whole withdrawal LINE, positions in order —
								    yours highlighted. FUN = arcade ticket row,
								    SERIOUS = numbered timeline (see wave3.css) */}
								<div className="w3-queue-line" role="list">
									{withdrawalQueue!.map((entry, i) => {
										const mine =
											!!address && entry.owner === address
										return (
											<div
												key={entry.request_id.toString()}
												role="listitem"
												className={`w3-queue-chip${
													mine ? " is-mine" : ""
												}`}
												title={
													mine ? t.house.queueMine : undefined
												}
											>
												<span className="w3-queue-pos">
													{mine
														? `#${i + 1} · ${t.house.queueMine}`
														: `#${i + 1}`}
												</span>
												<span className="w3-queue-shares">
													{formatUsdc(entry.shares)}
												</span>
											</div>
										)
									})}
								</div>

								{/* cancel controls for MY entries */}
								{myQueueEntries.length > 0 && (
									<div className="mt-3 space-y-2">
										{myQueueEntries.map((entry) => {
											const position =
												withdrawalQueue!.findIndex(
													(e) =>
														e.request_id ===
														entry.request_id,
												) + 1
											return (
												<div
													key={entry.request_id.toString()}
													className="box-soft flex items-center justify-between border-2 border-line bg-inset px-3 py-2"
												>
													<span className="font-board text-[18px] text-ink">
														{t.house.queueShares(
															formatUsdc(
																entry.shares,
															),
														)}
														<span className="ml-2 text-mute">
															{t.house.queuePosition(
																position,
															)}
														</span>
													</span>
													<button
														type="button"
														onClick={() =>
															void handleCancel(
																entry.request_id,
															)
														}
														disabled={
															cancelingId !== null
														}
														className="btn-px btn-ghost btn-sm text-loss"
													>
														{cancelingId ===
														entry.request_id
															? "…"
															: t.house.cancel}
													</button>
												</div>
											)
										})}
									</div>
								)}
							</>
						)}

						<h3 className="label-px mb-2 mt-5">
							{t.house.readyToCollect}
						</h3>
						{hasClaimable ? (
							<div className="box-soft border-2 border-win bg-surface p-3">
								<p className="board-figure text-[24px] text-win">
									{claimable !== undefined
										? formatUsdc(claimable)
										: "0.00"}{" "}
									USDC
								</p>
								<TransactionButton
									state={collectTx}
									onClick={() => void handleCollect()}
									disabled={!connected}
									className="btn-win mt-3 w-full"
								>
									{t.house.collectCta}
								</TransactionButton>
								<TxProgress state={collectTx} steps={["awaiting", "confirming"]} error={txError} />
							</div>
						) : (
							<p className="font-board text-[18px] text-mute">
								{t.house.nothingToCollect}
							</p>
						)}
					</div>
				</div>

				{txError && (
					<p className="box-soft mt-4 break-words border-2 border-loss bg-inset px-3 py-2 font-body text-[13px] text-loss">
						{txError}
					</p>
				)}
			</section>

			<p className="font-body text-[13px] text-mute">
				{t.house.fineprint}
			</p>
		</div>
	)
}
