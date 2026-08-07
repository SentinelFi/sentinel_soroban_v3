import type { ReactNode } from "react"

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
			<p className="mb-8 font-body text-meta text-mute">
				Last updated {updated}
			</p>
			<div className="panel space-y-6 p-6 font-body text-meta leading-relaxed text-dim">
				{children}
			</div>
		</div>
	)
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
	return (
		<section>
			<h2 className="mb-2 font-display text-meta leading-snug text-ink">
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

export function Disclaimers() {
	return (
		<LegalShell title="Disclaimers" updated="August 2026">
			<Section heading="Scope">
				<p>
					These disclaimers cover this website, the documentation, and any
					other material published around this protocol. Reading,
					browsing, or transacting through this interface means you accept
					them.
				</p>
			</Section>
			<Section heading="Nothing here is advice">
				<p>
					Everything on this site is general information. None of it is — or
					should be read as — investment, financial, legal, tax, accounting,
					or insurance advice, and nothing here recommends that you buy cover,
					deposit into the vault, or hold any digital asset. Talk to a
					qualified professional before making decisions that depend on your
					personal situation.
				</p>
			</Section>
			<Section heading="An autonomous protocol, not a company">
				<p>
					This protocol is a set of open-source smart contracts deployed on the
					Stellar network. Once deployed, the contracts execute exactly as
					written, without anyone standing in the middle: the contributors do
					not hold your funds, do not act as your counterparty, broker, agent,
					or insurer of record, and cannot reverse, block, or prioritize
					transactions. This website is only one independent way of reaching
					those contracts — the protocol exists and operates without it.
				</p>
			</Section>
			<Section heading="No affiliation">
				<p>
					Independent, not affiliated with the Stellar Development
					Foundation. This project builds on the Stellar network and its
					open-source tooling, but it is not sponsored, endorsed, or
					operated by the Stellar Development Foundation; "Stellar" and
					"Soroban" are referenced only to describe where the protocol
					runs.
				</p>
			</Section>
			<Section heading="You keep custody">
				<p>
					You interact through your own wallet and remain solely responsible
					for your keys, your credentials, and everything signed with them.
					There is no password reset on a blockchain: lost keys mean lost
					access, and nobody can recover them or undo a confirmed transaction.
				</p>
			</Section>
			<Section heading="Risk of loss">
				<p>
					Using DeFi protocols involves substantial risk. Smart contracts can
					contain defects even after review; oracles and the flight data
					behind them can be late, incomplete, or wrong; stablecoins can trade
					away from their peg; and network congestion or outages can delay
					settlement. Premiums you stake and capital you underwrite with can
					be lost entirely. Commit only what you can afford to lose.
				</p>
			</Section>
			<Section heading="Independent third parties">
				<p>
					Wallets, RPC endpoints, block explorers, bridges, aviation data
					providers, and other services reachable from this interface are
					built and operated by independent parties. Links to them are
					provided for convenience: the contributors have not audited them and
					do not endorse or guarantee their security, availability, or
					accuracy.
				</p>
			</Section>
			<Section heading="Estimates and forward-looking figures">
				<p>
					Some numbers shown in this interface — delay-risk estimates, trend
					sparklines, projected yields — are labelled as estimates or
					illustrative series. They are not measured history and not a promise
					of future performance; any forward-looking figure is inherently
					uncertain and can turn out to be wrong.
				</p>
			</Section>
			<Section heading="Regulatory status">
				<p>
					The legal treatment of digital assets and parametric protection
					products differs between jurisdictions and continues to change.
					Nothing published here is an offer or solicitation in any place
					where such an offer would be unlawful, and the protocol is not
					presented as a licensed or regulated financial or insurance service.
					It is your responsibility to confirm that using it is lawful where
					you live and to handle any consequences.
				</p>
			</Section>
			<Section heading="No warranties, no liability">
				<p>
					The interface, the contracts, and all related materials are provided
					"as is" and "as available", without warranties of any kind, express
					or implied. To the maximum extent the law allows, the contributors
					accept no liability for any loss or damage — direct or indirect,
					including lost assets or lost profits — arising from your use of, or
					inability to use, the protocol or this interface.
				</p>
			</Section>
		</LegalShell>
	)
}
