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
    WithdrawalQueueActive = 714,
    ExceedsFreeCapital = 715,
    WithdrawalQueueFull = 716,
    TooManyActiveRequests = 717,
    SettlementPending = 718,
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
}
