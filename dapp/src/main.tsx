import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { WalletProvider } from "./providers/WalletProvider"
import { NotificationProvider } from "./providers/NotificationProvider"
import { ThemeProvider } from "./providers/ThemeProvider"
import { applyFontScale } from "./lib/settings"
import App from "./App"
// ALL fonts are self-hosted in public/fonts and declared in index.css,
// none imported from @fontsource: bundler-hashed URLs can't be preloaded
// from index.html. DM Sans ships the same STATIC cuts @fontsource
// bundled (rendering unchanged — the fun skin's 650-weight labels rely
// on the snap to 700); Outfit (serious display only) is a VARIABLE file
// so its true 600/650 weights render. The @fontsource packages stay in
// package.json as the source the public/fonts woff2s are copied from.
import "./index.css"

console.log(String.raw`
  _    _      _ _
 | |  | |    | | |
 | |__| | ___| | | ___
 |  __  |/ _ \ | |/ _ \
 | |  | |  __/ | | (_) |
 |_|  |_|\___|_|_|\___/
`)

// App-wide query behaviour: one retry (a down RPC must not get 3
// exponential retries per batch entry per tick), no focus refetch on top
// of the per-hook polling intervals, and a small default staleTime.
// Individual hooks override where they need to.
// Persisted font-size preference (Settings page) — apply before first
// paint so the UI doesn't visibly jump to the chosen scale.
applyFontScale()

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: 1,
			refetchOnWindowFocus: false,
			staleTime: 15_000,
		},
	},
})

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ErrorBoundary>
			<ThemeProvider>
				<QueryClientProvider client={queryClient}>
					<WalletProvider>
						<NotificationProvider>
							<BrowserRouter>
								<App />
							</BrowserRouter>
						</NotificationProvider>
					</WalletProvider>
				</QueryClientProvider>
			</ThemeProvider>
		</ErrorBoundary>
	</StrictMode>,
)
