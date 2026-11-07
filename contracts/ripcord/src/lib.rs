//! Ripcord: term loans against native Bitcoin.
//!
//! Collateral never leaves Bitcoin. It sits in a P2WSH script with two paths: this
//! contract through Chain Signatures, or the owner alone after an escape height that
//! Bitcoin itself enforces. See `near_btc_script::VaultSpec`.
//!
//! The loan rules are in `ripcord_core`. This file is wiring: it holds state, talks to
//! the Bitcoin light client and the MPC signer, and moves USDC.
//!
//! There is no owner, no admin method, no pause and no upgrade path. Deployed with its
//! keys removed, the rules cannot change, and that matters: the MPC key for each vault
//! is derived from this account, so whatever code runs here controls that coin.

mod types;
mod util;

use near_btc_script::{
    build_spend, classify_script_pubkey, der_signature, parse_tx, signer_path_witness,
    Sha256, VaultSpec,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, PublicKey,
};
use ripcord_core::{self as rules, OfferTerms, Stage};

pub use types::*;
use util::*;

const MPC_SIGN_DOMAIN: u32 = 0; // secp256k1

const GAS_LIGHT_CLIENT: Gas = Gas::from_tgas(20);
const GAS_DERIVE: Gas = Gas::from_tgas(10);
const GAS_SIGN: Gas = Gas::from_tgas(40);
const GAS_CALLBACK: Gas = Gas::from_tgas(25);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_ENDOWMENT: Gas = Gas::from_tgas(10);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Covers the vault record, its balances entry and the signed transaction.
const VAULT_STORAGE: NearToken = NearToken::from_millinear(20);

/// Keeps offer spam from growing storage for free. Ten dollars.
const MIN_OFFER_MICRO_USDC: u128 = 10_000_000;

const MAX_PROOF_DEPTH: usize = 32;
const MAX_PAGE: u64 = 100;

struct HostHash;

impl Sha256 for HostHash {
    fn sha256(data: &[u8]) -> [u8; 32] {
        env::sha256_array(data)
    }
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Vaults,
    Offers,
    Balances,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ripcord {
    config: Config,
    next_vault_id: u64,
    next_offer_id: u64,
    vaults: IterableMap<u64, Vault>,
    offers: IterableMap<u64, Offer>,
    /// USDC anyone can withdraw. Payments are pulled, never pushed, so a lender with a
    /// broken account cannot make a borrower's repayment fail.
    balances: LookupMap<AccountId, u128>,
    stats: Stats,
}

#[near]
impl Ripcord {
    /// Everything set here is permanent. There is no method to change any of it. Private,
    /// so nobody can get in between the deploy and this call with their own settings.
    #[init]
    #[private]
    pub fn new(config: ConfigInput) -> Self {
        let config = Config::from_input(config);
        if let Err(e) = config.params.to_core().validate() {
            env::panic_str(&format!("bad params: {e}"));
        }
        Self {
            config,
            next_vault_id: 0,
            next_offer_id: 0,
            vaults: IterableMap::new(StorageKey::Vaults),
            offers: IterableMap::new(StorageKey::Offers),
            balances: LookupMap::new(StorageKey::Balances),
            stats: Stats::default(),
        }
    }

    // ---- Vaults ----

