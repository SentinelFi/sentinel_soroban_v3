// SPDX-License-Identifier: Apache-2.0
// Copyright @SentinelFi

#![no_std]
//! # RiskVault — underwriter capital pool
//!
//! The capital pool that backs every insurance policy. Underwriters deposit the
//! protocol asset and receive transferable vault shares (ERC-4626-style
//! mechanics, with an inflation-attack defense); they earn from on-time
//! premiums and absorb delay/cancel payouts.
//!
//! Implements the `FungibleToken` standard (vault shares).
//!
//! All LP entry and exit is TWO-PHASE: commit first (escrow assets or
//! shares), get priced later — only after the request outlives the LP
//! pricing delay, at the then-current share price. Immediate
//! deposit/mint/withdraw/redeem are disabled: any call-time price is stale
//! with respect to a flight outcome that is publicly knowable but not yet
//! written on-chain, and an informed LP could otherwise transact against the
//! other LPs' pending PnL.
//!
//! State:
//! - **Total Managed Assets (TMA)** — the pool's accounting balance.
//! - **Locked capital** — reserved against outstanding policies; free capital
//!   is `TMA − locked`, and exits are further bounded by the withdrawable
//!   amount `TMA − ceil(locked × solvency_ratio / 100)` so LP exits preserve
//!   the same reserve margin the controller admits policies against.
//! - **Solvency ratio** — controller-mirrored copy of the owner-configured
//!   collateralization percentage (100 until first pushed).
//! - **Deposit queue** — FIFO escrowed LP entries awaiting delayed pricing.
//! - **Withdrawal queue** — FIFO escrowed share-redemption requests awaiting
//!   delayed pricing and free capital.
//! - **Claimable balances** — per-underwriter pull-based payouts.
//! - **Daily share-price snapshots** — short-lived, for off-chain analytics.
//!
//! Core operations:
//! - **Underwriter:** `request_deposit` / `cancel_deposit` (entry queue),
//!   `request_withdrawal` / `cancel_withdrawal` (exit queue), `collect`
//!   (pull processed exits).
//! - **Controller-only:** `increase_locked`, `decrease_locked`,
//!   `record_premium_income`, `send_payout`, `process_deposit_queue`,
//!   `process_withdrawal_queue`.
//! - **Permissionless:** `snapshot` — records the daily share price.
//! - **Owner-only:** `recover_uncollected` — fallback for archived claimable
//!   balances.

mod admin;
mod auth;
mod capital;
mod claims;
mod constants;
mod error;
mod events;
mod queries;
mod snapshot;
mod storage;
mod traits;
mod upgrade;
mod vault_ops;

use soroban_sdk::contract;

#[cfg(test)]
use soroban_sdk::token;

#[cfg(test)]
use constants::SECONDS_PER_DAY;

pub use error::Error;
pub use storage::{DepositRequest, RecoveryMode, WithdrawalRequest};

#[contract]
pub struct RiskVault;

#[cfg(test)]
mod prop_test;
#[cfg(test)]
mod test;
