// Stamp the persisted theme/scheme on <html> before first paint so a
// reload never flashes the default look. Loaded as a blocking classic
// script from index.html <head>; kept external because the CSP is
// script-src 'self' with no 'unsafe-inline'. Storage keys and defaults
// mirror src/providers/ThemeProvider.tsx — keep both in sync.
;(function () {
	var theme = "fun"
	var scheme = "dark"
	try {
		var t = localStorage.getItem("flightsfun_theme")
		if (t === "fun" || t === "serious") theme = t
		var s = localStorage.getItem("flightsfun_scheme")
		if (s === "dark" || s === "light") scheme = s
	} catch {
		// localStorage unavailable — keep defaults
	}
	document.documentElement.setAttribute("data-theme", theme)
	document.documentElement.setAttribute("data-scheme", scheme)
})()
