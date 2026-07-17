import { useQueryClient } from "@tanstack/react-query"
import React, { useState, useEffect } from "react"
import {
	useGovernanceDefaults,
	useRoutes,
	useWhitelistEnabled,
	governanceClient,
	controllerClient,
	formatUsdc,
	parseUsdc,
	useContractSync,
} from "../hooks/useContracts"
import type { UiRoute } from "../hooks/useContracts"
import { useWallet } from "../hooks/useWallet"
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Button } from "../components/ui/button"

const STATUS_STYLES: Record<UiRoute["status"], string> = {
	Active: "bg-success/10 border-success/20 text-success",
	Disabled: "bg-destructive/10 border-destructive/20 text-destructive",
	Unknown: "bg-muted-foreground/10 border-muted-foreground/20 text-muted-foreground",
}

const RouteItem: React.FC<{
	route: UiRoute
	address?: string
	onWhitelist: () => void
	onEnable: () => void
	onDisable: () => void
	onRemove: () => void
	onUpdate: (premium: string, payoff: string, delayHours: string) => Promise<void> | undefined
}> = ({ route, address, onWhitelist, onEnable, onDisable, onRemove, onUpdate }) => {
	const { flightId, origin, dest, status, terms } = route
	const [editing, setEditing] = useState(false)
	const [saving, setSaving] = useState(false)
	const [editPremium, setEditPremium] = useState("")
	const [editPayoff, setEditPayoff] = useState("")
	const [editDelay, setEditDelay] = useState("")

	const handleSave = async () => {
		setSaving(true)
		try {
			await onUpdate(editPremium, editPayoff, editDelay)
			setEditing(false)
			setEditPremium("")
			setEditPayoff("")
			setEditDelay("")
		} catch (err) {
			console.error("Failed to update route terms:", err)
		} finally {
			setSaving(false)
		}
	}

	return (
		<li className="rounded-lg bg-muted px-4 py-3">
			<div className="flex items-center justify-between">
				<span className="text-foreground">
					<span className="font-mono font-semibold">{flightId}</span>
					<span className="ml-2 text-muted-foreground">{origin} &rarr; {dest}</span>
					<span className={`ml-3 rounded border px-1.5 py-0.5 text-xs ${STATUS_STYLES[status]}`}>
						{status === "Unknown" ? "Not Listed" : status}
					</span>
				</span>
				<div className="flex gap-2">
					{status === "Unknown" && (
						<Button
							onClick={onWhitelist}
							disabled={!address}
							variant="secondary"
							size="sm"
						>
							Whitelist
						</Button>
					)}
					{status === "Active" && (
						<>
							<Button
								onClick={() => setEditing((v) => !v)}
								disabled={!address}
								variant="outline"
								size="sm"
							>
								{editing ? "Cancel" : "Edit"}
							</Button>
							<Button
								onClick={onDisable}
								disabled={!address}
								variant="destructive"
								size="sm"
							>
								Disable
							</Button>
						</>
					)}
					{status === "Disabled" && (
						<>
							<Button
								onClick={onEnable}
								disabled={!address}
								variant="secondary"
								size="sm"
							>
								Enable
							</Button>
							<Button
								onClick={onRemove}
								disabled={!address}
								variant="destructive"
								size="sm"
							>
								Remove
							</Button>
						</>
					)}
				</div>
			</div>

			{/* Current terms display */}
			{terms && !editing && (
				<div className="mt-2 flex gap-4 text-xs text-muted-foreground">
					<span>Premium: <span className="text-foreground font-medium">{formatUsdc(terms.premium)} USDC</span></span>
					<span>Payoff: <span className="text-foreground font-medium">{formatUsdc(terms.payoff)} USDC</span></span>
					<span>Delay: <span className="text-foreground font-medium">{terms.delay_hours}h</span></span>
				</div>
			)}

			{/* Edit form — blank fields keep the current value */}
			{editing && (
				<div className="mt-3 border-t border-border pt-3">
					<div className="grid grid-cols-3 gap-3">
						<div>
							<label className="mb-1 block text-xs text-muted-foreground">Premium (USDC)</label>
							<Input
								type="number"
								value={editPremium}
								onChange={(e) => setEditPremium(e.target.value)}
								placeholder={terms ? `${formatUsdc(terms.premium)} (keep)` : "Keep"}
							/>
						</div>
						<div>
							<label className="mb-1 block text-xs text-muted-foreground">Payoff (USDC)</label>
							<Input
								type="number"
								value={editPayoff}
								onChange={(e) => setEditPayoff(e.target.value)}
								placeholder={terms ? `${formatUsdc(terms.payoff)} (keep)` : "Keep"}
							/>
						</div>
						<div>
							<label className="mb-1 block text-xs text-muted-foreground">Delay Hours</label>
							<Input
								type="number"
								value={editDelay}
								onChange={(e) => setEditDelay(e.target.value)}
								placeholder={terms ? `${terms.delay_hours} (keep)` : "Keep"}
							/>
						</div>
					</div>
					<Button
						onClick={() => void handleSave()}
						disabled={!address || saving}
						size="sm"
						className="mt-3"
					>
						{saving ? "Saving..." : "Save Terms"}
					</Button>
				</div>
			)}
		</li>
	)
}

