//! Ripcord's endowment: how a protocol with no team pays for its own upkeep, and how
//! every Bitcoin loan adds to NEAR's security.
//!
//! Each vault pays a small fee in NEAR. This contract stakes it with a NEAR validator
//! and never unstakes the principal, so that NEAR stays staked for as long as the chain
//! runs. Rewards are the only thing that ever leaves, and they pay keepers.
//!
//! Every method is permissionless, except `pay_keeper`, which only Ripcord can call.
//! There is no owner and no way to redirect the funds.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

const GAS_POOL: Gas = Gas::from_tgas(60);
const GAS_POOL_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);

/// Left unstaked so the contract can always pay for its own storage.
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Endowment {
    /// The only account that can spend keeper bounties.
    ripcord: AccountId,
    /// The validator pool. Fixed at deployment.
    pool: AccountId,
    keeper_bounty: NearToken,
    /// NEAR kept liquid for bounties, so a keeper never waits on an unstake.
    keeper_float: NearToken,
    /// NEAR staked and never to be withdrawn: the growing, permanent part.
    principal_staked: u128,
    total_received: u128,
    total_paid_to_keepers: u128,
    keeper_payments: u64,
}

#[near(serializers = [json])]
pub struct EndowmentStats {
    pub ripcord: AccountId,
    pub pool: AccountId,
    pub keeper_bounty: U128,
    pub keeper_float: U128,
    pub principal_staked: U128,
    pub total_received: U128,
    pub total_paid_to_keepers: U128,
    pub keeper_payments: u64,
    pub liquid_balance: U128,
}

#[near]
impl Endowment {
    #[init]
    pub fn new(
        ripcord: AccountId,
        pool: AccountId,
        keeper_bounty: U128,
        keeper_float: U128,
    ) -> Self {
        Self {
            ripcord,
            pool,
            keeper_bounty: NearToken::from_yoctonear(keeper_bounty.0),
            keeper_float: NearToken::from_yoctonear(keeper_float.0),
            principal_staked: 0,
            total_received: 0,
            total_paid_to_keepers: 0,
            keeper_payments: 0,
        }
    }

    /// Receives a vault fee. Anyone may add to the endowment.
    #[payable]
    pub fn receive_fee(&mut self) {
        self.total_received += env::attached_deposit().as_yoctonear();
    }

    /// Stakes everything above the storage reserve and the keeper float. Anyone can call
    /// it. The money can only go to the one pool set at deployment.
    pub fn stake(&mut self) -> Promise {
        let keep = STORAGE_RESERVE.saturating_add(self.keeper_float);
        let amount = self.spendable().saturating_sub(keep);
        require!(!amount.is_zero(), "nothing to stake");
        Promise::new(self.pool.clone())
            .function_call(
                "deposit_and_stake".to_string(),
                b"{}".to_vec(),
                amount,
                GAS_POOL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_staked(U128(amount.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_staked(&mut self, amount: U128) {
        if near_sdk::is_promise_success() {
            self.principal_staked += amount.0;
            log!(
                "EVENT_JSON:{}",
                json!({
                    "standard": "ripcord-endowment",
                    "version": "1.0.0",
                    "event": "staked",
                    "data": [{ "amount": amount, "principal_staked": U128(self.principal_staked) }]
                })
            );
        }
    }

    /// Pays a keeper. If the float is empty this simply pays nothing: keeping the loan
    /// system moving must never depend on a bounty succeeding.
    pub fn pay_keeper(&mut self, keeper: AccountId) {
        require!(
            env::predecessor_account_id() == self.ripcord,
            "only ripcord can pay keepers"
        );
        if self.spendable() >= STORAGE_RESERVE.saturating_add(self.keeper_bounty) {
            self.total_paid_to_keepers += self.keeper_bounty.as_yoctonear();
            self.keeper_payments += 1;
            let _ = Promise::new(keeper).transfer(self.keeper_bounty);
        }
    }

    /// Asks the pool to unstake rewards earned so far, keeping the principal staked.
    /// They become withdrawable after the pool's unbonding period.
    pub fn harvest_rewards(&mut self) -> Promise {
        Promise::new(self.pool.clone())
            .function_call(
                "get_account_staked_balance".to_string(),
                json!({ "account_id": env::current_account_id() })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_POOL_VIEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_POOL.saturating_add(GAS_CALLBACK))
                    .on_staked_balance(),
            )
    }

    #[private]
    pub fn on_staked_balance(
        &mut self,
        #[callback_result] staked: Result<U128, PromiseError>,
    ) -> Option<Promise> {
        let staked = staked.unwrap_or_else(|_| env::panic_str("could not read the pool"));
        let rewards = staked.0.saturating_sub(self.principal_staked);
        if rewards == 0 {
            log!("no rewards yet");
            return None;
        }
        Some(Promise::new(self.pool.clone()).function_call(
            "unstake".to_string(),
            json!({ "amount": U128(rewards) }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_POOL,
        ))
    }

    /// Pulls unstaked rewards back so they can fund the keeper float.
    pub fn collect_rewards(&mut self) -> Promise {
        Promise::new(self.pool.clone()).function_call(
            "withdraw_all".to_string(),
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            GAS_POOL,
        )
    }

    pub fn get_stats(&self) -> EndowmentStats {
        EndowmentStats {
            ripcord: self.ripcord.clone(),
            pool: self.pool.clone(),
            keeper_bounty: U128(self.keeper_bounty.as_yoctonear()),
            keeper_float: U128(self.keeper_float.as_yoctonear()),
            principal_staked: U128(self.principal_staked),
            total_received: U128(self.total_received),
            total_paid_to_keepers: U128(self.total_paid_to_keepers),
            keeper_payments: self.keeper_payments,
            liquid_balance: U128(env::account_balance().as_yoctonear()),
        }
    }

    /// Liquid NEAR, less what this contract's own storage locks up.
    fn spendable(&self) -> NearToken {
        let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        env::account_balance().saturating_sub(locked)
    }
}
