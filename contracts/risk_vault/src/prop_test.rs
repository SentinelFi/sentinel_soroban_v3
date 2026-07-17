//! Property-based tests for the vault's invariant-heavy logic.
//!
//! Two suites, both running under plain `cargo test` (unlike the
//! nightly-only cargo-fuzz harness in `fuzz/`, these gate CI):
//!
//! 1. **Conversion-math properties** — the TMA-basis share/asset conversions
//!    with the virtual-share offset, exercised across arbitrary
//!    (TMA, supply) states including extreme skews. The properties are the
//!    exact guarantees the call sites rely on: floor-floor round trips never
//!    create value (deposit/redeem, queue partial fills), ceil round trips
//!    never under-collect (withdraw), ceil ≥ floor, and monotonicity.
//!
//! 2. **Stateful invariant machine** — random operation sequences against a
//!    real vault (two-phase entry/exit requests and cancellations, both
//!    queue-processing passes, time advancement across the pricing delay,
//!    controller capital ops, ratio changes, donations, settlement-barrier
//!    flips, and disabled-direct-op probes), asserting the full invariant
//!    block after EVERY op — not just at chosen checkpoints: solvency
//!    (`locked ≤ TMA`), the reserve-aware withdrawable formula, asset
//!    conservation (`balance == TMA + Σclaimable + Σdeposit_escrow +
//!    donations`), share supply/escrow accounting, queue caps, and
//!    share-price monotonicity (rounding must always favor the vault, so no
//!    LP-driven op may ever lower the price for remaining holders — only a
//!    settlement, which recognizes losses, may). Payouts appear as the
//!    controller performs them — paired with their collateral unlock in one
//!    action — because `send_payout` alone transiently suspends
//!    `locked ≤ TMA` inside the controller's atomic settlement; the vault's
//!    guarantee (and this suite's assertion) is at controller-action
//!    granularity.
//!
//! Deliberately out of scope: `recover_uncollected`. Its two modes
//! re-classify untracked surplus into liabilities by owner judgment, which
//! bends the exact conservation ledger this suite asserts; its bounds are
//! covered by dedicated unit tests and the fuzz harness.

extern crate std;

// The crate is #![no_std]; pull in std's `vec!` (proptest's `prop_oneof!`
// expands to it) and Vec explicitly for this test-only module.
use std::vec;
use std::vec::Vec as StdVec;

use proptest::prelude::*;
use sentinel_types::test_support::{MockPendingOracle, MockPendingOracleClient};
use soroban_sdk::testutils::{EnvTestConfig, Ledger};
use soroban_sdk::{testutils::Address as _, token, Address, Env};
use stellar_contract_utils::math::Rounding;
use stellar_tokens::fungible::Base;

use crate::storage::VaultKey;
use crate::vault_ops::{
    convert_to_assets_with_tma, convert_to_shares_with_tma, managed_convert_to_shares,
};
use crate::{RiskVault, RiskVaultClient};

/// 10^decimals_offset — the vault constructor sets the offset to 3.
const POW_OFFSET: i128 = 1_000;

/// Fresh test env with per-drop snapshot capture off — proptest drops
/// hundreds of Envs per run, and each capture writes a JSON file.
fn prop_env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env
}

/// Upper bound on generated asset magnitudes: 100M units at 7 decimals.
/// Large enough that supply-side products explore the interesting range,
/// small enough that `amount × (supply + offset)` stays far from i128
/// overflow (the vault's real domain is bounded by the asset's supply).
const MAX_MAGNITUDE: i128 = 100_000_000_0000000;

// ────────────────────────────────────────────────────────────────────────
// Suite 1 — conversion math under arbitrary (TMA, supply) states
// ────────────────────────────────────────────────────────────────────────

