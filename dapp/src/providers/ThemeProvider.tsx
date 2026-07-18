import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react"

/**
 * Two skins over the same pages:
 *   fun     — pixel-arcade (default), arcade/market wording
 *   serious — clean professional insurance UI, calmer wording
 *
 * The active theme is written to <html data-theme> so CSS can re-skin every
 * shared component, and persisted so a reload keeps the choice.
 */
export type Theme = "fun" | "serious"

const STORAGE_KEY = "flightsfun_theme"

interface ThemeContextValue {
	theme: Theme
	setTheme: (t: Theme) => void
	toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readInitialTheme(): Theme {
	try {
		const stored = localStorage.getItem(STORAGE_KEY)
		if (stored === "fun" || stored === "serious") return stored
	} catch {
		// localStorage unavailable — fall through to default
	}
	return "fun"
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(readInitialTheme)

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme)
		try {
			localStorage.setItem(STORAGE_KEY, theme)
		} catch {
			// ignore persistence failure
		}
	}, [theme])

	const setTheme = useCallback((t: Theme) => setThemeState(t), [])
	const toggleTheme = useCallback(
		() => setThemeState((t) => (t === "fun" ? "serious" : "fun")),
		[],
	)

	const value = useMemo(
		() => ({ theme, setTheme, toggleTheme }),
		[theme, setTheme, toggleTheme],
	)

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext)
	if (!ctx) throw new Error("useTheme must be used within ThemeProvider")
	return ctx
}
