use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u32)]
pub enum Error {
    PremiumMustBePositive = 501,
    PayoffMustBePositive = 502,
    PayoffMustExceedPremium = 503,
    DelayHoursMustBePositive = 504,
    FlightIdAlreadyMapped = 505,
    RouteAlreadyDisabled = 506,
    RouteAlreadyActive = 507,
    RouteMustBeDisabledBeforeRemoval = 508,
    NotOwnerOrAdmin = 509,
    FlightIdRetired = 510,
    RouteNotFound = 511,
}
