/**
 * React Query hooks for reading from Soroban contracts.
 * Each hook wraps a contract client call with caching, polling, and error fallbacks.
 *
 * Pattern:
 *   const tx = await client.method_name({ args })
 *   const value = tx.result  // for read-only calls
 *
 * For write calls, use the client directly in the component:
 *   const tx = await client.method_name({ args })
 *   await tx.signAndSend({ signTransaction })
 */

import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import type { RouteStatus, ResolvedTerms } from "governance_module"
import type { FlightConfig } from "flight_pool_manager"
import type { FlightData } from "oracle_aggregator"
import controllerClient from "../contracts/controller"
import governanceClient from "../contracts/governance_module"
import oracleClient from "../contracts/oracle_aggregator"
import riskVaultClient from "../contracts/risk_vault"
import mockUsdcClient from "../contracts/mock_usdc"
import flightPoolManagerClient from "../contracts/flight_pool_manager"
import { CANDIDATE_ROUTES } from "../config/routes"
import { useWallet } from "./useWallet"

/**
 * Sync wallet address to all contract client singletons.
 * Must be called in any component that does write transactions.
 * Scaffold-stellar clients need `publicKey` set to build transactions.
 */
export function useContractSync() {
	const { address } = useWallet()
	useEffect(() => {
		const clients = [
			controllerClient,
			governanceClient,
			oracleClient,
			riskVaultClient,
			mockUsdcClient,
			flightPoolManagerClient,
		]
		for (const client of clients) {
			;(client as any).options.publicKey = address
		}
	}, [address])
}

const USDC_DECIMALS = 7
const USDC_DIVISOR = 10_000_000n

/** Format i128 USDC amount to human-readable string */
export function formatUsdc(amount: bigint): string {
	const whole = amount / USDC_DIVISOR
	const frac = amount % USDC_DIVISOR
	const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").slice(0, 2)
	return `${whole.toLocaleString()}.${fracStr}`
}

/** Convert human USDC string to i128 */
export function parseUsdc(amount: string): bigint {
	const num = parseFloat(amount)
	if (isNaN(num) || num <= 0) return 0n
	return BigInt(Math.floor(num * 10_000_000))
}

// ─── Controller reads ───

