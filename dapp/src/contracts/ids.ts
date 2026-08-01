/**
 * The single edit point for contract addresses. A redeploy (see the
 * vault-redeploy runbook) means updating this file — or, without a code
 * change, setting the matching PUBLIC_*_ID env vars at build time.
 * Defaults: 2026-07-18 testnet deployment (mirrors api/_lib/config.ts).
 */
const env = import.meta.env

export const CONTRACT_IDS = {
	controller:
		(env.PUBLIC_CONTROLLER_ID as string | undefined) ||
		"CBDJIPZOC7KH3ICK57MAUZMUXBQ5XF56WJLRP2OY6FF5V2HOFDOFXVY3",
	governanceModule:
		(env.PUBLIC_GOVERNANCE_ID as string | undefined) ||
		"CATUCJILWACDDEAIFXRL6HXSYDZ7TLOXHMUBKBG4URDOUJHEO7QAJ6NE",
	oracleAggregator:
		(env.PUBLIC_ORACLE_AGGREGATOR_ID as string | undefined) ||
		"CDMKBMNJ2YZTARAM4ZUU7HZJZA7UUYJU76ZOAN2SCR3WJYZSSHXV7ESW",
	riskVault:
		(env.PUBLIC_RISK_VAULT_ID as string | undefined) ||
		"CCJLBWEOPNUHIUNOGZMUDQ6EGO563SA3WSEX2NENEDCTJDZOKN3LLDKF",
	mockUsdc:
		(env.PUBLIC_MOCK_USDC_ID as string | undefined) ||
		"CDYZY5QA77SCNRKS7AOSVLCRKGI7TKYCWNAIHMOAKTZ5FLS3SR5MAE5Z",
	flightPoolManager:
		(env.PUBLIC_FLIGHT_POOL_MANAGER_ID as string | undefined) ||
		"CAA7DVZKQEA7JENAMI7DEKPGAWJQMPY6MKDED2DG2ZCK2G535X5V2PI7",
} as const
