import {
	useActiveFlightCount,
	useDepositQueue,
	usePendingOutcomes,
	useWithdrawalQueue,
} from "../hooks/useContracts"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"
import { REPO_URL } from "../config/links"
import { Bot } from "lucide-react"

/**
 * /keepers — the front door for the decentralization story: keepers are
 * the anyone-can-run bot tier (they move no new information on-chain,
 * only execute what the oracle attested). Live workload counts come
 * straight from chain; the run-it-yourself instructions mirror the dapp
 * README, which stays the canonical reference.
 *
 * Reached from the hamburger menu, not the main nav — ops-curious
 * audience, not the buy/earn path.
 */

function StatTile({ label, value }: { label: string; value: string }) {
	return (
		<div className="panel flex-1 basis-40 p-4 text-center">
			<p className="font-display text-[9px] tracking-[0.08em] text-mute uppercase">
				{label}
			</p>
			<p className="board-figure mt-1 text-[30px] text-ink">{value}</p>
		</div>
	)
}

function TierCard({
	icon,
	title,
	body,
	highlight,
}: {
	icon: React.ReactNode
	title: string
	body: string
	highlight?: boolean
}) {
	return (
		<div
			className={`panel flex-1 basis-60 p-4 ${highlight ? "border-gold" : ""}`}
		>
			<h3
				className={`flex items-center gap-2 font-display text-fine tracking-[0.05em] ${highlight ? "text-gold" : "text-ink"}`}
			>
				{icon}
				{title}
			</h3>
			<p className="mt-2 font-body text-meta leading-relaxed text-dim">
				{body}
			</p>
		</div>
	)
}

const RUN_SNIPPET = `git clone ${REPO_URL}
cd sentinel_soroban_v3/dapp
npm install && npm run install:contracts

# keeper bots need ONLY a Stellar RPC + a funded key
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export TTL_EXTENDER_SECRET_KEY="S..."  # any funded key
export KEEPER_SECRET_KEY="S..."        # registered keeper (for now)
export ORACLE_SECRET_KEY="S..."        # read-source only for keepers

npm run bot -- ttl_extender     # TTL upkeep + prune — anyone, today
npm run bot -- settler          # drain pending settlements
npm run bot -- classifier       # classification sweep
npm run bot -- queue_maintainer # LP queue maintenance`

export default function Keepers() {
	const t = useCopy()
	const { theme } = useTheme()
	const serious = theme === "serious"

	const { data: pending } = usePendingOutcomes()
	const { data: activeFlights } = useActiveFlightCount()
	const { data: depositQueue } = useDepositQueue()
	const { data: withdrawalQueue } = useWithdrawalQueue()

	const fmt = (v: number | bigint | undefined) =>
		v === undefined ? "…" : v.toString()

	return (
		<div className="mx-auto max-w-4xl space-y-10 px-4 py-8">
			<div>
				<h1 className="h-display text-[22px] leading-[1.35] sm:text-[28px]">
					{t.keepers.heroLine1}
					{serious ? " " : <br />}
					{t.keepers.heroLine2}
				</h1>
				<p className="mt-3 max-w-2xl font-body text-meta leading-relaxed text-dim">
					{t.keepers.sub}
				</p>
			</div>

			{/* live workload — the chain is the source, no backend involved */}
			<section>
				<h2 className="h-section mb-1">{t.keepers.liveTitle}</h2>
				<p className="mb-3 font-body text-meta text-mute">
					{t.keepers.liveSub}
				</p>
				<div className="flex flex-wrap gap-3">
					<StatTile
						label={t.keepers.statPending}
						value={fmt(pending)}
					/>
					<StatTile
						label={t.keepers.statActive}
						value={fmt(activeFlights)}
					/>
					<StatTile
						label={t.keepers.statDeposits}
						value={fmt(depositQueue?.length)}
					/>
					<StatTile
						label={t.keepers.statWithdrawals}
						value={fmt(withdrawalQueue?.length)}
					/>
				</div>
			</section>

			{/* what the keeper tier does */}
			<section>
				<h2 className="h-section mb-3">{t.keepers.tiersTitle}</h2>
				<TierCard
					highlight
					icon={<Bot size={15} aria-hidden="true" />}
					title={t.keepers.tierKeepers}
					body={t.keepers.tierKeepersBody}
				/>
			</section>

			{/* run one yourself */}
			<section>
				<h2 className="h-section mb-1">{t.keepers.runTitle}</h2>
				<p className="mb-3 max-w-2xl font-body text-meta text-mute">
					{t.keepers.runSub}
				</p>
				<pre className="panel overflow-x-auto p-4 font-board text-body leading-relaxed text-dim">
					{RUN_SNIPPET}
				</pre>
				<p className="mt-3 font-body text-meta leading-relaxed text-win">
					{t.keepers.runPermissionless}
				</p>
				<p className="mt-2 max-w-2xl font-body text-meta leading-relaxed text-mute">
					{t.keepers.runGated}
				</p>
				<a
					href={REPO_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="btn-px btn-gold mt-4 inline-block"
				>
					{t.keepers.sourceCta}
				</a>
			</section>
		</div>
	)
}
