import type { ReactNode } from "react"

/** Shared shell for the Privacy / Terms pages — themed via app tokens,
 *  so it reads correctly in both Fun (pixel) and Serious (clean) modes. */
function LegalShell({
	title,
	updated,
	children,
}: {
	title: string
	updated: string
	children: ReactNode
}) {
	return (
		<div className="mx-auto max-w-3xl px-4 py-10">
			<h1 className="mb-1 font-display text-[22px] leading-tight text-ink">
				{title}
			</h1>
			<p className="mb-8 font-body text-[13px] text-mute">
				Last updated {updated}
			</p>
			<div className="panel space-y-6 p-6 font-body text-[14px] leading-relaxed text-dim">
				{children}
			</div>
		</div>
	)
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
	return (
		<section>
			<h2 className="mb-2 font-display text-[13px] leading-snug text-ink">
				{heading}
			</h2>
			{children}
		</section>
	)
}

export function Privacy() {
	return (
		<LegalShell title="Privacy Policy" updated="July 2026">
			<Section heading="Overview">
				<p>
					Flights.Fun is a decentralized parametric flight-delay insurance
					protocol on the Stellar network. This interface is independent
					software and is not affiliated with, sponsored, or endorsed by the
					Stellar Development Foundation. It is early-stage software running on
					testnet and may contain bugs.
				</p>
			</Section>
			<Section heading="What we collect">
				<p>
					We are designed to minimize data collection. We do not collect names,
					emails, or phone numbers. When you interact with the protocol:
				</p>
				<ul className="mt-2 list-disc space-y-1 pl-6">
					<li>Your Stellar public address is used to build and submit transactions.</li>
					<li>Policy and vault parameters are recorded on-chain as contract state.</li>
					<li>
						A theme preference is stored locally in your browser; nothing is
						stored on our servers beyond what is public on the ledger.
					</li>
				</ul>
			</Section>
			<Section heading="Blockchain data">
				<p>
					All Stellar transactions are public and immutable — policy purchases,
					vault deposits and withdrawals, and settlements. On-chain data cannot
					be deleted or modified by us.
				</p>
			</Section>
			<Section heading="Third parties">
				<p>
					Wallet connections are handled by your wallet provider. Flight status
					is sourced from a third-party aviation data provider and written
					on-chain by an oracle. We do not control those services.
				</p>
			</Section>
			<Section heading="Contact">
				<p>
					Questions or issues? Open one on{" "}
					<a
						href="https://github.com/SentinelFi"
						target="_blank"
						rel="noopener noreferrer"
						className="text-sky underline underline-offset-2 hover:text-ink"
					>
						GitHub
					</a>
					.
				</p>
			</Section>
		</LegalShell>
	)
}

export function Terms() {
	return (
		<LegalShell title="Terms of Service" updated="July 2026">
			<Section heading="Acceptance">
				<p>
					By using this interface you agree to these terms. If you do not agree,
					do not use it. This is experimental, early-stage software provided on
					an "as is" basis with no warranties of any kind.
				</p>
			</Section>
			<Section heading="Not financial advice">
				<p>
					Nothing here is financial, legal, or tax advice. Parametric insurance
					and underwriting carry risk, including the total loss of funds you
					commit. You are solely responsible for your decisions.
				</p>
			</Section>
			<Section heading="How the protocol works">
				<ul className="mt-2 list-disc space-y-1 pl-6">
					<li>
						Buying cover stakes a fixed premium on a flight being delayed past
						its threshold; a payout is made if an oracle records that outcome.
					</li>
					<li>
						Underwriting deposits capital into a shared pool that earns premiums
						and absorbs payouts.
					</li>
					<li>
						Settlement is automated and depends on third-party flight data and
						on-chain oracles, which may be delayed or wrong.
					</li>
				</ul>
			</Section>
			<Section heading="Smart-contract risk">
				<p>
					Smart contracts may contain bugs or vulnerabilities. Transactions are
					irreversible. You interact with the contracts at your own risk and
					should do your own research.
				</p>
			</Section>
			<Section heading="Limitation of liability">
				<p>
					To the maximum extent permitted by law, the contributors are not
					liable for any loss or damage arising from your use of the protocol or
					this interface.
				</p>
			</Section>
		</LegalShell>
	)
}
