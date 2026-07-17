import React, { useState } from "react"
import { useWallet } from "../hooks/useWallet"
import { useContractSync } from "../hooks/useContracts"
import mockUsdcClient from "../contracts/mock_usdc"
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Button } from "../components/ui/button"

const Faucet: React.FC = () => {
	const { address, signTransaction } = useWallet()
	useContractSync()

	const [faucetTarget, setFaucetTarget] = useState("")
	const [minting, setMinting] = useState(false)
	const [faucetMsg, setFaucetMsg] = useState("")

	const handleFaucet = () => {
		if (!address || !signTransaction) return
		const target = faucetTarget.trim() || address
		setMinting(true)
		setFaucetMsg("")
		void (async () => {
			try {
				const tx = await mockUsdcClient.faucet({ to: target })
				await tx.signAndSend({ signTransaction })
				setFaucetMsg(`Minted 10,000 USDC to ${target.slice(0, 8)}...`)
			} catch (err) {
				console.error("Faucet failed:", err)
				setFaucetMsg("Mint failed — check the recipient address and try again.")
			} finally {
				setMinting(false)
			}
		})()
	}

	return (
		<div className="mx-auto max-w-3xl">
			<h1 className="mb-2 text-3xl font-bold text-foreground">Test USDC Faucet</h1>
			<p className="mb-8 text-muted-foreground">
				Mint test USDC on the Stellar testnet for development and testing.
			</p>

			{!address && (
				<div className="mb-6 rounded-xl border border-warning bg-card p-4 text-sm text-warning">
					Connect your wallet to mint test USDC.
				</div>
			)}

			<Card className="mb-6">
				<CardHeader>
					<CardTitle className="text-lg">Mint USDC</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="mb-3 text-sm text-muted-foreground">
						Mint 10,000 test USDC to any address. Leave blank to mint to your connected wallet.
					</p>
					<div className="flex gap-3">
						<Input
							type="text"
							value={faucetTarget}
							onChange={(e) => setFaucetTarget(e.target.value)}
							placeholder={address || "Recipient address (G...)"}
							className="flex-1"
						/>
						<Button
							onClick={handleFaucet}
							disabled={!address || minting}
							className="whitespace-nowrap bg-success text-success-foreground hover:bg-success/80"
						>
							{minting ? "Minting..." : "Mint 10,000 USDC"}
						</Button>
					</div>
					{faucetMsg && (
						<p className={`mt-3 text-sm ${faucetMsg.includes("failed") ? "text-destructive" : "text-success"}`}>
							{faucetMsg}
						</p>
					)}
				</CardContent>
			</Card>
		</div>
	)
}

export default Faucet