export function useProtocolStats() {
	return useQuery({
		queryKey: ["controller", "stats"],
		queryFn: async () => {
			const tx = await controllerClient.get_stats()
			// (total_travelers, total_locked, total_premiums)
			const [travelers, locked, premiums] = tx.result as readonly [
				bigint,
				bigint,
				bigint,
			]
			return {
				totalTravelers: Number(travelers),
				totalLocked: locked,
				totalPremiums: premiums,
			}
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Flights the connected traveler holds policies for: Vec<(flight_id, date)> */
export function useTravelerFlights(address: string | undefined) {
	return useQuery({
		queryKey: ["controller", "travelerFlights", address],
		queryFn: async () => {
			if (!address) return []
			const tx = await controllerClient.get_flights_for_traveler({ address })
			return tx.result as Array<readonly [string, bigint]>
		},
		enabled: !!address,
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useKeeper() {
	return useQuery({
		queryKey: ["controller", "keeper"],
		queryFn: async () => {
			const tx = await controllerClient.get_keeper()
			return tx.result as string
		},
		retry: 1,
	})
}

export function useSolvencyRatio() {
	return useQuery({
		queryKey: ["controller", "solvencyRatio"],
		queryFn: async () => {
			const tx = await controllerClient.get_solvency_ratio()
			return tx.result as number
		},
		retry: 1,
	})
}

/** Whether the buyer whitelist gate is active on the Controller. */
export function useWhitelistEnabled() {
	return useQuery({
		queryKey: ["controller", "whitelistEnabled"],
		queryFn: async () => {
			const tx = await controllerClient.whitelist_enabled()
			return tx.result as boolean
		},
		refetchInterval: 60_000,
		retry: 1,
	})
}

/** Whether the connected address is on the buyer whitelist. */
export function useIsWhitelisted(address: string | undefined) {
	return useQuery({
		queryKey: ["controller", "isWhitelisted", address],
		queryFn: async () => {
			if (!address) return false
			const tx = await controllerClient.is_whitelisted({ addr: address })
			return tx.result as boolean
		},
		enabled: !!address,
		refetchInterval: 60_000,
		retry: 1,
	})
}

// ─── Risk Vault reads ───

export function useTotalAssets() {
	return useQuery({
		queryKey: ["vault", "totalAssets"],
		queryFn: async () => {
			const tx = await riskVaultClient.total_assets()
			return tx.result as bigint
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useFreeCapital() {
	return useQuery({
		queryKey: ["vault", "freeCapital"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_free_capital()
			return tx.result as bigint
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useLockedCapital() {
	return useQuery({
		queryKey: ["vault", "lockedCapital"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_locked_capital()
			return tx.result as bigint
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useVaultBalance(address: string | undefined) {
	return useQuery({
		queryKey: ["vault", "balance", address],
		queryFn: async () => {
			if (!address) return 0n
			const tx = await riskVaultClient.balance({ account: address })
			return tx.result as bigint
		},
		enabled: !!address,
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Convert a share amount to its current asset value. */
export function useConvertToAssets(shares: bigint | undefined) {
	return useQuery({
		queryKey: ["vault", "convertToAssets", shares?.toString()],
		queryFn: async () => {
			if (shares === undefined || shares === 0n) return 0n
			const tx = await riskVaultClient.convert_to_assets({ shares })
			return tx.result as bigint
		},
		enabled: shares !== undefined,
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Share-price snapshot for today's calendar day (0n if not yet taken). */
export function useSnapshotPrice() {
	return useQuery({
		queryKey: ["vault", "snapshotPrice"],
		queryFn: async () => {
			const day = BigInt(Math.floor(Date.now() / 1000 / 86_400))
			const tx = await riskVaultClient.get_snapshot_price({ day })
			return tx.result as bigint
		},
		retry: 1,
	})
}

export function useWithdrawalQueue() {
	return useQuery({
		queryKey: ["vault", "withdrawalQueue"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_withdrawal_queue()
			// WithdrawalRequest { owner, request_id, shares }
			return tx.result as Array<{
				owner: string
				request_id: bigint
				shares: bigint
			}>
		},
		refetchInterval: 15_000,
		retry: 1,
	})
}

export function useClaimableBalance(address: string | undefined) {
	return useQuery({
		queryKey: ["vault", "claimable", address],
		queryFn: async () => {
			if (!address) return 0n
			const tx = await riskVaultClient.get_claimable_balance({ address })
			return tx.result as bigint
		},
		enabled: !!address,
		refetchInterval: 15_000,
		retry: 1,
	})
}

// ─── Governance reads ───

export interface UiRoute {
	flightId: string
	origin: string
	dest: string
	status: "Active" | "Disabled" | "Unknown"
	terms: ResolvedTerms | null
}

/**
 * Resolve the candidate route list against on-chain `route_status`.
 * GovernanceModule has no route enumeration — see src/config/routes.ts.
 */
export function useRoutes() {
	return useQuery({
		queryKey: ["governance", "routes"],
		queryFn: async () => {
			const results = await Promise.all(
				CANDIDATE_ROUTES.map(async (route): Promise<UiRoute> => {
					try {
						const tx = await governanceClient.route_status({
							flight_id: route.flightId,
							origin: route.origin,
							dest: route.dest,
						})
						const status = tx.result as RouteStatus
						return {
							...route,
							status: status.tag,
							terms: status.tag === "Active" ? status.values[0] : null,
						}
					} catch {
						return { ...route, status: "Unknown", terms: null }
					}
				}),
			)
			return results
		},
		refetchInterval: 60_000,
		retry: 1,
	})
}

/** Active (buyable) routes only, terms resolved on-chain. */
export function useActiveRoutes() {
	const query = useRoutes()
	return {
		...query,
		data: query.data?.filter((r) => r.status === "Active" && r.terms),
	}
}

export function useGovernanceDefaults() {
	return useQuery({
		queryKey: ["governance", "defaults"],
		queryFn: async () => {
			const tx = await governanceClient.get_defaults()
			const [default_premium, default_payoff, default_delay_hours] =
				tx.result as readonly [bigint, bigint, number]
			return { default_premium, default_payoff, default_delay_hours }
		},
		retry: 1,
	})
}

export function useIsAdmin(address: string | undefined) {
	return useQuery({
		queryKey: ["governance", "isAdmin", address],
		queryFn: async () => {
			if (!address) return false
			const tx = await governanceClient.is_admin({ addr: address })
			return tx.result as boolean
		},
		enabled: !!address,
		retry: 1,
	})
}

// ─── Oracle reads ───

export function useActiveFlights() {
	return useQuery({
		queryKey: ["oracle", "activeFlights"],
		queryFn: async () => {
			const tx = await oracleClient.get_active_flights()
			return tx.result as Array<readonly [string, bigint]>
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useFlightData(flightId: string, date: bigint, enabled = true) {
	return useQuery({
		queryKey: ["oracle", "flightData", flightId, date.toString()],
		queryFn: async () => {
			const tx = await oracleClient.get_flight_data({
				flight_id: flightId,
				date,
			})
			return tx.result as FlightData
		},
		enabled,
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useAuthorizedOracle() {
	return useQuery({
		queryKey: ["oracle", "authorizedOracle"],
		queryFn: async () => {
			const tx = await oracleClient.get_authorized_oracle()
			return tx.result as string
		},
		retry: 1,
	})
}

// ─── Batch oracle hook ───

export interface FlightWithData {
	flightId: string
	date: bigint
	data: FlightData | null
	error: boolean
}

export function useFlightDataBatch(
	flights: Array<readonly [string, bigint]> | undefined,
) {
	return useQuery({
		queryKey: [
			"oracle",
			"allFlightData",
			flights?.map(([f, d]) => `${f}:${d}`).join(","),
		],
		queryFn: async () => {
			if (!flights) return []
			const results: FlightWithData[] = await Promise.all(
				flights.map(async ([flightId, date]) => {
					try {
						const tx = await oracleClient.get_flight_data({
							flight_id: flightId,
							date,
						})
						return { flightId, date, data: tx.result as FlightData, error: false }
					} catch {
						return { flightId, date, data: null, error: true }
					}
				}),
			)
			return results
		},
		enabled: !!flights && flights.length > 0,
		refetchInterval: 30_000,
	})
}

// ─── Flight Pool Manager reads ───

export function useFlightConfig(
	flightId: string,
	date: bigint,
	enabled = true,
) {
	return useQuery({
		queryKey: ["pool", "flightConfig", flightId, date.toString()],
		queryFn: async () => {
			const tx = await flightPoolManagerClient.get_flight_config({
				flight_id: flightId,
				date,
			})
			return (tx.result ?? null) as FlightConfig | null
		},
		enabled,
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Batch pool config + claim state for the traveler's flights. */
export interface PolicyWithState {
	flightId: string
	date: bigint
	config: FlightConfig | null
	claimed: boolean
	error: boolean
}

export function usePolicyStateBatch(
	flights: Array<readonly [string, bigint]> | undefined,
	traveler: string | undefined,
) {
	return useQuery({
		queryKey: [
			"pool",
			"policyState",
			traveler,
			flights?.map(([f, d]) => `${f}:${d}`).join(","),
		],
		queryFn: async () => {
			if (!flights || !traveler) return []
			const results: PolicyWithState[] = await Promise.all(
				flights.map(async ([flightId, date]) => {
					try {
						const [cfgTx, claimedTx] = await Promise.all([
							flightPoolManagerClient.get_flight_config({
								flight_id: flightId,
								date,
							}),
							flightPoolManagerClient.has_claimed({
								flight_id: flightId,
								date,
								traveler,
							}),
						])
						return {
							flightId,
							date,
							config: (cfgTx.result ?? null) as FlightConfig | null,
							claimed: claimedTx.result as boolean,
							error: false,
						}
					} catch {
						return { flightId, date, config: null, claimed: false, error: true }
					}
				}),
			)
			return results
		},
		enabled: !!flights && flights.length > 0 && !!traveler,
		refetchInterval: 30_000,
	})
}

export function useRecoveredBalance() {
	return useQuery({
		queryKey: ["pool", "recoveredBalance"],
		queryFn: async () => {
			const tx = await flightPoolManagerClient.get_recovered_balance()
			return tx.result as bigint
		},
		refetchInterval: 60_000,
		retry: 1,
	})
}

// ─── USDC balance ───

export function useUsdcBalance(address: string | undefined) {
	return useQuery({
		queryKey: ["usdc", "balance", address],
		queryFn: async () => {
			if (!address) return 0n
			const tx = await mockUsdcClient.balance({ account: address })
			return tx.result as bigint
		},
		enabled: !!address,
		refetchInterval: 15_000,
		retry: 1,
	})
}

// ─── Contract clients (for write calls in components) ───

export {
	controllerClient,
	riskVaultClient,
	governanceClient,
	oracleClient,
	mockUsdcClient,
	flightPoolManagerClient,
}
