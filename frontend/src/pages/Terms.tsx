import React from "react"

const Terms: React.FC = () => (
	<div className="mx-auto max-w-3xl">
		<h1 className="mb-2 text-3xl font-bold text-foreground">Terms of Service</h1>
		<p className="mb-8 text-sm text-muted-foreground">Last updated: March 2026</p>

		<div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">1. Acceptance of Terms</h2>
				<p>
					By accessing or using Sentinel Protocol ("the Protocol"), you agree to be bound
					by these Terms of Service. The Protocol is a decentralized parametric flight delay
					insurance system deployed on the Stellar blockchain.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">2. Nature of the Protocol</h2>
				<p>
					Sentinel Protocol is an experimental decentralized application. Smart contracts
					are deployed on the Stellar network and operate autonomously. Once deployed,
					contract logic executes as written and cannot be altered except through
					governance-authorized updates.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">3. No Financial Advice</h2>
				<p>
					The Protocol does not provide financial, investment, or insurance advice in the
					traditional regulatory sense. Parametric payoffs are determined solely by
					on-chain oracle data. Users should understand the risks before participating.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">4. Risks</h2>
				<ul className="list-disc pl-6 space-y-1">
					<li>Smart contract risk: bugs or vulnerabilities may result in loss of funds.</li>
					<li>Oracle risk: flight data depends on third-party APIs and may be delayed or inaccurate.</li>
					<li>Network risk: Stellar network congestion or downtime may affect settlements.</li>
					<li>Liquidity risk: vault capital may be insufficient to cover all claims in extreme scenarios.</li>
				</ul>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">5. User Responsibilities</h2>
				<p>
					You are responsible for securing your wallet credentials and private keys. The
					Protocol cannot recover lost keys or reverse transactions. You are solely
					responsible for determining whether your use of the Protocol complies with
					applicable laws in your jurisdiction.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">6. Limitation of Liability</h2>
				<p>
					The Protocol is provided "as is" without warranties of any kind. The developers
					and contributors shall not be liable for any damages arising from the use of
					the Protocol, including but not limited to loss of funds, data, or profits.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">7. Modifications</h2>
				<p>
					These terms may be updated from time to time. Continued use of the Protocol
					after changes constitutes acceptance of the revised terms.
				</p>
			</section>

			<section>
				<h2 className="mb-2 text-lg font-semibold text-foreground">8. Contact</h2>
				<p>
					For questions about these terms, please open an issue on our{" "}
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

export default Terms
