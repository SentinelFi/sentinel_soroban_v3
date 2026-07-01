use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u32)]
pub enum Error {
    ControllerAlreadySet = 601,
    InvalidTransition = 602,
    InvalidSettlementStatus = 603,
    NotAuthorizedOracle = 604,
    NotAuthorizedController = 605,
    ActiveFlightListFull = 606,
}
