// SPDX-License-Identifier: Apache-2.0
// Copyright @SentinelFi

#![no_std]
//! # FlightPoolManager — per-flight policy state
//!
//! A singleton holding all per-flight policy state in keyed storage (no
//! per-flight contract factory). Each flight, keyed by `(flight_id, date)`,
//! records its locked terms (premium, payoff, delay-hours), buyer and claimed
//! counts, settlement status, and claim-window expiry.
//!
//! Settlement statuses:
//! - `Active` — accepting buyers.
//! - `SettledOnTime` — premiums forwarded to the vault as yield (terminal).
//! - `SettledDelayed` / `SettledCancelled` — claim window open for travelers.
//!
//! Core operations:
//! - **Controller-only:** `register_flight` (first buy locks terms),
//!   `add_buyer`, and the `settle_*` entrypoints (on-time forwards premiums to
//!   the vault; delayed/cancelled open the claim window).
//! - **Traveler:** `claim` — collects the payoff once, if eligible.
//! - **Anyone:** `sweep_expired` — after the claim window closes, credits
//!   unclaimed funds to the protocol's recovered balance.
//! - **Owner:** `withdraw_recovered` — claims swept funds.

mod admin;
mod auth;
mod claim;
mod constants;
mod error;
mod events;
mod lifecycle;
mod queries;
mod settle;
mod storage;
mod traits;
mod upgrade;

use soroban_sdk::contract;

pub use error::Error;
pub use storage::{FlightConfig, SettlementStatus};

#[contract]
pub struct FlightPoolManager;

#[cfg(test)]
mod test;
