import { Link, Route, Routes } from "react-router-dom"
import { TopBar } from "./components/TopBar"
import { FlightBackground } from "./components/FlightBackground"
import { ThemeDock } from "./components/ThemeToggle"
import { ActivityLog } from "./components/ActivityLog"
import { useTheme } from "./providers/ThemeProvider"
import { useCopy } from "./copy"
import Markets from "./pages/Markets"
import MarketsGlobe from "./pages/MarketsGlobe"
import MyBets from "./pages/MyBets"
import House from "./pages/House"
import Quant from "./pages/Quant"
import Admin from "./pages/Admin"
import { Privacy, Terms } from "./pages/Legal"

const GITHUB_URL = "https://github.com/SentinelFi"

export default function App() {
	const { theme } = useTheme()
	return (
		<div className="app-shell flex min-h-screen flex-col">
			{/* Serious mode: smooth canvas flight-paths behind everything.
			    Fun mode keeps the CSS pixel starfield (body background). */}
			{theme === "serious" && <FlightBackground />}

			<TopBar />
			<main className="relative z-10 flex-1">
				<Routes>
					<Route path="/" element={<Markets />} />
					<Route path="/markets" element={<MarketsGlobe />} />
					<Route path="/bets" element={<MyBets />} />
					<Route path="/house" element={<House />} />
					<Route path="/calculator" element={<Quant />} />
					{/* legacy alias */}
					<Route path="/quant" element={<Quant />} />
					<Route path="/privacy" element={<Privacy />} />
					<Route path="/terms" element={<Terms />} />
					{/* hidden — not linked from any nav; ops only */}
					<Route path="/admin" element={<Admin />} />
					<Route path="*" element={<Markets />} />
				</Routes>
			</main>

			<SiteFooter />

			{/* Serious / Fun switch — floats bottom-left, always reachable. */}
			<ThemeDock />

			{/* Activity log — collapsible drawer, docks above the MODE dock. */}
			<ActivityLog />
		</div>
	)
}

/** Privacy · Terms · GitHub — shared by both footer skins. */
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
			<a
				href={GITHUB_URL}
				target="_blank"
				rel="noopener noreferrer"
				className="footer-link"
			>
				GitHub
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
					<p className="font-body text-[13px] text-mute">{t.footer.left}</p>
					<FooterLinks className="flex items-center justify-center gap-3 font-body text-[13px]" />
					<p className="font-body text-[12px] text-mute">{t.footer.right}</p>
				</div>
			</footer>
		)
	}

	return (
		<footer className="relative z-10 mt-16 overflow-hidden border-t-2 border-line">
			<div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-4 sm:flex-row">
				<p className="font-body text-[13px] text-mute">{t.footer.left}</p>
				<FooterLinks className="flex items-center gap-3 font-display text-[9px] tracking-[0.06em] uppercase" />
				<p className="font-body text-[11px] tracking-[0.1em] text-mute">
					{t.footer.right}
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
