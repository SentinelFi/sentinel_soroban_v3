// SPDX-License-Identifier: Apache-2.0
// Copyright @SentinelFi

#![no_std]
//! # OracleAggregator — authoritative flight status
//!
//! The single source of truth for flight outcomes. A trusted off-chain oracle
//! pushes status data on-chain, and the contract enforces a **forward-only
//! state machine**:
//!
//! ```text
//! NotInitiated → Active → Landed    → ToBeSettledOnTime    → Settled
//!                       → Cancelled  → ToBeSettledDelayed   → Settled
//!                                    → ToBeSettledCancelled → Settled
//! ```
//!
//! Two additional timeout-gated void edges guarantee every collateral-locking
//! state has a bounded exit (both settle as on-time — no payout):
//! `NotInitiated → ToBeSettledOnTime` (no data ever arrived, stale timeout
//! past departure) and `Active → ToBeSettledOnTime` (terminal outcome never
//! arrived, active timeout past the recorded scheduled arrival).
//! `NotInitiated → Cancelled` covers short-notice and pre-purchase
//! cancellations (purchase-blocking tombstone).
//!
//! Each flight is keyed by `(flight_id, date)` and tracks its status, estimated
//! and actual arrival times, and a settled-at timestamp.
//!
//! Core operations:
//! - **Oracle-only:** `set_estimated_arrival`, `set_landed`, `set_cancelled`,
//!   plus the sale window (`open_sale` / `close_sale`) — a short-lived
//!   attestation that the flight instance is scheduled and not cancelled,
//!   which the controller's purchase gate requires.
//! - **Controller-only:** `register_flight`, `set_to_be_settled`
//!   (classification), `set_settled` (terminal).
//! - **Anyone:** `prune_settled` — bounded, cursor-rotated eviction of flights
//!   past the retention window from the active list; read flight data and list
//!   flights by status.

mod admin;
mod auth;
mod constants;
mod error;
mod events;
mod lifecycle;
mod queries;
mod storage;
mod traits;
mod upgrade;

use soroban_sdk::contract;

pub use error::Error;
pub use storage::{FlightData, FlightStatus};

#[contract]
pub struct OracleAggregator;

#[cfg(test)]
mod test;