    /// Opens a vault. `owner_pubkey` is the borrower's own Bitcoin key, 33 bytes in hex:
    /// the key that can recover the coins alone after `escape_height`.
    ///
    /// `expected_sats` is the smallest deposit this vault accepts. Proofs are open to
    /// anyone, so without it a stranger could prove a tiny deposit first and strand the
    /// real one until the escape height. With it, griefing means gifting that much.
    ///
    /// The address is ready in the callback, because the vault's key is derived by the
    /// MPC contract. Attach `VAULT_STORAGE` plus the vault fee. The fee is sent to the
    /// endowment, which stakes it with NEAR validators.
    #[payable]
    pub fn open_vault(
        &mut self,
        owner_pubkey: String,
        escape_height: u32,
        expected_sats: U64,
    ) -> Promise {
        require!(
            expected_sats.0 >= self.config.params.min_collateral_sats,
            "deposit below the minimum"
        );
        let owner_key: [u8; 33] = hex_array(&owner_pubkey, "owner_pubkey");
        // The signer key is unknown until the MPC answers. This checks the owner's half.
        let mut placeholder = [1u8; 33];
        placeholder[0] = 2;
        if let Err(e) = VaultSpec::new(placeholder, owner_key, escape_height) {
            env::panic_str(&format!("bad vault: {e}"));
        }

        let required = VAULT_STORAGE.saturating_add(self.config.vault_fee);
        let attached = env::attached_deposit();
        require!(
            attached >= required,
            format!("attach at least {} yoctoNEAR", required.as_yoctonear())
        );

        let id = self.next_vault_id;
        self.next_vault_id += 1;
        self.vaults.insert(
            id,
            Vault {
                id,
                owner: env::predecessor_account_id(),
                owner_pubkey: owner_key,
                escape_height,
                expected_sats: expected_sats.0,
                signer_pubkey: None,
                witness_script: Vec::new(),
                script_pubkey: Vec::new(),
                deposit: None,
                loan: None,
                status: Status::Deriving {
                    attached: attached.as_yoctonear(),
                },
                signed_tx: None,
                signed_txid: None,
            },
        );

        Promise::new(self.config.mpc.clone())
            .function_call(
                "derived_public_key".to_string(),
                json!({
                    "path": vault_path(id),
                    "predecessor": env::current_account_id(),
                    "domain_id": MPC_SIGN_DOMAIN,
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_DERIVE,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_vault_key(id),
            )
    }

    #[private]
    pub fn on_vault_key(
        &mut self,
        vault_id: u64,
        #[callback_result] key: Result<PublicKey, PromiseError>,
    ) -> Option<U64> {
        // Gone or moved on means the owner abandoned it and already has their money back.
        let mut vault = self.vaults.get(&vault_id).cloned()?;
        let Status::Deriving { attached } = vault.status else {
            return None;
        };
        let attached = NearToken::from_yoctonear(attached);
        let owner = vault.owner.clone();
        let key = match key {
            Ok(k) => k,
            Err(_) => {
                // Nothing was promised yet, so undo cleanly and return everything.
                self.vaults.remove(&vault_id);
                let _ = Promise::new(owner).transfer(attached);
                log!("vault {vault_id}: key derivation failed, deposit returned");
                return None;
            }
        };

        let signer = compress_secp256k1(&key);
        let spec = VaultSpec::new(signer, vault.owner_pubkey, vault.escape_height)
            .unwrap_or_else(|e| env::panic_str(&format!("bad vault: {e}")));
        vault.signer_pubkey = Some(signer);
        vault.witness_script = spec.witness_script();
        vault.script_pubkey = spec.script_pubkey::<HostHash>();
        vault.status = Status::AwaitingDeposit;
        let address = self.address_of(&vault.script_pubkey);
        self.vaults.insert(vault_id, vault);
        self.stats.vaults_opened += 1;
        emit("vault_opened", json!({ "vault_id": vault_id, "address": address }));

        // Fee to the endowment, anything over the requirement back to the owner.
        let fee = self.config.vault_fee;
        let _ = Promise::new(self.config.endowment.clone())
            .function_call(
                "receive_fee".to_string(),
                b"{}".to_vec(),
                fee,
                GAS_ENDOWMENT,
            );
        self.stats.near_sent_to_endowment.0 += fee.as_yoctonear();
        let refund = attached
            .saturating_sub(fee)
            .saturating_sub(VAULT_STORAGE);
        if !refund.is_zero() {
            let _ = Promise::new(owner).transfer(refund);
        }
        Some(U64(vault_id))
    }

    /// Returns the money for a vault whose key never arrived. If the callback above ever
    /// failed, nothing else could move the vault out of `Deriving`. The record is removed
    /// first, so a late callback finds nothing and cannot refund a second time.
    #[payable]
    pub fn abandon_vault(&mut self, vault_id: U64) -> Promise {
        near_sdk::assert_one_yocto();
        let vault = self.vault(vault_id.0);
        require!(
            vault.owner == env::predecessor_account_id(),
            "only the vault owner can abandon it"
        );
        let Status::Deriving { attached } = vault.status else {
            env::panic_str("this vault already has its key");
        };
        self.vaults.remove(&vault_id.0);
        emit("vault_abandoned", json!({ "vault_id": vault_id }));
        Promise::new(vault.owner).transfer(NearToken::from_yoctonear(attached))
    }

    /// Proves a deposit with a Merkle proof against the Bitcoin light client. Anyone can
    /// submit it: the proof either holds or it does not.
    ///
    /// `raw_tx` is the transaction in hex, with or without witness data. The contract
    /// computes the txid itself and reads the amount from the output, so nothing about
    /// the deposit is taken on trust.
    pub fn prove_deposit(
        &mut self,
        vault_id: U64,
        raw_tx: String,
        vout: u32,
        proof: TxProof,
    ) -> Promise {
        let vault = self.vault(vault_id.0);
        require!(
            vault.status == Status::AwaitingDeposit,
            "vault is not awaiting a deposit"
        );

        let tx = parse_tx(&hex_bytes(&raw_tx, "raw_tx"))
            .unwrap_or_else(|e| env::panic_str(&format!("bad transaction: {e}")));
        let output = tx
            .outputs
            .get(vout as usize)
            .unwrap_or_else(|| env::panic_str("no such output"));
        require!(
            output.script_pubkey == vault.script_pubkey,
            "output does not pay this vault"
        );
        require!(
            output.value >= vault.expected_sats,
            "deposit is below what this vault expects"
        );

        require!(
            proof.merkle_proof.len() <= MAX_PROOF_DEPTH
                && proof.merkle_proof.len() == proof.coinbase_merkle_proof.len(),
            "bad proof length"
        );
        let txid = tx.txid::<HostHash>();
        let args = ProofArgsV2 {
            tx_id: txid,
            tx_block_blockhash: display_hash(&proof.block_hash),
            tx_index: proof.tx_index.0,
            merkle_proof: proof.merkle_proof.iter().map(|h| display_hash(h)).collect(),
            coinbase_tx_id: display_hash(&proof.coinbase_txid),
            coinbase_merkle_proof: proof
                .coinbase_merkle_proof
                .iter()
                .map(|h| display_hash(h))
                .collect(),
            confirmations: self.config.confirmations,
        };

        Promise::new(self.config.btc_client.clone())
            .function_call(
                "verify_transaction_inclusion_v2".to_string(),
                near_sdk::borsh::to_vec(&args).expect("borsh"),
                NearToken::from_yoctonear(0),
                GAS_LIGHT_CLIENT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_deposit_proof(vault_id.0, hex(&txid), vout, U64(output.value)),
            )
    }

    #[private]
    pub fn on_deposit_proof(
        &mut self,
        vault_id: u64,
        txid: String,
        vout: u32,
        sats: U64,
        #[callback_result] result: Result<bool, PromiseError>,
    ) {
        require!(
            matches!(result, Ok(true)),
            "the light client did not accept this proof"
        );
        let mut vault = self.vault(vault_id);
        // Rechecked: two proofs can be in flight at once, and only the first may count.
        require!(
            vault.status == Status::AwaitingDeposit,
            "vault is not awaiting a deposit"
        );
        vault.deposit = Some(Deposit {
            txid: hex_array(&txid, "txid"),
            vout,
            sats: sats.0,
        });
        vault.status = Status::Funded;
        self.vaults.insert(vault_id, vault);
        self.stats.sats_locked += sats.0;
        self.stats.sats_deposited_ever += sats.0;
        emit(
            "deposit_proven",
            json!({ "vault_id": vault_id, "txid": display_txid(&txid), "vout": vout, "sats": sats }),
        );
    }

    // ---- Lending ----

    /// Takes an offer. The term runs in Bitcoin blocks, so the light client's height is
    /// read first and the checks run in the callback. If `payout_to` is set the USDC is
    /// sent there at once: a 1Click deposit address delivers it to any chain.
    ///
    /// `auction_open_per_btc` is the borrower's own bet on what a bitcoin could be worth,
    /// in micro-USDC. If the loan defaults, the auction opens there and falls to the debt.
    /// Nobody else can name it, because the contract has no price feed. Too low, and a
    /// bot can take the coins for less than they are worth. There is no such risk in
    /// aiming high: the price still falls all the way, so it only takes longer. Zero
    /// opens at the lowest the rules allow.
    ///
    /// Needs one yoctoNEAR so a full-access key must sign. Otherwise a leaked app session
    /// key could open a loan and point `payout_to` at an attacker.
    #[payable]
    pub fn borrow(
        &mut self,
        vault_id: U64,
        offer_id: U64,
        principal: U128,
        auction_open_per_btc: U128,
        payout_to: Option<AccountId>,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        let vault = self.vault(vault_id.0);
        require!(
            vault.owner == env::predecessor_account_id(),
            "only the vault owner can borrow"
        );
        require!(vault.status == Status::Funded, "vault has no free collateral");
        self.tip_then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK.saturating_add(GAS_FT_TRANSFER))
                .on_tip_borrow(vault_id.0, offer_id.0, principal, auction_open_per_btc, payout_to),
        )
    }

