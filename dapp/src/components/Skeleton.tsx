/**
 * Ghost rows shown while real ones load — a shimmer sweep over inset
 * bars (hard-edged in fun, rounded by the serious theme override in
 * index.css). Purely visual: callers pair it with an sr-only status
 * line so screen readers still hear "loading".
 */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
	return (
		<div
			className="panel space-y-4 p-5"
			data-testid="skeleton"
			aria-hidden="true"
		>
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="flex items-center gap-4">
					<div className="skeleton h-6 w-24" />
					<div className="skeleton h-4 w-40" />
					<div className="skeleton h-4 w-16" />
					<div className="skeleton ml-auto h-4 w-28" />
				</div>
			))}
		</div>
	)
}
