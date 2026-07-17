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
import { HowItWorksBubble } from "../components/InfoBubble"
import { TransactionButton } from "../components/TransactionButton"
import type { TxState } from "../types"

function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="panel p-4">
			<p className="label-px text-sky">{label}</p>
			<p className="board-figure mt-2 text-[26px]">{value}</p>
		</div>
	)
}

export default function House() {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const queryClient = useQueryClient()
	const { addNotification } = useNotification()
	const connected = Boolean(address)

	const [depositAmount, setDepositAmount] = useState("")
	const [withdrawAmount, setWithdrawAmount] = useState("")
	const [depositTx, setDepositTx] = useState<TxState>("idle")
	const [requestTx, setRequestTx] = useState<TxState>("idle")
	const [collectTx, setCollectTx] = useState<TxState>("idle")
	const [cancelingId, setCancelingId] = useState<bigint | null>(null)
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
	const { data: claimable } = useClaimableBalance(address)

	const depositAssets = parseUsdc(depositAmount)
	const withdrawShares = parseUsdc(withdrawAmount)
	const insufficientShares = shares !== undefined && withdrawShares > shares

	const myQueueEntries =
		withdrawalQueue && address
			? withdrawalQueue.filter((entry) => entry.owner === address)
			: []
	const hasClaimable = claimable !== undefined && claimable > 0n

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
			// ERC-4626-style 4-arg deposit
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
			addNotification("Deposited — you're underwriting flights", "success")
			invalidate()
			setTimeout(() => setDepositTx("idle"), 3000)
		} catch (err) {
			fail(err, setDepositTx, "Deposit")
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
			<section className="grid items-center gap-6 md:grid-cols-[1fr_260px]">
				<div>
					<h1 className="h-display flex items-center gap-3 text-[22px] leading-[1.35] sm:text-[28px]">
						EARN YIELD. <HowItWorksBubble />
					</h1>
					<p className="mt-2 font-display text-[13px] leading-[1.35] text-win sm:text-[15px]">
						BE THE UNDERWRITER.
					</p>
					<p className="mt-4 max-w-lg font-body text-[15px] leading-relaxed text-dim">
						Every <span className="font-semibold text-win">on-time</span>{" "}
						flight pays the underwriting pool. Deposit USDC, take a
						share of every premium, and absorb the payouts when flights
						run <span className="font-semibold text-loss">late</span>.
					</p>
				</div>
				<PixelArt name="vault-house" className="h-36 w-full" />
			</section>

			{/* underwriter calculator — run the numbers before you deposit */}
			<Link
				to="/calculator"
				className="group flex flex-wrap items-center justify-between gap-3 border-2 border-gold bg-surface px-5 py-4 shadow-[0_4px_0_0_#07102a] hover:bg-raised"
			>
				<span className="h-display text-[13px] sm:text-[15px]">
					HOW MUCH CAN YOU EARN?
				</span>
				<span className="font-display text-[10px] text-gold">
					RUN THE NUMBERS ▶
				</span>
			</Link>

			{/* pool stats */}
			<section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatTile
					label="POOL (TVL)"
					value={totalAssets !== undefined ? formatUsdc(totalAssets) : "…"}
				/>
				<StatTile
					label="BACKING POLICIES"
					value={locked !== undefined ? formatUsdc(locked) : "…"}
				/>
				<StatTile
					label="FREE CAPITAL"
					value={free !== undefined ? formatUsdc(free) : "…"}
				/>
				<StatTile
					label="POOL HEALTH"
					value={solvency !== undefined ? `${solvency}%` : "…"}
				/>
			</section>

			<div className="grid gap-6 lg:grid-cols-2">
				{/* deposit */}
				<section className="panel p-5">
					<h2 className="h-section mb-4 flex items-center gap-2">
						<PixelArt name="coin-usdc" icon className="h-6 w-6" />{" "}
						DEPOSIT
					</h2>
					<label className="block">
						<span className="label-px mb-1 block">AMOUNT (USDC)</span>
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
						Wallet:{" "}
						<span className="text-dim">
							{usdcBalance != null ? formatUsdc(usdcBalance) : "…"} USDC
						</span>{" "}
						· mint test USDC from the top bar.
					</p>
					<TransactionButton
						state={depositTx}
						onClick={() => void handleDeposit()}
						disabled={!connected || depositAssets <= 0n}
						className="btn-win mt-4 w-full"
					>
						{connected ? "DEPOSIT — EARN YIELD" : "CONNECT WALLET"}
					</TransactionButton>
				</section>

				{/* position */}
				<section className="panel p-5">
					<h2 className="h-section mb-4">YOUR POSITION</h2>
					<div className="space-y-3">
						<div className="flex items-baseline justify-between">
							<span className="label-px">POOL SHARES</span>
							<span className="board-figure text-[24px] text-ink">
								{shares !== undefined ? formatUsdc(shares) : "…"}
							</span>
						</div>
						<div className="flex items-baseline justify-between">
							<span className="label-px">CURRENT VALUE</span>
							<span className="board-figure text-[24px]">
								{positionAssets !== undefined
									? `${formatUsdc(positionAssets)} USDC`
									: "…"}
							</span>
						</div>
						<div className="flex items-baseline justify-between border-t-2 border-dashed border-line-mid pt-3">
							<span className="label-px text-win">
								PREMIUMS EARNED (ALL TIME)
							</span>
							<span className="board-figure text-[20px] text-win">
								{protocolStats !== undefined
									? `+${formatUsdc(protocolStats.totalPremiums)} USDC`
									: "…"}
							</span>
						</div>
					</div>
				</section>
			</div>

			{/* cash out */}
			<section className="panel p-5">
				<h2 className="h-section mb-4">CASH OUT</h2>
				<div className="grid gap-6 md:grid-cols-2">
					<div>
						<label className="block">
							<span className="label-px mb-1 block">
								AMOUNT (SHARES)
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
								That's more shares than you hold.
							</p>
						)}
						<TransactionButton
							state={requestTx}
							onClick={() => void handleRequestWithdrawal()}
							disabled={
								!connected || withdrawShares <= 0n || insufficientShares
							}
							className="btn-blip mt-4 w-full"
						>
							{connected ? "QUEUE CASH-OUT" : "CONNECT WALLET"}
						</TransactionButton>
						<p className="mt-2 font-body text-[13px] text-mute">
							Cash-outs queue until the vault frees capital, then
							appear below to collect.
						</p>
					</div>

					<div>
						<h3 className="label-px mb-2">YOUR QUEUE</h3>
						{myQueueEntries.length === 0 ? (
							<p className="font-board text-[18px] text-mute">
								NO QUEUED CASH-OUTS
							</p>
						) : (
							<div className="space-y-2">
								{myQueueEntries.map((entry) => {
									const position = withdrawalQueue
										? withdrawalQueue.findIndex(
												(e) => e.request_id === entry.request_id,
											) + 1
										: 0
									return (
										<div
											key={entry.request_id.toString()}
											className="flex items-center justify-between border-2 border-line bg-inset px-3 py-2"
										>
											<span className="font-board text-[18px] text-ink">
												{formatUsdc(entry.shares)} shares
												<span className="ml-2 text-mute">
													#{position} in line
												</span>
											</span>
											<button
												type="button"
												onClick={() =>
													void handleCancel(entry.request_id)
												}
												disabled={cancelingId !== null}
												className="btn-px btn-ghost btn-sm text-loss"
											>
												{cancelingId === entry.request_id
													? "…"
													: "CANCEL"}
											</button>
										</div>
									)
								})}
							</div>
						)}

						<h3 className="label-px mb-2 mt-5">READY TO COLLECT</h3>
						{hasClaimable ? (
							<div className="border-2 border-win bg-surface p-3">
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
									COLLECT ★
								</TransactionButton>
							</div>
						) : (
							<p className="font-board text-[18px] text-mute">
								NOTHING TO COLLECT YET
							</p>
						)}
					</div>
				</div>

				{txError && (
					<p className="mt-4 break-words border-2 border-loss bg-inset px-3 py-2 font-body text-[13px] text-loss">
						{txError}
					</p>
				)}
			</section>

			<p className="font-body text-[13px] text-mute">
				The underwriting pool is an ERC-4626-style Soroban vault:
				deposits mint shares, premiums accrue to share price, and
				payouts on delayed flights are absorbed by the vault.
				Underwriting carries risk.
			</p>
		</div>
	)
}
