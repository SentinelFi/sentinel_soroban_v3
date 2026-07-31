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
 * Two independent axes over the same pages:
 *
 *   theme  — fun (pixel-arcade, default) | serious (clean insurance UI)
 *   scheme — dark (default) | light
 *
 * The active theme is written to <html data-theme> and the active scheme to
 * <html data-scheme> so CSS can re-skin every shared component; both are
 * persisted so a reload keeps the choice.
 */
export type Theme = "fun" | "serious"
export type Scheme = "dark" | "light"

const STORAGE_KEY = "flightsfun_theme"
const SCHEME_STORAGE_KEY = "flightsfun_scheme"

interface ThemeContextValue {
	theme: Theme
	setTheme: (t: Theme) => void
	toggleTheme: () => void
	scheme: Scheme
	setScheme: (s: Scheme) => void
	toggleScheme: () => void
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

function readInitialScheme(): Scheme {
	try {
		const stored = localStorage.getItem(SCHEME_STORAGE_KEY)
		if (stored === "dark" || stored === "light") return stored
	} catch {
		// localStorage unavailable — fall through to default
	}
	return "dark"
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(readInitialTheme)
	const [scheme, setSchemeState] = useState<Scheme>(readInitialScheme)

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme)
		try {
			localStorage.setItem(STORAGE_KEY, theme)
		} catch {
			// ignore persistence failure
		}
	}, [theme])

	useEffect(() => {
		document.documentElement.setAttribute("data-scheme", scheme)
		try {
			localStorage.setItem(SCHEME_STORAGE_KEY, scheme)
		} catch {
			// ignore persistence failure
		}
	}, [scheme])

	const setTheme = useCallback((t: Theme) => setThemeState(t), [])
	const toggleTheme = useCallback(
		() => setThemeState((t) => (t === "fun" ? "serious" : "fun")),
		[],
	)
	const setScheme = useCallback((s: Scheme) => setSchemeState(s), [])
	const toggleScheme = useCallback(
		() => setSchemeState((s) => (s === "dark" ? "light" : "dark")),
		[],
	)

	const value = useMemo(
		() => ({ theme, setTheme, toggleTheme, scheme, setScheme, toggleScheme }),
		[theme, setTheme, toggleTheme, scheme, setScheme, toggleScheme],
	)

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
	const ctx = useContext(ThemeContext)
	if (!ctx) throw new Error("useTheme must be used within ThemeProvider")
	return ctx
}
