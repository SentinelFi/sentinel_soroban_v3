import React from "react"

const Privacy: React.FC = () => (
	<div className="mx-auto max-w-3xl">
		<h1 className="mb-2 text-3xl font-bold text-foreground">Privacy Policy</h1>
		<p className="mb-8 text-sm text-muted-foreground">Last updated: March 2026</p>

		<div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">1. Overview</h2>
				<p>
					Sentinel Protocol ("we", "us", "our") is a decentralized parametric flight delay
					insurance protocol built on the Stellar blockchain. This Privacy Policy explains
					how we handle information when you interact with our smart contracts and frontend
					interface.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">2. Information We Collect</h2>
				<p>
					Sentinel Protocol is designed to minimize data collection. We do not collect
					personal information such as names, emails, or phone numbers. When you interact
					with the protocol:
				</p>
				<ul className="mt-2 list-disc pl-6 space-y-1">
					<li>Your Stellar public address is used to process transactions on-chain.</li>
					<li>Flight route selections and policy parameters are recorded on-chain as part of smart contract state.</li>
					<li>No data is stored on our servers beyond what is publicly available on the Stellar ledger.</li>
				</ul>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">3. Blockchain Data</h2>
				<p>
					All transactions on the Stellar network are public and immutable. This includes
					policy purchases, vault deposits/withdrawals, and settlement transactions. We
					cannot delete or modify on-chain data.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">4. Third-Party Services</h2>
				<p>
					The protocol uses FlightAware AeroAPI to fetch real-time flight data for oracle
					updates. Flight queries are made server-side by the executor and are not linked to
					your wallet address.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">5. Local Storage</h2>
				<p>
					The frontend may store preferences (such as wallet connection state and theme
					settings) in your browser's local storage. This data never leaves your device.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">6. Contact</h2>
				<p>
					For questions about this policy, please open an issue on our{" "}
					<a
						href="https://github.com/SentinelFi"
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:text-primary/80 transition-colors"
					>
						GitHub repository
					</a>.
				</p>
			</section>
		</div>
	</div>
)

export default Privacy
