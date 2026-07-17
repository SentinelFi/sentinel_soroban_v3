import { useState, useEffect } from "react"
import { Routes, Route, Outlet, NavLink, Link, Navigate } from "react-router-dom"
import { ShieldCheck, ShoppingCart, FileText, Plane, Landmark } from "lucide-react"
import ConnectAccount from "./components/ConnectAccount"
import { AdminGate } from "./components/AdminGate"
import { FlightBackground } from "./components/FlightBackground"
import { ThemeToggle } from "./components/ThemeToggle"
import Admin from "./pages/Admin"
import BuyInsurance from "./pages/BuyInsurance"
import FlightMarkets from "./pages/FlightMarkets"
import Landing from "./pages/Landing"
import MyPolicies from "./pages/MyPolicies"
import Vault from "./pages/Vault"
import Crons from "./pages/Crons"
import Faucet from "./pages/Faucet"
import Privacy from "./pages/Privacy"
import Terms from "./pages/Terms"

function App() {
	return (
		<Routes>
			{/* Landing page — no navbar */}
			<Route element={<LandingLayout />}>
				<Route path="/" element={<Landing />} />
			</Route>

			{/* All other pages — with navbar */}
			<Route element={<AppLayout />}>
				<Route path="/buy" element={<BuyInsurance />} />
				<Route path="/policies" element={<MyPolicies />} />
				<Route path="/flights" element={<FlightMarkets />} />
				<Route path="/vault" element={<Vault />} />
				<Route path="/privacy" element={<Privacy />} />
				<Route path="/terms" element={<Terms />} />

				{/* Hidden operator section — password-gated, never linked from the UI */}
				<Route element={<AdminSection />}>
					<Route path="/admin" element={<Admin />} />
					<Route path="/admin/crons" element={<Crons />} />
					<Route path="/admin/faucet" element={<Faucet />} />
				</Route>

				{/* Unknown routes → home */}
				<Route path="*" element={<Navigate to="/" replace />} />
			</Route>
		</Routes>
	)
}

/* ─── Admin Section (password gate + sub-nav) ─── */

const ADMIN_TABS = [
	{ to: "/admin", label: "Protocol", end: true },
	{ to: "/admin/crons", label: "Crons", end: false },
	{ to: "/admin/faucet", label: "Faucet", end: false },
]

const AdminSection: React.FC = () => (
	<AdminGate>
		<nav className="flex items-center gap-1 mb-6 border-b border-border/60 pb-3">
			{ADMIN_TABS.map(({ to, label, end }) => (
				<NavLink
					key={to}
					to={to}
					end={end}
					className={({ isActive }) =>
						`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
							isActive
								? "bg-accent text-foreground"
								: "text-muted-foreground hover:text-foreground hover:bg-accent/60"
						}`
					}
				>
					{label}
				</NavLink>
			))}
		</nav>
		<Outlet />
	</AdminGate>
)

/* ─── Landing Layout (no navbar) ─── */

const LandingLayout: React.FC = () => (
	<div className="sentinel-bg min-h-screen bg-background text-foreground flex flex-col">
		<FlightBackground />

		{/* Theme toggle — fixed top-right */}
		<div className="fixed top-4 right-4 z-50">
			<ThemeToggle />
		</div>

		<main className="relative z-10 flex-1">
			<Outlet />
		</main>

		<SiteFooter />
	</div>
)

/* ─── App Layout (with navbar) ─── */

const NAV_ITEMS = [
	{ to: "/buy", label: "Buy Insurance", icon: ShoppingCart },
	{ to: "/policies", label: "My Policies", icon: FileText },
	{ to: "/flights", label: "Flights", icon: Plane },
	{ to: "/vault", label: "Vault", icon: Landmark },
]

