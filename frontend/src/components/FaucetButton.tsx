import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { mockUsdcClient } from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"

/**
 * Inline testnet faucet — mints 10,000 mock USDC to the connected wallet
 * via the permissionless `faucet` entry point. Rendered next to balance
 * displays so testers can fund themselves without leaving the flow.
 */
export function FaucetButton({ className }: { className?: string }) {
	const { address, signTransaction } = useWallet()
	const queryClient = useQueryClient()
	const [state, setState] = useState<"idle" | "minting" | "done" | "error">(
		"idle",
	)

	if (!address) return null

	const mint = async () => {
		setState("minting")
		try {
			const tx = await mockUsdcClient.faucet({ to: address })
			await tx.signAndSend({ signTransaction })
			await queryClient.invalidateQueries({ queryKey: ["usdc"] })
			setState("done")
			setTimeout(() => setState("idle"), 4000)
		} catch {
			setState("error")
			setTimeout(() => setState("idle"), 4000)
		}
	}

	const label =
		state === "minting"
			? "Minting…"
			: state === "done"
				? "+10,000 USDC"
				: state === "error"
					? "Mint failed"
					: "Get test USDC"

	return (
		<button
			type="button"
			onClick={mint}
			disabled={state === "minting"}
			className={
				className ??
				"ml-auto text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer disabled:opacity-50"
			}
		>
			{label}
		</button>
	)
}
