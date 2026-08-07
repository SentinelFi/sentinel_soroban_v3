import { useState } from "react"
import { useTheme } from "../providers/ThemeProvider"
import { defaultRpcUrl } from "../contracts/util"
import { defaultHorizonUrl } from "../util/wallet"
import { EXPLORERS } from "../lib/explorer"
import {
	FONT_SCALES,
	getCustomHorizonUrl,
	getCustomRpcUrl,
	getExplorerKey,
	getFontScale,
	setCustomHorizonUrl,
	setCustomRpcUrl,
	setExplorerKey,
	setFontScale,
	validateEndpointUrl,
	type ExplorerKey,
	type FontScale,
} from "../lib/settings"

/**
 * SETTINGS — per-browser app preferences (reached from the top-bar
 * hamburger menu): preferred explorer, custom RPC / Horizon endpoints,
 * color scheme and font size. Endpoint changes reload the app — the
 * contract clients are constructed at module load, so a reload is what
 * makes them real. Read-only deployment facts live on the Information
 * page.
 */

function SectionPanel({
	title,
	children,
}: {
	title: string
	children: React.ReactNode
}) {
	return (
		<section className="panel mt-6 px-5 py-4">
			<h2 className="font-display text-meta tracking-[0.04em] text-ink">
				{title}
			</h2>
			{children}
		</section>
	)
}

function SettingRow({
	label,
	hint,
	children,
}: {
	label: string
	hint?: string
	children: React.ReactNode
}) {
	return (
		<div className="mt-4">
			<p className="label-px">{label}</p>
			{hint && <p className="mt-1 font-body text-fine text-mute">{hint}</p>}
			<div className="mt-2">{children}</div>
		</div>
	)
}

/**
 * Default-or-custom URL editor. Applying saves the preference and
 * reloads the app; an empty field returns to the default endpoint.
 */
function EndpointField({
	label,
	hint,
	defaultUrl,
	storedCustom,
	onSave,
	testId,
}: {
	label: string
	hint: string
	defaultUrl: string
	storedCustom: string | null
	onSave: (url: string | null) => void
	testId: string
}) {
	const [value, setValue] = useState(storedCustom ?? "")
	const [error, setError] = useState<string | null>(null)
	const dirty = value.trim() !== (storedCustom ?? "")

	const apply = () => {
		const trimmed = value.trim()
		if (trimmed !== "" && !validateEndpointUrl(trimmed)) {
			setError(
				"Enter a valid https:// URL (http:// is allowed for localhost only).",
			)
			return
		}
		setError(null)
		onSave(trimmed === "" ? null : trimmed)
	}

	return (
		<SettingRow label={label} hint={hint}>
			<p className="font-body text-fine text-dim">
				Default:{" "}
				<span className="font-board text-meta text-sky">{defaultUrl}</span>
			</p>
			<p className="mt-1 font-body text-fine text-dim">
				In use:{" "}
				<span className="font-board text-meta text-ink">
					{storedCustom ?? defaultUrl}
				</span>
				{storedCustom === null && (
					<span className="ml-1 text-mute">(default)</span>
				)}
			</p>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<input
					className="field-px w-full max-w-md"
					data-testid={testId}
					value={value}
					onChange={(e) => {
						setValue(e.target.value)
						setError(null)
					}}
					placeholder="Custom URL — leave empty for the default"
					spellCheck={false}
				/>
				<button
					type="button"
					className="btn-px btn-gold btn-sm"
					disabled={!dirty}
					onClick={apply}
				>
					Apply
				</button>
				{storedCustom !== null && (
					<button
						type="button"
						className="btn-px btn-ghost btn-sm"
						onClick={() => onSave(null)}
					>
						Use default
					</button>
				)}
			</div>
			{error && (
				<p role="alert" className="mt-2 font-body text-fine text-loss">
					{error}
				</p>
			)}
		</SettingRow>
	)
}