const AppLayout: React.FC = () => {
	const [scrolled, setScrolled] = useState(false)

	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 10)
		window.addEventListener("scroll", onScroll, { passive: true })
		return () => window.removeEventListener("scroll", onScroll)
	}, [])

	return (
		<div className="sentinel-bg min-h-screen bg-background text-foreground flex flex-col">
			<FlightBackground />

			{/* Header */}
			<header
				className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
					scrolled
						? "bg-background/85 backdrop-blur-xl border-b border-border/60 shadow-lg shadow-black/20"
						: "bg-background/50 backdrop-blur-md"
				}`}
			>
				<div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
					<Link
						to="/"
						className="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
					>
						<ShieldCheck
							className="h-6 w-6 group-hover:scale-110 transition-transform"
							style={{ animation: "logo-glow 3s ease-in-out infinite" }}
						/>
						<span className="hidden sm:inline text-sm font-semibold tracking-wide uppercase">
							Sentinel Protocol
						</span>
					</Link>

					<nav className="flex items-center gap-1">
						{NAV_ITEMS.map(({ to, label, icon: Icon }) => (
							<NavLink
								key={to}
								to={to}
								className={({ isActive }) =>
									`relative px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
										isActive
											? "text-foreground"
											: "text-muted-foreground hover:text-foreground hover:bg-accent"
									}`
								}
							>
								{({ isActive }) => (
									<>
										<Icon className="h-4 w-4" />
										<span className="hidden md:inline">{label}</span>
										{isActive && (
											<span className="absolute bottom-0 left-2 right-2 h-0.5 bg-gradient-to-r from-primary to-highlight rounded-full" />
										)}
									</>
								)}
							</NavLink>
						))}
					</nav>

					<div className="flex items-center gap-2">
						<ThemeToggle />
						<ConnectAccount />
					</div>
				</div>
			</header>

			{/* Main content */}
			<main className="relative z-10 flex-1 pt-16">
				<div className="max-w-7xl mx-auto px-4 py-8">
					<Outlet />
				</div>
			</main>

			<AppFooter />
		</div>
	)
}

/* ─── App Footer (compact) ─── */

const AppFooter: React.FC = () => (
	<footer className="relative z-10 border-t border-border/30">
		<div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between text-xs text-muted-foreground/50">
			<span className="uppercase tracking-widest text-[10px]" title="Independent software, not affiliated with the Stellar Development Foundation. Early-stage testnet software.">&copy; 2026 Sentinel Protocol</span>
			<div className="flex items-center gap-4">
				<Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
				<Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
				<a
					href="https://github.com/SentinelFi"
					target="_blank"
					rel="noopener noreferrer"
					className="hover:text-foreground transition-colors"
				>
					GitHub
				</a>
			</div>
		</div>
	</footer>
)

/* ─── Site Footer ─── */

const SiteFooter: React.FC = () => (
	<footer className="relative z-10 border-t border-border">
		<div className="max-w-7xl mx-auto px-4 py-10">
			<div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
				{/* Brand */}
				<div>
					<Link to="/" className="flex items-center gap-2 text-primary font-semibold mb-3">
						<ShieldCheck className="h-5 w-5" />
						Sentinel Protocol
					</Link>
					<p className="text-sm text-muted-foreground leading-relaxed">
						Parametric flight delay insurance on Stellar. Pay premium in USDC, get payoff if delayed.
					</p>
					<a
						href="https://github.com/SentinelFi"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-block mt-3 text-muted-foreground hover:text-foreground transition-colors"
					>
						<svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
							<path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
						</svg>
					</a>
				</div>

				{/* Product */}
				<div>
					<h3 className="text-sm font-semibold text-foreground mb-3">Product</h3>
					<ul className="space-y-2">
						<li><Link to="/buy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Buy Insurance</Link></li>
						<li><Link to="/vault" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Earn Yield</Link></li>
						<li><Link to="/policies" className="text-sm text-muted-foreground hover:text-foreground transition-colors">My Policies</Link></li>
					</ul>
				</div>

				{/* Legal */}
				<div>
					<h3 className="text-sm font-semibold text-foreground mb-3">Legal</h3>
					<ul className="space-y-2">
						<li><Link to="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Privacy Policy</Link></li>
						<li><Link to="/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Terms of Service</Link></li>
					</ul>
				</div>
			</div>
		</div>

		{/* Copyright + legal notices */}
		<div className="border-t border-border">
			<div className="max-w-7xl mx-auto px-4 py-5 space-y-2">
				<p className="text-center text-xs text-muted-foreground">
					&copy; 2026 Sentinel Protocol. Built on Stellar.
				</p>
				<p className="text-center text-[11px] leading-relaxed text-muted-foreground/70 max-w-2xl mx-auto">
					Independent software, not affiliated with, sponsored, or endorsed
					by the Stellar Development Foundation. Early-stage software on
					testnet; it may contain bugs. Please report issues on{" "}
					<a
						href="https://github.com/SentinelFi"
						target="_blank"
						rel="noopener noreferrer"
						className="underline decoration-border underline-offset-2 hover:text-foreground transition-colors"
					>
						GitHub
					</a>
					.
				</p>
			</div>
		</div>
	</footer>
)

export default App
