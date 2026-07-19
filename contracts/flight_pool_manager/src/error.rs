use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u32)]
pub enum Error {
    NotController = 401,
    ControllerAlreadySet = 402,
    AmountNotPositive = 403,
    ExceedsRecoveredBalance = 404,
    FlightNotActive = 405,
    ClaimExpiryNotInFuture = 406,
    PremiumNotPositive = 407,
    PayoffNotPositive = 408,
    PayoffNotAbovePremium = 409,
    FlightTermsMismatch = 410,
    AlreadyBuyer = 411,
    FlightNotClaimable = 412,
    ClaimWindowClosed = 413,
    NoPolicy = 414,
    AlreadyClaimed = 415,
    ClaimWindowStillOpen = 416,
    ActiveFlightListFull = 417,
    PayoutNotReceived = 418,
    DelayHoursNotPositive = 419,
    // `reconcile_settled_active_entry` was called on a bucket still Active — a
    // live flight legitimately belongs in the active set, so only a settled
    // bucket (whose settlement already attempted the prune) may be reconciled.
    FlightStillActive = 420,
}
