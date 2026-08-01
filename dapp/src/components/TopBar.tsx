import { useEffect, useRef, useState } from "react"
import { NavLink } from "react-router-dom"
import { useWallet } from "../hooks/useWallet"
import { useNotification } from "../hooks/useNotification"
import { formatUsdc, mockUsdcClient, useUsdcBalance } from "../hooks/useContracts"
import { useTxFlow } from "../hooks/useTxFlow"
import { connectWallet, disconnectWallet } from "../util/wallet"
import { stellarNetwork } from "../contracts/util"
import { cn, txHashOf } from "../lib/utils"
import { useCopy } from "../copy"
import { useTheme } from "../providers/ThemeProvider"
import { PixelArt } from "./PixelArt"
import { SchemeToggle } from "./ThemeToggle"

const NAV = [
	{ to: "/", key: "markets" },
	{ to: "/markets", key: "globe" },
	{ to: "/policies", key: "policies" },
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

/** Connected-wallet chip: opens a small menu with copy-address / disconnect. */
function WalletMenu({ address }: { address: string }) {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)
	const { addNotification } = useNotification()
	const t = useCopy()

	// close on outside click / Escape
	useEffect(() => {
		if (!open) return
		const onPointer = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false)
		}
		document.addEventListener("mousedown", onPointer)
		document.addEventListener("keydown", onKey)
		return () => {
			document.removeEventListener("mousedown", onPointer)
			document.removeEventListener("keydown", onKey)
		}
	}, [open])

	const copyAddress = async () => {
		setOpen(false)
		try {
			await navigator.clipboard.writeText(address)
			addNotification(t.wallet.copied, "success")
		} catch {
			addNotification(t.wallet.copyFailed, "error")
		}
	}

	const disconnect = () => {
		setOpen(false)
		void disconnectWallet()
	}

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t.wallet.menuAria}
				onClick={() => setOpen((o) => !o)}
				className="btn-px btn-ghost btn-sm"
			>
				{shortAddr(address)} ▾
			</button>
			{open && (
				<div
					role="menu"
					className="panel-raised absolute right-0 top-full z-30 mt-2 min-w-[11rem] p-1"
				>
					<button
						role="menuitem"
						type="button"
						onClick={() => void copyAddress()}
						className="block w-full px-3 py-2 text-left font-body text-[12px] font-semibold text-dim hover:bg-raised hover:text-ink"
					>
						{t.wallet.copyAddress}
					</button>
					<button
						role="menuitem"
						type="button"
						onClick={disconnect}
						className="block w-full px-3 py-2 text-left font-body text-[12px] font-semibold text-dim hover:bg-raised hover:text-loss"
					>
						{t.wallet.disconnect}
					</button>
				</div>
			)}
		</div>
	)
}

/** USDC balance chip with inline testnet faucet mint (+10,000 mock USDC). */
function CoinChip() {
	const { address, signTransaction, networkMismatch } = useWallet()
	const { data: usdcBalance } = useUsdcBalance(address)
	const { theme } = useTheme()
	const t = useCopy()
	const mintFlow = useTxFlow({
		invalidateKeys: [["usdc"]],
		errorFallback: t.notify.mintFailed,
		notifyError: true,
	})
	const minting =
		mintFlow.state === "awaiting" || mintFlow.state === "confirming"

	if (!address) return null

	const mint = () =>
		mintFlow.run(async (step) => {
			step("awaiting")
			const tx = await mockUsdcClient.faucet({ to: address })
			step("confirming")
			const sent = await tx.signAndSend({ signTransaction })
			return { message: t.notify.mintSuccess, txHash: txHashOf(sent) }
		})

	return (
		// hidden again on md–lg: with the inline nav there the chip is what
		// pushes the single-row bar past the viewport
		<div className="hidden items-center gap-2 border-2 border-line bg-raised px-3 py-1.5 sm:flex md:hidden lg:flex">
			{theme === "fun" ? (
				<PixelArt
					key={usdcBalance?.toString() ?? "loading"}
					name="coin-usdc"
					className="coin-flip h-4 w-4"
				/>
			) : (
				<span className="font-body text-[12px] font-bold text-gold">$</span>
			)}
			<span className="board-figure text-[18px] text-ink">
				{usdcBalance != null ? formatUsdc(usdcBalance) : "…"}
			</span>
			<span className="label-px">USDC</span>
			{/* faucet is a test-token affordance — never rendered against
			    a mainnet deployment (mock USDC does not exist there) */}
			{stellarNetwork !== "PUBLIC" && (
				<button
					type="button"
					onClick={() => void mint()}
					disabled={minting || networkMismatch}
					className="ml-1 border-l-2 border-line px-2 font-body text-[11px] font-bold tracking-[0.06em] text-win hover:text-ink disabled:opacity-50"
					title="Mint 10,000 test USDC"
				>
					{minting ? "MINTING…" : "+MINT"}
				</button>
			)}
		</div>
	)
}

export function TopBar() {
	const { address } = useWallet()
	const t = useCopy()
	const [brandHead, brandTail] = splitBrand(t.brand.name)

	return (
		<header className="topbar sticky top-0 z-20 border-b-2 border-line bg-page">
			{/* phones may wrap the wallet group to its own line; from md up the
		    bar stays a single row — squeezed items wrap their own text
		    ("MY POLICIES" → two lines) instead of breaking the row */}
		<div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 md:flex-nowrap">
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

				{/* nav — multi-word labels ("MY POLICIES") wrap to two centered
				    lines when squeezed, keeping the whole bar on one row */}
				<nav className="ml-6 hidden items-center gap-1 md:flex">
					{NAV.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							end={item.to === "/"}
							className={({ isActive }) =>
								cn(
									"nav-link px-3 py-2 text-center font-display text-[10px] leading-[1.6] tracking-[0.04em]",
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
					<SchemeToggle />
					<CoinChip />
					{address ? (
						<WalletMenu address={address} />
					) : (
						<button
							type="button"
							onClick={() => void connectWallet()}
							className="btn-px btn-gold btn-sm whitespace-normal text-center lg:whitespace-nowrap"
						>
							{t.wallet.connect}
						</button>
					)}
				</div>
			</div>

			{/* mobile nav */}
			<nav className="flex flex-wrap items-center justify-center gap-1 border-t-2 border-line px-4 py-2 md:hidden">
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
