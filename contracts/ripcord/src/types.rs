use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, NearToken};
use ripcord_core::{LoanTerms, OfferTerms, Params};

use crate::util::{hex, reverse_hex};

/// Permanent settings, as given to `new`.
#[near(serializers = [json])]
pub struct ConfigInput {
    pub mpc: AccountId,
    pub btc_client: AccountId,
    pub usdc: AccountId,
    pub endowment: AccountId,
    /// Address prefix: `bc` on mainnet, `tb` on testnet.
    pub btc_hrp: String,
    /// Blocks a deposit must have before its proof counts.
    pub confirmations: u64,
    /// Sent to the endowment for each vault, in yoctoNEAR.
    pub vault_fee: U128,
    pub params: StoredParams,
}

#[near(serializers = [borsh])]
pub struct Config {
    pub mpc: AccountId,
    pub btc_client: AccountId,
    pub usdc: AccountId,
    pub endowment: AccountId,
    pub btc_hrp: String,
    pub confirmations: u64,
    pub vault_fee: NearToken,
    pub params: StoredParams,
}

impl Config {
    pub fn from_input(input: ConfigInput) -> Self {
        Self {
            mpc: input.mpc,
            btc_client: input.btc_client,
            usdc: input.usdc,
            endowment: input.endowment,
            btc_hrp: input.btc_hrp,
            confirmations: input.confirmations,
            vault_fee: NearToken::from_yoctonear(input.vault_fee.0),
            params: input.params,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub struct StoredParams {
    pub min_collateral_sats: u64,
    pub grace_blocks: u32,
    pub start_window_blocks: u32,
    pub auction_seconds: u64,
    pub auction_blocks: u32,
    pub safety_blocks: u32,
    pub auction_start_bps: u32,
    pub flywheel_share_bps: u32,
    pub max_btc_fee_bps: u32,
    pub max_tip_age_seconds: u64,
}

impl StoredParams {
    pub fn to_core(self) -> Params {
        Params {
            min_collateral_sats: self.min_collateral_sats,
            grace_blocks: self.grace_blocks,
            start_window_blocks: self.start_window_blocks,
            auction_seconds: self.auction_seconds,
            auction_blocks: self.auction_blocks,
            safety_blocks: self.safety_blocks,
            auction_start_bps: self.auction_start_bps,
            flywheel_share_bps: self.flywheel_share_bps,
            max_btc_fee_bps: self.max_btc_fee_bps,
            max_tip_age_seconds: self.max_tip_age_seconds,
        }
    }
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub mpc: AccountId,
    pub btc_client: AccountId,
    pub usdc: AccountId,
    pub endowment: AccountId,
    pub btc_hrp: String,
    pub confirmations: u64,
    pub vault_fee: U128,
    pub vault_storage: U128,
    pub params: StoredParams,
}

impl ConfigView {
    pub fn from(c: &Config, storage: NearToken) -> Self {
        Self {
            mpc: c.mpc.clone(),
            btc_client: c.btc_client.clone(),
            usdc: c.usdc.clone(),
            endowment: c.endowment.clone(),
            btc_hrp: c.btc_hrp.clone(),
            confirmations: c.confirmations,
            vault_fee: U128(c.vault_fee.as_yoctonear()),
            vault_storage: U128(storage.as_yoctonear()),
            params: c.params,
        }
    }
}

/// The deposit a vault holds. `txid` is in internal byte order.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Deposit {
    pub txid: [u8; 32],
    pub vout: u32,
    pub sats: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Loan {
    pub offer_id: u64,
    pub lender: AccountId,
    /// Where the coins go if nobody bids.
    pub lender_script: Vec<u8>,
    pub principal: u128,
    pub interest: u128,
    pub due_height: u32,
    /// Where the auction opens if this loan defaults.
    pub auction_start: u128,
}

impl Loan {
    pub fn terms(&self) -> LoanTerms {
        LoanTerms {
            principal: self.principal,
            interest: self.interest,
            due_height: self.due_height,
            auction_start: self.auction_start,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq)]
pub enum SettleReason {
    /// The owner took the coins back.
    Released,
    /// An auction bidder bought them.
    AuctionWon,
    /// The auction ended with no bid, so the lender took them.
    NoBids,
    /// Nobody started the auction in time, so the lender took them.
    LateClaim,
}

#[near(serializers = [borsh])]
#[derive(Clone, PartialEq)]
pub enum Status {
    /// Waiting for the MPC contract to return this vault's key. `attached` is what the
    /// owner paid, held until the key arrives so it can go back in full if it never does.
    Deriving {
        attached: u128,
    },
    AwaitingDeposit,
    /// Deposit proven, with no loan against it.
    Funded,
    Borrowed,
    Auction {
        started_at_ms: u64,
    },
    /// The coins have one fixed destination and only need a signature. This state is
    /// final: nothing can redirect them.
    Settling {
        destination: Vec<u8>,
        beneficiary: AccountId,
        reason: SettleReason,
    },
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Vault {
    pub id: u64,
    pub owner: AccountId,
    pub owner_pubkey: [u8; 33],
    pub escape_height: u32,
    /// Smallest deposit a proof may claim. See `open_vault`.
    pub expected_sats: u64,
    pub signer_pubkey: Option<[u8; 33]>,
    pub witness_script: Vec<u8>,
    pub script_pubkey: Vec<u8>,
    pub deposit: Option<Deposit>,
    pub loan: Option<Loan>,
    pub status: Status,
    pub signed_tx: Option<Vec<u8>>,
    pub signed_txid: Option<[u8; 32]>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Offer {
    pub id: u64,
    pub lender: AccountId,
    /// USDC still free to lend, in micro-USDC.
    pub available: u128,
    pub micro_usdc_per_btc: u128,
    pub apr_bps: u32,
    pub term_blocks: u32,
    pub btc_script: Vec<u8>,
}

impl Offer {
    pub fn terms(&self) -> OfferTerms {
        OfferTerms {
            micro_usdc_per_btc: self.micro_usdc_per_btc,
            apr_bps: self.apr_bps,
            term_blocks: self.term_blocks,
        }
    }
}

/// `msg` for `ft_transfer_call`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum TokenAction {
    Offer(OfferInput),
    Repay { vault_id: U64 },
    Bid { vault_id: U64, btc_script: String },
}

#[near(serializers = [json])]
pub struct OfferInput {
    pub micro_usdc_per_btc: U128,
    pub apr_bps: u32,
    pub term_blocks: u32,
    /// Output script, in hex, for the coins if a borrower defaults and nobody bids.
    pub btc_script: String,
}

/// Hashes are in hex, in the order explorers print them.
#[near(serializers = [json])]
pub struct TxProof {
    pub block_hash: String,
    pub tx_index: U64,
    pub merkle_proof: Vec<String>,
    pub coinbase_txid: String,
    pub coinbase_merkle_proof: Vec<String>,
}

/// Arguments of the light client's `verify_transaction_inclusion_v2`, in borsh.
#[near(serializers = [borsh])]
pub struct ProofArgsV2 {
    pub tx_id: [u8; 32],
    pub tx_block_blockhash: [u8; 32],
    pub tx_index: u64,
    pub merkle_proof: Vec<[u8; 32]>,
    pub coinbase_tx_id: [u8; 32],
    pub coinbase_merkle_proof: Vec<[u8; 32]>,
    pub confirmations: u64,
}

/// The parts of the light client's `get_last_block_header` answer this contract reads.
#[near(serializers = [json])]
pub struct LightClientTip {
    pub block_header: TipHeader,
    pub block_height: u64,
}

#[near(serializers = [json])]
pub struct TipHeader {
    /// Seconds since 1970, as the miner stamped it.
    pub time: u32,
}

/// The part of the MPC response this contract reads.
#[near(serializers = [json])]
pub struct MpcSignature {
    pub big_r: BigR,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
pub struct BigR {
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct Scalar {
    pub scalar: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Stats {
    pub vaults_opened: u64,
    /// Bitcoin currently held under this contract's rules.
    pub sats_locked: u64,
    pub sats_deposited_ever: u64,
    pub loans_opened: u64,
    pub loans_repaid: u64,
    pub auctions_won: u64,
    pub lender_claims: u64,
    pub principal_lent: U128,
    pub usdc_to_flywheel: U128,
    pub near_sent_to_endowment: U128,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            vaults_opened: 0,
            sats_locked: 0,
            sats_deposited_ever: 0,
            loans_opened: 0,
            loans_repaid: 0,
            auctions_won: 0,
            lender_claims: 0,
            principal_lent: U128(0),
            usdc_to_flywheel: U128(0),
            near_sent_to_endowment: U128(0),
        }
    }
}

#[near(serializers = [json])]
pub struct OfferView {
    pub id: U64,
    pub lender: AccountId,
    pub available: U128,
    pub micro_usdc_per_btc: U128,
    pub apr_bps: u32,
    pub term_blocks: u32,
    pub btc_script: String,
}

impl From<&Offer> for OfferView {
    fn from(o: &Offer) -> Self {
        Self {
            id: U64(o.id),
            lender: o.lender.clone(),
            available: U128(o.available),
            micro_usdc_per_btc: U128(o.micro_usdc_per_btc),
            apr_bps: o.apr_bps,
            term_blocks: o.term_blocks,
            btc_script: hex(&o.btc_script),
        }
    }
}

#[near(serializers = [json])]
pub struct LoanView {
    pub offer_id: U64,
    pub lender: AccountId,
    pub principal: U128,
    pub interest: U128,
    pub debt: U128,
    pub due_height: u32,
    /// Blocks after this the auction may start.
    pub grace_end_height: u32,
    /// Where the auction opens if this loan defaults.
    pub auction_start: U128,
}

#[near(serializers = [json])]
pub struct DepositView {
    pub txid: String,
    pub vout: u32,
    pub sats: U64,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub id: U64,
    pub owner: AccountId,
    pub status: String,
    pub address: Option<String>,
    pub escape_height: u32,
    pub expected_sats: U64,
    pub owner_pubkey: String,
    pub signer_pubkey: Option<String>,
    pub witness_script: String,
    pub script_pubkey: String,
    pub deposit: Option<DepositView>,
    pub loan: Option<LoanView>,
    pub auction_started_at_ms: Option<U64>,
    pub destination: Option<String>,
    pub beneficiary: Option<AccountId>,
    pub settle_reason: Option<SettleReason>,
    pub signed_tx: Option<String>,
    pub signed_txid: Option<String>,
}

impl VaultView {
    pub fn from(v: &Vault, address: Option<String>, params: Params) -> Self {
        let (status, started, destination, beneficiary, settle_reason) = match &v.status {
            Status::Deriving { .. } => ("deriving", None, None, None, None),
            Status::AwaitingDeposit => ("awaiting_deposit", None, None, None, None),
            Status::Funded => ("funded", None, None, None, None),
            Status::Borrowed => ("borrowed", None, None, None, None),
            Status::Auction { started_at_ms } => {
                ("auction", Some(U64(*started_at_ms)), None, None, None)
            }
            Status::Settling {
                destination,
                beneficiary,
                reason,
            } => (
                "settling",
                None,
                Some(hex(destination)),
                Some(beneficiary.clone()),
                Some(reason.clone()),
            ),
        };
        Self {
            id: U64(v.id),
            owner: v.owner.clone(),
            status: status.to_string(),
            address,
            escape_height: v.escape_height,
            expected_sats: U64(v.expected_sats),
            owner_pubkey: hex(&v.owner_pubkey),
            signer_pubkey: v.signer_pubkey.as_ref().map(|k| hex(k)),
            witness_script: hex(&v.witness_script),
            script_pubkey: hex(&v.script_pubkey),
            deposit: v.deposit.as_ref().map(|d| DepositView {
                txid: reverse_hex(&d.txid),
                vout: d.vout,
                sats: U64(d.sats),
            }),
            loan: v.loan.as_ref().map(|l| LoanView {
                offer_id: U64(l.offer_id),
                lender: l.lender.clone(),
                principal: U128(l.principal),
                interest: U128(l.interest),
                debt: U128(l.terms().debt()),
                due_height: l.due_height,
                grace_end_height: l.due_height.saturating_add(params.grace_blocks),
                auction_start: U128(l.auction_start),
            }),
            auction_started_at_ms: started,
            destination,
            beneficiary,
            settle_reason,
            signed_tx: v.signed_tx.as_ref().map(|t| hex(t)),
            signed_txid: v.signed_txid.as_ref().map(|t| reverse_hex(t)),
        }
    }
}
