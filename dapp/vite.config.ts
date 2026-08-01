import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { createLogger, defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import wasm from "vite-plugin-wasm"

// The SPA polls /api on intervals, so while `npm run dev:api` is down every
// tick logs a full proxy-error stack. Collapse them to one line per 10s.
const logger = createLogger()
const logError = logger.error.bind(logger)
let nextProxyErrorAt = 0
logger.error = (msg, options) => {
	if (!msg.includes("http proxy error")) return logError(msg, options)
	if (Date.now() < nextProxyErrorAt) return
	nextProxyErrorAt = Date.now() + 10_000
	// eslint-disable-next-line no-control-regex
	const firstLine = msg.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]
	logError(`${firstLine} — is \`npm run dev:api\` running? (repeats muted for 10s)`, {
		timestamp: true,
	})
}

// https://vite.dev/config/
export default defineConfig({
	customLogger: logger,
	plugins: [
		tailwindcss(),
		react(),
		nodePolyfills({
			include: ["buffer"],
			globals: {
				Buffer: true,
			},
		}),
		wasm(),
	],
	build: {
		target: "esnext",
	},
	resolve: {
		// The generated binding packages each declare their own stellar-sdk
		// dependency — if their version ever drifts from the root's, npm
		// nests per-package copies and the bundle ships the SDK N times.
		// Dedupe pins every import to the single root copy.
		dedupe: ["@stellar/stellar-sdk", "@stellar/stellar-base"],
	},
	define: {
		global: "window",
	},
	envPrefix: "PUBLIC_",
	server: {
		port: 5175,
		strictPort: true,
		proxy: {
			// api/**/*.ts only run under Vercel's function runtime — vite dev
			// serves the SPA, `npm run dev:api` (scripts/dev_api.ts) serves /api.
			"/api": "http://localhost:3000",
		},
	},
})
