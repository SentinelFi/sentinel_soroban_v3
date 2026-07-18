import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WalletProvider } from "./providers/WalletProvider"
import { NotificationProvider } from "./providers/NotificationProvider"
import { ThemeProvider } from "./providers/ThemeProvider"
import App from "./App"
import "./index.css"

const queryClient = new QueryClient()

createRoot(document.getElementById("root")!).render(
	<StrictMode>
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
	</StrictMode>,
)