/// Register a vault, force an arbitrary (TMA, share-supply) state directly
/// in its storage, and run `f` in its contract context. Skews impossible to
/// reach through short client sequences (huge supply against dust TMA and
/// vice versa) are exactly where rounding bugs live.
fn with_seeded_vault<R>(tma: i128, supply: i128, f: impl FnOnce(&Env) -> R) -> R {
    let env = prop_env();

    let owner = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    let oracle_id = env.register(MockPendingOracle, ());
    let vault_id = env.register(RiskVault, (&owner, asset_id.address(), &oracle_id));

    env.as_contract(&vault_id, || {
        if supply > 0 {
            let holder = Address::generate(&env);
            Base::update(&env, None, Some(&holder), supply);
        }
        env.storage()
            .instance()
            .set(&VaultKey::TotalManagedAssets, &tma);
        f(&env)
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    /// Floor both ways never creates value: converting assets to shares and
    /// back must not exceed the input. This is the guarantee the deposit
    /// path, redeem path, and the queue's partial-fill sizing all rely on.
    #[test]
    fn floor_round_trip_never_creates_value(
        tma in 0i128..=MAX_MAGNITUDE,
        supply in 0i128..=MAX_MAGNITUDE * POW_OFFSET,
        assets in 0i128..=MAX_MAGNITUDE,
    ) {
        with_seeded_vault(tma, supply, |e| {
            let shares = managed_convert_to_shares(e, assets, Rounding::Floor);
            assert!(shares >= 0);
            let back = convert_to_assets_with_tma(e, shares, tma, Rounding::Floor);
            assert!(
                (0..=assets).contains(&back),
                "floor round trip created value: {assets} assets -> {shares} shares -> {back} assets \
                 (tma={tma}, supply={supply})",
            );
        });
    }

    /// Ceil both ways never under-covers: the shares burned for a withdrawal
    /// must always be worth at least the assets paid out, or exits would
    /// leak value from the remaining holders.
    #[test]
    fn ceil_round_trip_never_under_covers(
        tma in 0i128..=MAX_MAGNITUDE,
        supply in 0i128..=MAX_MAGNITUDE * POW_OFFSET,
        assets in 0i128..=MAX_MAGNITUDE,
    ) {
        with_seeded_vault(tma, supply, |e| {
            let shares = managed_convert_to_shares(e, assets, Rounding::Ceil);
            let back = convert_to_assets_with_tma(e, shares, tma, Rounding::Ceil);
            assert!(
                back >= assets,
                "ceil round trip under-covered: {assets} assets -> {shares} shares -> {back} assets \
                 (tma={tma}, supply={supply})",
            );
        });
    }

    /// Ceil dominates floor, and both conversions are monotone in their
    /// input — a larger deposit can never mint fewer shares, a larger share
    /// count can never redeem fewer assets.
    #[test]
    fn conversions_are_ordered_and_monotone(
        tma in 0i128..=MAX_MAGNITUDE,
        supply in 0i128..=MAX_MAGNITUDE * POW_OFFSET,
        x in 0i128..=MAX_MAGNITUDE,
        y in 0i128..=MAX_MAGNITUDE,
    ) {
        let (small, large) = if x <= y { (x, y) } else { (y, x) };
        with_seeded_vault(tma, supply, |e| {
            let floor_small = managed_convert_to_shares(e, small, Rounding::Floor);
            let floor_large = managed_convert_to_shares(e, large, Rounding::Floor);
            let ceil_small = managed_convert_to_shares(e, small, Rounding::Ceil);
            assert!(ceil_small >= floor_small, "ceil below floor");
            assert!(floor_small <= floor_large, "shares not monotone in assets");

            let a_small = convert_to_assets_with_tma(e, small, tma, Rounding::Floor);
            let a_large = convert_to_assets_with_tma(e, large, tma, Rounding::Floor);
            let a_ceil = convert_to_assets_with_tma(e, small, tma, Rounding::Ceil);
            assert!(a_ceil >= a_small, "ceil below floor (assets)");
            assert!(a_small <= a_large, "assets not monotone in shares");
        });
    }

    /// The queue partial-fill sizing guarantee, exactly as the processor
    /// uses it: the asset value credited for the fillable share slice never
    /// exceeds the free capital that sized the slice.
    #[test]
    fn partial_fill_slice_never_exceeds_budget(
        tma in 0i128..=MAX_MAGNITUDE,
        supply in 0i128..=MAX_MAGNITUDE * POW_OFFSET,
        budget in 0i128..=MAX_MAGNITUDE,
    ) {
        with_seeded_vault(tma, supply, |e| {
            let fillable = convert_to_shares_with_tma(e, budget, tma, Rounding::Floor);
            let credited = convert_to_assets_with_tma(e, fillable, tma, Rounding::Floor);
            assert!(
                credited <= budget,
                "partial fill overdrew its budget: budget={budget}, credited={credited} \
                 (tma={tma}, supply={supply})",
            );
        });
    }
}

// ────────────────────────────────────────────────────────────────────────
// Suite 2 — stateful invariant machine over random operation sequences
// ────────────────────────────────────────────────────────────────────────

const NUM_USERS: usize = 3;
/// Per-user starting balance: 10M asset units at 7 decimals.
const INITIAL_ASSET: i128 = 10_000_000_0000000;
/// Queue caps mirrored from the contract constants. The AdvanceTime op's
/// range straddles the 6-hour pricing delay so sequences exercise immature,
/// just-matured, and long-matured requests.
const QUEUE_CAP: u32 = 150;
const DEPOSIT_QUEUE_CAP: u32 = 100;
const PER_ADDRESS_CAP: u32 = 20;

#[derive(Clone, Debug)]
enum Op {
    RequestDeposit {
        user: usize,
        amount: i128,
    },
    CancelDeposit {
        user: usize,
        request_id: u64,
    },
    ProcessDepositQueue,
    /// Probe: every immediate-pricing operation must reject unconditionally.
    DirectOpProbe {
        user: usize,
        amount: i128,
    },
    TransferShares {
        from: usize,
        to: usize,
        amount: i128,
    },
    RequestWithdrawal {
        user: usize,
        shares: i128,
    },
    CancelWithdrawal {
        user: usize,
        request_id: u64,
    },
    ProcessQueue,
    Collect {
        user: usize,
    },
    /// Advance ledger time — requests mature only by crossing the pricing
    /// delay, so sequences interleave partial and full advances.
    AdvanceTime {
        secs: u64,
    },
    IncreaseLocked {
        amount: i128,
    },
    DecreaseLocked {
        amount: i128,
    },
    RecordPremium {
        amount: i128,
    },
    /// A delayed/cancelled settlement as the controller performs it: pay
    /// `gross − premium_part` out of TMA, then release the full `gross`
    /// locked collateral in the same action. `send_payout` alone may
    /// transiently push TMA below locked (the controller restores the
    /// invariant with the paired unlock before its transaction commits, and
    /// Soroban's no-reentrancy hides the intermediate state), so the
    /// invariant this suite asserts — like the vault's real guarantee — is
    /// defined at controller-action granularity.
    Settle {
        user: usize,
        gross: i128,
        premium_bps: u32,
    },
    /// Probe: a payout exceeding TMA must be rejected by the vault itself.
    PayoutOverTma {
        user: usize,
    },
    SetSolvencyRatio {
        ratio: u32,
    },
    Donate {
        amount: i128,
    },
    TogglePending {
        pending: bool,
    },
}

/// Amounts weighted toward the two regimes where rounding matters — dust
/// against a large pool, and pool-scale moves — plus explicit reject-path
/// probes (zero and negative).
fn amount_strategy() -> impl Strategy<Value = i128> {
    prop_oneof![
        4 => 1i128..=1_000,
        5 => 1i128..=1_000_000_0000000,
        1 => Just(0i128),
        1 => Just(-1i128),
    ]
}

fn op_strategy() -> impl Strategy<Value = Op> {
    let user = 0..NUM_USERS;
    prop_oneof![
        6 => (user.clone(), amount_strategy()).prop_map(|(user, amount)| Op::RequestDeposit { user, amount }),
        2 => (user.clone(), 0u64..48).prop_map(|(user, request_id)| Op::CancelDeposit { user, request_id }),
        5 => Just(Op::ProcessDepositQueue),
        2 => (user.clone(), amount_strategy()).prop_map(|(user, amount)| Op::DirectOpProbe { user, amount }),
        2 => (user.clone(), user.clone(), amount_strategy())
            .prop_map(|(from, to, amount)| Op::TransferShares { from, to, amount }),
        4 => (user.clone(), amount_strategy())
            .prop_map(|(user, shares)| Op::RequestWithdrawal { user, shares }),
        2 => (user.clone(), 0u64..48).prop_map(|(user, request_id)| Op::CancelWithdrawal { user, request_id }),
        4 => Just(Op::ProcessQueue),
        3 => user.clone().prop_map(|user| Op::Collect { user }),
        5 => (0u64..=8 * 3600).prop_map(|secs| Op::AdvanceTime { secs }),
        4 => amount_strategy().prop_map(|amount| Op::IncreaseLocked { amount }),
        3 => amount_strategy().prop_map(|amount| Op::DecreaseLocked { amount }),
        3 => amount_strategy().prop_map(|amount| Op::RecordPremium { amount }),
        3 => (user.clone(), amount_strategy(), 0u32..=10_000)
            .prop_map(|(user, gross, premium_bps)| Op::Settle { user, gross, premium_bps }),
        1 => user.clone().prop_map(|user| Op::PayoutOverTma { user }),
        2 => (0u32..=20_000).prop_map(|ratio| Op::SetSolvencyRatio { ratio }),
        1 => amount_strategy().prop_map(|amount| Op::Donate { amount }),
        1 => any::<bool>().prop_map(|pending| Op::TogglePending { pending }),
    ]
}

struct Harness<'a> {
    client: RiskVaultClient<'a>,
    asset: token::Client<'a>,
    asset_admin: token::StellarAssetClient<'a>,
    oracle: MockPendingOracleClient<'a>,
    controller: Address,
    users: StdVec<Address>,
    /// Asset minted directly to the vault without a matching TMA credit —
    /// the only deliberate breach of the conservation ledger, tracked so
    /// the identity stays exact.
    donated: i128,
    prev_tma: i128,
    prev_supply: i128,
}

impl Harness<'_> {
    fn user(&self, idx: usize) -> &Address {
        &self.users[idx % NUM_USERS]
    }

    fn apply(&mut self, op: &Op) {
        let c = &self.client;
        match op {
            Op::RequestDeposit { user, amount } => {
                let u = self.user(*user);
                let _ = c.try_request_deposit(u, amount);
            }
            Op::CancelDeposit { user, request_id } => {
                let _ = c.try_cancel_deposit(self.user(*user), request_id);
            }
            Op::ProcessDepositQueue => {
                let _ = c.try_process_deposit_queue(&self.controller);
            }
            Op::DirectOpProbe { user, amount } => {
                // The immediate-pricing surface is permanently disabled; any
                // acceptance would reopen stale-price entry/exit.
                let u = self.user(*user).clone();
                assert!(c.try_deposit(amount, &u, &u, &u).is_err());
                assert!(c.try_mint(amount, &u, &u, &u).is_err());
                assert!(c.try_withdraw(amount, &u, &u, &u).is_err());
                assert!(c.try_redeem(amount, &u, &u, &u).is_err());
            }
            Op::AdvanceTime { secs } => {
                self.client
                    .env
                    .ledger()
                    .with_mut(|li| li.timestamp += *secs);
            }
            Op::TransferShares { from, to, amount } => {
                let _ = c.try_transfer(self.user(*from), self.user(*to), amount);
            }
            Op::RequestWithdrawal { user, shares } => {
                let _ = c.try_request_withdrawal(self.user(*user), shares);
            }
            Op::CancelWithdrawal { user, request_id } => {
                let _ = c.try_cancel_withdrawal(self.user(*user), request_id);
            }
            Op::ProcessQueue => {
                let _ = c.try_process_withdrawal_queue(&self.controller);
            }
            Op::Collect { user } => {
                let _ = c.try_collect(self.user(*user));
            }
            Op::IncreaseLocked { amount } => {
                let _ = c.try_increase_locked(&self.controller, amount);
            }
            Op::DecreaseLocked { amount } => {
                let _ = c.try_decrease_locked(&self.controller, amount);
            }
            Op::RecordPremium { amount } => {
                if *amount > 0 {
                    // Real flow: the pool transfers asset in BEFORE the
                    // controller credits it. If the credit is refused, the
                    // minted asset stays behind as untracked surplus.
                    self.asset_admin.mint(&self.client.address, amount);
                    if c.try_record_premium_income(&self.controller, amount)
                        .is_err()
                    {
                        self.donated += amount;
                    }
                } else {
                    let _ = c.try_record_premium_income(&self.controller, amount);
                }
            }
            Op::Settle {
                user,
                gross,
                premium_bps,
            } => {
                // Mirror the controller's admission guarantee: it only ever
                // settles exposure it previously locked, so gross is bounded
                // by the currently locked collateral.
                let gross = (*gross).clamp(0, c.get_locked_capital());
                if gross > 0 {
                    let premium_part = gross * (*premium_bps as i128) / 10_000;
                    let payout = gross - premium_part;
                    if payout > 0 {
                        let u = self.user(*user).clone();
                        let r = c.try_send_payout(&self.controller, &u, &payout);
                        assert!(r.is_ok(), "backed payout rejected: {payout} of {gross}");
                    }
                    let r = c.try_decrease_locked(&self.controller, &gross);
                    assert!(r.is_ok(), "paired unlock rejected: {gross}");
                }
            }
            Op::PayoutOverTma { user } => {
                let over = c.get_total_managed_assets() + 1;
                let u = self.user(*user).clone();
                let r = c.try_send_payout(&self.controller, &u, &over);
                assert!(r.is_err(), "unbacked payout of {over} was accepted");
            }
            Op::SetSolvencyRatio { ratio } => {
                let _ = c.try_set_solvency_ratio(&self.controller, ratio);
            }
            Op::Donate { amount } => {
                // Direct token transfer to the vault — the classic share
                // price manipulation attempt. Must never enter TMA.
                if *amount > 0 {
                    self.asset_admin.mint(&self.client.address, amount);
                    self.donated += amount;
                }
            }
            Op::TogglePending { pending } => {
                self.oracle.set_pending_outcomes(pending);
            }
        }
    }

    /// The full invariant block, asserted after every op.
    fn assert_invariants(&mut self, op: &Op) {
        let c = &self.client;
        let tma = c.get_total_managed_assets();
        let locked = c.get_locked_capital();
        let free = c.get_free_capital();
        let withdrawable = c.get_withdrawable_capital();
        let ratio = c.get_solvency_ratio();

        // Solvency: locked capital can never exceed managed assets.
        assert!(tma >= 0, "TMA negative after {op:?}: {tma}");
        assert!(
            (0..=tma).contains(&locked),
            "solvency broken after {op:?}: locked={locked}, tma={tma}",
        );

        // Ratio bounds mirror the setter validation on both contracts.
        assert!(
            (100..=10_000).contains(&ratio),
            "ratio out of bounds after {op:?}: {ratio}",
        );

        // Derived capital figures match their definitions exactly.
        assert_eq!(free, tma - locked, "free capital drifted after {op:?}");
        let required = (locked * ratio as i128 + 99) / 100;
        assert_eq!(
            withdrawable,
            (tma - required).max(0),
            "withdrawable drifted after {op:?} (tma={tma}, locked={locked}, ratio={ratio})",
        );
        assert!(withdrawable <= free, "withdrawable above free after {op:?}");

        // Conservation: every asset unit the vault holds is either managed
        // (TMA), owed to a specific user (claimable), escrowed for a pending
        // entry (deposit queue), or a tracked donation.
        let claimable_sum: i128 = self.users.iter().map(|u| c.get_claimable_balance(u)).sum();
        let dep_queue = c.get_deposit_queue();
        let deposit_escrow: i128 = dep_queue.iter().map(|r| r.assets).sum();
        let balance = self.asset.balance(&self.client.address);
        assert_eq!(
            balance,
            tma + claimable_sum + deposit_escrow + self.donated,
            "conservation broken after {op:?}: balance={balance}, tma={tma}, \
             claimable={claimable_sum}, deposit_escrow={deposit_escrow}, donated={}",
            self.donated,
        );

        // Share accounting: supply is exactly user holdings plus the queue's
        // escrow, and the escrow is exactly the queued share total.
        let supply = c.total_supply();
        let user_shares: i128 = self.users.iter().map(|u| c.balance(u)).sum();
        let escrow = c.balance(&self.client.address);
        assert_eq!(
            supply,
            user_shares + escrow,
            "share supply drifted after {op:?}",
        );
        let queue = c.get_withdrawal_queue();
        let queued_shares: i128 = queue.iter().map(|r| r.shares).sum();
        assert_eq!(
            escrow, queued_shares,
            "escrow != queued shares after {op:?}"
        );

        // Queue caps hold at all times, on both queues.
        assert!(queue.len() <= QUEUE_CAP, "queue over cap after {op:?}");
        assert!(
            dep_queue.len() <= DEPOSIT_QUEUE_CAP,
            "deposit queue over cap after {op:?}"
        );
        for u in &self.users {
            let own = queue.iter().filter(|r| r.owner == *u).count() as u32;
            assert!(
                own <= PER_ADDRESS_CAP,
                "per-address queue cap broken after {op:?}"
            );
            let own_dep = dep_queue.iter().filter(|r| r.owner == *u).count() as u32;
            assert!(
                own_dep <= PER_ADDRESS_CAP,
                "per-address deposit queue cap broken after {op:?}"
            );
        }

        // Share price never decreases for remaining holders — rounding
        // always favors the vault — except when a settlement pays a loss.
        // Cross-multiplied to stay in integers:
        //   (tma+1)/(supply+POW)  >=  (prev_tma+1)/(prev_supply+POW)
        if !matches!(op, Op::Settle { .. }) {
            assert!(
                (tma + 1) * (self.prev_supply + POW_OFFSET)
                    >= (self.prev_tma + 1) * (supply + POW_OFFSET),
                "share price dropped after {op:?}: ({}+1)/({}+{POW_OFFSET}) -> ({tma}+1)/({supply}+{POW_OFFSET})",
                self.prev_tma,
                self.prev_supply,
            );
        }
        self.prev_tma = tma;
        self.prev_supply = supply;
    }
}

