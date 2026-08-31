import { lazy, Suspense, type ReactNode } from "react"
import { Link, Navigate, Route, Routes } from "react-router-dom"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { PageMeta } from "./components/PageMeta"
import { TopBar } from "./components/TopBar"
import { FlightBackground } from "./components/FlightBackground"
import { ThemeDock } from "./components/ThemeToggle"
import { ActivityLog } from "./components/ActivityLog"
import { Tour } from "./components/Tour"
import { AgreementGate, useAgreementAccepted } from "./components/AgreementGate"
import { useTheme } from "./providers/ThemeProvider"
import { useWallet } from "./hooks/useWallet"
import { stellarNetwork } from "./contracts/util"
import { useCopy } from "./copy"
import { BRIDGE_URL, GITHUB_URL, STELLAR_URL, X_URL } from "./config/links"
import Markets from "./pages/Markets"
import Policies from "./pages/Policies"
import PolicyDetail from "./pages/PolicyDetail"
import House from "./pages/House"
import Status from "./pages/Status"
import Keepers from "./pages/Keepers"
import Seatbelters from "./pages/Seatbelters"
import Settings from "./pages/Settings"
import Information from "./pages/Information"
import { Disclaimers, Privacy, Terms } from "./pages/Legal"

// Heavy pages load on first navigation, not with the landing page:
// the globe carries d3-geo + the world-atlas topology, the calculator its
// Monte Carlo engine, and /admin is the only consumer of supabase-js.
const MarketsGlobe = lazy(() => import("./pages/MarketsGlobe"))
const Quant = lazy(() => import("./pages/Quant"))
const Admin = lazy(() => import("./pages/Admin"))

/** A route's page element plus its hoisted <title>/description. */
function withMeta(page: ReactNode, title?: string, description?: string) {
	return (
		<>
			<PageMeta title={title} description={description} />
			{page}
		</>
	)
}

function PageLoading() {
	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<p className="font-display text-fine tracking-[0.1em] text-mute uppercase">
				LOADING…
			</p>
		</div>
	)
}

/**
 * Warn when the connected wallet is on a different Stellar network than
 * the one this app signs for. Signing is ALSO blocked while the flag is
 * up (buttons disabled + a guard in useTxFlow). The flag only ever
 * trips when the wallet's network is positively known to differ — an
 * unknown/unreported network never blocks — so a bad comparison cannot
 * lock a user out of a working app.
 */
function NetworkMismatchBanner() {
	const { networkMismatch } = useWallet()
	const t = useCopy()
	if (!networkMismatch) return null
	return (
		<div
			role="alert"
			data-testid="network-mismatch-banner"
			className="relative z-20 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center font-body text-meta text-amber-200"
		>
			{t.wallet.mismatchBanner(stellarNetwork)}
		</div>
	)
}

