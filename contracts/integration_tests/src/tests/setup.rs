use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger, token, Address, Env, Symbol,
};

mod flight_pool_wasm {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/flight_pool.wasm"
    );
}

pub const PREMIUM: i128 = 10_0000000; // 10 USDC (7 decimals)
pub const PAYOFF: i128 = 50_0000000; // 50 USDC
pub const DELAY_HOURS: u32 = 3;
pub const FLIGHT_DATE: u64 = 1710500000;
pub const MIN_LEAD_TIME: u64 = 3600;
pub const CLAIM_EXPIRY_WINDOW: u64 = 5_184_000; // 60 days
pub const DEPOSIT_AMOUNT: i128 = 1000_0000000; // 1000 USDC
pub const INITIAL_TIMESTAMP: u64 = 1710400000;
pub const EST_ARRIVAL: u64 = 1710500000;
pub const ACTUAL_ON_TIME: u64 = 1710501800; // 30 min late (< 3h)
pub const ACTUAL_DELAYED: u64 = 1710510800; // 3h late (>= 3h)

#[allow(dead_code)]
pub struct TestEnv {
    pub env: Env,
    pub ctrl: controller::ControllerClient<'static>,
    pub ctrl_addr: Address,
    pub vault: risk_vault::RiskVaultClient<'static>,
    pub vault_addr: Address,
    pub oracle: oracle_aggregator::OracleAggregatorClient<'static>,
    pub oracle_addr: Address,
    pub gov: governance_module::GovernanceModuleClient<'static>,
    pub recovery_addr: Address,
    pub usdc: token::Client<'static>,
    pub usdc_admin: token::StellarAssetClient<'static>,
    pub usdc_addr: Address,
    pub owner: Address,
    pub keeper: Address,
    pub oracle_account: Address,
    pub underwriter: Address,
}

impl TestEnv {
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

        let owner = Address::generate(&env);
        let keeper = Address::generate(&env);
        let usdc_admin_addr = Address::generate(&env);
        let oracle_account = Address::generate(&env);

        // USDC
        let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin_addr.clone());
        let usdc_admin = token::StellarAssetClient::new(&env, &usdc_id.address());
        let usdc = token::Client::new(&env, &usdc_id.address());

        // GovernanceModule
        let gov_addr = env.register(
            governance_module::GovernanceModule,
            (&owner, &PREMIUM, &PAYOFF, &DELAY_HOURS),
        );
        let gov = governance_module::GovernanceModuleClient::new(&env, &gov_addr);

        // RiskVault
        let vault_addr = env.register(risk_vault::RiskVault, (&owner, &usdc_id.address()));
        let vault = risk_vault::RiskVaultClient::new(&env, &vault_addr);

        // OracleAggregator
        let oracle_addr = env.register(
            oracle_aggregator::OracleAggregator,
            (&owner, &oracle_account),
        );
        let oracle = oracle_aggregator::OracleAggregatorClient::new(&env, &oracle_addr);

        // RecoveryPool
        let recovery_addr = env.register(
            recovery_pool::RecoveryPool,
            (&owner, &usdc_id.address()),
        );

        // FlightPool WASM
        let pool_wasm_hash = env.deployer().upload_contract_wasm(flight_pool_wasm::WASM);

        // Controller
        let ctrl_addr = env.register(
            controller::Controller,
            (
                &owner,
                &gov_addr,
                &vault_addr,
                &oracle_addr,
                &recovery_addr,
                &usdc_id.address(),
                &pool_wasm_hash,
                &keeper,
                &MIN_LEAD_TIME,
                &CLAIM_EXPIRY_WINDOW,
            ),
        );
        let ctrl = controller::ControllerClient::new(&env, &ctrl_addr);

        // Wire
        vault.set_controller(&ctrl_addr);
        oracle.set_controller(&ctrl_addr);

        // Whitelist default route
        gov.whitelist_route(
            &owner,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        );

        // Deposit underwriter capital
        let underwriter = Address::generate(&env);
        usdc_admin.mint(&underwriter, &DEPOSIT_AMOUNT);
        vault.deposit(&DEPOSIT_AMOUNT, &underwriter, &underwriter, &underwriter);

        TestEnv {
            env,
            ctrl,
            ctrl_addr,
            vault,
            vault_addr,
            oracle,
            oracle_addr,
            gov,
            recovery_addr,
            usdc,
            usdc_admin,
            usdc_addr: usdc_id.address(),
            owner,
            keeper,
            oracle_account,
            underwriter,
        }
    }

    pub fn buy(&self, traveler: &Address) {
        self.usdc_admin.mint(traveler, &PREMIUM);
        self.ctrl.buy_insurance(
            traveler,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &FLIGHT_DATE,
        );
    }

    pub fn buy_flight(&self, traveler: &Address, flight_id: &Symbol, date: u64) {
        self.usdc_admin.mint(traveler, &PREMIUM);
        self.ctrl.buy_insurance(
            traveler,
            flight_id,
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &date,
        );
    }

    pub fn oracle_on_time(&self) {
        self.oracle.set_estimated_arrival(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &EST_ARRIVAL,
        );
        self.oracle.set_landed(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &ACTUAL_ON_TIME,
        );
    }

    pub fn oracle_delayed(&self) {
        self.oracle.set_estimated_arrival(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &EST_ARRIVAL,
        );
        self.oracle.set_landed(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &ACTUAL_DELAYED,
        );
    }

    pub fn oracle_cancelled(&self) {
        self.oracle.set_estimated_arrival(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &EST_ARRIVAL,
        );
        self.oracle.set_cancelled(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
        );
    }

    pub fn classify_and_settle(&self) {
        self.ctrl.classify_flights(&self.keeper);
        self.ctrl.execute_settlements(&self.keeper);
    }

    pub fn pool_addr(&self) -> Address {
        self.ctrl
            .get_pool_address(&symbol_short!("AA100"), &FLIGHT_DATE)
            .unwrap()
    }

    pub fn pool_client(&self, addr: &Address) -> flight_pool::FlightPoolClient<'static> {
        flight_pool::FlightPoolClient::new(&self.env, addr)
    }

}