fn run_sequence(ops: &[Op]) {
    let env = prop_env();

    let owner = Address::generate(&env);
    let controller = Address::generate(&env);
    let asset_admin_addr = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin_addr);
    let asset_admin = token::StellarAssetClient::new(&env, &asset_id.address());
    let asset = token::Client::new(&env, &asset_id.address());

    let oracle_id = env.register(MockPendingOracle, ());
    let oracle = MockPendingOracleClient::new(&env, &oracle_id);
    let vault_id = env.register(RiskVault, (&owner, asset_id.address(), &oracle_id));
    let client = RiskVaultClient::new(&env, &vault_id);
    client.set_controller(&controller);

    let users: StdVec<Address> = (0..NUM_USERS)
        .map(|_| {
            let a = Address::generate(&env);
            asset_admin.mint(&a, &INITIAL_ASSET);
            a
        })
        .collect();

    let mut h = Harness {
        client,
        asset,
        asset_admin,
        oracle,
        controller,
        users,
        donated: 0,
        prev_tma: 0,
        prev_supply: 0,
    };

    for op in ops {
        h.apply(op);
        h.assert_invariants(op);
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

    /// Every invariant holds after every step of any operation sequence —
    /// including sequences no example-based test would think to write.
    #[test]
    fn invariants_hold_across_random_op_sequences(
        ops in prop::collection::vec(op_strategy(), 1..48)
    ) {
        run_sequence(&ops);
    }
}