export default function App() {
	const { theme } = useTheme()
	// The sticky chrome (activity drawer, tour invite) stays hidden until
	// the agreement notice is accepted — nothing competes with the gate.
	const agreed = useAgreementAccepted()
	return (
		<div className="app-shell flex min-h-screen flex-col">
			{/* Serious mode: smooth canvas flight-paths behind everything.
			    Fun mode keeps the CSS pixel starfield (body background). */}
			{theme === "serious" && <FlightBackground />}

			<TopBar />
			<NetworkMismatchBanner />
			<main className="relative z-10 flex-1">
				{/* Boundary OUTSIDE Suspense: a failed lazy import() (stale
				    deploy, chunk hash changed) rejects through Suspense and
				    lands here as a reload prompt instead of a white screen. */}
				<ErrorBoundary>
					<Suspense fallback={<PageLoading />}>
						<Routes>
						<Route
							path="/"
							element={withMeta(
								<Markets />,
								undefined,
								"Parametric flight delay insurance, played like a market. Insure your flight. Get paid if it's late.",
							)}
						/>
						<Route
							path="/markets"
							element={withMeta(
								<MarketsGlobe />,
								"Live Flight Map",
								"A live global map of insured flights — watch departures, delays, and payouts play out across the board.",
							)}
						/>
						<Route
							path="/policies"
							element={withMeta(
								<Policies />,
								"My Policies",
								"Your flight delay policies: premiums staked, claim windows, and payouts — the full record, on-chain.",
							)}
						/>
						{/* deep-linkable per-policy lifecycle record */}
						<Route
							path="/policy/:id"
							element={withMeta(
								<PolicyDetail />,
								"Policy Record",
								"The complete on-chain lifecycle of one flight delay policy: purchase, flight outcome, settlement, and claim.",
							)}
						/>
						<Route
							path="/earn"
							element={withMeta(
								<House />,
								"Earn",
								"Deposit USDC into the risk vault that underwrites flight delay insurance and earn premiums as yield.",
							)}
						/>
						{/* legacy alias — /house is live in the wild (nav, docs,
						    the soak harness), so keep the URL resolving. */}
						<Route path="/house" element={<Navigate to="/earn" replace />} />
						<Route
							path="/calculator"
							element={withMeta(
								<Quant />,
								"Premium Calculator",
								"Explore how flight delay premiums are priced — run Monte Carlo simulations over route, delay threshold, and payout.",
							)}
						/>
						{/* legacy alias */}
						<Route
							path="/quant"
							element={withMeta(
								<Quant />,
								"Premium Calculator",
								"Explore how flight delay premiums are priced — run Monte Carlo simulations over route, delay threshold, and payout.",
							)}
						/>
						<Route
							path="/privacy"
							element={withMeta(
								<Privacy />,
								"Privacy Policy",
								"What data Flights.Fun does and does not collect, and what lives on the public Stellar ledger.",
							)}
						/>
						<Route
							path="/terms"
							element={withMeta(
								<Terms />,
								"Terms of Service",
								"The terms governing use of the Flights.Fun parametric flight delay insurance interface.",
							)}
						/>
						<Route
							path="/disclaimers"
							element={withMeta(
								<Disclaimers />,
								"Disclaimers",
								"Risk disclosures for using early-stage, on-chain parametric flight insurance software.",
							)}
						/>
						<Route
							path="/status"
							element={withMeta(
								<Status />,
								"Protocol Status",
								"Live protocol health: oracle, classification, settlement, and governance job runs.",
							)}
						/>
						{/* main-nav trophy icon — the travelers' leaderboard */}
						<Route
							path="/seatbelters"
							element={withMeta(
								<Seatbelters />,
								"Seatbelters",
								"The Seatbelters leaderboard — top flight-delay cover buyers, ranked by premiums staked.",
							)}
						/>
						{/* hamburger-menu page — the run-a-keeper front door */}
						<Route
							path="/keepers"
							element={withMeta(
								<Keepers />,
								"Run a Keeper",
								"What keepers do — classifying flights and settling policies — and how to run one yourself.",
							)}
						/>
						<Route
							path="/settings"
							element={withMeta(<Settings />, "Settings")}
						/>
						<Route
							path="/information"
							element={withMeta(
								<Information />,
								"How It Works",
								"How parametric flight delay insurance works on Stellar — cover, oracle attestation, and automatic payouts.",
							)}
						/>
						{/* hidden — not linked from any nav; ops only */}
						<Route path="/admin" element={withMeta(<Admin />, "Admin")} />
						<Route
							path="*"
							element={withMeta(
								<Markets />,
								undefined,
								"Parametric flight delay insurance, played like a market. Insure your flight. Get paid if it's late.",
							)}
						/>
					</Routes>
					</Suspense>
				</ErrorBoundary>
			</main>

			<SiteFooter />

			{/* Serious / Fun switch — floats bottom-left, always reachable. */}
			<ThemeDock />

			{/* Activity log — collapsible drawer, docks above the MODE dock. */}
			{agreed && <ActivityLog />}

			{/* First-visit onboarding — invite card bottom-right, guided tour.
			    Mounts only after the agreement, so the welcome card makes its
			    first-visit appearance right after acceptance. */}
			{agreed && <Tour />}

			{/* First-visit agreement notice — blocking modal on the board and
			    vault pages (z-50). */}
			<AgreementGate />
		</div>
	)
}

