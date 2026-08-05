/**
 * Contract error code → what actually went wrong, in a sentence a traveller
 * or underwriter can act on.
 *
 * The generated bindings already export an `Errors` map per package, but it
 * only carries the Rust variant NAME ("InsufficientVaultCapital"), which is
 * not something to show a user. This table adds the missing half: what the
 * failure means and what, if anything, they can do about it.
 *
 * Codes are namespaced by contract in the Rust source (3xx controller,
 * 4xx flight pool manager, 5xx governance, 6xx oracle, 7xx risk vault), so
 * one flat map is unambiguous. Anything absent falls through to a generic
 * message that still shows the number.
 */

export interface ContractErrorInfo {
	/** What happened, in plain language. */
	message: string
	/** What the user can do next. Omitted when there is genuinely nothing. */
	action?: string
	/** True when waiting or retrying could plausibly succeed. */
	transient?: boolean
}

export const CONTRACT_ERRORS: Record<number, ContractErrorInfo> = {
	// ── Controller (3xx) ────────────────────────────────────────────────
	306: {
		message: "This wallet isn't on the buyer allowlist.",
		action: "The allowlist is admin-managed — ask an operator to add your address.",
	},
	307: {
		message: "This route has been paused.",
		action: "Pausing is automatic and temporary — try another route, or check back shortly.",
		transient: true,
	},
	308: {
		message: "This route isn't offered.",
		action: "Pick a route from the board.",
	},
	309: {
		message: "This flight departs too soon to insure.",
		action: "Cover closes 24 hours before departure. Choose a later date.",
	},
	310: {
		message: "That departure is too far ahead to insure yet.",
		action: "Choose a nearer date.",
	},
	311: {
		message: "This flight already has a recorded outcome, so cover is closed.",
		action: "Pick a different flight or date.",
	},
	312: {
		message: "The vault doesn't have enough free capital to back this policy right now.",
		action: "Every policy is fully collateralized at purchase, so cover pauses when the vault is fully committed. Try again once an underwriter deposits or existing policies settle.",
		transient: true,
	},
	313: {
		message: "That flight date isn't valid.",
		action: "Pick the date again from the calendar.",
	},
	315: {
		message: "Flight data is temporarily unavailable for this route.",
		action: "Try again in a few minutes.",
		transient: true,
	},
	319: {
		message: "The sale window for this flight isn't open.",
		action: "Cover is authorized per flight at purchase time. Reopen the slip to retry, or pick another flight.",
		transient: true,
	},
	320: {
		message: "This flight's terms no longer pass the protocol's limits.",
		action: "Pick another flight — an operator has to re-price this one.",
	},

	// ── Flight pool manager (4xx) ───────────────────────────────────────
	405: { message: "This flight is no longer accepting policies." },
	410: {
		message: "The terms changed while you were buying.",
		action: "Reopen the slip to load the current price and try again.",
		transient: true,
	},
	411: {
		message: "You already hold a policy for this flight and date.",
		action: "One policy per flight per wallet. Check My Bets.",
	},

	// ── Risk vault (7xx) ────────────────────────────────────────────────
	702: { message: "Only the controller can perform that action." },
	704: {
		message: "That deposit would exceed the vault's managed limit.",
		action: "Try a smaller amount.",
	},
}

/** Human sentence for a contract error code, or null if we don't know it. */
export function describeContractError(code: number): string | null {
	const info = CONTRACT_ERRORS[code]
	if (!info) return null
	return info.action ? `${info.message} ${info.action}` : info.message
}
