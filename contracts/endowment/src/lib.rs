//! Ripcord's endowment: how a protocol with no team pays for its own upkeep, and how
//! every Bitcoin loan adds to NEAR's security.
//!
//! Two streams come in. Each vault pays a flat fee in NEAR. A share of all loan interest
//! arrives as USDC, and a Dutch auction sells that for NEAR, with no price feed: the
//! rate falls until someone takes it. On mainnet a buyer can source that NEAR through
//! Intents, so the flow also passes through the Intents fee switch.
//!
//! All of that NEAR is staked with a validator and the principal is never unstaked. It
//! stays staked for as long as the chain runs. Rewards are the only thing that ever
//! leaves, and they pay keepers.
//!
//! Every method is permissionless, except `pay_keeper`, which only Ripcord can call.
//! There is no owner and no way to redirect the funds.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{
    env, log, near, require, AccountId, EpochHeight, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const GAS_POOL: Gas = Gas::from_tgas(60);
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_FT: Gas = Gas::from_tgas(15);
const GAS_WITHDRAW: Gas = Gas::from_tgas(50);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Left unstaked so the contract can always pay for its own storage.
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);

/// A smaller sale would tie up the sale slot for its whole length to sell almost nothing.
const MIN_SALE_MICRO_USDC: u128 = 1_000_000;

/// A pool makes unstaked NEAR wait four epochs, and each `unstake` restarts that wait for
/// everything already waiting. Harvests stay one epoch further apart than that wait.
const HARVEST_EVERY_EPOCHS: EpochHeight = 5;

/// A running sale of USDC for NEAR. It stays on record after selling out, so a transfer
/// that fails afterwards can still put its USDC back.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Sale {
    pub usdc_left: U128,
    pub started_at_ms: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Endowment {
    /// The only account that can spend keeper bounties.
    ripcord: AccountId,
    usdc: AccountId,
    /// The validator pool. Fixed at deployment.
    pool: AccountId,
    keeper_bounty: NearToken,
    /// NEAR kept liquid for bounties, so a keeper never waits on an unstake.
    keeper_float: NearToken,
    sale_seconds: u64,
    /// Every sale opens at this rate, in yoctoNEAR per micro-USDC. See
    /// `ripcord_core::sale_rate` for why it never moves.
    sale_start_rate: u128,
    sale_halvings: u32,
    sale: Option<Sale>,
    /// NEAR from purchases whose USDC is still on its way. If that transfer fails it goes
    /// back to the buyer, so until then it must not be staked or paid out.
    pending_refunds: u128,
    /// NEAR staked and never to be withdrawn: the growing, permanent part.
    principal_staked: u128,
    total_received: u128,
    total_paid_to_keepers: u128,
    keeper_payments: u64,
    near_from_sales: u128,
    usdc_sold: u128,
    last_harvest_epoch: EpochHeight,
}

#[near(serializers = [json])]
pub struct EndowmentStats {
    pub ripcord: AccountId,
    pub usdc: AccountId,
    pub pool: AccountId,
    pub keeper_bounty: U128,
    pub keeper_float: U128,
    pub principal_staked: U128,
    pub total_received: U128,
    pub total_paid_to_keepers: U128,
    pub keeper_payments: u64,
    pub near_from_sales: U128,
    pub usdc_sold: U128,
    pub sale_seconds: U64,
    pub sale_start_rate: U128,
    pub sale_halvings: u32,
    pub sale: Option<Sale>,
    pub pending_refunds: U128,
    pub last_harvest_epoch: U64,
    pub liquid_balance: U128,
}

