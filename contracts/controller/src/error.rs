use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u32)]
pub enum Error {
    SolvencyRatioOutOfBounds = 301,
    MinLeadTimeExceedsMaximum = 302,
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
}
