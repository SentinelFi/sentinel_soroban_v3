/**
 * Pixel-styled toast notifications.
 * Same context API as frontend/src/providers/NotificationProvider.tsx
 * (`addNotification(message, type)`) but rendered with arcade panels
 * instead of @stellar/design-system — that dependency is dropped here.
 */

import React, {
	createContext,
	useCallback,
	useMemo,
	useState,
	type ReactNode,
} from "react"

type NotificationType =
	| "primary"
	| "secondary"
	| "success"
	| "error"
	| "warning"

interface Notification {
	id: string
	message: string
	type: NotificationType
}

interface NotificationContextType {
	addNotification: (message: string, type: NotificationType) => void
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
		warning: { border: "var(--color-gold)", label: "HEY!" },
	}

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({
	children,
}) => {
	const [notifications, setNotifications] = useState<Notification[]>([])

	const addNotification = useCallback(
		(message: string, type: NotificationType) => {
			const id = `${type}-${Date.now().toString()}-${Math.random().toString(36).slice(2, 6)}`
			setNotifications((prev) => [...prev, { id, message, type }])
			setTimeout(() => {
				setNotifications((prev) => prev.filter((n) => n.id !== id))
			}, 5000)
		},
		[],
	)

	const contextValue = useMemo(() => ({ addNotification }), [addNotification])

	return (
		<NotificationContext value={contextValue}>
			{children}
			<div className="toast-stack">
				{notifications.map((n) => {
					const style = TYPE_STYLE[n.type]
					return (
						<div
							key={n.id}
							className="toast-px"
							style={{ borderColor: style.border }}
							role="status"
						>
							<span
								className="label-px mr-2"
								style={{ color: style.border }}
							>
								{style.label}
							</span>
							{n.message}
						</div>
					)
				})}
			</div>
		</NotificationContext>
	)
}

export { NotificationContext }
export type { NotificationContextType }
