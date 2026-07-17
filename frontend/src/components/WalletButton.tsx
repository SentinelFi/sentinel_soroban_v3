import { Button, Icon, Profile } from "@stellar/design-system"
import { useState, useEffect, useCallback, useRef } from "react"
import { useWallet } from "../hooks/useWallet"
import { connectWallet, disconnectWallet } from "../util/wallet"
import mockUsdcClient from "../contracts/mock_usdc"

export const WalletButton = () => {
	const [showDropdown, setShowDropdown] = useState(false)
	const { address, isPending, balances } = useWallet()
	const [usdcBalance, setUsdcBalance] = useState<string | null>(null)
	const dropdownRef = useRef<HTMLDivElement>(null)
	const buttonLabel = isPending ? "Loading..." : "Connect Wallet"

	const fetchUsdcBalance = useCallback(async () => {
		if (!address) {
			setUsdcBalance(null)
			return
		}
		try {
			const result = await mockUsdcClient.balance({ account: address })
			const raw = BigInt(result.result.toString())
			const formatted = new Intl.NumberFormat().format(Number(raw / 10_000_000n))
			setUsdcBalance(formatted)
		} catch (err) {
			console.warn("USDC balance fetch failed:", err)
			setUsdcBalance(null)
		}
	}, [address])

	useEffect(() => {
		void fetchUsdcBalance()
		const interval = setInterval(() => void fetchUsdcBalance(), 5_000)
		return () => clearInterval(interval)
	}, [fetchUsdcBalance])

	// Close dropdown on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setShowDropdown(false)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [])

	if (!address) {
		return (
			<Button
				variant="secondary"
				size="md"
				onClick={() => void connectWallet()}
			>
				<Icon.Wallet02 />
				{buttonLabel}
			</Button>
		)
	}

	const xlmBal = balances?.xlm?.balance ?? "-"

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				gap: "5px",
				opacity: isPending ? 0.6 : 1,
			}}
		>
			{/* Profile + dropdown wrapper */}
			<div ref={dropdownRef} style={{ position: "relative" }}>
				<div
					style={{ cursor: "pointer" }}
					onClick={() => setShowDropdown((v) => !v)}
				>
					<Profile
						publicAddress={address}
						size="md"
						isShort
					/>
				</div>

				{showDropdown && (
					<div
						style={{
							position: "absolute",
							top: "calc(100% + 8px)",
							right: 0,
							minWidth: "200px",
							background: "var(--card, #0f172a)",
							border: "1px solid var(--border, #1e293b)",
							borderRadius: "10px",
							padding: "12px 16px",
							zIndex: 200,
							boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
						}}
					>
						<div style={{
							fontSize: "11px",
							fontWeight: 600,
							textTransform: "uppercase",
							letterSpacing: "0.08em",
							color: "var(--muted-foreground, #64748b)",
							marginBottom: "10px",
						}}>
							Balance
						</div>

						<div style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							marginBottom: "8px",
						}}>
							<span style={{ fontSize: "14px", color: "var(--muted-foreground, #94a3b8)" }}>XLM</span>
							<span style={{ fontSize: "14px", fontWeight: 600, color: "var(--foreground, #e2e8f0)" }}>{xlmBal}</span>
						</div>

						<div style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							marginBottom: "12px",
						}}>
							<span style={{ fontSize: "14px", color: "var(--muted-foreground, #94a3b8)" }}>USDC</span>
							<span style={{ fontSize: "14px", fontWeight: 600, color: "var(--foreground, #e2e8f0)" }}>{usdcBalance ?? "-"}</span>
						</div>

						<div style={{
							borderTop: "1px solid var(--border, #1e293b)",
							paddingTop: "8px",
						}}>
							<button
								onClick={() => {
									setShowDropdown(false)
									void disconnectWallet()
								}}
								style={{
									background: "none",
									border: "none",
									color: "var(--destructive, #ef4444)",
									fontSize: "13px",
									cursor: "pointer",
									padding: 0,
									fontWeight: 500,
								}}
							>
								Disconnect
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}
