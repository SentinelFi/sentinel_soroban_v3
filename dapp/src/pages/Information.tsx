import { stellarNetwork } from "../contracts/util"
import { CONTRACT_IDS } from "../contracts/ids"
import { explorerContractUrl } from "../lib/explorer"
import pkg from "../../package.json"

/**
 * INFORMATION — read-only facts about this deployment (reached from the
 * top-bar hamburger menu): app version, the Stellar network the
 * contracts live on, and the deployed contract addresses. Preferences
 * live on the Settings page.
 */

const NETWORK_LABEL: Record<string, string> = {
	PUBLIC: "Public (mainnet)",
	TESTNET: "Testnet",
	FUTURENET: "Futurenet",
	LOCAL: "Local",
}

const CONTRACTS: { label: string; address: string }[] = [
	{ label: "Controller", address: CONTRACT_IDS.controller },
	{ label: "Risk Vault", address: CONTRACT_IDS.riskVault },
	{ label: "Flight Pool Manager", address: CONTRACT_IDS.flightPoolManager },
	{ label: "Oracle Aggregator", address: CONTRACT_IDS.oracleAggregator },
	{ label: "Governance Module", address: CONTRACT_IDS.governanceModule },
	{ label: "Mock USDC", address: CONTRACT_IDS.mockUsdc },
]

export default function Information() {
	const networkLabel = NETWORK_LABEL[stellarNetwork] ?? stellarNetwork

	return (
		<div className="mx-auto max-w-4xl px-4 py-10">
			<header className="panel-raised relative overflow-hidden px-5 py-4">
				<div aria-hidden="true" className="scanlines absolute inset-0" />
				<h1 className="font-display text-[18px] leading-tight text-ink sm:text-[22px]">
					INFORMATION
				</h1>
			</header>

			<section className="panel mt-6 px-5 py-4">
				<h2 className="font-display text-[13px] tracking-[0.04em] text-ink">
					APPLICATION
				</h2>
				<div className="mt-4">
					<p className="label-px">App version</p>
					<p className="mt-2 board-figure text-[18px] text-ink">
						v{pkg.version}
					</p>
				</div>
				<div className="mt-4">
					<p className="label-px">Network</p>
					<p
						className="mt-2 board-figure text-[18px]"
						data-testid="info-network"
						style={{
							color:
								stellarNetwork === "PUBLIC"
									? "var(--color-win)"
									: "var(--color-gold)",
						}}
					>
						{networkLabel}
					</p>
				</div>
			</section>

			<section className="panel mt-6 px-5 py-4">
				<h2 className="font-display text-[13px] tracking-[0.04em] text-ink">
					DEPLOYED CONTRACTS
				</h2>
				<div className="mt-3">
					{CONTRACTS.map((c) => (
						<div
							key={c.address}
							className="border-b border-line/60 py-2.5 last:border-b-0"
						>
							<p className="label-px">{c.label}</p>
							<a
								href={explorerContractUrl(c.address)}
								target="_blank"
								rel="noopener noreferrer"
								className="footer-link mt-1 inline-block font-body text-[12px] break-all"
								data-testid={`info-contract-${c.label.toLowerCase().replaceAll(" ", "-")}`}
							>
								{c.address} ↗
							</a>
						</div>
					))}
				</div>
			</section>
		</div>
	)
}