#[near]
impl Endowment {
    /// Private, so nobody can get in between the deploy and this call with their own
    /// settings.
    #[init]
    #[private]
    pub fn new(
        ripcord: AccountId,
        usdc: AccountId,
        pool: AccountId,
        keeper_bounty: U128,
        keeper_float: U128,
        sale_seconds: U64,
        sale_start_rate: U128,
        sale_halvings: u32,
    ) -> Self {
        if let Err(e) =
            ripcord_core::validate_sale(sale_start_rate.0, sale_halvings, sale_seconds.0)
        {
            env::panic_str(&format!("bad sale: {e}"));
        }
        Self {
            ripcord,
            usdc,
            pool,
            keeper_bounty: NearToken::from_yoctonear(keeper_bounty.0),
            keeper_float: NearToken::from_yoctonear(keeper_float.0),
            sale_seconds: sale_seconds.0,
            sale_start_rate: sale_start_rate.0,
            sale_halvings,
            sale: None,
            pending_refunds: 0,
            principal_staked: 0,
            total_received: 0,
            total_paid_to_keepers: 0,
            keeper_payments: 0,
            near_from_sales: 0,
            usdc_sold: 0,
            last_harvest_epoch: 0,
        }
    }

    /// Receives a vault fee. Anyone may add to the endowment.
    #[payable]
    pub fn receive_fee(&mut self) {
        self.total_received += env::attached_deposit().as_yoctonear();
    }

    // ---- Selling USDC for NEAR ----

    /// Pulls this contract's share of interest out of Ripcord.
    pub fn collect_usdc(&mut self) -> Promise {
        Promise::new(self.ripcord.clone()).function_call(
            "withdraw".to_string(),
            b"{}".to_vec(),
            ONE_YOCTO,
            GAS_WITHDRAW,
        )
    }

