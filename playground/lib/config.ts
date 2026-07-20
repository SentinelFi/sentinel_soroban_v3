// Network + deployment configuration for the Sentinel testnet playground.
// Addresses are taken from deployments/testnet.json in the Sentinel repo.
// Everything here is public information — this app holds no secrets.

export const NETWORK = {
  name: "testnet",
  passphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  explorerBase: "https://stellar.expert/explorer/testnet",
} as const;

export type ContractKey =
  | "controller"
  | "risk_vault"
  | "flight_pool_manager"
  | "oracle_aggregator"
  | "governance_module"
  | "mock_usdc";

export const CONTRACTS: Record<
  ContractKey,
  { label: string; address: string; description: string }
> = {
  controller: {
    label: "Controller",
    address: "CCWDQVAJCNMU2P35JF5RNGC7PM2LGWBXBSO6QUME2PJFK5LTVFNQZGHB",
    description:
      "Protocol orchestrator. Users buy flight-delay insurance here; the keeper classifies and settles flights through it.",
  },
  risk_vault: {
    label: "Risk Vault",
    address: "CAHUWF7GMAKZK34C3BBQWHA4GLAI2OSXGL25KMLW45INBDJMVQRAL3QW",
    description:
      "ERC-4626-style underwriter capital pool. Deposit USDC, receive RVS shares, earn premiums, back payouts.",
  },
  flight_pool_manager: {
    label: "Flight Pool Manager",
    address: "CD6XRCMKALQLB63ZYMA7GCW3Q2BQROGKYASRRRNZEFRPINQ6JFXO6YZT",
    description:
      "Per-flight policy state: premiums held per flight, buyer records, claim windows. Travelers claim payouts here.",
  },
  oracle_aggregator: {
    label: "Oracle Aggregator",
    address: "CBSX3KRT4JI7XAOB33OTGZMZVOFXOS2LWDQCQKR2UAGHRMWYMC2D6QUL",
    description:
      "Authoritative flight status: sale windows, arrival times, landed/cancelled outcomes, settlement lifecycle.",
  },
  governance_module: {
    label: "Governance Module",
    address: "CANSHOFUFZPLZPCVUQYL3LBO25FW5BP6AEVAMNN2QS2BINGDIVZVEWYZ",
    description:
      "Route whitelist and policy terms: which routes are insurable and at what premium / payoff / delay threshold.",
  },
  mock_usdc: {
    label: "Mock USDC",
    address: "CCGB4TFBJYG7FMMZYH4BZC5SJITQIJ33XTJHSKRAVFKOQKDBM4QJPTVB",
    description:
      "Testnet-only USDC token with a permissionless faucet (10,000 USDC per call).",
  },
};

export const ACCOUNTS = {
  owner: "GCEODBNVUGJVYQKWY7NMU4U3EIYQOXA7LADMQOPNB5PBBKMYCQJ7E6KD",
  oracle_executor: "GDPAV73VMO7K5BD6GXXP53KAH4UNXM3WIGNLALIGQVMEX7FBY4DPNTSO",
  keeper_executor: "GDIGW7URDVR3ZP3BNZWI7QKTQFXXGZUY2IV66M2GAXHQ6GBR4CPXRU2H",
} as const;

// Deployment parameters (deployments/testnet.json), for display only.
export const PARAMETERS = {
  default_premium: 500000000n, // 50 USDC
  default_payoff: 5000000000n, // 500 USDC
  default_delay_hours: 3,
  min_lead_time_secs: 3600,
  claim_expiry_window_secs: 5184000,
  min_withdrawal_request: 1000000000n, // 100 USDC
  solvency_ratio: 100,
} as const;

/** Mock USDC decimals. */
export const USDC_DECIMALS = 7;
/** Risk-vault share (RVS) decimals = asset 7 + virtual offset 3. */
export const SHARE_DECIMALS = 10;

/**
 * Source account used for read-only simulations when no wallet is connected.
 * Simulations are never submitted, so this signs nothing — any funded
 * account works; the protocol owner account is used as a stable default.
 */
export const SIMULATION_SOURCE = ACCOUNTS.owner;

export function explorerContractUrl(address: string): string {
  return `${NETWORK.explorerBase}/contract/${address}`;
}

export function explorerAccountUrl(address: string): string {
  return `${NETWORK.explorerBase}/account/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${NETWORK.explorerBase}/tx/${hash}`;
}
