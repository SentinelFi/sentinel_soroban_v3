import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { WalletProvider } from "./providers/WalletProvider"
import { NotificationProvider } from "./providers/NotificationProvider"
import { ThemeProvider } from "./providers/ThemeProvider"
import App from "./App"
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