const Admin: React.FC = () => {
	const { address, signTransaction } = useWallet()
	useContractSync()
	const queryClient = useQueryClient()

	const { data: defaults } = useGovernanceDefaults()
	const { data: routes, isLoading: routesLoading } = useRoutes()
	const { data: whitelistEnabled } = useWhitelistEnabled()

	const [premium, setPremium] = useState("")
	const [payoff, setPayoff] = useState("")
	const [delayHours, setDelayHours] = useState("")
	const [saving, setSaving] = useState(false)

	useEffect(() => {
		if (defaults) {
			setPremium(formatUsdc(defaults.default_premium))
			setPayoff(formatUsdc(defaults.default_payoff))
			setDelayHours(String(defaults.default_delay_hours))
		}
	}, [defaults])

	const [newFlightId, setNewFlightId] = useState("")
	const [newOrigin, setNewOrigin] = useState("")
	const [newDest, setNewDest] = useState("")
	const [newRoutePremium, setNewRoutePremium] = useState("")
	const [newRoutePayoff, setNewRoutePayoff] = useState("")
	const [newRouteDelay, setNewRouteDelay] = useState("")
	const [routeLoading, setRouteLoading] = useState(false)

	// Buyer whitelist state
	const [buyerAddr, setBuyerAddr] = useState("")
	const [buyerBusy, setBuyerBusy] = useState(false)
	const [gateBusy, setGateBusy] = useState(false)

	const isOwner = true

	const handleUpdateDefaults = () => {
		if (!address || !signTransaction) return
		setSaving(true)
		void (async () => {
			try {
				const tx = await governanceClient.set_defaults({
					premium: parseUsdc(premium),
					payoff: parseUsdc(payoff),
					delay_hours: parseInt(delayHours) || 3,
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({ queryKey: ["governance"] })
			} catch (err) {
				console.error("Failed to update defaults:", err)
			} finally {
				setSaving(false)
			}
		})()
	}

	const handleWhitelist = (
		flightId: string,
		origin: string,
		dest: string,
		routePremium?: string,
		routePayoff?: string,
		routeDelay?: string,
	) => {
		if (!address || !signTransaction || !flightId || !origin || !dest) return
		setRouteLoading(true)
		void (async () => {
			try {
				const tx = await governanceClient.whitelist_route({
					caller: address,
					flight_id: flightId,
					origin,
					dest,
					premium: routePremium ? parseUsdc(routePremium) : undefined,
					payoff: routePayoff ? parseUsdc(routePayoff) : undefined,
					delay_hours: routeDelay ? parseInt(routeDelay) : undefined,
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({
					queryKey: ["governance"],
				})
				setNewFlightId("")
				setNewOrigin("")
				setNewDest("")
				setNewRoutePremium("")
				setNewRoutePayoff("")
				setNewRouteDelay("")
			} catch (err) {
				console.error("Failed to whitelist route:", err)
			} finally {
				setRouteLoading(false)
			}
		})()
	}

	const handleEnableRoute = (
		flightId: string,
		origin: string,
		dest: string,
	) => {
		if (!address || !signTransaction) return
		void (async () => {
			try {
				const tx = await governanceClient.enable_route({
					caller: address,
					flight_id: flightId,
					origin,
					dest,
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({
					queryKey: ["governance", "routes"],
				})
			} catch (err) {
				console.error("Failed to enable route:", err)
			}
		})()
	}

	const handleDisableRoute = (
		flightId: string,
		origin: string,
		dest: string,
	) => {
		if (!address || !signTransaction) return
		void (async () => {
			try {
				const tx = await governanceClient.disable_route({
					caller: address,
					flight_id: flightId,
					origin,
					dest,
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({
					queryKey: ["governance", "routes"],
				})
			} catch (err) {
				console.error("Failed to disable route:", err)
			}
		})()
	}

	const handleRemoveRoute = (
		flightId: string,
		origin: string,
		dest: string,
	) => {
		if (!address || !signTransaction) return
		void (async () => {
			try {
				const tx = await governanceClient.remove_route({
					caller: address,
					flight_id: flightId,
					origin,
					dest,
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({
					queryKey: ["governance", "routes"],
				})
			} catch (err) {
				console.error("Failed to remove route:", err)
			}
		})()
	}

	const handleUpdateRouteTerms = (
		flightId: string,
		origin: string,
		dest: string,
		newPremium: string,
		newPayoff: string,
		newDelayHours: string,
	) => {
		if (!address || !signTransaction) return
		return (async () => {
			const tx = await governanceClient.update_route_terms({
				caller: address,
				flight_id: flightId,
				origin,
				dest,
				premium: newPremium
					? { tag: "Set", values: [parseUsdc(newPremium)] }
					: { tag: "Keep", values: undefined },
				payoff: newPayoff
					? { tag: "Set", values: [parseUsdc(newPayoff)] }
					: { tag: "Keep", values: undefined },
				delay_hours: newDelayHours
					? { tag: "Set", values: [parseInt(newDelayHours)] }
					: { tag: "Keep", values: undefined },
			})
			await tx.signAndSend({ signTransaction })
			void queryClient.invalidateQueries({
				queryKey: ["governance"],
			})
		})()
	}

	// ── Buyer whitelist handlers (Controller) ──

	const handleToggleWhitelistGate = () => {
		if (!address || !signTransaction) return
		setGateBusy(true)
		void (async () => {
			try {
				const tx = await controllerClient.set_whitelist_enabled({
					enabled: !whitelistEnabled,
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({ queryKey: ["controller"] })
			} catch (err) {
				console.error("Failed to toggle buyer whitelist:", err)
			} finally {
				setGateBusy(false)
			}
		})()
	}

	const handleAddBuyer = () => {
		if (!address || !signTransaction || !buyerAddr.trim()) return
		setBuyerBusy(true)
		void (async () => {
			try {
				const tx = await controllerClient.add_whitelisted_buyer({
					caller: address,
					addr: buyerAddr.trim(),
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({ queryKey: ["controller"] })
				setBuyerAddr("")
			} catch (err) {
				console.error("Failed to add whitelisted buyer:", err)
			} finally {
				setBuyerBusy(false)
			}
		})()
	}

	const handleRemoveBuyer = () => {
		if (!address || !signTransaction || !buyerAddr.trim()) return
		setBuyerBusy(true)
		void (async () => {
			try {
				const tx = await controllerClient.remove_whitelisted_buyer({
					caller: address,
					addr: buyerAddr.trim(),
				})
				await tx.signAndSend({ signTransaction })
				void queryClient.invalidateQueries({ queryKey: ["controller"] })
				setBuyerAddr("")
			} catch (err) {
				console.error("Failed to remove whitelisted buyer:", err)
			} finally {
				setBuyerBusy(false)
			}
		})()
	}

	return (
		<div className="mx-auto max-w-3xl">
			<h1 className="mb-2 text-3xl font-bold text-foreground">Admin</h1>
			<p className="mb-8 text-muted-foreground">
				Manage protocol defaults and routes.
			</p>

			{/* Owner Warning */}
			{address && !isOwner && (
				<div className="mb-6 rounded-xl border border-warning bg-card p-4 text-sm text-warning">
					Connected wallet is not the protocol owner. Admin actions will fail.
				</div>
			)}
			{!address && (
				<div className="mb-6 rounded-xl border border-warning bg-card p-4 text-sm text-warning">
					Connect your wallet to perform admin actions.
				</div>
			)}

			{/* Default Terms */}
			<Card className="mb-6">
				<CardHeader>
					<CardTitle className="text-lg">Default Terms</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<div>
							<label className="mb-2 block text-sm font-medium text-muted-foreground">
								Default Premium (USDC)
							</label>
							<Input
								type="number"
								value={premium}
								onChange={(e) => setPremium(e.target.value)}
								placeholder="10"
							/>
						</div>
						<div>
							<label className="mb-2 block text-sm font-medium text-muted-foreground">
								Default Payoff (USDC)
							</label>
							<Input
								type="number"
								value={payoff}
								onChange={(e) => setPayoff(e.target.value)}
								placeholder="50"
							/>
						</div>
						<div>
							<label className="mb-2 block text-sm font-medium text-muted-foreground">
								Default Delay Hours
							</label>
							<Input
								type="number"
								value={delayHours}
								onChange={(e) => setDelayHours(e.target.value)}
								placeholder="2"
							/>
						</div>
					</div>
					<div className="mt-8">
						<Button
							onClick={handleUpdateDefaults}
							disabled={!address || saving}
						>
							{saving ? "Updating..." : "Update Defaults"}
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Route Management */}
			<Card className="mb-6">
				<CardHeader>
					<CardTitle className="text-lg">Route Management</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="mb-4">
						<h3 className="mb-2 text-sm font-medium text-muted-foreground">
							Candidate Routes
						</h3>
						{routesLoading ? (
							<p className="text-sm text-muted-foreground animate-pulse">
								Loading routes...
							</p>
						) : !routes || routes.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No candidate routes configured.
							</p>
						) : (
							<ul className="space-y-3">
								{routes.map((route) => (
									<RouteItem
										key={`${route.flightId}-${route.origin}-${route.dest}`}
										route={route}
										address={address}
										onWhitelist={() => handleWhitelist(route.flightId, route.origin, route.dest)}
										onEnable={() => handleEnableRoute(route.flightId, route.origin, route.dest)}
										onDisable={() => handleDisableRoute(route.flightId, route.origin, route.dest)}
										onRemove={() => handleRemoveRoute(route.flightId, route.origin, route.dest)}
										onUpdate={(p, po, d) => handleUpdateRouteTerms(route.flightId, route.origin, route.dest, p, po, d)}
									/>
								))}
							</ul>
						)}
					</div>

					{/* Add Route Form */}
					<div className="rounded-lg border border-border bg-muted p-4">
						<h3 className="mb-3 text-sm font-medium text-muted-foreground">
							Add Route
						</h3>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<Input
								type="text"
								value={newFlightId}
								onChange={(e) => setNewFlightId(e.target.value)}
								placeholder="Flight ID (e.g. AA100)"
							/>
							<Input
								type="text"
								value={newOrigin}
								onChange={(e) => setNewOrigin(e.target.value)}
								placeholder="Origin (e.g. JFK)"
							/>
							<Input
								type="text"
								value={newDest}
								onChange={(e) => setNewDest(e.target.value)}
								placeholder="Dest (e.g. LAX)"
							/>
						</div>
						<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
							<Input
								type="number"
								value={newRoutePremium}
								onChange={(e) => setNewRoutePremium(e.target.value)}
								placeholder="Premium USDC (blank = default)"
							/>
							<Input
								type="number"
								value={newRoutePayoff}
								onChange={(e) => setNewRoutePayoff(e.target.value)}
								placeholder="Payoff USDC (blank = default)"
							/>
							<Input
								type="number"
								value={newRouteDelay}
								onChange={(e) => setNewRouteDelay(e.target.value)}
								placeholder="Delay hours (blank = default)"
							/>
						</div>
						<Button
							onClick={() =>
								handleWhitelist(
									newFlightId,
									newOrigin,
									newDest,
									newRoutePremium,
									newRoutePayoff,
									newRouteDelay,
								)
							}
							disabled={
								!address ||
								!newFlightId ||
								!newOrigin ||
								!newDest ||
								routeLoading
							}
							variant="secondary"
							className="mt-5"
						>
							{routeLoading ? "Whitelisting..." : "Whitelist"}
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Buyer Whitelist (Controller) */}
			<Card className="mb-6">
				<CardHeader>
					<CardTitle className="text-lg">Buyer Whitelist</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="mb-4 flex items-center justify-between rounded-lg bg-muted px-4 py-3">
						<span className="text-sm text-foreground">
							Whitelist gate:{" "}
							<span className={whitelistEnabled ? "font-medium text-success" : "font-medium text-muted-foreground"}>
								{whitelistEnabled === undefined
									? "Loading..."
									: whitelistEnabled
										? "Enabled"
										: "Disabled"}
							</span>
						</span>
						<Button
							onClick={handleToggleWhitelistGate}
							disabled={!address || gateBusy || whitelistEnabled === undefined}
							variant="outline"
							size="sm"
						>
							{gateBusy
								? "Updating..."
								: whitelistEnabled
									? "Disable Gate"
									: "Enable Gate"}
						</Button>
					</div>
					<p className="mb-3 text-sm text-muted-foreground">
						When the gate is enabled, only whitelisted addresses can buy policies.
					</p>
					<div className="flex gap-3">
						<Input
							type="text"
							value={buyerAddr}
							onChange={(e) => setBuyerAddr(e.target.value)}
							placeholder="Buyer address (G...)"
							className="flex-1"
						/>
						<Button
							onClick={handleAddBuyer}
							disabled={!address || !buyerAddr.trim() || buyerBusy}
							variant="secondary"
							className="whitespace-nowrap"
						>
							{buyerBusy ? "Working..." : "Add"}
						</Button>
						<Button
							onClick={handleRemoveBuyer}
							disabled={!address || !buyerAddr.trim() || buyerBusy}
							variant="destructive"
							className="whitespace-nowrap"
						>
							Remove
						</Button>
					</div>
				</CardContent>
			</Card>

		</div>
	)
}

export default Admin
