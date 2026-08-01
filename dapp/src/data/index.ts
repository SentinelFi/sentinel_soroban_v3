/**
 * Data-layer facade.
 *
 * Pages should import protocol data from here rather than reaching into
 * `../hooks/useContracts` or the raw contract clients directly. This module is
 * deliberately THIN: it re-exports the existing React Query hooks under stable
 * names and adds the derived selectors from `./derived`. It duplicates no
 * contract logic.
 *
 * Existing pages still import from `../hooks/useContracts` today — later waves
 * migrate them to this facade as they touch each page.
 */

// ── stats / protocol-wide ──────────────────────────────────────────
export {
	useProtocolStats,
	useSolvencyRatio,
	useKeeper,
} from "../hooks/useContracts"

// ── routes / markets ───────────────────────────────────────────────
export {
	useRoutes,
	useActiveRoutes,
	useGovernanceDefaults,
} from "../hooks/useContracts"
export type { UiRoute } from "../hooks/useContracts"

// ── active flights / oracle flight data ────────────────────────────
export {
	useActiveFlights,
	useFlightData,
	useFlightDataBatch,
	useAuthorizedOracle,
} from "../hooks/useContracts"
export type { FlightWithData } from "../hooks/useContracts"

// ── policies (traveler) ────────────────────────────────────────────
export {
	useTravelerFlights,
	usePolicyStateBatch,
	useFlightConfig,
} from "../hooks/useContracts"
export type { PolicyWithState } from "../hooks/useContracts"

// ── vault reads ────────────────────────────────────────────────────
export {
	useTotalAssets,
	useFreeCapital,
	useLockedCapital,
	useVaultBalance,
	useConvertToAssets,
	useSnapshotPrice,
	useWithdrawalQueue,
	useClaimableBalance,
	useRecoveredBalance,
} from "../hooks/useContracts"

// ── whitelist / admin ──────────────────────────────────────────────
export {
	useWhitelistEnabled,
	useIsWhitelisted,
	useIsAdmin,
} from "../hooks/useContracts"

// ── usdc balance ───────────────────────────────────────────────────
export { useUsdcBalance } from "../hooks/useContracts"

// ── helpers + clients (re-exposed for write paths; the wallet→client
// publicKey sync now lives in WalletProvider) ──────────────────────
export {
	formatUsdc,
	parseUsdc,
	controllerClient,
	riskVaultClient,
	governanceClient,
	oracleClient,
	mockUsdcClient,
	flightPoolManagerClient,
} from "../hooks/useContracts"

// ── derived selectors (estimates / illustrative — labelled in UI) ──
export {
	routeRisk,
	useTvlSparkline,
	useApySparkline,
	useSharePriceSeries,
	useTrackedFlights,
	TRACKED_MAP_LIMIT,
	airportCoords,
	INTL_HUBS,
} from "./derived"
export type {
	RouteRisk,
	RiskBand,
	SharePricePoint,
	SharePriceSeries,
	AirportCoord,
	TrackedFlight,
	TrackedStatus,
} from "./derived"
