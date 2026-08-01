import { lazy, Suspense } from "react"
import { Link, Route, Routes } from "react-router-dom"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { TopBar } from "./components/TopBar"
import { FlightBackground } from "./components/FlightBackground"
import { ThemeDock } from "./components/ThemeToggle"
import { ActivityLog } from "./components/ActivityLog"
import { useTheme } from "./providers/ThemeProvider"
import { useWallet } from "./hooks/useWallet"
import { stellarNetwork } from "./contracts/util"
import { useCopy } from "./copy"
import { DOCS_URL, GITHUB_URL, STELLAR_URL, X_URL } from "./config/links"
import Markets from "./pages/Markets"
import Policies from "./pages/Policies"
import House from "./pages/House"
import Status from "./pages/Status"
import { Privacy, Terms } from "./pages/Legal"

// Heavy pages load on first navigation, not with the landing page:
// the globe carries d3-geo + the world-atlas topology, the calculator its
// Monte Carlo engine, and /admin is the only consumer of supabase-js.
const MarketsGlobe = lazy(() => import("./pages/MarketsGlobe"))
const Quant = lazy(() => import("./pages/Quant"))
const Admin = lazy(() => import("./pages/Admin"))

function PageLoading() {
	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<p className="font-display text-[11px] tracking-[0.1em] text-mute uppercase">
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
	if (!networkMismatch) return null
	return (
		<div
			role="alert"
			className="relative z-20 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center font-body text-[13px] text-amber-200"
		>
			Your wallet is on a different network than this app (
			{stellarNetwork}). Switch your wallet to {stellarNetwork} before
			signing.
		</div>
	)
}

export default function App() {
	const { theme } = useTheme()
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
						<Route path="/" element={<Markets />} />
						<Route path="/markets" element={<MarketsGlobe />} />
						<Route path="/policies" element={<Policies />} />
						<Route path="/house" element={<House />} />
						<Route path="/calculator" element={<Quant />} />
						{/* legacy alias */}
						<Route path="/quant" element={<Quant />} />
						<Route path="/privacy" element={<Privacy />} />
						<Route path="/terms" element={<Terms />} />
						<Route path="/status" element={<Status />} />
						{/* hidden — not linked from any nav; ops only */}
						<Route path="/admin" element={<Admin />} />
						<Route path="*" element={<Markets />} />
					</Routes>
					</Suspense>
				</ErrorBoundary>
			</main>

			<SiteFooter />

			{/* Serious / Fun switch — floats bottom-left, always reachable. */}
			<ThemeDock />

			{/* Activity log — collapsible drawer, docks above the MODE dock. */}
			<ActivityLog />
		</div>
	)
}

/** © line — "Soroban" links out to stellar.org; shared by both footer skins. */
function FooterCopyright() {
	const t = useCopy()
	const year = new Date().getFullYear()
	return (
		<p className="font-body text-[13px] text-mute">
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
			<footer className="relative z-10 mt-16 border-t border-line/60">
				<div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-center sm:flex-row sm:items-center sm:justify-between sm:text-left">
					<FooterCopyright />
					<FooterLinks className="flex items-center justify-center gap-3 font-body text-[13px]" />
					<p className="font-body text-[12px] text-mute">
						{t.footer.right}{" "}
						<span aria-hidden="true" className="text-mute/50">
							·
						</span>{" "}
						<a
							href={DOCS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="footer-link"
						>
							Docs
						</a>
					</p>
				</div>
			</footer>
		)
	}

	return (
		<footer className="relative z-10 mt-16 overflow-hidden border-t-2 border-line">
			{/* pixel type is wide — stay stacked until lg or the row overflows */}
			<div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-4 text-center lg:flex-row lg:text-left">
				<FooterCopyright />
				<FooterLinks className="flex flex-wrap items-center justify-center gap-3 font-display text-[9px] tracking-[0.06em] uppercase" />
				<p className="font-body text-[11px] tracking-[0.1em] text-mute">
					{t.footer.right}{" "}
					<span aria-hidden="true" className="text-mute/50">
						·
					</span>{" "}
					<a
						href={DOCS_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="footer-link"
					>
						DOCS
					</a>
				</p>
			</div>
			{/* oversized wordmark: whole across the width, flush to the
			    bottom edge and bleeding slightly off it — only there */}
			<p
				aria-hidden="true"
				className="pointer-events-none -mb-[0.8vw] select-none text-center font-display text-[8.4vw] leading-none whitespace-nowrap text-raised"
			>
				FLIGHTS.FUN
			</p>
		</footer>
	)
}