    /// Opens a sale of all USDC held here. Anyone can call it, once the last sale is over.
    pub fn start_sale(&mut self) -> Promise {
        self.require_sale_slot_free();
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_balance_of".to_string(),
                json!({ "account_id": env::current_account_id() })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_usdc_balance(),
            )
    }

    #[private]
    pub fn on_usdc_balance(&mut self, #[callback_result] balance: Result<U128, PromiseError>) {
        let balance = balance.unwrap_or_else(|_| env::panic_str("could not read the balance"));
        // Rechecked: two calls can be in flight at once, and the second must not reset
        // the first sale back to its opening rate.
        self.require_sale_slot_free();
        require!(balance.0 >= MIN_SALE_MICRO_USDC, "not enough USDC to sell");
        self.sale = Some(Sale {
            usdc_left: balance,
            started_at_ms: U64(env::block_timestamp_ms()),
        });
    }

    /// Buys USDC with the attached NEAR at the current rate, refunding what is unused.
    #[payable]
    pub fn buy_usdc(&mut self) -> Promise {
        let mut sale = self
            .sale
            .clone()
            .unwrap_or_else(|| env::panic_str("no sale is running"));
        let rate = self
            .rate_of(&sale)
            .unwrap_or_else(|| env::panic_str("the sale has ended"));
        require!(sale.usdc_left.0 > 0, "the sale has sold out");

        let attached = env::attached_deposit().as_yoctonear();
        let usdc_out = (attached / rate).min(sale.usdc_left.0);
        require!(usdc_out > 0, "attach enough NEAR for at least one micro-USDC");
        let cost = usdc_out * rate;
        let buyer = env::predecessor_account_id();

        sale.usdc_left = U128(sale.usdc_left.0 - usdc_out);
        self.sale = Some(sale);
        self.pending_refunds += cost;
        self.near_from_sales += cost;
        self.usdc_sold += usdc_out;

        let refund = attached - cost;
        if refund > 0 {
            let _ = Promise::new(buyer.clone()).transfer(NearToken::from_yoctonear(refund));
        }
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": buyer, "amount": U128(usdc_out) })
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                GAS_FT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_usdc_sent(buyer, U128(cost), U128(usdc_out)),
            )
    }

    /// If the buyer could not take the USDC, the sale is undone and the NEAR goes back.
    #[private]
    pub fn on_usdc_sent(&mut self, buyer: AccountId, cost: U128, usdc: U128) {
        self.pending_refunds -= cost.0;
        if near_sdk::is_promise_success() {
            log!(
                "EVENT_JSON:{}",
                json!({
                    "standard": "ripcord-endowment",
                    "version": "1.0.0",
                    "event": "usdc_sold",
                    "data": [{ "buyer": buyer, "near": cost, "usdc": usdc }]
                })
            );
            return;
        }
        self.near_from_sales -= cost.0;
        self.usdc_sold -= usdc.0;
        if let Some(sale) = &mut self.sale {
            sale.usdc_left = U128(sale.usdc_left.0 + usdc.0);
        }
        let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(cost.0));
    }

    // ---- Staking ----

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

    /// Asks the pool to unstake rewards earned so far, keeping the principal staked. They
    /// become withdrawable after the pool's unbonding period.
    ///
    /// Open once every `HARVEST_EVERY_EPOCHS`. Otherwise a stranger could call this every
    /// few hours, restart the pool's wait each time, and keep the rewards locked for good.
    pub fn harvest_rewards(&mut self) -> Promise {
        self.require_harvest_open();
        Promise::new(self.pool.clone())
            .function_call(
                "get_account_staked_balance".to_string(),
                json!({ "account_id": env::current_account_id() })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
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
        // Rechecked: two calls can be in flight at once.
        self.require_harvest_open();
        let rewards = staked.0.saturating_sub(self.principal_staked);
        if rewards == 0 {
            log!("no rewards yet");
            return None;
        }
        self.last_harvest_epoch = env::epoch_height();
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

    // ---- Views ----

    /// The rate a buyer pays right now, in yoctoNEAR per micro-USDC.
    pub fn current_rate(&self) -> Option<U128> {
        self.sale
            .as_ref()
            .filter(|s| s.usdc_left.0 > 0)
            .and_then(|s| self.rate_of(s))
            .map(U128)
    }

    pub fn get_stats(&self) -> EndowmentStats {
        EndowmentStats {
            ripcord: self.ripcord.clone(),
            usdc: self.usdc.clone(),
            pool: self.pool.clone(),
            keeper_bounty: U128(self.keeper_bounty.as_yoctonear()),
            keeper_float: U128(self.keeper_float.as_yoctonear()),
            principal_staked: U128(self.principal_staked),
            total_received: U128(self.total_received),
            total_paid_to_keepers: U128(self.total_paid_to_keepers),
            keeper_payments: self.keeper_payments,
            near_from_sales: U128(self.near_from_sales),
            usdc_sold: U128(self.usdc_sold),
            sale_seconds: U64(self.sale_seconds),
            sale_start_rate: U128(self.sale_start_rate),
            sale_halvings: self.sale_halvings,
            sale: self.sale.clone(),
            pending_refunds: U128(self.pending_refunds),
            last_harvest_epoch: U64(self.last_harvest_epoch),
            liquid_balance: U128(env::account_balance().as_yoctonear()),
        }
    }

    // ---- Internals ----

    fn sale_elapsed_seconds(&self, sale: &Sale) -> u64 {
        env::block_timestamp_ms().saturating_sub(sale.started_at_ms.0) / 1_000
    }

    fn rate_of(&self, sale: &Sale) -> Option<u128> {
        ripcord_core::sale_rate(
            self.sale_start_rate,
            self.sale_halvings,
            self.sale_seconds,
            self.sale_elapsed_seconds(sale),
        )
    }

    /// A new sale needs the last one over and no purchase mid-flight. A purchase in
    /// flight still counts in this contract's token balance, so a sale opened then would
    /// offer USDC that has already been sold.
    fn require_sale_slot_free(&self) {
        require!(self.pending_refunds == 0, "a purchase is still settling");
        if let Some(sale) = &self.sale {
            require!(
                sale.usdc_left.0 == 0 || self.rate_of(sale).is_none(),
                "a sale is still running"
            );
        }
    }

    fn require_harvest_open(&self) {
        require!(
            env::epoch_height() >= self.last_harvest_epoch + HARVEST_EVERY_EPOCHS,
            "harvested too recently"
        );
    }

    /// Liquid NEAR, less what this contract's own storage locks up and what may yet go
    /// back to a buyer.
    fn spendable(&self) -> NearToken {
        let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        env::account_balance()
            .saturating_sub(locked)
            .saturating_sub(NearToken::from_yoctonear(self.pending_refunds))
    }
}
