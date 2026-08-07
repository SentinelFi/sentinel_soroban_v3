import { Link, useParams, useSearchParams } from "react-router-dom"
import type { ReactNode } from "react"
import {
	formatUsdc,
	useFlightConfig,
	useFlightData,
	useHasClaimed,
	useHasPolicy,
	useSaleAuth,
} from "../hooks/useContracts"
import { usePolicyEvents } from "../hooks/usePolicyEvents"
import { useFlightSchedules } from "../hooks/useFlightSchedules"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import { formatDate, localDate, localHm } from "../lib/format"
import { explorerLabel, explorerTxUrl } from "../lib/explorer"
import { flightradarUrl } from "../config/airlines"
import { PixelArt } from "../components/PixelArt"
import { Check, Plane, Share2, Trophy } from "lucide-react"

/**
 * /policy/:id — the per-policy trust artifact: the full lifecycle of one
 * (flight, date) as an on-chain paper trail, so "why was I (not) paid?"
 * has a public, verifiable answer.
 *
 * `:id` is `${flightId}-${dateSecs}` (the same key Policies rows use).
 * Deep-linkable without a wallet: everything except the per-traveler claim
 * state reads public chain data. An optional `?t=G...` pins the viewed
 * traveler, so a shared link shows the sharer's slip — the viewer's own
 * wallet is only the fallback. Tx links come from the backend's DB mirror
 * and are strictly optional garnish: no DB, no link, page still stands.
 */

const ID_RE = /^([A-Z0-9]{2,10})-(\d+)$/
const ADDR_RE = /^G[A-Z2-7]{55}$/

function parseId(raw: string | undefined): { flightId: string; date: bigint } | null {
	const m = raw?.match(ID_RE)
	if (!m) return null
	const date = BigInt(m[2])
	// the on-chain key is a UTC-midnight bucket — reject junk numbers
	if (date <= 0n || date % 86_400n !== 0n) return null
	return { flightId: m[1], date }
}

/** "2026-08-06 · 18:30 PDT" — a real instant, viewer-local. */
function localStamp(epochSecs: number): string {
	return `${localDate(epochSecs)} · ${localHm(epochSecs)}`
}

/** "3h 12m" (clamped at 0 → "0m") for a seconds delta. */
function fmtDur(secs: number): string {
	const s = Math.max(0, secs)
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	return h > 0 ? `${h}h ${m}m` : `${m}m`
}

type BadgeKind = "tracking" | "onTime" | "claimable" | "paid" | "expired"

const BADGE_VAR: Record<BadgeKind, string> = {
	tracking: "var(--color-gold)",
	onTime: "var(--color-sky)",
	claimable: "var(--color-win)",
	paid: "var(--color-win)",
	expired: "var(--color-mute)",
}

function StatusBadge({ kind, label }: { kind: BadgeKind; label: string }) {
	return (
		<span
			data-testid="policy-status"
			className="w3-badge"
			style={{ ["--badge" as string]: BADGE_VAR[kind] }}
		>
			<span className="w3-badge-dot" aria-hidden="true" />
			{label}
		</span>
	)
}

type StepState = "done" | "active" | "pending"

interface Step {
	key: string
	state: StepState
	/** marker + title colour (CSS value); defaults by state */
	color?: string
	title: string
	body: ReactNode
	meta?: ReactNode
}

function TimelineStep({ step }: { step: Step }) {
	const color =
		step.color ??
		(step.state === "done"
			? "var(--color-win)"
			: step.state === "active"
				? "var(--color-gold)"
				: "var(--color-mute)")
	return (
		<li
			data-testid="lifecycle-step"
			data-step={step.key}
			className={`w4-step is-${step.state}`}
			style={{ ["--step" as string]: color }}
		>
			<span className="w4-step-dot" aria-hidden="true" />
			<div className="min-w-0">
				<p className="w4-step-title">{step.title}</p>
				<div className="w4-step-body">{step.body}</div>
				{step.meta && <div className="w4-step-meta">{step.meta}</div>}
			</div>
		</li>
	)
}

function TxChip({ hash }: { hash: string }) {
	const t = useCopy()
	return (
		<a
			href={explorerTxUrl(hash)}
			target="_blank"
			rel="noopener noreferrer"
			className="w4-txchip"
		>
			{t.policyDetail.viewTx(explorerLabel())}
		</a>
	)
}

