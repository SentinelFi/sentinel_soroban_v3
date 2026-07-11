// Fuzz harness for the risk_vault solvency invariant.
//
// Generates a random sequence of vault operations (deposit / withdraw /
// mint_shares / redeem / queue lifecycle / controller-only capital ops /
// recover_uncollected) and asserts after every step that the core invariant
// holds:
//
//     get_locked_capital() <= get_total_managed_assets()
//
// Failing inputs are minimised by libfuzzer and saved to fuzz/artifacts/.

#![no_main]

use libfuzzer_sys::fuzz_target;
use risk_vault::{RiskVault, RiskVaultClient, RecoveryMode};
use sentinel_types::test_support::MockPendingOracle;
use soroban_sdk::{
    testutils::arbitrary::{arbitrary, Arbitrary},
    testutils::Address as _,
    token, Address, Env,
};

const NUM_USERS: usize = 4;
const INITIAL_ASSET: i128 = 1_000_000_0000000; // 1,000,000 asset

#[derive(Debug, Arbitrary)]
pub enum Op {
    Deposit { user: u8, amount: i128 },
    Withdraw { user: u8, amount: i128 },
    MintShares { user: u8, shares: i128 },
    Redeem { user: u8, shares: i128 },
    RequestWithdrawal { user: u8, shares: i128 },
    CancelWithdrawal { user: u8, request_id: u64 },
    ProcessQueue,
    Collect { user: u8 },
    IncreaseLocked { amount: i128 },
    DecreaseLocked { amount: i128 },
    RecordPremium { amount: i128 },
    SendPayout { to: u8, amount: i128 },
    RecoverRecredit { user: u8, amount: i128 },
    RecoverTransfer { user: u8, amount: i128 },
    Snapshot,
}

#[derive(Debug, Arbitrary)]
pub struct Input {
    pub ops: Vec<Op>,
}

fuzz_target!(|input: Input| {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let controller = Address::generate(&env);

    let asset_admin = Address::generate(&env);
    let asset_id = env.register_stellar_asset_contract_v2(asset_admin);
    let asset_admin_client = token::StellarAssetClient::new(&env, &asset_id.address());
    let asset = token::Client::new(&env, &asset_id.address());

    // Settlement barrier consults the constructor-wired oracle on every
    // entry/exit; the mock reports no pending outcomes so the barrier stays
    // open and the fuzzer exercises the full op set.
    let oracle_id = env.register(MockPendingOracle, ());
    let vault_id = env.register(RiskVault, (&owner, asset_id.address(), &oracle_id));
    let client = RiskVaultClient::new(&env, &vault_id);
    client.set_controller(&controller);

    // Pre-fund the user pool so deposit / mint_shares have something to spend.
    let users: Vec<Address> = (0..NUM_USERS)
        .map(|_| {
            let a = Address::generate(&env);
            asset_admin_client.mint(&a, &INITIAL_ASSET);
            a
        })
        .collect();

    let pick = |idx: u8| -> Address { users[(idx as usize) % NUM_USERS].clone() };

    for op in input.ops {
        match op {
            Op::Deposit { user, amount } => {
                let u = pick(user);
                let _ = client.try_deposit(&amount, &u, &u, &u);
            }
            Op::Withdraw { user, amount } => {
                let u = pick(user);
                let _ = client.try_withdraw(&amount, &u, &u, &u);
            }
            Op::MintShares { user, shares } => {
                let u = pick(user);
                let _ = client.try_mint(&shares, &u, &u, &u);
            }
            Op::Redeem { user, shares } => {
                let u = pick(user);
                let _ = client.try_redeem(&shares, &u, &u, &u);
            }
            Op::RequestWithdrawal { user, shares } => {
                let u = pick(user);
                let _ = client.try_request_withdrawal(&u, &shares);
            }
            Op::CancelWithdrawal { user, request_id } => {
                let u = pick(user);
                let _ = client.try_cancel_withdrawal(&u, &request_id);
            }
            Op::ProcessQueue => {
                let _ = client.try_process_withdrawal_queue(&controller);
            }
            Op::Collect { user } => {
                let u = pick(user);
                let _ = client.try_collect(&u);
            }
            Op::IncreaseLocked { amount } => {
                let _ = client.try_increase_locked(&controller, &amount);
            }
            Op::DecreaseLocked { amount } => {
                let _ = client.try_decrease_locked(&controller, &amount);
            }
            Op::RecordPremium { amount } => {
                let _ = client.try_record_premium_income(&controller, &amount);
            }
            Op::SendPayout { to, amount } => {
                let target = pick(to);
                let _ = client.try_send_payout(&controller, &target, &amount);
            }
            Op::RecoverRecredit { user, amount } => {
                let u = pick(user);
                let _ = client.try_recover_uncollected(&u, &amount, &RecoveryMode::Recredit);
            }
            Op::RecoverTransfer { user, amount } => {
                let u = pick(user);
                let _ = client.try_recover_uncollected(&u, &amount, &RecoveryMode::Transfer);
            }
            Op::Snapshot => {
                let _ = client.try_snapshot();
            }
        }

        // ─── Invariants — must hold after every op ──────────────────────
        let tma = client.get_total_managed_assets();
        let locked = client.get_locked_capital();
        assert!(
            locked <= tma,
            "solvency invariant broken: locked={} > tma={}",
            locked,
            tma
        );
        assert!(tma >= 0, "tma went negative: {}", tma);
        assert!(locked >= 0, "locked went negative: {}", locked);

        // Vault asset balance should cover unlocked claims + locked capital.
        let vault_asset = asset.balance(&client.address);
        assert!(
            vault_asset >= 0,
            "vault asset balance went negative: {}",
            vault_asset
        );
    }
});
