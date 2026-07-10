// SPDX-License-Identifier: Apache-2.0
// Copyright @SentinelFi

#![no_std]
//! # GovernanceModule — route whitelist & policy defaults
//!
//! Defines which flight routes are insurable and the policy terms that apply to
//! them. Holds global default terms (premium, payoff, delay-hours threshold)
//! plus route entries keyed by `(flight_id, origin, dest)`, each with optional
//! per-route overrides and an `approved` flag. A single `(origin, dest)` is
//! enforced per `flight_id` so downstream pool/oracle keys can't collide.
//!
//! Core operations:
//! - **Owner:** `set_defaults`, `add_admin` / `remove_admin`, `upgrade`.
//! - **Owner or Admin:** route lifecycle — `whitelist_route`, `disable_route`,
//!   `enable_route`, `remove_route` (only when disabled), `update_route_terms`
//!   (per-field keep / override / revert-to-default).
//! - **Anyone:** `route_status` — returns a typed `Active(ResolvedTerms)`
//!   (defaults folded in), `Disabled`, or `Unknown`, letting the controller
//!   distinguish "never approved" from "explicitly disabled" in one call.

mod admin;
mod auth;
mod constants;
mod error;
mod events;
mod queries;
mod routes;
mod storage;
mod traits;
mod upgrade;

use soroban_sdk::contract;

pub use error::Error;
pub use storage::{DelayHoursUpdate, PayoffUpdate, PremiumUpdate, ResolvedTerms, RouteStatus};

#[contract]
pub struct GovernanceModule;

#[cfg(test)]
mod test;
