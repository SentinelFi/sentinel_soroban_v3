/**
 * User-adjustable app settings, persisted per-browser in localStorage.
 * Everything here is a display / connection preference — contract IDs and
 * the network passphrase stay compile-time configuration (see
 * contracts/util.ts and contracts/ids.ts).
 *
 * Custom RPC / Horizon endpoints are read ONCE at module load (the
 * contract clients are constructed at import time), so the Settings page
 * reloads the app after changing them. Explorer choice and font scale
 * are read at call time and apply immediately.
 *
 * Node-safe: every accessor optional-chains through globalThis, so the
 * e2e scripts that import the contract clients under tsx keep working.
 */

export type ExplorerKey = "stellar_expert" | "stellarchain" | "steexp"
export type FontScale = 50 | 100 | 150 | 200

export const FONT_SCALES: readonly FontScale[] = [50, 100, 150, 200]

const EXPLORER_KEY = "flightsfun_explorer"
const RPC_URL_KEY = "flightsfun_rpc_url"
const HORIZON_URL_KEY = "flightsfun_horizon_url"
const FONT_SCALE_KEY = "flightsfun_font_scale"

function read(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null
	} catch {
		return null
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) globalThis.localStorage?.removeItem(key)
		else globalThis.localStorage?.setItem(key, value)
	} catch {
		// storage unavailable (private mode, quota) — preference not persisted
	}
}

/* ── preferred explorer ────────────────────────────────────────────── */

export function getExplorerKey(): ExplorerKey {
	const v = read(EXPLORER_KEY)
	return v === "stellarchain" || v === "steexp" ? v : "stellar_expert"
}

export function setExplorerKey(key: ExplorerKey): void {
	write(EXPLORER_KEY, key === "stellar_expert" ? null : key)
}

/* ── custom endpoints ──────────────────────────────────────────────── */

function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
}

/**
 * Accept only http(s) URLs, with cleartext http limited to loopback
 * hosts — a user-supplied endpoint must not downgrade a public
 * deployment to http (same MITM concern documented in
 * contracts/util.ts). Returns the trimmed URL, or null when rejected.
 */
export function validateEndpointUrl(raw: string): string | null {
	const trimmed = raw.trim()
	let url: URL
	try {
		url = new URL(trimmed)
	} catch {
		return null
	}
	if (url.protocol === "https:") return trimmed
	if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return trimmed
	return null
}

/** True only for the one http form validateEndpointUrl lets through. */
export function isLoopbackHttp(url: string): boolean {
	try {
		const u = new URL(url)
		return u.protocol === "http:" && isLoopbackHost(u.hostname)
	} catch {
		return false
	}
}

/** Custom Soroban RPC URL, or null to use the default. Re-validated on
 *  read so a hand-edited storage entry can't smuggle in a bad URL. */
export function getCustomRpcUrl(): string | null {
	const raw = read(RPC_URL_KEY)
	return raw ? validateEndpointUrl(raw) : null
}

export function setCustomRpcUrl(url: string | null): void {
	write(RPC_URL_KEY, url && url.trim() !== "" ? url.trim() : null)
}

/** Custom Horizon API URL, or null to use the default. */
export function getCustomHorizonUrl(): string | null {
	const raw = read(HORIZON_URL_KEY)
	return raw ? validateEndpointUrl(raw) : null
}

export function setCustomHorizonUrl(url: string | null): void {
	write(HORIZON_URL_KEY, url && url.trim() !== "" ? url.trim() : null)
}

/* ── font size ─────────────────────────────────────────────────────── */

export function getFontScale(): FontScale {
	const v = Number(read(FONT_SCALE_KEY))
	return (FONT_SCALES as readonly number[]).includes(v) ? (v as FontScale) : 100
}

export function setFontScale(scale: FontScale): void {
	write(FONT_SCALE_KEY, scale === 100 ? null : String(scale))
	applyFontScale(scale)
}

/**
 * Scale the whole UI with CSS zoom on <html>. The design speaks fixed
 * pixels throughout (Tailwind text-[12px] etc.), so a root font-size
 * change would move nothing — zoom scales every px value coherently.
 */
export function applyFontScale(scale: FontScale = getFontScale()): void {
	if (typeof document === "undefined") return
	const style = document.documentElement.style
	if (scale === 100) style.removeProperty("zoom")
	else style.setProperty("zoom", String(scale / 100))
}
