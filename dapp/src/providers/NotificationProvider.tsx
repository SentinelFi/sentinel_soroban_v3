/**
 * Toast notifications + activity log.
 *
 * API (backwards-compatible):
 *   addNotification(message, type)                       — original signature
 *   addNotification(message, type, { txHash })           — attaches a
 *       Stellar.expert explorer link to the toast + log entry.
 *
 * Behaviour:
 *   - success/info/warning toasts auto-dismiss (~5s)
 *   - error toasts are STICKY (stay until closed) so users can read/copy them
 *   - a bounded history buffer (~50) backs the Activity Log drawer
 *
 * Themed rendering lives in CSS: FUN = pixel panel (hard border, CRT),
 * SERIOUS = clean rounded drawer with soft shadow.
 */

import React, {
	createContext,
	useCallback,
	useMemo,
	useState,
	type ReactNode,
} from "react"
import { explorerTxUrl } from "../lib/explorer"

type NotificationType =
	| "primary"
	| "secondary"
	| "success"
	| "error"
	| "warning"

interface NotifyOptions {
	/** Transaction hash — renders a "View on Stellar.expert" link. */
	txHash?: string
}

interface Notification {
	id: string
	message: string
	type: NotificationType
	txHash?: string
	/** epoch ms, for the activity log timestamp */
	at: number
}

interface NotificationContextType {
	/** Fire a toast. Optional `opts.txHash` attaches an explorer link. */
	addNotification: (
		message: string,
		type: NotificationType,
		opts?: NotifyOptions,
	) => void
	/** Bounded history (most-recent-first) for the Activity Log drawer. */
	history: Notification[]
	clearHistory: () => void
}

const NotificationContext = createContext<NotificationContextType | undefined>(
	undefined,
)

const TYPE_STYLE: Record<NotificationType, { border: string; label: string }> =
	{
		primary: { border: "var(--color-sky)", label: "INFO" },
		secondary: { border: "var(--color-blip)", label: "INFO" },
		success: { border: "var(--color-win)", label: "NICE!" },
		error: { border: "var(--color-loss)", label: "OOPS" },
		warning: { border: "var(--color-gold)", label: "HEADS UP" },
	}

const AUTO_DISMISS_MS = 5000
const HISTORY_LIMIT = 50

// Re-exported for existing importers; the implementation derives the
// explorer network from the app's configured Stellar network.
export { explorerTxUrl }

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({
	children,
}) => {
	// live toasts on screen
	const [toasts, setToasts] = useState<Notification[]>([])
	// bounded history (most-recent-first) — backs the Activity Log
	const [history, setHistory] = useState<Notification[]>([])

	const dismiss = useCallback((id: string) => {
		setToasts((prev) => prev.filter((n) => n.id !== id))
	}, [])

	const addNotification = useCallback(
		(message: string, type: NotificationType, opts?: NotifyOptions) => {
			const id = `${type}-${Date.now().toString()}-${Math.random().toString(36).slice(2, 6)}`
			const entry: Notification = {
				id,
				message,
				type,
				txHash: opts?.txHash,
				at: Date.now(),
			}
			setToasts((prev) => [...prev, entry])
			setHistory((prev) => [entry, ...prev].slice(0, HISTORY_LIMIT))
			// Errors are sticky — users need time to read/copy them.
			if (type !== "error") {
				setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
			}
		},
		[dismiss],
	)

	const clearHistory = useCallback(() => setHistory([]), [])

	const contextValue = useMemo(
		() => ({ addNotification, history, clearHistory }),
		[addNotification, history, clearHistory],
	)

	return (
		<NotificationContext value={contextValue}>
			{children}
			<div className="toast-stack">
				{toasts.map((n) => {
					const style = TYPE_STYLE[n.type]
					const sticky = n.type === "error"
					return (
						<div
							key={n.id}
							className="toast-px"
							style={{ borderColor: style.border }}
							role={sticky ? "alert" : "status"}
						>
							<div className="toast-row">
								<span
									className="label-px toast-tag"
									style={{ color: style.border }}
								>
									{style.label}
								</span>
								<span className="toast-msg">{n.message}</span>
								{sticky && (
									<button
										type="button"
										className="toast-close"
										aria-label="Dismiss"
										onClick={() => dismiss(n.id)}
									>
										✕
									</button>
								)}
							</div>
							{n.txHash && (
								<a
									className="toast-link"
									href={explorerTxUrl(n.txHash)}
									target="_blank"
									rel="noopener noreferrer"
								>
									View on Stellar.expert ↗
								</a>
							)}
						</div>
					)
				})}
			</div>
		</NotificationContext>
	)
}

export { NotificationContext }
export type { NotificationContextType, NotificationType, Notification }
