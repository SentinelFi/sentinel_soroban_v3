//! Cross-contract client for the OracleAggregator. The vault reads the oracle's
//! pending-outcome flag to block entry/exit while a flight outcome is public but
//! not yet financially settled (so LPs cannot transact at a stale share price).
#![allow(dead_code)]

use soroban_sdk::{contractclient, Env};

#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    fn has_pending_outcomes(env: &Env) -> bool;
}
