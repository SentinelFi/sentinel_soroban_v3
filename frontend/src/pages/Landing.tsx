import React from "react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { ArrowRight, ShieldCheck } from "lucide-react"
import TestimonialsSection from "../components/ui/testimonial-v2"
import { useGovernanceDefaults, formatUsdc } from "../hooks/useContracts"

const Landing: React.FC = () => {
	const { data: defaults } = useGovernanceDefaults()
	const delayHours = defaults?.default_delay_hours ?? 3
	const payoffStr = defaults ? formatUsdc(defaults.default_payoff) : "50.00"

	return (
		<div>
			{/* ─── Hero Section — full viewport ─── */}
			<section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden px-4 sm:px-6 lg:px-8">
				<div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
				<div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--primary)_0%,transparent_60%)] opacity-[0.07] pointer-events-none" />

				{/* Hero content */}
				<div className="relative z-10 max-w-4xl mx-auto text-center">
					{/* Brand badge */}
					<motion.div
						initial={{ y: 16 }}
						animate={{ y: 0 }}
						transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
						className="inline-flex items-center gap-2 mb-10"
					>
						<ShieldCheck className="h-5 w-5 text-primary" style={{ animation: "logo-glow 3s ease-in-out infinite" }} />
						<span className="text-lg font-bold tracking-wide text-foreground/80">Sentinel Protocol</span>
					</motion.div>

					<motion.h1
						initial={{ y: 16 }}
						animate={{ y: 0 }}
						transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
						className="font-bold tracking-tighter mb-8"
						style={{ fontSize: "clamp(4rem, 8vw, 8rem)" }}
					>
						<span className="inline-block px-[0.06em] pb-[0.06em] bg-gradient-to-b from-foreground to-foreground/80 bg-clip-text text-transparent">Flight Delay</span>
						<br />
						<span className="inline-block px-[0.06em] pb-[0.06em] bg-gradient-to-r from-primary to-highlight bg-clip-text text-transparent">
							Insurance
						</span>
					</motion.h1>

					<motion.p
						initial={{ y: 16 }}
						animate={{ y: 0 }}
						transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
						className="text-lg md:text-xl text-muted-foreground font-normal mb-12 max-w-xl mx-auto leading-relaxed"
					>
						Pay a small premium. If your flight is delayed beyond {delayHours}{" "}
						{delayHours === 1 ? "hour" : "hours"},
						receive a fixed payout in{" "}
						<a href="https://www.circle.com/multi-chain-usdc/stellar" target="_blank" rel="noopener noreferrer" className="text-foreground/90 underline decoration-border underline-offset-4 hover:decoration-foreground transition-colors">USDC</a>. No claim forms. No waiting.
						Settled automatically on{" "}
						<a href="https://stellar.org" target="_blank" rel="noopener noreferrer" className="text-foreground/90 underline decoration-border underline-offset-4 hover:decoration-foreground transition-colors">Stellar</a>.
					</motion.p>

					{/* CTA Buttons */}
					<motion.div
						initial={{ y: 16 }}
						animate={{ y: 0 }}
						transition={{ duration: 0.5, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
						className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16"
					>
						<Link
							to="/buy"
							className="group shimmer-cta relative rounded-full px-8 py-4 text-base font-semibold text-primary-foreground backdrop-blur-sm transition-all duration-300"
						>
							<span className="relative z-10 inline-flex items-center gap-2">
								Insure My Flight
								<ArrowRight className="h-4 w-4 group-hover:translate-x-1.5 transition-all" />
							</span>
						</Link>
						<Link
							to="/vault"
							className="rounded-full px-8 py-4 text-base font-semibold border border-border/60 bg-card/50 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:border-border transition-all duration-300"
						>
							Earn Yield
						</Link>
					</motion.div>

					{/* Inline stats strip */}
					<motion.div
						initial={{ y: 16 }}
						animate={{ y: 0 }}
						transition={{ duration: 0.5, delay: 0.45, ease: [0.22, 1, 0.36, 1] }}
						className="flex flex-wrap items-center justify-center gap-8 md:gap-14"
					>
						{[
							{ value: `${delayHours}h`, label: "delay threshold" },
							{ value: `$${payoffStr}`, label: "fixed payout" },
							{ value: "Auto", label: "settlement" },
							{ value: "100%", label: "collateralised" },
						].map(({ value, label }) => (
							<div key={label} className="text-center">
								<p className="stat-value text-2xl text-foreground">{value}</p>
								<p className="stat-label mt-1">{label}</p>
							</div>
						))}
					</motion.div>
				</div>
			</section>

			{/* ─── Architecture Diagram (How It Works) ─── */}
			<section className="px-4 sm:px-6 lg:px-8 py-24">
				<div className="max-w-6xl mx-auto">
					<h2 className="text-3xl font-bold text-center text-foreground tracking-tight mb-2">
						Protocol Flow
					</h2>
					<p className="text-muted-foreground text-center mb-12 text-sm">
						USDC flows through smart contracts — no intermediaries
					</p>

					{/* Architecture SVG */}
					<div className="rounded-2xl border border-border bg-card/60 backdrop-blur-sm shadow-lg shadow-black/10 p-6 md:p-10 overflow-x-auto">
						<svg
							viewBox="0 0 900 200"
							className="w-full min-w-[600px] h-auto"
							xmlns="http://www.w3.org/2000/svg"
						>
							{/* Node: Traveler */}
							<g>
								<rect
									x="20" y="70" width="120" height="60" rx="12"
									fill="var(--muted)"
									stroke="var(--primary)"
									strokeWidth="1.5"
								/>
								<text x="80" y="97" textAnchor="middle" fill="var(--primary)" fontSize="13" fontWeight="600">
									Traveler
								</text>
								<text x="80" y="117" textAnchor="middle" fill="var(--muted-foreground)" fontSize="10">
									Buys policy
								</text>
							</g>

							{/* Arrow: Traveler → Pool */}
							<line
								x1="140" y1="100" x2="280" y2="100"
								stroke="var(--highlight)"
								strokeWidth="1.5" strokeDasharray="6 4"
								style={{ animation: "dash-flow 1s linear infinite" }}
							/>
							<text x="210" y="90" textAnchor="middle" fill="var(--highlight)" fontSize="10" fontWeight="500">
								Premium
							</text>
							<circle
								r="3" fill="var(--highlight)"
								style={{
									offsetPath: `path("M 140 100 L 280 100")`,
									animation: "dot-flow 2s linear infinite",
									filter: `drop-shadow(0 0 4px var(--highlight))`,
								}}
							/>

							{/* Node: Pool */}
							<g style={{ animation: "float 4s ease-in-out infinite" }}>
								<rect
									x="280" y="55" width="140" height="90" rx="16"
									fill="var(--primary)"
									stroke="var(--primary)"
									strokeWidth="2"
									style={{ animation: "glow-pulse 3s ease-in-out infinite" }}
								/>
								<text x="350" y="92" textAnchor="middle" fill="var(--primary-foreground)" fontSize="14" fontWeight="700">
									Flight Pool
								</text>
								<text x="350" y="112" textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize="10">
									Smart Contract
								</text>
							</g>

							{/* Upper branch: On-time → Vault */}
							<path
								d="M 420 80 Q 500 30, 580 45" fill="none"
								stroke="var(--success)" strokeWidth="1.5" strokeDasharray="6 4"
								style={{ animation: "dash-flow 1.2s linear infinite" }}
							/>
							<text x="500" y="35" textAnchor="middle" fill="var(--success)" fontSize="10" fontWeight="500">
								On-time
							</text>
							<circle
								r="3" fill="var(--success)"
								style={{
									offsetPath: `path("M 420 80 Q 500 30, 580 45")`,
									animation: "dot-flow 2.5s linear 0.5s infinite",
									filter: "drop-shadow(0 0 4px var(--success))",
								}}
							/>

							{/* Node: Vault */}
							<g>
								<rect
									x="580" y="20" width="130" height="55" rx="12"
									fill="var(--muted)"
									stroke="var(--success)"
									strokeWidth="1.5"
								/>
								<text x="645" y="44" textAnchor="middle" fill="var(--success)" fontSize="13" fontWeight="600">
									Risk Vault
								</text>
								<text x="645" y="62" textAnchor="middle" fill="var(--muted-foreground)" fontSize="10">
									Yield for LPs
								</text>
							</g>

							{/* Lower branch: Delayed → Payout */}
							<path
								d="M 420 120 Q 500 175, 580 160" fill="none"
								stroke="var(--warning)" strokeWidth="1.5" strokeDasharray="6 4"
								style={{ animation: "dash-flow 1.2s linear infinite" }}
							/>
							<text x="500" y="175" textAnchor="middle" fill="var(--warning)" fontSize="10" fontWeight="500">
								Delayed
							</text>
							<circle
								r="3" fill="var(--warning)"
								style={{
									offsetPath: `path("M 420 120 Q 500 175, 580 160")`,
									animation: "dot-flow 2.5s linear 1s infinite",
									filter: "drop-shadow(0 0 4px var(--warning))",
								}}
							/>

							{/* Node: Payout */}
							<g>
								<rect
									x="580" y="132" width="130" height="55" rx="12"
									fill="var(--muted)"
									stroke="var(--warning)"
									strokeWidth="1.5"
								/>
								<text x="645" y="156" textAnchor="middle" fill="var(--warning)" fontSize="13" fontWeight="600">
									Payout
								</text>
								<text x="645" y="174" textAnchor="middle" fill="var(--muted-foreground)" fontSize="10">
									Auto to traveler
								</text>
							</g>
						</svg>
					</div>
				</div>
			</section>

			{/* ─── How It Works — Step Cards ─── */}
			<section className="px-4 sm:px-6 lg:px-8 pb-24">
				<div className="max-w-6xl mx-auto">
					<h2 className="text-3xl font-bold text-center text-foreground tracking-tight mb-12">
						How It Works
					</h2>

					<div className="grid md:grid-cols-3 gap-8 stagger-children">
						{[
							{
								step: "1",
								title: "Pick a Flight",
								description:
									"Enter your flight number and departure date. We check real-time schedules via oracle.",
								icon: (
									<svg viewBox="0 0 48 48" className="w-12 h-12" fill="none" xmlns="http://www.w3.org/2000/svg">
										<circle cx="24" cy="24" r="22" stroke="var(--primary)" strokeWidth="1.5" opacity="0.3" />
										<path d="M14 32 L24 16 L34 32 Z" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
										<circle cx="24" cy="26" r="2" fill="var(--primary)" />
									</svg>
								),
							},
							{
								step: "2",
								title: "Pay Premium",
								description:
									"Pay a small USDC premium directly from your Stellar wallet. Instant, no paperwork.",
								icon: (
									<svg viewBox="0 0 48 48" className="w-12 h-12" fill="none" xmlns="http://www.w3.org/2000/svg">
										<circle cx="24" cy="24" r="22" stroke="var(--highlight)" strokeWidth="1.5" opacity="0.3" />
										<circle cx="24" cy="24" r="10" stroke="var(--highlight)" strokeWidth="2" />
										<text x="24" y="29" textAnchor="middle" fill="var(--highlight)" fontSize="14" fontWeight="700">$</text>
									</svg>
								),
							},
							{
								step: "3",
								title: "Get Paid if Delayed",
								description:
									"Oracle confirms the delay, smart contract pays you automatically. No claims needed.",
								icon: (
									<svg viewBox="0 0 48 48" className="w-12 h-12" fill="none" xmlns="http://www.w3.org/2000/svg">
										<circle cx="24" cy="24" r="22" stroke="var(--success)" strokeWidth="1.5" opacity="0.3" />
										<path d="M16 24 L22 30 L34 18" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
									</svg>
								),
							},
						].map(({ step, title, description, icon }) => (
							<div
								key={step}
								className="group relative rounded-xl border border-border bg-card/80 backdrop-blur-sm shadow-lg shadow-black/5 p-8 text-center transition-colors duration-300 hover:border-primary/40"
							>
								<div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center shadow-lg">
									{step}
								</div>
								<div className="flex justify-center mb-5 mt-2">{icon}</div>
								<h3 className="text-lg font-semibold text-foreground mb-3 tracking-tight">
									{title}
								</h3>
								<p className="text-sm text-muted-foreground leading-relaxed">
									{description}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			{/* ─── Testimonials ─── */}
			<TestimonialsSection />

			{/* ─── Bottom CTA ─── */}
			<section className="px-4 sm:px-6 lg:px-8 pb-24">
				<div className="max-w-2xl mx-auto text-center">
					<p className="text-muted-foreground mb-8 text-sm">
						Built on Stellar &middot; Powered by Soroban smart contracts
						&middot; USDC settlements
					</p>
					<div className="flex flex-col sm:flex-row items-center justify-center gap-4">
						<Link
							to="/buy"
							className="rounded-[1.15rem] px-8 py-4 shimmer-cta text-primary-foreground font-semibold transition-all duration-300"
						>
							Buy Insurance
						</Link>
						<Link
							to="/vault"
							className="rounded-[1.15rem] px-8 py-4 border border-border bg-background/50 backdrop-blur-sm text-foreground font-semibold hover:bg-accent hover:text-accent-foreground transition-all duration-300"
						>
							Deposit to Vault
						</Link>
					</div>
				</div>
			</section>
		</div>
	)
}

export default Landing
