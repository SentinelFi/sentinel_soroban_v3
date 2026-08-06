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
