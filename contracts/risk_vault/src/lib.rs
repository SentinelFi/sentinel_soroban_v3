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
//! State:
//! - **Total Managed Assets (TMA)** — the pool's accounting balance.
//! - **Locked capital** — reserved against outstanding policies; free capital
//!   is `TMA − locked`.
//! - **Withdrawal queue** — FIFO share-redemption requests for when free
//!   capital is insufficient for an immediate redeem.
//! - **Claimable balances** — per-underwriter pull-based payouts.
//! - **Daily share-price snapshots** — short-lived, for off-chain analytics.
//!
//! Core operations:
//! - **Underwriter:** `deposit`, `redeem` (immediate, if free capital allows),
//!   `request_withdrawal` / `cancel_withdrawal` (queue), `collect` (pull).
//! - **Controller-only:** `increase_locked`, `decrease_locked`,
//!   `record_premium_income`, `send_payout`, `process_withdrawal_queue`,
//!   `snapshot`.
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
pub use storage::{RecoveryMode, WithdrawalRequest};

#[contract]
pub struct RiskVault;

#[cfg(test)]
mod test;
