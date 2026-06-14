//! MockUSDC compile-time constants.

/// Amount minted per `faucet` call: 10,000 USDC (7 decimals).
#[cfg(feature = "testnet")]
pub(crate) const FAUCET_AMOUNT: i128 = 10_000_0000000;
