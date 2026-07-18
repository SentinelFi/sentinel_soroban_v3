// SPDX-License-Identifier: Apache-2.0
// Copyright @SentinelFi

#![no_std]
//! # Controller — protocol orchestrator
//!
//! The only contract that holds policy logic; every multi-contract operation
//! is mediated here. It ties together the `GovernanceModule` (route terms),
//! `RiskVault` (capital), `OracleAggregator` (flight status), and
//! `FlightPoolManager` (per-flight policy state).
//!
//! Core operations:
//! - **Traveler:** `buy_insurance` — validates the route, enforces lead time
//!   and solvency, registers the flight on first buy, pulls the premium, locks
//!   collateral, and records the buyer.
//! - **Keeper:** `classify_flights` — reads the oracle's active list and sorts
//!   landed/cancelled flights into `ToBeSettled*` by comparing actual vs.
//!   estimated arrival against the route delay threshold; also voids
//!   NotInitiated/Active flights stuck past their lifecycle timeouts
//!   (classified on-time — premiums to the vault, no payout).
//! - **Keeper:** `execute_settlements` — processes every `ToBeSettled*` flight
//!   (moves money between pool and vault, marks the oracle `Settled`).
//!   `classify_flight` / `settle_flight` are exact-tuple variants of the two
//!   sweeps, and `execute_settlements_bounded` caps a settlement pass.
//! - **Keeper:** `run_queue_maintenance` — drains the vault withdrawal queue
//!   and snapshots share price, decoupled from settlement so a heavy
//!   settlement batch can never block underwriter exits.
//! - **Owner:** rotate the keeper address and tune solvency ratio, lead time,
//!   and claim-expiry window.
//!
//! State is limited to contract addresses, the keeper address, tunables,
//! aggregate counters, rotating classification/settlement cursors, the
//! buyer-whitelist toggle and per-buyer approval deadlines, and a
//! per-traveler purchase index.

mod admin;
mod auth;
mod constants;
mod error;
mod events;
mod interfaces;
mod purchase;
mod queries;
mod settle;
mod storage;
mod traits;
mod upgrade;
mod whitelist;

use soroban_sdk::contract;

pub use error::Error;

#[contract]
pub struct Controller;

#[cfg(test)]
mod test;
