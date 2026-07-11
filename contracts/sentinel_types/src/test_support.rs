// Shared test scaffolding used by every contract's unit-test suite plus the
// integration_tests crate. Gated behind the `testutils` feature so production
// builds don't pull in soroban-sdk's testutils.

use soroban_sdk::xdr::{ContractEventBody, ScAddress, ScVal};
use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Events as _, Address, Env, TryFromVal, Val,
    Vec,
};

/// Minimal OracleAggregator stand-in for unit tests. The RiskVault requires an
/// oracle address at construction (its settlement barrier consults
/// `has_pending_outcomes` on every LP entry/exit), so suites that don't want
/// the full OracleAggregator register this instead: it answers with a settable
/// flag, defaulting to `false` (barrier open).
#[contract]
pub struct MockPendingOracle;

#[contractimpl]
impl MockPendingOracle {
    /// Set the value `has_pending_outcomes` reports.
    pub fn set_pending_outcomes(e: &Env, pending: bool) {
        e.storage()
            .instance()
            .set(&symbol_short!("pending"), &pending);
    }

    /// Mirror of `OracleAggregator::has_pending_outcomes` — the only entry
    /// point the vault's settlement barrier calls.
    pub fn has_pending_outcomes(e: &Env) -> bool {
        e.storage()
            .instance()
            .get(&symbol_short!("pending"))
            .unwrap_or(false)
    }
}

/// Decode the testutils `ContractEvents` wrapper (soroban-sdk 25+) back into
/// the pre-25 `(contract_address, topics, data)` tuple shape every contract's
/// event assertions rely on. Returns events from the MOST RECENT contract
/// invocation only — call immediately after the emitting tx and before any
/// other contract call (including reads).
pub fn collect_events(env: &Env) -> Vec<(Address, Vec<Val>, Val)> {
    let mut out: Vec<(Address, Vec<Val>, Val)> = Vec::new(env);
    for e in env.events().all().events() {
        let cid = e.contract_id.clone().unwrap();
        let addr = Address::try_from_val(env, &ScVal::Address(ScAddress::Contract(cid))).unwrap();
        let ContractEventBody::V0(body) = &e.body;
        let mut topics: Vec<Val> = Vec::new(env);
        for sv in body.topics.iter() {
            topics.push_back(Val::try_from_val(env, sv).unwrap());
        }
        let data = Val::try_from_val(env, &body.data).unwrap();
        out.push_back((addr, topics, data));
    }
    out
}
