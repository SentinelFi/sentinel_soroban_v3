use sentinel_types::test_support::collect_events;
use soroban_sdk::{
    symbol_short, testutils::Address as _, testutils::Ledger as _, token, Address, Env, Symbol,
    TryFromVal,
};

pub const PREMIUM: i128 = 10_0000000; // 10 USDC (7 decimals)
pub const PAYOFF: i128 = 50_0000000; // 50 USDC
pub const DELAY_HOURS: u32 = 3;
pub const FLIGHT_DATE: u64 = 1_710_500_000;
pub const MIN_LEAD_TIME: u64 = 3_600;
pub const CLAIM_EXPIRY_WINDOW: u64 = 5_184_000; // 60 days
pub const DEPOSIT_AMOUNT: i128 = 1_000_0000000; // 1000 USDC
pub const INITIAL_TIMESTAMP: u64 = 1_710_400_000;
pub const EST_ARRIVAL: u64 = 1_710_500_000;
pub const ACTUAL_ON_TIME: u64 = 1_710_501_800; // 30min late (< 3h)
pub const ACTUAL_DELAYED: u64 = 1_710_510_800; // ~3h late (>= 3h)

#[allow(dead_code)]
pub struct TestEnv {
    pub env: Env,
    pub ctrl: controller::ControllerClient<'static>,
    pub ctrl_addr: Address,
    pub vault: risk_vault::RiskVaultClient<'static>,
    pub vault_addr: Address,
    pub oracle: oracle_aggregator::OracleAggregatorClient<'static>,
    pub oracle_addr: Address,
    pub pool: flight_pool_manager::FlightPoolManagerClient<'static>,
    pub pool_addr: Address,
    pub gov: governance_module::GovernanceModuleClient<'static>,
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
        // Required for the 3-deep contract auth chain
        // (keeper -> controller -> pool -> vault). Plain mock_all_auths only
        // handles root-frame auth.
        env.mock_all_auths_allowing_non_root_auth();
        env.ledger().with_mut(|l| l.timestamp = INITIAL_TIMESTAMP);

        let owner = Address::generate(&env);
        let keeper = Address::generate(&env);
        let usdc_admin_addr = Address::generate(&env);
        let oracle_account = Address::generate(&env);

        // USDC (Stellar Asset Contract)
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

        // FlightPoolManager
        let pool_addr = env.register(
            flight_pool_manager::FlightPoolManager,
            (&owner, &usdc_id.address(), &vault_addr),
        );
        let pool = flight_pool_manager::FlightPoolManagerClient::new(&env, &pool_addr);

        // Controller
        let ctrl_addr = env.register(
            controller::Controller,
            (
                &owner,
                &gov_addr,
                &vault_addr,
                &oracle_addr,
                &pool_addr,
                &usdc_id.address(),
                &keeper,
                &MIN_LEAD_TIME,
                &CLAIM_EXPIRY_WINDOW,
            ),
        );
        let ctrl = controller::ControllerClient::new(&env, &ctrl_addr);

        // Wire one-time controllers on the three downstream contracts.
        vault.set_controller(&ctrl_addr);
        oracle.set_controller(&ctrl_addr);
        pool.set_controller(&ctrl_addr);

        // Whitelist the default test route.
        gov.whitelist_route(
            &owner,
            &symbol_short!("AA100"),
            &symbol_short!("JFK"),
            &symbol_short!("LAX"),
            &None::<i128>,
            &None::<i128>,
            &None::<u32>,
        );

        // Seed underwriter capital so solvency checks pass.
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
            pool,
            pool_addr,
            gov,
            usdc,
            usdc_admin,
            usdc_addr: usdc_id.address(),
            owner,
            keeper,
            oracle_account,
            underwriter,
        }
    }

    /// Mint PREMIUM USDC to the traveler and call `controller.buy_insurance`
    /// for the default route + FLIGHT_DATE.
    #[allow(dead_code)]
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

    /// Same as `buy` but for an arbitrary flight_id + date (default origin/dest).
    #[allow(dead_code)]
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

    /// Drive the default flight to Landed-on-time via oracle calls.
    #[allow(dead_code)]
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

    /// Drive the default flight to Landed-delayed (>= delay_hours) via oracle calls.
    #[allow(dead_code)]
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

    /// Drive the default flight to Cancelled via oracle calls.
    #[allow(dead_code)]
    pub fn oracle_cancelled(&self) {
        self.oracle.set_estimated_arrival(
            &self.oracle_account,
            &symbol_short!("AA100"),
            &FLIGHT_DATE,
            &EST_ARRIVAL,
        );
        self.oracle
            .set_cancelled(&self.oracle_account, &symbol_short!("AA100"), &FLIGHT_DATE);
    }

    /// Run the full classify + execute settlement cycle (Crons #2 + #3) plus
    /// the queue/snapshot maintenance pass (split out by audit M-03).
    #[allow(dead_code)]
    pub fn classify_and_settle(&self) {
        self.ctrl.classify_flights(&self.keeper);
        self.ctrl.execute_settlements(&self.keeper);
        self.ctrl.run_queue_maintenance(&self.keeper);
    }

    /// Advance ledger time by `seconds`.
    #[allow(dead_code)]
    pub fn advance_time(&self, seconds: u64) {
        let now = self.env.ledger().timestamp();
        self.env.ledger().with_mut(|l| l.timestamp = now + seconds);
    }
}

/// Count events emitted on `addr` whose protocol-prefix topics match
/// `["sentinel", prefix0, prefix1]`. Reused across all integration test
/// groups. The leading `"sentinel"` symbol is implicit — callers pass the
/// post-namespace prefixes they care about.
///
/// IMPORTANT: `env.events().all()` returns events from the MOST RECENT
/// contract invocation only. Subsequent contract calls (even read-only)
/// clear the event log. Call this helper IMMEDIATELY after the emitting
/// invocation, before any further client method calls.
#[allow(dead_code)]
pub fn count_events_with_topic(env: &Env, addr: &Address, prefix0: Symbol, prefix1: Symbol) -> u32 {
    let mut count: u32 = 0;
    let sentinel = symbol_short!("sentinel");
    for (event_addr, topics, _data) in collect_events(env).iter() {
        if event_addr != *addr {
            continue;
        }
        if topics.len() < 3 {
            continue;
        }
        let t0: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(0).unwrap());
        let t1: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(1).unwrap());
        let t2: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(2).unwrap());
        if let (Ok(s0), Ok(s1), Ok(s2)) = (t0, t1, t2) {
            if s0 == sentinel && s1 == prefix0 && s2 == prefix1 {
                count += 1;
            }
        }
    }
    count
}

/// Same as `count_events_with_topic` but for events with a single-symbol
/// post-namespace prefix (e.g. `topics = ["sentinel", "register"]`).
#[allow(dead_code)]
pub fn count_events_with_single_prefix(env: &Env, addr: &Address, prefix: Symbol) -> u32 {
    let mut count: u32 = 0;
    let sentinel = symbol_short!("sentinel");
    for (event_addr, topics, _data) in collect_events(env).iter() {
        if event_addr != *addr {
            continue;
        }
        if topics.len() < 2 {
            continue;
        }
        let t0: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(0).unwrap());
        let t1: Result<Symbol, _> = Symbol::try_from_val(env, &topics.get(1).unwrap());
        if let (Ok(s0), Ok(s1)) = (t0, t1) {
            if s0 == sentinel && s1 == prefix {
                count += 1;
            }
        }
    }
    count
}
