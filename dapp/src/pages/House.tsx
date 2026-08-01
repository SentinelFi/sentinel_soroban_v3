import { useState } from "react"
import { Link } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
	formatUsdc,
	parseUsdc,
	riskVaultClient,
	useClaimableBalance,
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
import { useTxFlow } from "../hooks/useTxFlow"
import { connectWallet } from "../util/wallet"
import { errorMessage, txHashOf } from "../lib/utils"
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
import { AlertTriangle } from "lucide-react"

/** Vault writes touch balances and both queues. */
const VAULT_INVALIDATE = [["vault"], ["usdc"]]

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
	const queryClient = useQueryClient()
	const { addNotification } = useNotification()
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const connected = Boolean(address)

	const [depositAmount, setDepositAmount] = useState("")
	const [withdrawAmount, setWithdrawAmount] = useState("")
	const [cancelingId, setCancelingId] = useState<bigint | null>(null)
	const [cancelingDepositId, setCancelingDepositId] = useState<bigint | null>(
		null,
	)
	// One flow instance per write, so a failed deposit never bleeds into
	// the withdraw/collect steppers (and vice versa).
	const flowOpts = {
		invalidateKeys: VAULT_INVALIDATE,
		resetDelayMs: 3000,
		errorResetDelayMs: 4000,
	}
	const depositFlow = useTxFlow(flowOpts)
	const requestFlow = useTxFlow(flowOpts)
	const collectFlow = useTxFlow(flowOpts)
	const [cancelDepositError, setCancelDepositError] = useState<string | null>(
		null,
	)
	const [cancelWithdrawError, setCancelWithdrawError] = useState<
		string | null
	>(null)

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

	const withdrawalQueueRows = withdrawalQueue ?? []
	const hasQueue = withdrawalQueueRows.length > 0
	const myQueueEntries = address
		? withdrawalQueueRows.filter((entry) => entry.owner === address)
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

	// ─── writes ───
	function handleDeposit() {
		if (!address || depositAssets <= 0n) return
		void depositFlow.run(async (step) => {
			step("awaiting")
			// Two-phase LP entry: escrow assets now; the queue-maintenance
			// cron mints shares at the post-delay share price.
			const tx = await riskVaultClient.request_deposit({
				caller: address,
				assets: depositAssets,
			})
			step("confirming")
			const sent = await tx.signAndSend({ signTransaction })
			setDepositAmount("")
			return { message: t.notify.depositQueued, txHash: txHashOf(sent) }
		})
	}

	async function handleCancelDeposit(requestId: bigint) {
		if (!address || cancelingDepositId !== null) return
		setCancelingDepositId(requestId)
		setCancelDepositError(null)
		try {
			const tx = await riskVaultClient.cancel_deposit({
				caller: address,
				request_id: requestId,
			})
			await tx.signAndSend({ signTransaction })
			addNotification(t.notify.depositCancelled, "secondary")
			invalidate()
		} catch (err) {
			console.error("Cancel deposit failed:", err)
			setCancelDepositError(errorMessage(err))
		} finally {
			setCancelingDepositId(null)
		}
	}

	function handleRequestWithdrawal() {
		if (!address || withdrawShares <= 0n) return
		void requestFlow.run(async (step) => {
			step("awaiting")
			const tx = await riskVaultClient.request_withdrawal({
				caller: address,
				shares: withdrawShares,
			})
			step("confirming")
			const sent = await tx.signAndSend({ signTransaction })
			setWithdrawAmount("")
			return { message: t.notify.withdrawQueued, txHash: txHashOf(sent) }
		})
	}

	async function handleCancel(requestId: bigint) {
		if (!address || cancelingId !== null) return
		setCancelingId(requestId)
		setCancelWithdrawError(null)
		try {
			const tx = await riskVaultClient.cancel_withdrawal({
				caller: address,
				request_id: requestId,
			})
			await tx.signAndSend({ signTransaction })
			addNotification(t.notify.withdrawCancelled, "secondary")
			invalidate()
		} catch (err) {
			console.error("Cancel withdrawal failed:", err)
			setCancelWithdrawError(errorMessage(err))
		} finally {
			setCancelingId(null)
		}
	}

	function handleCollect() {
		if (!address) return
		void collectFlow.run(async (step) => {
			step("awaiting")
			const tx = await riskVaultClient.collect({ caller: address })
			step("confirming")
			const sent = await tx.signAndSend({ signTransaction })
			return { message: t.notify.collected, txHash: txHashOf(sent) }
		})
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
						state={depositFlow.state}
						onClick={() =>
							void (connected ? handleDeposit() : connectWallet())
						}
						disabled={connected && depositAssets <= 0n}
						className="btn-win mt-4 w-full"
					>
						{connected ? t.house.depositCta : t.house.connectWallet}
					</TransactionButton>
					<TxProgress state={depositFlow.state} steps={["awaiting", "confirming"]} error={depositFlow.error} />
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
					{cancelDepositError && (
						<p className="mt-2 break-words font-body text-[13px] text-loss">
							{cancelDepositError}
						</p>
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
							state={requestFlow.state}
							onClick={() =>
								void (
									connected
										? handleRequestWithdrawal()
										: connectWallet()
								)
							}
							disabled={
								connected &&
								(withdrawShares <= 0n || insufficientShares)
							}
							className="btn-blip mt-4 w-full"
						>
							{connected ? t.house.queueCta : t.house.connectWallet}
						</TransactionButton>
						<TxProgress state={requestFlow.state} steps={["awaiting", "confirming"]} error={requestFlow.error} />
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
									{withdrawalQueueRows.map((entry, i) => {
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
												withdrawalQueueRows.findIndex(
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
								{cancelWithdrawError && (
									<p className="mt-2 break-words font-body text-[13px] text-loss">
										{cancelWithdrawError}
									</p>
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
									state={collectFlow.state}
									onClick={handleCollect}
									disabled={!connected}
									className="btn-win mt-3 w-full"
								>
									{t.house.collectCta}
								</TransactionButton>
								<TxProgress state={collectFlow.state} steps={["awaiting", "confirming"]} error={collectFlow.error} />
							</div>
						) : (
							<p className="font-board text-[18px] text-mute">
								{t.house.nothingToCollect}
							</p>
						)}
					</div>
				</div>

			</section>

			<p className="font-body text-[13px] text-mute">
				{t.house.fineprint}
			</p>
		</div>
	)
}
