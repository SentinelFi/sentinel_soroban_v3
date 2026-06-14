//! GovernanceModule compile-time constants.

// 60 days at 5s/ledger = 60 * 24 * 60 * 12 = 1_036_800.
// Applied on every Route(...) write to keep actively edited routes from
// archival drift; idle routes are extended by the off-chain TTL cron which
// folds Route(...) keys into its ExtendFootprintTTLOp footprint using the
// indexer's enumeration.
pub(crate) const ROUTE_TTL_LEDGERS: u32 = 60 * 24 * 60 * 12;
