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

import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import type { ResolvedTerms } from "governance_module"
import type { FlightConfig } from "flight_pool_manager"
import type { FlightData } from "oracle_aggregator"
import controllerClient from "../contracts/controller"
import governanceClient from "../contracts/governance_module"
import oracleClient from "../contracts/oracle_aggregator"
import riskVaultClient from "../contracts/risk_vault"
import mockUsdcClient from "../contracts/mock_usdc"
import flightPoolManagerClient from "../contracts/flight_pool_manager"
import { CANDIDATE_ROUTES } from "../config/routes"

// NOTE: the wallet→client publicKey sync now lives in WalletProvider —
// it runs once for every page, so write pages no longer need (and no
// longer have) a per-page useContractSync() call.

// Formatting lives in lib/format.ts; re-exported here because most
// pages already import these alongside the hooks.
export { formatUsdc, parseUsdc } from "../lib/format"

// ─── Controller reads ───

export function useProtocolStats() {
	return useQuery({
		queryKey: ["controller", "stats"],
		queryFn: async () => {
			const tx = await controllerClient.get_stats()
			// (total_policies_sold, total_premiums_collected, total_payouts_distributed)
			const [sold, premiumsCollected, payoutsDistributed] = tx.result
			return {
				totalPoliciesSold: Number(sold),
				totalPremiumsCollected: premiumsCollected,
				totalPayoutsDistributed: payoutsDistributed,
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
			return tx.result
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
			return tx.result
		},
		retry: 1,
	})
}

export function useSolvencyRatio() {
	return useQuery({
		queryKey: ["controller", "solvencyRatio"],
		queryFn: async () => {
			const tx = await controllerClient.get_solvency_ratio()
			return tx.result
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
			return tx.result
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
			return tx.result
		},
		enabled: !!address,
		refetchInterval: 60_000,
		retry: 1,
	})
}

// ─── Risk Vault reads ───

// Vault-level figures (TVL / locked / free) only move when a transaction
// lands, and every write flow invalidates the ["vault"] keys — so instead
// of a permanent 30s poll these load once per visit, serve from cache for
// 5 minutes across navigations, retry with exponential backoff on
// failure, and keep self-healing on a slow 60s cadence only while in an
// error state.
const VAULT_STAT_STALE_MS = 300_000
const VAULT_STAT_ERROR_RETRY_MS = 60_000

export function useTotalAssets() {
	return useQuery({
		queryKey: ["vault", "totalAssets"],
		queryFn: async () => {
			const tx = await riskVaultClient.total_assets()
			return tx.result
		},
		staleTime: VAULT_STAT_STALE_MS,
		retry: 2,
		refetchInterval: (query) =>
			query.state.status === "error" ? VAULT_STAT_ERROR_RETRY_MS : false,
	})
}

export function useFreeCapital() {
	return useQuery({
		queryKey: ["vault", "freeCapital"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_free_capital()
			return tx.result
		},
		staleTime: VAULT_STAT_STALE_MS,
		retry: 2,
		refetchInterval: (query) =>
			query.state.status === "error" ? VAULT_STAT_ERROR_RETRY_MS : false,
	})
}

export function useLockedCapital() {
	return useQuery({
		queryKey: ["vault", "lockedCapital"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_locked_capital()
			return tx.result
		},
		staleTime: VAULT_STAT_STALE_MS,
		retry: 2,
		refetchInterval: (query) =>
			query.state.status === "error" ? VAULT_STAT_ERROR_RETRY_MS : false,
	})
}

export function useVaultBalance(address: string | undefined) {
	return useQuery({
		queryKey: ["vault", "balance", address],
		queryFn: async () => {
			if (!address) return 0n
			const tx = await riskVaultClient.balance({ account: address })
			return tx.result
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
			return tx.result
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
			return tx.result
		},
		retry: 1,
	})
}

export function useWithdrawalQueue() {
	return useQuery({
		queryKey: ["vault", "withdrawalQueue"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_withdrawal_queue()
			// WithdrawalRequest { owner, request_id, shares, requested_at }
			return tx.result
		},
		refetchInterval: 15_000,
		retry: 1,
	})
}

export function useDepositQueue() {
	return useQuery({
		queryKey: ["vault", "depositQueue"],
		queryFn: async () => {
			const tx = await riskVaultClient.get_deposit_queue()
			// DepositRequest { owner, request_id, assets, requested_at }
			return tx.result
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
			return tx.result
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
	/** IATA carrier ("AS"), needed for airline names and FlightRadar links —
	 *  flightId is the ICAO ident ("ASA462"), which neither accepts. */
	carrier?: string | null
	/** Real ML delay probability for this route, when the catalog has one. */
	pCovered?: number | null
	/** True when pCovered is the seasonal peak rather than one priced date. */
	pCoveredIsPeak?: boolean
	/** Origin-LOCAL scheduled departure HHMM (e.g. 1730) from the pricing
	 *  run — an approximate display hint for the UTC-vs-boarding-pass date
	 *  disclosure in the BetSlip. */
	depTimeLocalHhmm?: number | null
	/** IANA zone of the origin airport, when the catalog knows it. */
	originTz?: string | null
}

/** Row shape served by GET /api/routes (see api/routes.ts). */
interface ApiRouteRow {
	flight_id: string
	origin: string
	destination: string
	carrier: string | null
	status: "Active" | "Disabled"
	premium_units: string
	/** Resolved on-chain premium (base + any weather surcharge). Null when
	 *  the catalog could not resolve it — fall back to premium_units. */
	chain_premium_units: string | null
	p_covered: number | null
	p_covered_is_peak?: boolean
	dep_time_local_hhmm?: number | null
	origin_tz?: string | null
	payoff_units: string
	delay_hours: number
	featured: boolean
}

/**
 * Primary board source: one CDN-cached catalog fetch (api/routes.ts)
 * instead of per-route on-chain simulates — the full seeded fleet in a
 * single request, regardless of how many routes it holds. Premium/payoff
 * arrive as i128 base-unit strings; parse to bigint so the rows carry
 * real `ResolvedTerms`. Featured rows (routes.live.json) pin to the top;
 * the sort is stable, so API order holds within each group.
 *
 * Terms here mirror chain state at seed time (plus the DB pause overlay),
 * so they can lag a governance change by up to the CDN window — the
 * BetSlip re-verifies `route_status` on-chain at buy time.
 */
async function fetchRouteCatalog(): Promise<UiRoute[]> {
	const res = await fetch("/api/routes")
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	const body = (await res.json()) as { count: number; routes: ApiRouteRow[] }
	const ordered = [...(body.routes ?? [])].sort(
		(a, b) => Number(b.featured) - Number(a.featured),
	)
	return ordered.map((row) => ({
		flightId: row.flight_id,
		origin: row.origin,
		dest: row.destination,
		status: row.status,
		carrier: row.carrier,
		pCovered: row.p_covered,
		pCoveredIsPeak: row.p_covered_is_peak ?? false,
		depTimeLocalHhmm: row.dep_time_local_hhmm ?? null,
		originTz: row.origin_tz ?? null,
		terms:
			row.status === "Active"
				? {
						// Prefer the chain's number: the fleet-file base omits any
						// weather surcharge, so showing it would advertise a price
						// below what the BetSlip actually charges.
						premium: BigInt(row.chain_premium_units ?? row.premium_units),
						payoff: BigInt(row.payoff_units),
						delay_hours: row.delay_hours,
					}
				: null,
	}))
}

/**
 * Fallback resolver: the pre-catalog chunked on-chain scan, kept as the
 * resilience path for when /api/routes isn't deployed (or answers empty).
 * Resolves CANDIDATE_ROUTES against `route_status` — GovernanceModule has
 * no route enumeration (see src/config/routes.ts) — in chunks of 20
 * rather than one giant Promise.all, to stay friendly to the public RPC.
 *
 * On the FIRST scan (no cached data yet) each resolved chunk is published
 * into the query cache immediately, so the board fills in as chunks land
 * instead of blocking on all of them. Background refetches keep the
 * previous full list on screen until the new scan completes.
 */
const ROUTE_RESOLVE_CHUNK = 20
const ROUTES_QUERY_KEY = ["governance", "routes"] as const

async function scanCandidateRoutes(
	queryClient: QueryClient,
): Promise<UiRoute[]> {
	const isFirstScan =
		queryClient.getQueryData(ROUTES_QUERY_KEY) === undefined
	const results: UiRoute[] = []
	for (
		let i = 0;
		i < CANDIDATE_ROUTES.length;
		i += ROUTE_RESOLVE_CHUNK
	) {
		const chunk = CANDIDATE_ROUTES.slice(i, i + ROUTE_RESOLVE_CHUNK)
		const resolved = await Promise.all(
			chunk.map(async (route): Promise<UiRoute> => {
				try {
					const tx = await governanceClient.route_status({
						flight_id: route.flightId,
						origin: route.origin,
						dest: route.dest,
					})
					const status = tx.result
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
		results.push(...resolved)
		// Stream partials only while the board has nothing real yet —
		// a background refetch must not shrink the visible list.
		if (
			isFirstScan &&
			i + ROUTE_RESOLVE_CHUNK < CANDIDATE_ROUTES.length
		) {
			queryClient.setQueryData(ROUTES_QUERY_KEY, [...results])
		}
	}
	return results
}

/** Board inventory: /api/routes catalog first, on-chain scan fallback. */
export function useRoutes() {
	const queryClient = useQueryClient()
	return useQuery({
		queryKey: ROUTES_QUERY_KEY,
		queryFn: async () => {
			try {
				const catalog = await fetchRouteCatalog()
				if (catalog.length > 0) return catalog
				// Empty catalog → treat as "endpoint not seeded yet" and let
				// the chain scan decide what actually exists.
			} catch {
				/* endpoint unreachable/undeployed — chain scan below */
			}
			return scanCandidateRoutes(queryClient)
		},
		refetchInterval: 300_000,
		staleTime: 120_000,
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
			const [default_premium, default_payoff, default_delay_hours] = tx.result
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
			return tx.result
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
			return tx.result
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
			return tx.result
		},
		enabled,
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Oracle outcomes attested but not yet drained by the settle sweep. */
export function usePendingOutcomes() {
	return useQuery({
		queryKey: ["oracle", "pendingOutcomes"],
		queryFn: async () => {
			const tx = await oracleClient.get_pending_outcomes()
			return tx.result
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Sale-authorization expiry for (flight, date): unix seconds, or null
 *  when no authorization is live (never opened, closed, or lapsed). */
export function useSaleAuth(flightId: string, date: bigint, enabled = true) {
	return useQuery({
		queryKey: ["oracle", "saleAuth", flightId, date.toString()],
		queryFn: async () => {
			const tx = await oracleClient.get_sale_auth({
				flight_id: flightId,
				date,
			})
			return tx.result ?? null
		},
		enabled,
		refetchInterval: 60_000,
		retry: 1,
	})
}

export function useAuthorizedOracle() {
	return useQuery({
		queryKey: ["oracle", "authorizedOracle"],
		queryFn: async () => {
			const tx = await oracleClient.get_authorized_oracle()
			return tx.result
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

/** On-chain active_set caps at 100k flights (sentinel_types::active_set)
 *  — firing one RPC call per entry unbounded would let a busy fleet flood
 *  the public RPC every 30s. A worker pool of this size keeps the burst
 *  flat regardless of how many flights are actually active. */
const FLIGHT_DATA_CONCURRENCY = 50

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let next = 0
	async function worker() {
		while (next < items.length) {
			const i = next++
			results[i] = await fn(items[i])
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	)
	return results
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
			return mapWithConcurrency(flights, FLIGHT_DATA_CONCURRENCY, async ([flightId, date]) => {
				try {
					const tx = await oracleClient.get_flight_data({
						flight_id: flightId,
						date,
					})
					return { flightId, date, data: tx.result, error: false }
				} catch {
					return { flightId, date, data: null, error: true }
				}
			})
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
			return tx.result ?? null
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
							config: cfgTx.result ?? null,
							claimed: claimedTx.result,
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

/** How many insured flight instances are currently live in the pool. */
export function useActiveFlightCount() {
	return useQuery({
		queryKey: ["pool", "activeFlightCount"],
		queryFn: async () => {
			const tx = await flightPoolManagerClient.get_active_flight_count()
			return tx.result
		},
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Whether `traveler` holds a policy on (flight, date). */
export function useHasPolicy(
	flightId: string,
	date: bigint,
	traveler: string | undefined,
) {
	return useQuery({
		queryKey: ["pool", "hasPolicy", flightId, date.toString(), traveler],
		queryFn: async () => {
			if (!traveler) return false
			const tx = await flightPoolManagerClient.has_policy({
				flight_id: flightId,
				date,
				traveler,
			})
			return tx.result
		},
		enabled: !!traveler,
		refetchInterval: 30_000,
		retry: 1,
	})
}

/** Whether `traveler` has already claimed their payout on (flight, date). */
export function useHasClaimed(
	flightId: string,
	date: bigint,
	traveler: string | undefined,
) {
	return useQuery({
		queryKey: ["pool", "hasClaimed", flightId, date.toString(), traveler],
		queryFn: async () => {
			if (!traveler) return false
			const tx = await flightPoolManagerClient.has_claimed({
				flight_id: flightId,
				date,
				traveler,
			})
			return tx.result
		},
		enabled: !!traveler,
		refetchInterval: 30_000,
		retry: 1,
	})
}

export function useRecoveredBalance() {
	return useQuery({
		queryKey: ["pool", "recoveredBalance"],
		queryFn: async () => {
			const tx = await flightPoolManagerClient.get_recovered_balance()
			return tx.result
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
			return tx.result
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
