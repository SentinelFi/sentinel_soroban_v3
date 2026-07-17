use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u32)]
pub enum Error {
    SolvencyRatioOutOfBounds = 301,
    // 302 retired (was MinLeadTimeExceedsMaximum, never emitted; superseded
    // by MinLeadTimeLeavesNoBookingWindow = 314). Do not reuse the code.
    ClaimExpiryWindowOutOfBounds = 303,
    NotAuthorizedKeeper = 304,
    NotOwnerOrGovernanceAdmin = 305,
    BuyerNotWhitelisted = 306,
    RouteDisabled = 307,
    RouteNotWhitelisted = 308,
    DepartureTooSoon = 309,
    DepartureTooFarInFuture = 310,
    FlightNotOpenForPurchase = 311,
    InsufficientVaultCapital = 312,
    DateNotDayAligned = 313,
    MinLeadTimeLeavesNoBookingWindow = 314,
    OracleDataUnavailable = 315,
    FlightDataStillPresent = 316,
    FlightStillListed = 317,
    FlightNotRegisteredInPool = 318,
    SaleNotOpen = 319,
    SnapshotTermsExceedLimits = 320,
}