    #[private]
    pub fn on_tip_borrow(
        &mut self,
        vault_id: u64,
        offer_id: u64,
        principal: U128,
        auction_open_per_btc: U128,
        payout_to: Option<AccountId>,
        #[callback_result] tip: Result<LightClientTip, PromiseError>,
    ) -> PromiseOrValue<()> {
        let tip = self.fresh_tip(tip);
        let mut vault = self.vault(vault_id);
        // Rechecked here: this is the step that actually commits.
        require!(vault.status == Status::Funded, "vault has no free collateral");
        let mut offer = self.offer(offer_id);
        let deposit = vault.deposit.clone().expect("funded vault has a deposit");

        let terms = rules::open_loan(
            &self.config.params.to_core(),
            &offer.terms(),
            offer.available,
            deposit.sats,
            principal.0,
            auction_open_per_btc.0,
            tip,
            vault.escape_height,
        )
        .unwrap_or_else(|e| env::panic_str(&format!("loan refused: {e}")));

        offer.available -= principal.0;
        vault.loan = Some(Loan {
            offer_id,
            lender: offer.lender.clone(),
            lender_script: offer.btc_script.clone(),
            principal: terms.principal,
            interest: terms.interest,
            due_height: terms.due_height,
            auction_start: terms.auction_start,
        });
        vault.status = Status::Borrowed;
        let owner = vault.owner.clone();
        // An empty offer is deleted. Nothing pays rent for offers, so dead ones must go.
        if offer.available == 0 {
            self.offers.remove(&offer_id);
            emit("offer_closed", json!({ "offer_id": U64(offer_id), "returned": U128(0) }));
        } else {
            self.offers.insert(offer_id, offer);
        }
        self.vaults.insert(vault_id, vault);
        self.credit(&owner, principal.0);
        self.stats.loans_opened += 1;
        self.stats.principal_lent.0 += principal.0;
        emit(
            "loan_opened",
            json!({
                "vault_id": vault_id,
                "offer_id": offer_id,
                "principal": principal,
                "interest": U128(terms.interest),
                "due_height": terms.due_height,
                "auction_start": U128(terms.auction_start),
            }),
        );

        match payout_to {
            Some(receiver) => PromiseOrValue::Promise(self.pay_out(owner, receiver, principal.0)),
            None => PromiseOrValue::Value(()),
        }
    }

