import { Route, Routes } from "react-router-dom"
import { TopBar } from "./components/TopBar"
import Markets from "./pages/Markets"
import MyBets from "./pages/MyBets"
import House from "./pages/House"
import Calculator from "./pages/Calculator"

export default function App() {
	return (
		<div className="flex min-h-screen flex-col">
			<TopBar />
			<main className="flex-1">
				<Routes>
					<Route path="/" element={<Markets />} />
					<Route path="/bets" element={<MyBets />} />
					<Route path="/house" element={<House />} />
					<Route path="/calculator" element={<Calculator />} />
					<Route path="*" element={<Markets />} />
				</Routes>
			</main>

			<footer className="relative mt-16 overflow-hidden border-t-2 border-line">
				<div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
					<p className="font-body text-[13px] text-mute">
						Soroban testnet · same contracts, different game.
					</p>
					<p className="font-body text-[11px] tracking-[0.1em] text-mute">
						NOT FINANCIAL ADVICE. IT'S INSURANCE, BUT FUN.
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
		</div>
	)
}
