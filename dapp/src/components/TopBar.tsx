import { useState } from "react"
import { NavLink } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import {
	formatUsdc,
	mockUsdcClient,
	useContractSync,
	useUsdcBalance,
} from "../hooks/useContracts"
import { connectWallet, disconnectWallet } from "../util/wallet"
import { cn, txHashOf } from "../lib/utils"
import { useCopy } from "../copy"

const NAV = [
	{ to: "/", key: "markets" },
	{ to: "/markets", key: "globe" },
	{ to: "/bets", key: "policies" },
	{ to: "/house", key: "yield" },
] as const

/** Split a brand name at its last dot so the suffix (".FUN") can carry the accent. */
function splitBrand(name: string): [string, string] {
	const i = name.lastIndexOf(".")
	return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""]
}

function shortAddr(addr: string) {
	return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

/** USDC balance chip with inline testnet faucet mint (+10,000 mock USDC). */
function CoinChip() {
	const { address, signTransaction } = useWallet()
	const { addNotification } = useNotification()
	const queryClient = useQueryClient()
	const { data: usdcBalance } = useUsdcBalance(address)
	const [minting, setMinting] = useState(false)

	if (!address) return null

	const mint = async () => {
		if (minting) return
		setMinting(true)
		try {
			const tx = await mockUsdcClient.faucet({ to: address })
			const sent = await tx.signAndSend({ signTransaction })
			await queryClient.invalidateQueries({ queryKey: ["usdc"] })
			addNotification("+10,000 USDC minted to your wallet", "success", {
				txHash: txHashOf(sent),
			})
		} catch {
			addNotification("Mint failed — try again", "error")
		} finally {
			setMinting(false)
		}
	}

	return (
		<div className="hidden items-center gap-2 border-2 border-line bg-raised px-3 py-1.5 sm:flex">
			<span className="font-body text-[12px] font-bold text-gold">$</span>
			<span className="board-figure text-[18px] text-ink">
				{usdcBalance != null ? formatUsdc(usdcBalance) : "…"}
			</span>
			<span className="label-px">USDC</span>
			<button
				type="button"
				onClick={() => void mint()}
				disabled={minting}
				className="ml-1 border-l-2 border-line pl-2 font-body text-[11px] font-bold tracking-[0.06em] text-win hover:text-ink disabled:opacity-50"
				title="Mint 10,000 test USDC"
			>
				{minting ? "MINTING…" : "+MINT"}
			</button>
		</div>
	)
}

export function TopBar() {
	const { address } = useWallet()
	useContractSync()
	const t = useCopy()
	const [brandHead, brandTail] = splitBrand(t.brand.name)

	return (
		<header className="topbar sticky top-0 z-20 border-b-2 border-line bg-page">
			<div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
				{/* logo block */}
				<NavLink to="/" className="flex items-center gap-3">
					<span className="floaty font-display text-[16px] text-gold">
						✈
					</span>
					<span className="flex flex-col">
						<span className="font-display text-[13px] leading-none text-ink">
							{brandHead}
							<span className="text-gold">{brandTail}</span>
						</span>
						<span className="brand-tagline mt-1 font-body text-[10px] font-semibold tracking-[0.14em] text-sky">
							{t.brand.tagline}
						</span>
					</span>
				</NavLink>

				{/* nav */}
				<nav className="ml-6 hidden items-center gap-1 md:flex">
					{NAV.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							end={item.to === "/"}
							className={({ isActive }) =>
								cn(
									"nav-link px-3 py-2 font-display text-[10px] tracking-[0.04em]",
									isActive
										? "bg-gold text-page"
										: "text-dim hover:bg-raised hover:text-ink",
								)
							}
						>
							{t.nav[item.key]}
						</NavLink>
					))}
				</nav>

				<div className="ml-auto flex items-center gap-3">
					<CoinChip />
					{address ? (
						<button
							type="button"
							onClick={() => void disconnectWallet()}
							className="btn-px btn-ghost btn-sm"
							title="Disconnect"
						>
							{shortAddr(address)} ✕
						</button>
					) : (
						<button
							type="button"
							onClick={() => void connectWallet()}
							className="btn-px btn-gold btn-sm"
						>
							{t.wallet.connect}
						</button>
					)}
				</div>
			</div>

			{/* mobile nav */}
			<nav className="flex items-center justify-center gap-1 border-t-2 border-line px-4 py-2 md:hidden">
				{NAV.map((item) => (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.to === "/"}
						className={({ isActive }) =>
							cn(
								"nav-link whitespace-nowrap px-3 py-1.5 font-display text-[10px]",
								isActive
									? "bg-gold text-page"
									: "text-dim hover:text-ink",
							)
						}
					>
						{t.nav[item.key]}
					</NavLink>
				))}
			</nav>
		</header>
	)
}
