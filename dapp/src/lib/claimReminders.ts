/**
 * Claim-expiry reminders — helpers for the live countdown on claimable
 * policy cards plus opt-in browser notifications, so a traveler learns a
 * payout is about to vanish even when they aren't staring at the page.
 *
 * Ground rules:
 *  - strictly opt-in: the page offers a "remind me" button while
 *    permission is undecided; there is never an unsolicited prompt;
 *  - at most one notification per policy per local calendar day (plus
 *    the OS-level `tag` dedupe), so an open tab can't nag;
 *  - display-only: the backend expired-claim sweeper is unaffected.
 */

const NOTIFIED_KEY = "flightsfun_claim_notified"

/** "3d 4h" / "4h 12m" / "12m" — or "" once the instant has passed. */
export function timeLeft(expirySecs: number, nowMs = Date.now()): string {
	const secs = expirySecs - Math.floor(nowMs / 1000)
	if (secs <= 0) return ""
	const d = Math.floor(secs / 86_400)
	const h = Math.floor((secs % 86_400) / 3600)
	const m = Math.floor((secs % 3600) / 60)
	if (d > 0) return `${d}d ${h}h`
	if (h > 0) return `${h}h ${m}m`
	return `${Math.max(m, 1)}m`
}

export function notificationPermission(): NotificationPermission | "unsupported" {
	return typeof Notification === "undefined" ? "unsupported" : Notification.permission
}

/** Permission-gated OS notification; no-op when unsupported/ungranted. */
export function showAlert(title: string, body: string, tag: string): void {
	if (notificationPermission() !== "granted") return
	try {
		const n = new Notification(title, {
			body,
			icon: "/favicon.png",
			tag,
		})
		n.onclick = () => window.focus()
	} catch {
		/* some browsers only allow construction from a service worker */
	}
}

export interface ClaimReminder {
	/** stable policy id — the dedupe key */
	id: string
	title: string
	body: string
}

/**
 * Show a browser notification for each reminder not already shown today.
 * Safe to call on every render pass: permission and the per-day ledger
 * make repeat calls free. The ledger is pruned to the ids passed in, so
 * claimed/expired policies stop occupying storage.
 */
export function notifyClaims(reminders: ClaimReminder[]): void {
	if (notificationPermission() !== "granted") return

	let ledger: Record<string, string> = {}
	try {
		ledger = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}") as Record<string, string>
	} catch {
		/* corrupted ledger → start fresh; worst case one extra nudge */
	}

	const today = new Date().toDateString()
	const next: Record<string, string> = {}
	for (const r of reminders) {
		const last = ledger[r.id]
		next[r.id] = today
		if (last === today) continue
		try {
			const n = new Notification(r.title, {
				body: r.body,
				icon: "/favicon.png",
				tag: `flightsfun-claim-${r.id}`,
			})
			n.onclick = () => window.focus()
		} catch {
			/* some browsers only allow construction from a service worker */
		}
	}

	try {
		localStorage.setItem(NOTIFIED_KEY, JSON.stringify(next))
	} catch {
		/* can't persist — the OS tag still suppresses duplicates */
	}
}
