import { useEffect, useRef, useState } from "react"
import { useNotification } from "../hooks/useNotification"
import { useWallet } from "../hooks/useWallet"
import { explorerTxUrl } from "../providers/NotificationProvider"
import type { NotificationType } from "../providers/NotificationProvider"
import { useTheme } from "../providers/ThemeProvider"
import { useCopy } from "../copy"

/**
 * Collapsible Activity Log drawer. A small tab docks bottom-left (above the
 * MODE dock); clicking it slides up a panel listing recent notifications with
 * their kind, time, message, and explorer link (when a tx hash was captured).
 *
 * Genuinely different per theme:
 *   FUN     = pixel panel — hard border, step shadow, CRT scanlines
 *   SERIOUS = clean rounded drawer with a soft directional shadow
 */

const KIND_DOT: Record<NotificationType, string> = {
	success: "var(--color-win)",
	error: "var(--color-loss)",
	warning: "var(--color-gold)",
	primary: "var(--color-sky)",
	secondary: "var(--color-blip)",
}

function shortAddr(addr: string) {
	return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

/**
 * Log wallet connect / disconnect into the activity feed. Watching the
 * address transition (rather than the connect/disconnect buttons) also
 * catches session restores on load, account switches, and the provider
 * signing the user out after a wallet error.
 */
function useWalletActivity() {
	const { address } = useWallet()
	const { addNotification } = useNotification()
	const t = useCopy()
	const prevAddress = useRef<string | undefined>(undefined)

	useEffect(() => {
		const prev = prevAddress.current
		if (prev === address) return
		prevAddress.current = address
		if (address) {
			addNotification(t.wallet.connected(shortAddr(address)), "success")
		} else if (prev) {
			addNotification(t.wallet.disconnected(shortAddr(prev)), "warning")
		}
	}, [address, addNotification, t])
}

function timeAgo(at: number): string {
	const s = Math.max(0, Math.round((Date.now() - at) / 1000))
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	return `${h}h ago`
}

export function ActivityLog() {
	const { history, clearHistory } = useNotification()
	const { theme } = useTheme()
	const serious = theme === "serious"
	const [open, setOpen] = useState(false)
	useWalletActivity()

	return (
		<div className="activity-dock" data-open={open}>
			<button
				type="button"
				className="activity-tab"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="activity-tab-glyph" aria-hidden="true">
					{serious ? "≣" : "▤"}
				</span>
				<span className="activity-tab-label">
					{serious ? "Activity" : "ACTIVITY"}
				</span>
				{history.length > 0 && (
					<span className="activity-count">{history.length}</span>
				)}
			</button>

			{open && (
				<div className="activity-panel" role="region" aria-label="Activity log">
					<div className="activity-panel-head">
						<span className="activity-panel-title">
							{serious ? "Activity Log" : "ACTIVITY LOG"}
						</span>
						{history.length > 0 && (
							<button
								type="button"
								className="activity-clear"
								onClick={clearHistory}
							>
								{serious ? "Clear" : "CLEAR"}
							</button>
						)}
					</div>

					{!serious && <div className="scanlines activity-scan" />}

					<div className="activity-list">
						{history.length === 0 ? (
							<p className="activity-empty">
								{serious
									? "No activity yet."
									: "NO ACTIVITY YET — MAKE A MOVE"}
							</p>
						) : (
							history.map((n) => (
								<div key={n.id} className="activity-item">
									<span
										className="activity-item-dot"
										style={{ background: KIND_DOT[n.type] }}
										aria-hidden="true"
									/>
									<div className="activity-item-body">
										<p className="activity-item-msg">{n.message}</p>
										<div className="activity-item-meta">
											<span className="activity-item-time">
												{timeAgo(n.at)}
											</span>
											{n.txHash && (
												<a
													className="activity-item-link"
													href={explorerTxUrl(n.txHash)}
													target="_blank"
													rel="noopener noreferrer"
												>
													Stellar.expert ↗
												</a>
											)}
										</div>
									</div>
								</div>
							))
						)}
					</div>
				</div>
			)}
		</div>
	)
}