export default function PolicyDetail() {
	const { id } = useParams()
	const [search] = useSearchParams()
	const parsed = parseId(id)
	const flightId = parsed?.flightId ?? ""
	const date = parsed?.date ?? 0n
	const enabled = parsed !== null

	const { address } = useWallet()
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const { addNotification } = useNotification()

	// The viewed traveler: a shared link's ?t pins it; otherwise the
	// connected wallet. Without either, the page shows the market record.
	const tParam = search.get("t")
	const traveler =
		tParam && ADDR_RE.test(tParam) ? tParam : (address ?? undefined)

	const {
		data: flightData,
		isLoading: oracleLoading,
		isError: oracleError,
		refetch: refetchOracle,
	} = useFlightData(flightId, date, enabled)
	const {
		data: config,
		isLoading: configLoading,
		isError: configError,
		refetch: refetchConfig,
	} = useFlightConfig(flightId, date, enabled)
	const { data: saleAuth } = useSaleAuth(flightId, date, enabled)
	const { data: hasPolicy } = useHasPolicy(flightId, date, enabled ? traveler : undefined)
	const { data: claimed } = useHasClaimed(flightId, date, enabled ? traveler : undefined)
	const { data: events } = usePolicyEvents(
		flightId,
		date,
		hasPolicy ? traveler : undefined,
		enabled,
	)
	const { data: depTimes } = useFlightSchedules(
		enabled ? [{ flightId, date }] : [],
	)

	if (!parsed) {
		return <NotFound t={t} serious={serious} />
	}

	const isLoading = oracleLoading || configLoading
	const loadFailed = oracleError && configError

	if (isLoading) {
		return (
			<div className="mx-auto max-w-3xl px-4 py-16">
				<div className="panel p-8 text-center">
					<span className="font-board text-[22px] text-gold">
						{t.policyDetail.loading}
						{!serious && <span className="blink">…</span>}
					</span>
				</div>
			</div>
		)
	}

	if (loadFailed) {
		return (
			<div className="mx-auto max-w-3xl px-4 py-16">
				<div role="alert" className="panel p-8 text-center">
					<p className="font-board text-[22px] text-loss">
						{t.policyDetail.loadError}
					</p>
					<p className="mt-2 font-body text-[13px] text-mute">
						{t.policyDetail.loadErrorSub}
					</p>
					<button
						type="button"
						className="btn-px btn-gold mt-4"
						onClick={() => {
							void refetchOracle()
							void refetchConfig()
						}}
					>
						{t.policyDetail.retry}
					</button>
				</div>
			</div>
		)
	}

	const oracleTag = flightData?.status.tag
	const settlementTag = config?.status.tag
	const saleExpiry = saleAuth ?? null
	const nowSecs = Math.floor(Date.now() / 1000)

	// Nothing on-chain at all for this (flight, date) → dead link, say so.
	const noRecord =
		!config && (oracleTag === undefined || oracleTag === "NotInitiated") && saleExpiry === null
	if (noRecord) {
		return <NotFound t={t} serious={serious} />
	}

	const scheduled = Number(flightData?.estimated_arrival_time ?? 0n)
	const actual = Number(flightData?.actual_arrival_time ?? 0n)
	const settledAtChain = Number(flightData?.settled_at ?? 0n)
	const lateSecs = scheduled > 0 && actual > 0 ? actual - scheduled : 0
	const delayHours = config?.delay_hours ?? 0
	const cancelled =
		settlementTag === "SettledCancelled" ||
		oracleTag === "Cancelled" ||
		oracleTag === "ToBeSettledCancelled"
	const settled =
		settlementTag === "SettledOnTime" ||
		settlementTag === "SettledDelayed" ||
		settlementTag === "SettledCancelled"
	const pays =
		settlementTag === "SettledDelayed" || settlementTag === "SettledCancelled"
	const claimExpiry = config ? Number(config.claim_expiry) : 0
	const claimWindowOpen = claimExpiry > 0 && nowSecs < Number(claimExpiry)
	const holdsSlip = !!traveler && hasPolicy === true
	const isMine = holdsSlip && traveler === address

	// ── verdict header state (same buckets as the Policies list) ──
	let badge: BadgeKind
	let verdict: string
	if (!settled) {
		badge = "tracking"
		verdict =
			oracleTag === "Active"
				? t.policies.liveInAir
				: oracleTag === "Landed"
					? t.policies.liveLanded
					: cancelled
						? t.policies.liveCancelled
						: oracleTag === "ToBeSettledDelayed"
							? t.policies.liveDelayedSettling
							: oracleTag === "ToBeSettledOnTime"
								? t.policies.liveOnTimeSettling
								: t.policies.liveScheduled
	} else if (settlementTag === "SettledOnTime") {
		badge = "onTime"
		verdict = t.policies.outcomeOnTime
	} else if (holdsSlip && claimed) {
		badge = "paid"
		verdict =
			settlementTag === "SettledCancelled"
				? t.policies.outcomeCancelledPaid
				: t.policies.outcomeDelayedPaid
	} else if (claimWindowOpen) {
		badge = "claimable"
		verdict =
			settlementTag === "SettledCancelled"
				? t.policies.outcomeCancelledPays
				: t.policies.outcomeDelayedPays
	} else {
		badge = "expired"
		verdict =
			settlementTag === "SettledCancelled"
				? t.policies.outcomeCancelledExpired
				: t.policies.outcomeDelayedExpired
	}
	const badgeLabel =
		badge === "tracking"
			? t.policies.badgeTracking
			: badge === "onTime"
				? t.policies.badgeOnTime
				: badge === "claimable"
					? t.policies.badgeClaimable
					: badge === "paid"
						? t.policies.badgePaid
						: t.policies.badgeExpired

	const depSecs = depTimes?.get(`${flightId}:${date.toString()}`)
	const frUrl = flightradarUrl(flightId)

	// ── the timeline ──
	const steps: Step[] = []

	// 1. sale window
	steps.push(
		saleExpiry !== null && nowSecs < Number(saleExpiry)
			? {
					key: "sale",
					state: "done",
					title: t.policyDetail.stepSaleTitle,
					body: t.policyDetail.stepSaleOpen(localStamp(Number(saleExpiry))),
				}
			: config
				? {
						key: "sale",
						state: "done",
						title: t.policyDetail.stepSaleTitle,
						body: t.policyDetail.stepSaleDone,
					}
				: {
						key: "sale",
						state: "pending",
						title: t.policyDetail.stepSaleTitle,
						body: t.policyDetail.stepSaleNone,
					},
	)

	// 2. purchase
	{
		const bought = events?.bought ?? null
		const boughtSecs = bought ? Math.floor(new Date(bought.bought_at).getTime() / 1000) : 0
		steps.push(
			holdsSlip && config
				? {
						key: "buy",
						state: "done",
						title: t.policyDetail.stepBuyTitle,
						body: t.policyDetail.stepBuyKnown(formatUsdc(config.premium)),
						meta: (
							<>
								{boughtSecs > 0 && (
									<span className="w4-stamp">
										{t.policyDetail.boughtAt(localStamp(boughtSecs))}
									</span>
								)}
								{bought?.tx_hash && <TxChip hash={bought.tx_hash} />}
							</>
						),
					}
				: config && config.buyer_count > 0
					? {
							key: "buy",
							state: "done",
							title: t.policyDetail.stepBuyTitle,
							body: t.policyDetail.stepBuyMarket(config.buyer_count),
						}
					: {
							key: "buy",
							state: "pending",
							title: t.policyDetail.stepBuyTitle,
							body: t.policyDetail.stepBuyNone,
						},
		)
	}

	// 3. schedule attested (the baseline every payout decision uses)
	steps.push(
		scheduled > 0
			? {
					key: "eta",
					state: "done",
					title: t.policyDetail.stepEtaTitle,
					body: t.policyDetail.stepEtaDone(localStamp(scheduled)),
				}
			: {
					key: "eta",
					state: "pending",
					title: t.policyDetail.stepEtaTitle,
					body: t.policyDetail.stepEtaPending,
				},
	)

	// 4. outcome
	steps.push(
		cancelled
			? {
					key: "outcome",
					state: "done",
					color: "var(--color-loss)",
					title: t.policyDetail.stepOutcomeTitle,
					body: t.policyDetail.stepOutcomeCancelled,
				}
			: actual > 0
				? {
						key: "outcome",
						state: "done",
						title: t.policyDetail.stepOutcomeTitle,
						body: (
							<>
								{t.policyDetail.stepOutcomeLanded(localStamp(actual))}{" "}
								{lateSecs > 0
									? t.policyDetail.stepOutcomeLate(fmtDur(lateSecs))
									: t.policyDetail.stepOutcomeNotLate}
							</>
						),
					}
				: {
						key: "outcome",
						state: oracleTag === "Active" ? "active" : "pending",
						title: t.policyDetail.stepOutcomeTitle,
						body: t.policyDetail.stepOutcomePending,
					},
	)

	// 5. settlement — the classification arithmetic, in the open
	{
		const settleTx = events?.settled?.tx_hash ?? null
		const settledSecs =
			settledAtChain > 0
				? settledAtChain
				: events?.settled
					? Math.floor(new Date(events.settled.settled_at).getTime() / 1000)
					: 0
		steps.push(
			settled
				? {
						key: "settle",
						state: "done",
						color: pays ? "var(--color-gold)" : "var(--color-sky)",
						title: t.policyDetail.stepSettleTitle,
						body: (
							<span className="w4-math">
								{settlementTag === "SettledCancelled"
									? t.policyDetail.settleCancelled
									: settlementTag === "SettledDelayed"
										? t.policyDetail.settleMathLate(fmtDur(lateSecs), delayHours)
										: t.policyDetail.settleMathOnTime(fmtDur(lateSecs), delayHours)}
							</span>
						),
						meta: (
							<>
								{settledSecs > 0 && (
									<span className="w4-stamp">
										{t.policyDetail.settledAt(localStamp(settledSecs))}
									</span>
								)}
								{settleTx && <TxChip hash={settleTx} />}
							</>
						),
					}
				: {
						key: "settle",
						state:
							oracleTag === "ToBeSettledOnTime" ||
							oracleTag === "ToBeSettledDelayed" ||
							oracleTag === "ToBeSettledCancelled"
								? "active"
								: "pending",
						title: t.policyDetail.stepSettleTitle,
						body: t.policyDetail.stepSettlePending,
					},
		)
	}

	// 6. payout
	if (settled && config) {
		const payoffStr = formatUsdc(config.payoff)
		steps.push(
			!pays
				? {
						key: "claim",
						state: "done",
						color: "var(--color-sky)",
						title: t.policyDetail.stepClaimTitle,
						body: t.policyDetail.claimNone,
					}
				: holdsSlip && claimed
					? {
							key: "claim",
							state: "done",
							title: t.policyDetail.stepClaimTitle,
							body: t.policyDetail.claimPaid(payoffStr),
						}
					: holdsSlip && claimWindowOpen
						? {
								key: "claim",
								state: "active",
								title: t.policyDetail.stepClaimTitle,
								body: (
									<>
										{t.policyDetail.claimReady(
											payoffStr,
											localDate(claimExpiry),
										)}
										{isMine && (
											<>
												{" "}
												<Link
													to="/policies"
													className="text-gold hover:underline"
												>
													{t.policyDetail.claimCta}
												</Link>
											</>
										)}
									</>
								),
							}
						: holdsSlip
							? {
									key: "claim",
									state: "done",
									color: "var(--color-mute)",
									title: t.policyDetail.stepClaimTitle,
									body: t.policyDetail.claimExpired,
								}
							: {
									key: "claim",
									state: "done",
									title: t.policyDetail.stepClaimTitle,
									body: t.policyDetail.claimAggregate(
										config.claimed_count,
										config.buyer_count,
									),
								},
		)
	} else {
		steps.push({
			key: "claim",
			state: "pending",
			title: t.policyDetail.stepClaimTitle,
			body: t.policyDetail.stepSettlePending,
		})
	}

	// ── share / copy ──
	const shareUrl =
		`${window.location.origin}/policy/${flightId}-${date.toString()}` +
		(holdsSlip && traveler ? `?t=${traveler}` : "")
	const shareText =
		pays && holdsSlip && claimed
			? t.policyDetail.shareTextPaid(flightId, formatUsdc(config?.payoff ?? 0n))
			: pays && holdsSlip
				? t.policyDetail.shareTextReady(flightId, formatUsdc(config?.payoff ?? 0n))
				: t.policyDetail.shareTextGeneric(flightId)

	const share = async () => {
		if (navigator.share) {
			try {
				await navigator.share({
					title: t.policyDetail.shareTitle,
					text: shareText,
					url: shareUrl,
				})
				return
			} catch {
				return // user dismissed the sheet — not an error
			}
		}
		try {
			await navigator.clipboard.writeText(`${shareText} ${shareUrl}`)
			addNotification(t.policyDetail.linkCopied, "success")
		} catch {
			addNotification(t.policyDetail.copyFailed, "error")
		}
	}

	const won = badge === "paid" || badge === "claimable"

	return (
		<div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
			<Link
				to="/policies"
				className="inline-block font-display text-[11px] tracking-[0.06em] text-mute hover:text-ink"
			>
				{t.policyDetail.back}
			</Link>

			{/* verdict header — the shareable card */}
			<div className={`w4-verdict ${won ? "is-win" : ""}`}>
				<p className="font-display text-[10px] tracking-[0.1em] text-mute uppercase">
					{t.policyDetail.eyebrow}
				</p>
				<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
					{frUrl ? (
						<a
							href={frUrl}
							target="_blank"
							rel="noopener noreferrer"
							title={t.markets.flightLinkTitle(flightId)}
							className="board-figure text-[34px] hover:text-sky hover:underline"
						>
							{flightId}
						</a>
					) : (
						<span className="board-figure text-[34px]">{flightId}</span>
					)}
					<span className="font-board text-[22px] text-dim">
						{depSecs !== undefined ? localDate(depSecs) : formatDate(date)}
						{depSecs !== undefined
							? ` · ${t.policies.depTime(localHm(depSecs))}`
							: ""}
					</span>
					<StatusBadge kind={badge} label={badgeLabel} />
					{won &&
						(serious ? (
							<Trophy className="h-7 w-7 text-gold" strokeWidth={1.7} />
						) : (
							<PixelArt name="trophy-win" className="h-9 w-9" />
						))}
				</div>
				<p className="mt-2 font-body text-[15px] text-dim">{verdict}</p>

				<div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
					{config && (
						<>
							<div>
								<p className="w4-stamp">{t.policyDetail.premiumLabel}</p>
								<p className="board-figure text-[20px] text-ink">
									{formatUsdc(config.premium)} USDC
								</p>
							</div>
							<div>
								<p className="w4-stamp">{t.policyDetail.payoutLabel}</p>
								<p className="board-figure text-[20px] text-win">
									{formatUsdc(config.payoff)} USDC
								</p>
							</div>
						</>
					)}
					<div>
						<p className="w4-stamp">{t.policyDetail.dateLabel}</p>
						<p className="board-figure text-[20px] text-dim">
							{formatDate(date)}
						</p>
					</div>
				</div>

				{config && (
					<p className="mt-3 font-body text-[12px] text-mute">
						{t.policyDetail.triggerLabel(delayHours)} ·{" "}
						{t.policyDetail.buyers(config.buyer_count)}
						{pays
							? ` · ${t.policyDetail.claimedOf(config.claimed_count, config.buyer_count)}`
							: ""}
					</p>
				)}
				{holdsSlip && traveler && (
					<p className="mt-1 break-all font-body text-[12px] text-mute">
						{t.policyDetail.viewingAs(traveler)}
					</p>
				)}
				{!holdsSlip && traveler && config && (
					<p className="mt-1 font-body text-[12px] text-mute">
						{t.policyDetail.noPolicyForWallet}
					</p>
				)}

				<div className="w4-share-row mt-5">
					<button
						type="button"
						data-testid="policy-share"
						onClick={() => void share()}
						className="btn-px btn-gold"
					>
						{serious && (
							<Share2 className="mr-1.5 inline h-4 w-4" strokeWidth={1.8} />
						)}
						{t.policyDetail.share}
					</button>
				</div>
			</div>

			{/* the paper trail */}
			<section>
				<h2 className="h-section mb-1 flex items-center gap-2">
					{serious && <Check className="h-5 w-5" strokeWidth={1.7} />}
					{t.policyDetail.timelineTitle}
				</h2>
				<p className="mb-5 font-body text-[13px] text-mute">
					{t.policyDetail.timelineSub}
				</p>
				<ol className="w4-timeline">
					{steps.map((step) => (
						<TimelineStep key={step.key} step={step} />
					))}
				</ol>
			</section>

		</div>
	)
}

type Copy = ReturnType<typeof useCopy>

function NotFound({ t, serious }: { t: Copy; serious: boolean }) {
	return (
		<div className="mx-auto max-w-3xl px-4 py-16 text-center">
			{serious ? (
				<Plane className="mx-auto h-14 w-14 text-highlight" strokeWidth={1.6} />
			) : (
				<PixelArt name="avatar-pilot" className="mx-auto h-24 w-24" />
			)}
			<h1 className="h-display mt-6 text-[18px]">{t.policyDetail.notFound}</h1>
			<p className="mt-4 font-body text-[15px] leading-relaxed text-dim">
				{t.policyDetail.notFoundSub}
			</p>
			<Link to="/" className="btn-px btn-loss mt-6 inline-block">
				{t.policyDetail.notFoundCta}
			</Link>
		</div>
	)
}
