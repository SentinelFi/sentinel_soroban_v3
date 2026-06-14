#![no_std]
//! # MockUSDC — ⚠️ TESTNET ONLY
//!
//! Audit ASF-03 (Deployment Critical). This token exposes **permissionless**
//! mint/faucet: anyone can mint arbitrary balances. It exists only to fund
//! integration tests and testnet demos.
//!
//! NEVER deploy MockUSDC as the `asset token` backing `RiskVault`, `Controller`,
//! or `FlightPoolManager` on mainnet. Production must use the real USDC Stellar Asset Contract (SAC).
//!
//! Guardrail: the permissionless `mint`/`faucet` entrypoints are compiled only
//! under the default-on `testnet` feature. A production build
//! (`--no-default-features`) omits them entirely.
mod token;
mod traits;
mod upgrade;

use soroban_sdk::contract;

#[contract]
pub struct MockUSDC;

#[cfg(test)]
mod test;
