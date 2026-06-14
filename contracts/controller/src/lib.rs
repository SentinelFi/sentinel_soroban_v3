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
//!   estimated arrival against the route delay threshold.
//! - **Keeper:** `execute_settlements` — processes every `ToBeSettled*` flight
//!   (moves money between pool and vault, marks the oracle `Settled`), then
//!   drains the vault withdrawal queue and snapshots share price.
//! - **Owner:** rotate the keeper address and tune solvency ratio, lead time,
//!   and claim-expiry window.
//!
//! State is limited to contract addresses, the keeper address, tunables,
//! aggregate counters, and a per-traveler purchase index.

mod admin;
mod auth;
mod error;
mod events;
mod interfaces;
mod purchase;
mod queries;
mod settle;
mod storage;
mod traits;
mod whitelist;

use soroban_sdk::contract;

pub use error::Error;

#[contract]
pub struct Controller;

#[cfg(test)]
mod test;
