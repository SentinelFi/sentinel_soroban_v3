use soroban_sdk::{contractimpl, token, Address, Env, Symbol};

use crate::auth::extend_instance_ttl;
use crate::events::InsuranceBought;
use crate::interfaces::{FlightPoolManagerClient, GovClient, OracleClient, RouteStatus, VaultClient};
use crate::storage::{append_traveler_flight, CtrlKey};
use crate::{Controller, ControllerArgs, ControllerClient};

#[contractimpl]
impl Controller {
    pub fn buy_insurance(
        e: &Env,
        traveler: Address,
        flight_id: Symbol,
        origin: Symbol,
        dest: Symbol,
        date: u64,
    ) {
        traveler.require_auth();

        let gov_addr: Address = e.storage().instance().get(&CtrlKey::Governance).unwrap();
        let vault_addr: Address = e.storage().instance().get(&CtrlKey::RiskVault).unwrap();
        let oracle_addr: Address = e.storage().instance().get(&CtrlKey::Oracle).unwrap();
        let pool_addr: Address = e
            .storage()
            .instance()
            .get(&CtrlKey::FlightPoolManager)
            .unwrap();
        let usdc_addr: Address = e.storage().instance().get(&CtrlKey::UsdcToken).unwrap();
        let controller_addr = e.current_contract_address();

        // 1+2. Validate route + read terms in one cross-contract call.
        let gov = GovClient::new(e, &gov_addr);
        let terms = match gov.route_status(&flight_id, &origin, &dest) {
            RouteStatus::Active(t) => t,
            RouteStatus::Disabled => panic!("route is disabled"),
            RouteStatus::Unknown => panic!("route not whitelisted"),
        };

        // 3. Enforce minimum lead time.
        let min_lead: u64 = e.storage().instance().get(&CtrlKey::MinLeadTime).unwrap();
        let earliest_allowed = e
            .ledger()
            .timestamp()
            .checked_add(min_lead)
            .expect("addition overflow");
        assert!(date > earliest_allowed, "departure too soon");

        // 4. Look up flight in the singleton FlightPoolManager. If missing,
        //    register it (locks terms) AND register the same (flight_id, date)
        //    in the oracle so the off-chain fetcher can populate
        //    estimated/actual arrival times.
        let pool = FlightPoolManagerClient::new(e, &pool_addr);
        if pool.get_flight_config(&flight_id, &date).is_none() {
            pool.register_flight(
                &controller_addr,
                &flight_id,
                &date,
                &terms.premium,
                &terms.payoff,
                &terms.delay_hours,
            );
            let oracle = OracleClient::new(e, &oracle_addr);
            oracle.register_flight(&controller_addr, &flight_id, &date);
        }

        // 5. Solvency check.
        let vault = VaultClient::new(e, &vault_addr);
        let free_capital = vault.get_free_capital();
        let solvency_ratio: u32 = e
            .storage()
            .instance()
            .get(&CtrlKey::SolvencyRatio)
            .unwrap();
        let required = terms
            .payoff
            .checked_mul(solvency_ratio as i128)
            .expect("multiplication overflow")
            .checked_div(100)
            .expect("division by zero");
        assert!(free_capital >= required, "insufficient vault capital");

        // 6. Transfer premium directly from traveler to FlightPoolManager.
        //    Soroban auth propagates: the traveler signed buy_insurance, so
        //    this sub-invocation transfer is authorized.
        let usdc = token::Client::new(e, &usdc_addr);
        usdc.transfer(&traveler, &pool_addr, &terms.premium);

        // 7. Lock collateral in vault.
        vault.increase_locked(&controller_addr, &terms.payoff);

        // 8. Record buyer in FlightPoolManager.
        pool.add_buyer(&controller_addr, &flight_id, &date, &traveler);

        // 9. Append to per-traveler index (unblocks MyPolicies frontend).
        append_traveler_flight(e, &traveler, &flight_id, date);

        // 10. Update aggregate counters.
        let sold: u64 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPoliciesSold)
            .unwrap_or(0);
        e.storage().instance().set(
            &CtrlKey::TotalPoliciesSold,
            &sold.checked_add(1).expect("addition overflow"),
        );

        let collected: i128 = e
            .storage()
            .instance()
            .get(&CtrlKey::TotalPremiumsCollected)
            .unwrap_or(0);
        e.storage().instance().set(
            &CtrlKey::TotalPremiumsCollected,
            &collected
                .checked_add(terms.premium)
                .expect("addition overflow"),
        );

        extend_instance_ttl(e);

        InsuranceBought {
            traveler,
            premium: terms.premium,
        }
        .publish(e);
    }
}
