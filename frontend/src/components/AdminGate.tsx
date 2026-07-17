import { useState } from "react"
import type { ReactNode } from "react"
import { Lock } from "lucide-react"

/**
 * Password gate for the hidden /admin section.
 *
 * The password comes from PUBLIC_ADMIN_PASSWORD (baked into the bundle at
 * build time — this hides the ops pages from casual visitors, it is NOT
 * security). Real protection stays on-chain: every admin write still
 * requires the owner/admin wallet signature.
 */

const ADMIN_PASSWORD =
	(import.meta.env.PUBLIC_ADMIN_PASSWORD as string) || "yoyohoneysingh"

const STORAGE_KEY = "sentinel_admin_unlocked"

export function isAdminUnlocked(): boolean {
	try {
		return sessionStorage.getItem(STORAGE_KEY) === "1"
	} catch {
		return false
	}
}

export function AdminGate({ children }: { children: ReactNode }) {
	const [unlocked, setUnlocked] = useState(isAdminUnlocked)
	const [input, setInput] = useState("")
	const [error, setError] = useState(false)

	if (unlocked) return <>{children}</>

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (input === ADMIN_PASSWORD) {
			try {
				sessionStorage.setItem(STORAGE_KEY, "1")
			} catch {
				// sessionStorage unavailable — gate still opens for this render
			}
			setUnlocked(true)
		} else {
			setError(true)
		}
	}

	return (
		<div className="max-w-sm mx-auto mt-24 mb-32">
			<form
				onSubmit={submit}
				className="rounded-xl border border-border bg-card/60 backdrop-blur-md p-8 flex flex-col gap-4"
			>
				<div className="flex items-center gap-2 text-muted-foreground">
					<Lock className="h-4 w-4" />
					<span className="text-xs uppercase tracking-widest">
						Operator access
					</span>
				</div>
				<input
					type="password"
					id="admin-password"
					name="admin-password"
					aria-label="Operator password"
					autoFocus
					value={input}
					onChange={(e) => {
						setInput(e.target.value)
						setError(false)
					}}
					placeholder="Password"
					className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				{error && (
					<p className="text-xs text-destructive">Incorrect password.</p>
				)}
				<button
					type="submit"
					className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
				>
					Unlock
				</button>
			</form>
		</div>
	)
}
