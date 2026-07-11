use soroban_sdk::{panic_with_error, Address, Env};

use sentinel_types::interfaces::OracleClient;

use crate::storage::VaultKey;
use crate::Error;

pub(crate) use sentinel_types::ttl::{INSTANCE_TTL_EXTEND, INSTANCE_TTL_THRESHOLD};

pub(crate) fn require_controller(e: &Env, controller: &Address) {
    controller.require_auth();
    let stored: Address = e
        .storage()
        .instance()
        .get(&VaultKey::Controller)
        .expect("controller not set");
    if controller != &stored {
        panic_with_error!(e, Error::NotController);
    }
}

/// Whether any flight outcome is public but not yet financially settled, per the
/// configured oracle. Returns false when no oracle is configured (the gate is
/// inactive until the deployment wires it via `set_oracle`).
pub(crate) fn settlement_pending(e: &Env) -> bool {
    let oracle: Option<Address> = e.storage().instance().get(&VaultKey::Oracle);
    match oracle {
        Some(addr) => OracleClient::new(e, &addr).has_pending_outcomes(),
        None => false,
    }
}

/// Block LP entry/exit while pending PnL is unrecognized. Pricing a deposit,
/// mint, withdraw, or redeem while a flight outcome is public but unsettled would
/// let an LP take the pre-outcome share price and shift the pending gain/loss to
/// the other LPs. During such windows LPs must use `request_withdrawal`, which is
/// priced only when the queue is processed after settlement.
pub(crate) fn assert_no_settlement_pending(e: &Env) {
    if settlement_pending(e) {
        panic_with_error!(e, Error::SettlementPending);
    }
}
