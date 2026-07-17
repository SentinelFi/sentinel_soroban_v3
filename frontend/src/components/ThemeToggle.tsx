import { Sun, Moon } from "lucide-react"
import { useTheme } from "../providers/ThemeProvider"

export function ThemeToggle() {
	const { theme, toggleTheme } = useTheme()

	return (
		<button
			onClick={toggleTheme}
			className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background/60 text-foreground transition-colors hover:bg-accent"
			aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
		>
			<Sun
				className={`h-4 w-4 transition-all duration-300 ${
					theme === "dark"
						? "rotate-0 scale-100 opacity-100"
						: "rotate-90 scale-0 opacity-0"
				} absolute`}
			/>
			<Moon
				className={`h-4 w-4 transition-all duration-300 ${
					theme === "light"
						? "rotate-0 scale-100 opacity-100"
						: "-rotate-90 scale-0 opacity-0"
				} absolute`}
			/>
		</button>
	)
}