export default function Settings() {
	const { scheme, setScheme } = useTheme()
	const [explorer, setExplorer] = useState<ExplorerKey>(getExplorerKey)
	const [fontScale, setScale] = useState<FontScale>(getFontScale)

	const pickExplorer = (key: ExplorerKey) => {
		setExplorerKey(key)
		setExplorer(key)
	}

	const pickScale = (scale: FontScale) => {
		setFontScale(scale)
		setScale(scale)
	}

	const saveEndpoint =
		(persist: (url: string | null) => void) => (url: string | null) => {
			persist(url)
			window.location.reload()
		}

	return (
		<div className="mx-auto max-w-4xl px-4 py-10">
			<header className="panel-raised relative overflow-hidden px-5 py-4">
				<div aria-hidden="true" className="scanlines absolute inset-0" />
				<h1 className="font-display text-[18px] leading-tight text-ink sm:text-[22px]">
					SETTINGS
				</h1>
			</header>

			<SectionPanel title="APPEARANCE">
				<SettingRow
					label="Theme"
				>
					<div
						role="group"
						aria-label="Color scheme"
						className="theme-toggle inline-flex select-none items-center"
					>
						<button
							type="button"
							aria-pressed={scheme === "dark"}
							onClick={() => setScheme("dark")}
							className="theme-toggle-opt"
							data-active={scheme === "dark"}
						>
							Dark mode
						</button>
						<button
							type="button"
							aria-pressed={scheme === "light"}
							onClick={() => setScheme("light")}
							className="theme-toggle-opt"
							data-active={scheme === "light"}
							data-testid="settings-light-mode"
						>
							Light mode
						</button>
					</div>
				</SettingRow>
				<SettingRow
					label="Font size"
				>
					<div
						role="group"
						aria-label="Font size"
						className="theme-toggle inline-flex select-none items-center"
					>
						{FONT_SCALES.map((scale) => (
							<button
								key={scale}
								type="button"
								aria-pressed={fontScale === scale}
								onClick={() => pickScale(scale)}
								className="theme-toggle-opt"
								data-active={fontScale === scale}
								data-testid={`settings-font-${scale}`}
							>
								{scale}%
							</button>
						))}
					</div>
				</SettingRow>
			</SectionPanel>

			<SectionPanel title="EXPLORER">
				<SettingRow
					label="Preferred explorer"
				>
					<div
						role="group"
						aria-label="Preferred explorer"
						className="theme-toggle inline-flex flex-wrap select-none items-center"
					>
						{(Object.keys(EXPLORERS) as ExplorerKey[]).map((key) => (
							<button
								key={key}
								type="button"
								aria-pressed={explorer === key}
								onClick={() => pickExplorer(key)}
								className="theme-toggle-opt"
								data-active={explorer === key}
								data-testid={`settings-explorer-${key}`}
							>
								{EXPLORERS[key].label}
							</button>
						))}
					</div>
					<p className="mt-2 font-body text-fine break-all text-mute">
						Transaction links become:{" "}
						<span className="font-board text-meta text-sky">
							{EXPLORERS[explorer].txUrl("…")}
						</span>
					</p>
				</SettingRow>
			</SectionPanel>

			<SectionPanel title="NETWORK ENDPOINTS">
				<EndpointField
					label="Soroban RPC URL"
					hint="Every contract read and transaction simulation goes through this endpoint."
					defaultUrl={defaultRpcUrl}
					storedCustom={getCustomRpcUrl()}
					onSave={saveEndpoint(setCustomRpcUrl)}
					testId="settings-rpc-input"
				/>
				<EndpointField
					label="Horizon API URL"
					hint="Used for wallet balances (classic Stellar API)."
					defaultUrl={defaultHorizonUrl}
					storedCustom={getCustomHorizonUrl()}
					onSave={saveEndpoint(setCustomHorizonUrl)}
					testId="settings-horizon-input"
				/>
			</SectionPanel>

			<p className="mt-6 font-body text-fine text-mute">
				Preferences are stored in this browser only. Custom endpoints must be
				https (http is accepted for localhost), and never receive keys — all
				signing stays in your wallet.
			</p>
		</div>
	)
}