/** © line — "Soroban" links out to stellar.org; shared by both footer skins. */
function FooterCopyright() {
	const t = useCopy()
	const year = new Date().getFullYear()
	return (
		<p className="font-body text-meta text-mute">
			© {year} {t.brand.name} ·{" "}
			<a
				href={STELLAR_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="footer-link"
			>
				Soroban
			</a>{" "}
			testnet · {t.footer.left}
		</p>
	)
}

/** Privacy · Terms · Status · GitHub · X — shared by both footer skins. */
function FooterLinks({ className }: { className?: string }) {
	return (
		<div className={className}>
			<Link to="/privacy" className="footer-link">
				Privacy
			</Link>
			<span aria-hidden="true" className="text-mute/50">
				·
			</span>
			<Link to="/terms" className="footer-link">
				Terms
			</Link>
			<span aria-hidden="true" className="text-mute/50">
				·
			</span>
			<Link to="/disclaimers" className="footer-link">
				Disclaimers
			</Link>
			<span aria-hidden="true" className="text-mute/50">
				·
			</span>
			<Link to="/status" className="footer-link">
				Status
			</Link>
			<span aria-hidden="true" className="text-mute/50">
				·
			</span>
			<a
				href={GITHUB_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="footer-link"
			>
				GitHub
			</a>
			<span aria-hidden="true" className="text-mute/50">
				·
			</span>
			<a
				href={BRIDGE_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="footer-link"
				aria-label="Bridge USDC to Stellar via Allbridge (mainnet)"
			>
				Bridge
			</a>
			<span aria-hidden="true" className="text-mute/50">
				·
			</span>
			<a
				href={X_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="footer-link"
				aria-label="Sentinel on X"
			>
				X
			</a>
		</div>
	)
}

function SiteFooter() {
	const { theme } = useTheme()
	const t = useCopy()

	if (theme === "serious") {
		return (
			<footer className="relative z-10 mt-16 overflow-hidden border-t border-line/60">
				{/* wrap + a later breakpoint: at sm the three columns overflowed
				    rather than wrapping, pushing the whole page sideways */}
				<div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-center lg:flex-row lg:items-center lg:justify-between lg:text-left">
					<FooterCopyright />
					<FooterLinks className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-body text-meta whitespace-nowrap" />
					<p className="font-body text-fine text-mute">{t.footer.right}</p>
				</div>
			</footer>
		)
	}

	return (
		<footer className="relative z-10 mt-16 overflow-hidden border-t-2 border-line">
			{/* Two rows, not three columns. Press Start 2P is ~1em per glyph,
			    so the 42-character link run needs ~460px of type plus ~144px
			    of gap — it never fit beside two paragraphs at any width below
			    ~1500px, and silently reflowed to two or three ragged lines. */}
			<div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4">
				<FooterLinks className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-display text-[9px] tracking-[0.06em] whitespace-nowrap uppercase" />
				<div className="flex flex-col items-center justify-between gap-2 text-center md:flex-row md:text-left">
					<FooterCopyright />
					<p className="font-body text-fine tracking-[0.1em] text-mute">
						{t.footer.right}
					</p>
				</div>
			</div>
			{/* Oversized wordmark, flush to the bottom edge and bleeding just
			    past it. 8.4vw x 11 glyphs is ~92vw of type, which tips over
			    the viewport once the scrollbar gutter is taken out — clamp it
			    so it stays inside at every width, and hide it on narrow
			    screens where it dominates the whole footer. */}
			<p
				aria-hidden="true"
				className="pointer-events-none -mb-[0.8vw] hidden max-w-full select-none overflow-hidden text-center font-display leading-none whitespace-nowrap text-raised sm:block"
				style={{ fontSize: "clamp(28px, 7.6vw, 150px)" }}
			>
				FLIGHTS.FUN
			</p>
		</footer>
	)
}
