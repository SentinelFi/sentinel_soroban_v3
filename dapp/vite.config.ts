import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import wasm from "vite-plugin-wasm"

// https://vite.dev/config/
export default defineConfig({
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