    /// Withdraws the caller's USDC balance. `receiver` defaults to the caller.
    #[payable]
    pub fn withdraw(&mut self, receiver: Option<AccountId>) -> Promise {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        let amount = self.balances.get(&account).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        let receiver = receiver.unwrap_or_else(|| account.clone());
        self.pay_out(account, receiver, amount)
    }

    #[private]
    pub fn on_payout(&mut self, account: AccountId, amount: U128) {
        if !near_sdk::is_promise_success() {
            // The receiver could not take it, so the balance stays safe in the contract.
            self.credit(&account, amount.0);
            log!("payout failed, {} returned to {account}", amount.0);
        }
    }

    /// Handles USDC sent with `ft_transfer_call`. `msg` is a [`TokenAction`] in JSON.
    /// Anything that panics here refunds the sender in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.config.usdc,
            "only the configured USDC"
        );
        let action: TokenAction = serde_json::from_str(&msg)
            .unwrap_or_else(|e| env::panic_str(&format!("bad msg: {e}")));
        let refund = match action {
            TokenAction::Offer(input) => {
                self.create_offer(sender_id, amount.0, input);
                0
            }
            TokenAction::Repay { vault_id } => self.repay(vault_id.0, amount.0),
            TokenAction::Bid {
                vault_id,
                btc_script,
            } => self.bid(sender_id, vault_id.0, amount.0, btc_script),
        };
        PromiseOrValue::Value(U128(refund))
    }

    /// Closes an offer and returns whatever has not been lent. Loans already taken from
    /// it are unaffected.
    #[payable]
    pub fn cancel_offer(&mut self, offer_id: U64) {
        near_sdk::assert_one_yocto();
        let offer = self.offer(offer_id.0);
        require!(
            offer.lender == env::predecessor_account_id(),
            "only the lender can cancel"
        );
        self.offers.remove(&offer_id.0);
        self.credit(&offer.lender, offer.available);
        emit(
            "offer_closed",
            json!({ "offer_id": offer_id, "returned": U128(offer.available) }),
        );
    }

    // ---- Default ----

    /// Starts the auction for a loan past its grace period. Anyone can call this, and
    /// the caller earns a keeper bounty from the endowment.
    pub fn start_auction(&mut self, vault_id: U64) -> Promise {
        let vault = self.vault(vault_id.0);
        require!(vault.status == Status::Borrowed, "no active loan");
        self.tip_then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_tip_start_auction(vault_id.0, env::predecessor_account_id()),
        )
    }

    #[private]
    pub fn on_tip_start_auction(
        &mut self,
        vault_id: u64,
        keeper: AccountId,
        #[callback_result] tip: Result<LightClientTip, PromiseError>,
    ) {
        let tip = self.fresh_tip(tip);
        let mut vault = self.vault(vault_id);
        require!(vault.status == Status::Borrowed, "no active loan");
        let loan = vault.loan.clone().expect("borrowed vault has a loan");
        let params = self.config.params.to_core();

        match rules::stage(&params, &loan.terms(), tip, vault.escape_height) {
            Stage::Protected => env::panic_str("the loan is not past its grace period"),
            Stage::Auctionable => {
                let started_at_ms = env::block_timestamp_ms();
                vault.status = Status::Auction { started_at_ms };
                self.vaults.insert(vault_id, vault);
                emit(
                    "auction_started",
                    json!({
                        "vault_id": vault_id,
                        "start_price": U128(loan.auction_start),
                        "floor_price": U128(loan.terms().debt()),
                    }),
                );
            }
            Stage::TooLateForAuction => {
                // No safe window is left, so the lender takes the coins directly.
                vault.status = Status::Settling {
                    destination: loan.lender_script.clone(),
                    beneficiary: loan.lender.clone(),
                    reason: SettleReason::LateClaim,
                };
                self.vaults.insert(vault_id, vault);
                self.stats.lender_claims += 1;
                emit("collateral_claimed", json!({ "vault_id": vault_id, "late": true }));
            }
        }

        let _ = Promise::new(self.config.endowment.clone()).function_call(
            "pay_keeper".to_string(),
            json!({ "keeper": keeper }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_ENDOWMENT,
        );
    }

    /// After an auction ends with no bid, the coins go to the lender's Bitcoin script.
    /// Anyone can call this: the destination was fixed when the lender made the offer.
    pub fn claim_collateral(&mut self, vault_id: U64) {
        let mut vault = self.vault(vault_id.0);
        let Status::Auction { started_at_ms } = vault.status else {
            env::panic_str("no auction on this vault");
        };
        let loan = vault.loan.clone().expect("auction has a loan");
        let elapsed = seconds_since(started_at_ms);
        let params = self.config.params.to_core();
        require!(
            rules::auction_price(&params, &loan.terms(), elapsed).is_none(),
            "the auction is still running"
        );
        vault.status = Status::Settling {
            destination: loan.lender_script,
            beneficiary: loan.lender,
            reason: SettleReason::NoBids,
        };
        self.vaults.insert(vault_id.0, vault);
        self.stats.lender_claims += 1;
        emit("collateral_claimed", json!({ "vault_id": vault_id, "late": false }));
    }

    // ---- Moving the coins ----

    /// Fixes where a vault with no loan sends its coins.
    #[payable]
    pub fn release(&mut self, vault_id: U64, destination: String) {
        near_sdk::assert_one_yocto();
        let mut vault = self.vault(vault_id.0);
        require!(
            vault.owner == env::predecessor_account_id(),
            "only the vault owner can release"
        );
        require!(vault.status == Status::Funded, "vault has no free collateral");
        let destination = checked_script(&destination);
        vault.status = Status::Settling {
            destination,
            beneficiary: vault.owner.clone(),
            reason: SettleReason::Released,
        };
        self.vaults.insert(vault_id.0, vault);
        emit("collateral_released", json!({ "vault_id": vault_id }));
    }

    /// Asks the MPC network to sign the settling spend. Only the beneficiary chooses the
    /// fee, because it comes out of their coins. Calling again with a higher fee replaces
    /// the stored transaction, which is how a stuck spend gets unstuck.
    ///
    /// Needs one yoctoNEAR so a full-access key must sign, because the fee spends real
    /// coins, and so the contract's own balance does not pay for the signature.
    #[payable]
    pub fn request_signature(&mut self, vault_id: U64, fee_sats: U64) -> Promise {
        near_sdk::assert_one_yocto();
        let vault = self.vault(vault_id.0);
        let Status::Settling { beneficiary, .. } = &vault.status else {
            env::panic_str("vault is not settling");
        };
        require!(
            *beneficiary == env::predecessor_account_id(),
            "only the beneficiary can set the fee"
        );
        let (_, sighash) = self.build_settlement(&vault, fee_sats.0);

        Promise::new(self.config.mpc.clone())
            .function_call(
                "sign".to_string(),
                json!({
                    "request": {
                        "path": vault_path(vault_id.0),
                        "payload_v2": { "Ecdsa": hex(&sighash) },
                        "domain_id": MPC_SIGN_DOMAIN,
                    }
                })
                .to_string()
                .into_bytes(),
                ONE_YOCTO,
                GAS_SIGN,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_signature(vault_id.0, fee_sats),
            )
    }

    #[private]
    pub fn on_signature(
        &mut self,
        vault_id: u64,
        fee_sats: U64,
        #[callback_result] signature: Result<MpcSignature, PromiseError>,
    ) {
        let signature = signature
            .unwrap_or_else(|_| env::panic_str("the signer did not answer, call again"));
        let mut vault = self.vault(vault_id);
        require!(
            matches!(vault.status, Status::Settling { .. }),
            "vault is not settling"
        );
        // Deterministic, so this rebuilds exactly what the signer was given.
        let (tx, sighash) = self.build_settlement(&vault, fee_sats.0);

        let (r, s) = signature.parts();
        let signer = vault.signer_pubkey.expect("settling vault has a key");
        check_signature(&sighash, &r, &s, signature.recovery_id, &signer);

        let der = der_signature(&r, &s);
        let witness = signer_path_witness(&der, &vault.witness_script);
        let raw = tx
            .serialize_with_witness(&[witness])
            .unwrap_or_else(|e| env::panic_str(&format!("{e}")));
        let txid = tx.txid::<HostHash>();

        // A fee bump signs again. Only the first signature takes the coins off the total.
        let first_signature = vault.signed_tx.is_none();
        vault.signed_tx = Some(raw);
        vault.signed_txid = Some(txid);
        let sats = vault.deposit.as_ref().map_or(0, |d| d.sats);
        self.vaults.insert(vault_id, vault);
        if first_signature {
            self.stats.sats_locked = self.stats.sats_locked.saturating_sub(sats);
        }
        emit(
            "spend_signed",
            json!({ "vault_id": vault_id, "txid": display_txid(&hex(&txid)), "fee_sats": fee_sats }),
        );
    }

    // ---- Views ----

    pub fn get_config(&self) -> ConfigView {
        ConfigView::from(&self.config, VAULT_STORAGE)
    }

    pub fn get_stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn get_vault(&self, vault_id: U64) -> Option<VaultView> {
        self.vaults
            .get(&vault_id.0)
            .map(|v| self.view_of(v))
    }

    pub fn list_vaults(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<VaultView> {
        self.vaults
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(_, v)| self.view_of(v))
            .collect()
    }

    pub fn get_offer(&self, offer_id: U64) -> Option<OfferView> {
        self.offers.get(&offer_id.0).map(OfferView::from)
    }

    pub fn list_offers(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<OfferView> {
        self.offers
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize)
            .map(|(_, o)| OfferView::from(o))
            .collect()
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    /// The current auction price, or `None` if there is no running auction.
    pub fn auction_price(&self, vault_id: U64) -> Option<U128> {
        let vault = self.vaults.get(&vault_id.0)?;
        let Status::Auction { started_at_ms } = vault.status else {
            return None;
        };
        let terms = vault.loan.as_ref()?.terms();
        rules::auction_price(&self.config.params.to_core(), &terms, seconds_since(started_at_ms))
            .map(U128)
    }

    // ---- Internals ----

    fn vault(&self, id: u64) -> Vault {
        self.vaults
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such vault"))
    }

    fn offer(&self, id: u64) -> Offer {
        self.offers
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such offer"))
    }

    fn credit(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let balance = self.balances.get(account).copied().unwrap_or(0);
        self.balances.insert(account.clone(), balance + amount);
    }

    /// Reads the newest Bitcoin header from the light client, then runs `callback`.
    fn tip_then(&self, callback: Promise) -> Promise {
        Promise::new(self.config.btc_client.clone())
            .function_call(
                "get_last_block_header".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                GAS_LIGHT_CLIENT,
            )
            .then(callback)
    }

    /// The Bitcoin height, refusing a light client that has stopped following Bitcoin.
    fn fresh_tip(&self, tip: Result<LightClientTip, PromiseError>) -> u32 {
        let tip = tip.unwrap_or_else(|_| env::panic_str("could not read the Bitcoin height"));
        require!(
            rules::tip_is_fresh(
                &self.config.params.to_core(),
                tip.block_header.time,
                env::block_timestamp_ms() / 1_000,
            ),
            "the light client is behind Bitcoin"
        );
        u32::try_from(tip.block_height)
            .unwrap_or_else(|_| env::panic_str("Bitcoin height out of range"))
    }

    fn pay_out(&mut self, account: AccountId, receiver: AccountId, amount: u128) -> Promise {
        let balance = self.balances.get(&account).copied().unwrap_or(0);
        require!(balance >= amount, "insufficient balance");
        // A settled balance is deleted, for the same reason as an empty offer.
        if balance == amount {
            self.balances.remove(&account);
        } else {
            self.balances.insert(account.clone(), balance - amount);
        }
        Promise::new(self.config.usdc.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": receiver, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(5))
                    .on_payout(account, U128(amount)),
            )
    }

    fn create_offer(&mut self, lender: AccountId, amount: u128, input: OfferInput) {
        require!(amount >= MIN_OFFER_MICRO_USDC, "offer below the minimum");
        let terms = OfferTerms {
            micro_usdc_per_btc: input.micro_usdc_per_btc.0,
            apr_bps: input.apr_bps,
            term_blocks: input.term_blocks,
        };
        if let Err(e) = terms.validate() {
            env::panic_str(&format!("bad offer: {e}"));
        }
        let btc_script = checked_script(&input.btc_script);
        let id = self.next_offer_id;
        self.next_offer_id += 1;
        self.offers.insert(
            id,
            Offer {
                id,
                lender,
                available: amount,
                micro_usdc_per_btc: terms.micro_usdc_per_btc,
                apr_bps: terms.apr_bps,
                term_blocks: terms.term_blocks,
                btc_script,
            },
        );
        emit(
            "offer_created",
            json!({
                "offer_id": U64(id),
                "amount": U128(amount),
                "micro_usdc_per_btc": input.micro_usdc_per_btc,
                "apr_bps": input.apr_bps,
                "term_blocks": input.term_blocks,
            }),
        );
    }

    /// Clears a loan. Anyone can pay, because a repayment arriving through 1Click comes
    /// from a solver, not the borrower. Returns the unused part of `amount`.
    fn repay(&mut self, vault_id: u64, amount: u128) -> u128 {
        let mut vault = self.vault(vault_id);
        require!(vault.status == Status::Borrowed, "no active loan");
        let loan = vault.loan.clone().expect("borrowed vault has a loan");
        let terms = loan.terms();
        let debt = terms.debt();
        require!(amount >= debt, "payment is below the debt");

        let split = rules::repayment_split(&self.config.params.to_core(), &terms);
        self.credit(&loan.lender, split.to_lender);
        let endowment = self.config.endowment.clone();
        self.credit(&endowment, split.to_flywheel);

        vault.loan = None;
        vault.status = Status::Funded;
        self.vaults.insert(vault_id, vault);
        self.stats.loans_repaid += 1;
        self.stats.usdc_to_flywheel.0 += split.to_flywheel;
        emit("loan_repaid", json!({ "vault_id": U64(vault_id), "debt": U128(debt) }));
        amount - debt
    }

    fn bid(&mut self, bidder: AccountId, vault_id: u64, amount: u128, btc_script: String) -> u128 {
        let mut vault = self.vault(vault_id);
        let Status::Auction { started_at_ms } = vault.status else {
            env::panic_str("no auction on this vault");
        };
        let destination = checked_script(&btc_script);
        let loan = vault.loan.clone().expect("auction has a loan");
        let terms = loan.terms();
        let params = self.config.params.to_core();
        let price = rules::auction_price(&params, &terms, seconds_since(started_at_ms))
            .unwrap_or_else(|| env::panic_str("the auction has ended"));
        require!(amount >= price, "bid is below the current price");

        let split = rules::bid_split(&params, &terms, price);
        self.credit(&loan.lender, split.to_lender);
        let endowment = self.config.endowment.clone();
        self.credit(&endowment, split.to_flywheel);
        let owner = vault.owner.clone();
        self.credit(&owner, split.to_borrower);

        vault.status = Status::Settling {
            destination,
            beneficiary: bidder,
            reason: SettleReason::AuctionWon,
        };
        self.vaults.insert(vault_id, vault);
        self.stats.auctions_won += 1;
        self.stats.usdc_to_flywheel.0 += split.to_flywheel;
        emit(
            "auction_won",
            json!({
                "vault_id": U64(vault_id),
                "price": U128(price),
                "to_borrower": U128(split.to_borrower),
            }),
        );
        amount - price
    }

    /// Builds the settling spend. Pure in its inputs, so the request and the callback
    /// always agree on what is signed.
    fn build_settlement(&self, vault: &Vault, fee_sats: u64) -> (near_btc_script::Tx, [u8; 32]) {
        let Status::Settling { destination, .. } = &vault.status else {
            env::panic_str("vault is not settling");
        };
        let deposit = vault
            .deposit
            .as_ref()
            .unwrap_or_else(|| env::panic_str("vault has no deposit"));
        require!(
            fee_sats <= rules::max_btc_fee(&self.config.params.to_core(), deposit.sats),
            "fee is above the cap"
        );
        let tx = build_spend(
            near_btc_script::OutPoint {
                txid: deposit.txid,
                vout: deposit.vout,
            },
            deposit.sats,
            destination,
            fee_sats,
            0,
        )
        .unwrap_or_else(|e| env::panic_str(&format!("bad spend: {e}")));
        let sighash = tx
            .sighash_all::<HostHash>(0, &vault.witness_script, deposit.sats)
            .unwrap_or_else(|e| env::panic_str(&format!("bad sighash: {e}")));
        (tx, sighash)
    }

    fn address_of(&self, script_pubkey: &[u8]) -> String {
        near_btc_script::bech32::encode_segwit(&self.config.btc_hrp, 0, &script_pubkey[2..])
            .unwrap_or_default()
    }

    fn view_of(&self, vault: &Vault) -> VaultView {
        let address = if vault.script_pubkey.is_empty() {
            None
        } else {
            Some(self.address_of(&vault.script_pubkey))
        };
        VaultView::from(vault, address, self.config.params.to_core())
    }
}

/// Refuses any destination nodes would not relay or that nobody could spend.
fn checked_script(script_hex: &str) -> Vec<u8> {
    let script = hex_bytes(script_hex, "btc_script");
    require!(
        classify_script_pubkey(&script).is_some(),
        "not a standard Bitcoin output"
    );
    script
}

fn seconds_since(started_at_ms: u64) -> u64 {
    env::block_timestamp_ms().saturating_sub(started_at_ms) / 1_000
}

fn vault_path(id: u64) -> String {
    format!("ripcord-vault-{id}")
}

fn emit(event: &str, data: serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({ "standard": "ripcord", "version": "1.0.0", "event": event, "data": [data] })
    );
}

/// Confirms the signer's answer really is for this key and digest, so a bad response
/// can never be stored as a usable transaction.
fn check_signature(digest: &[u8; 32], r: &[u8; 32], s: &[u8; 32], v: u8, signer: &[u8; 33]) {
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(r);
    sig[32..].copy_from_slice(s);
    let recovered = env::ecrecover(digest, &sig, v, false)
        .unwrap_or_else(|| env::panic_str("signature does not recover"));
    let prefix = if recovered[63] & 1 == 0 { 2 } else { 3 };
    require!(
        prefix == signer[0] && recovered[..32] == signer[1..],
        "signature is not from this vault's key"
    );
}
