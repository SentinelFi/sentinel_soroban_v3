import { Component, type ErrorInfo, type ReactNode } from "react"

/**
 * Route-level error boundary: catches render-time throws AND failed
 * lazy-chunk loads (the stale-deploy case — a `React.lazy` import()
 * rejecting inside <Suspense> surfaces here), replacing the former
 * white-screen unmount with an in-place reload path.
 *
 * Copy is intentionally theme-independent: the boundary may catch before
 * providers are usable, so it must not depend on useCopy()/useTheme().
 */
interface Props {
	children: ReactNode
}

interface State {
	error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null }

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("ErrorBoundary caught:", error, info.componentStack)
	}

	render() {
		if (!this.state.error) return this.props.children
		return (
			<div
				role="alert"
				className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center gap-4 px-4 py-16 text-center"
			>
				<p className="font-display text-[15px] text-loss">
					SOMETHING WENT WRONG
				</p>
				<p className="break-words font-body text-[13px] leading-relaxed text-mute">
					{this.state.error.message}
				</p>
				<div className="flex gap-3">
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="btn-px btn-gold btn-sm"
					>
						RELOAD
					</button>
					<button
						type="button"
						onClick={() => {
							window.location.href = "/"
						}}
						className="btn-px btn-ghost btn-sm"
					>
						BACK TO BOARD
					</button>
				</div>
			</div>
		)
	}
}
