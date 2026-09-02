import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { txHashOf } from "../lib/utils"
import { humanizeTxError } from "../lib/errors"
import { useNotification } from "./useNotification"
import { useWallet } from "./useWallet"
import { stellarNetwork } from "../contracts/util"
import type { TxState } from "../types"

/**
 * Wrap the wallet's signTransaction so the flow state flips to
 * "awaiting" (CHECK WALLET…) at the moment the wallet is actually
 * invoked and to "confirming" once the signature returns — instead of
 * labeling the RPC build/simulate step as the wallet step. Callers use
 * step("verifying") for the build/simulate phase:
 *
 *   step("verifying")
 *   const tx = await client.method({ ... })
 *   const sent = await tx.signAndSend({
 *     signTransaction: stagedSigner(step, signTransaction),
 *   })
 */
export function stagedSigner<A extends unknown[], R>(
	step: (s: TxState) => void,
	sign: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args: A) => {
		step("awaiting")
		const result = await sign(...args)
		step("confirming")
		return result
	}
}

/**
 * The one chain-write state machine. Every signing flow (buy cover,
 * deposit, queue/cancel withdrawal, collect, claim, mint) used to
 * hand-roll the same guard → step states → signAndSend → invalidate →
 * toast → timed reset sequence, with uncleared setTimeouts and drifting
 * error handling. This hook owns that sequence once:
 *
 *   const flow = useTxFlow({ invalidateKeys: [["vault"], ["usdc"]] })
 *   ...
 *   flow.run(async (step) => {
 *     step("awaiting")
 *     const tx = await client.method({ ... })
 *     step("confirming")
 *     const sent = await tx.signAndSend({ signTransaction })
 *     return { message: t.notify.done, txHash: txHashOf(sent) }
 *   })
 *
 * - re-entry is guarded (run() is a no-op unless idle)
 * - success: toast (with explorer link when the callback returns a
 *   txHash), invalidate the given query-key prefixes, hold "success"
 *   for resetDelayMs, then reset and call onSettled (slip close, etc.)
 * - failure: flow.error carries the formatted message for the stepper,
 *   optional error toast, timed reset
 * - all timers are cleared on unmount, so no late setState/onSettled
 */
interface TxFlowOptions {
	/** Query-key prefixes to invalidate after a successful send. */
	invalidateKeys?: ReadonlyArray<readonly string[]>
	/** Fallback message when a caught error has no usable message. */
	errorFallback?: string
	/** Also toast the error (sticky), not just show it in the stepper. */
	notifyError?: boolean
	/** How long "success" is displayed before resetting (default 1500). */
	resetDelayMs?: number
	/** How long "error" is displayed before resetting (default 3000). */
	errorResetDelayMs?: number
	/** Runs when the flow leaves "success"/"error" back to idle. */
	onSettled?: (outcome: "success" | "error") => void
}

export interface TxFlowResult {
	/** Success-toast message; omit to skip the toast. */
	message?: string
	/** Attaches a block-explorer link to the toast. */
	txHash?: string
}

export function useTxFlow(options: TxFlowOptions = {}) {
	const {
		invalidateKeys = [],
		errorFallback,
		notifyError = false,
		resetDelayMs = 1500,
		errorResetDelayMs = 3000,
		onSettled,
	} = options
	const [state, setState] = useState<TxState>("idle")
	const [error, setError] = useState<string | null>(null)
	const stateRef = useRef<TxState>("idle")
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const queryClient = useQueryClient()
	const { addNotification } = useNotification()
	// Defense in depth behind the disabled buttons: refuse to start any
	// signing flow while the wallet positively reports a different
	// network than the one this app builds transactions for. Wallets
	// that never report a network (anything beyond Freighter/HOT) can't
	// trip that check, so their failures get a network hint appended.
	const { networkMismatch, networkPassphrase } = useWallet()
	const networkMismatchRef = useRef(networkMismatch)
	networkMismatchRef.current = networkMismatch
	const networkUnverifiedRef = useRef(!networkPassphrase)
	networkUnverifiedRef.current = !networkPassphrase

	// Options are captured in a ref so run() stays referentially stable
	// even when callers pass inline arrays/handlers.
	const optsRef = useRef({
		invalidateKeys,
		errorFallback,
		notifyError,
		resetDelayMs,
		errorResetDelayMs,
		onSettled,
	})
	optsRef.current = {
		invalidateKeys,
		errorFallback,
		notifyError,
		resetDelayMs,
		errorResetDelayMs,
		onSettled,
	}

	useEffect(() => () => clearTimeout(timerRef.current), [])

	const transition = useCallback((s: TxState) => {
		stateRef.current = s
		setState(s)
	}, [])

	const run = useCallback(
		async (
			fn: (step: (s: TxState) => void) => Promise<TxFlowResult | void>,
		): Promise<boolean> => {
			if (stateRef.current !== "idle") return false
			if (networkMismatchRef.current) {
				const message = `Your wallet is on a different network than this app (${stellarNetwork}). Switch networks before signing.`
				setError(message)
				transition("error")
				addNotification(message, "error")
				timerRef.current = setTimeout(() => {
					transition("idle")
				}, optsRef.current.errorResetDelayMs)
				return false
			}
			setError(null)
			try {
				const result = await fn(transition)
				transition("success")
				// App-level listeners (the alerts permission prompt, the
				// event watcher's self-action suppression) hear every
				// successful signing flow without each caller wiring it.
				window.dispatchEvent(new CustomEvent("flightsfun:tx-success"))
				if (result?.message) {
					addNotification(result.message, "success", {
						txHash: result.txHash,
					})
				}
				for (const key of optsRef.current.invalidateKeys) {
					void queryClient.invalidateQueries({ queryKey: [...key] })
				}
				timerRef.current = setTimeout(() => {
					transition("idle")
					optsRef.current.onSettled?.("success")
				}, optsRef.current.resetDelayMs)
				return true
			} catch (err) {
				console.error("Transaction failed:", err)
				let message = humanizeTxError(err, optsRef.current.errorFallback)
				// A declined signature is the user's own action — no hint
				// needed. Everything else on a non-reporting wallet might
				// really be a wrong-network failure in disguise.
				if (
					networkUnverifiedRef.current &&
					!message.startsWith("Signature request was declined")
				) {
					message += ` (Tip: this wallet doesn't report its network — check that it's on ${stellarNetwork}.)`
				}
				setError(message)
				transition("error")
				if (optsRef.current.notifyError) {
					addNotification(message, "error")
				}
				timerRef.current = setTimeout(() => {
					transition("idle")
					optsRef.current.onSettled?.("error")
				}, optsRef.current.errorResetDelayMs)
				return false
			}
		},
		[addNotification, queryClient, transition],
	)

	return { state, error, run }
}

export { txHashOf }
