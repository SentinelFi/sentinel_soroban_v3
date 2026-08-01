import { useTheme } from "../providers/ThemeProvider"

export function ThemeToggle() {
	const { theme, setTheme } = useTheme()
	return (
		<div
			role="group"
			aria-label="Theme"
			className="theme-toggle inline-flex select-none items-center"
		>
			<ToggleButtons theme={theme} setTheme={setTheme} />
		</div>
	)
}

/** Fixed bottom-left dock — always present, survives scroll. */
export function ThemeDock() {
	const { theme, setTheme } = useTheme()
	return (
		<div className="theme-dock">
			<span className="theme-dock-label" aria-hidden="true">
				Mode
			</span>
			<div
				role="group"
				aria-label="Theme"
				className="theme-toggle inline-flex select-none items-center"
			>
				<ToggleButtons theme={theme} setTheme={setTheme} />
			</div>
		</div>
	)
}

/**
 * Dark / light scheme toggle for the header — shows the scheme you'll GET:
 * a sun while dark ("click for light"), a moon while light. Works in both
 * fun and serious skins via the shared button classes.
 */
export function SchemeToggle() {
	const { scheme, toggleScheme } = useTheme()
	const dark = scheme === "dark"
	const label = dark ? "Switch to light mode" : "Switch to dark mode"
	return (
		<button
			type="button"
			onClick={toggleScheme}
			className="btn-px btn-ghost btn-sm scheme-toggle"
			aria-label={label}
			title={label}
		>
			{dark ? <SunIcon /> : <MoonIcon />}
		</button>
	)
}

function SunIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.4"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="4.4" fill="currentColor" stroke="none" />
			<line x1="12" y1="1.6" x2="12" y2="4.6" />
			<line x1="12" y1="19.4" x2="12" y2="22.4" />
			<line x1="1.6" y1="12" x2="4.6" y2="12" />
			<line x1="19.4" y1="12" x2="22.4" y2="12" />
			<line x1="4.7" y1="4.7" x2="6.8" y2="6.8" />
			<line x1="17.2" y1="17.2" x2="19.3" y2="19.3" />
			<line x1="4.7" y1="19.3" x2="6.8" y2="17.2" />
			<line x1="17.2" y1="6.8" x2="19.3" y2="4.7" />
		</svg>
	)
}

function MoonIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M20.8 14.9A9.2 9.2 0 0 1 9.1 3.2a.7.7 0 0 0-.9-.9 10.6 10.6 0 1 0 13.5 13.5.7.7 0 0 0-.9-.9Z" />
		</svg>
	)
}

function ToggleButtons({
	theme,
	setTheme,
}: {
	theme: "fun" | "serious"
	setTheme: (t: "fun" | "serious") => void
}) {
	return (
		<>
			<button
				type="button"
				aria-pressed={theme === "fun"}
				onClick={() => setTheme("fun")}
				className="theme-toggle-opt"
				data-active={theme === "fun"}
			>
				Fun
			</button>
			<button
				type="button"
				aria-pressed={theme === "serious"}
				onClick={() => setTheme("serious")}
				className="theme-toggle-opt"
				data-active={theme === "serious"}
			>
				Serious
			</button>
		</>
	)
}
