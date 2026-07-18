use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u32)]
pub enum Error {
    ControllerAlreadySet = 701,
    NotController = 702,
    AmountMustBePositive = 703,
    WouldExceedTotalManagedAssets = 704,
    WouldGoNegative = 705,
    PremiumNotReceived = 706,
    InsufficientManagedAssets = 707,
    SharesMustBePositive = 708,
    SharesRedeemToZeroAssets = 709,
    NotYourRequest = 710,
    NothingToCollect = 711,
    RecreditWouldUnderpay = 712,
    AmountExceedsClaimableBalance = 713,
    // Retired codes — removed from the enum so they cannot be raised by
    // accident; the values stay reserved and must never be reassigned a
    // different meaning (integrators may still have handlers for them):
    //   714 WithdrawalQueueActive — was raised by the direct (immediate)
    //       exit path, permanently disabled in favor of the queued
    //       two-phase flow.
    //   715 ExceedsFreeCapital — same disabled direct-exit path.
    //   718 SettlementPending — queue processing now defers silently
    //       (no-op) while the settlement barrier is engaged instead of
    //       reverting.
    WithdrawalQueueFull = 716,
    TooManyActiveRequests = 717,
    RequestBelowMinimum = 719,
    AssetsConvertToZeroShares = 720,
    RequestNotFound = 721,
    AmountMustBeNonNegative = 722,
    RecreditExceedsRecoverableSurplus = 723,
    SolvencyRatioOutOfBounds = 724,
    OraclePendingOutcomesUnreconciled = 725,
    ForcedRotationRequiresPause = 726,
    DirectEntryDisabled = 727,
    DirectExitDisabled = 728,
    DepositQueueFull = 729,
    OracleActiveExposureUnreconciled = 730,
}
