//! Hold native Bitcoin under script rules from a NEAR smart contract.
//!
//! A NEAR contract can already sign Bitcoin transactions through Chain Signatures and
//! check Bitcoin history through the on-chain light client. What was missing is the
//! piece in between: building Bitcoin script, hashing what must be signed, reading
//! deposit transactions strictly, and assembling the final signed transaction, all
//! inside a contract. This crate is that piece.
//!
//! It has no dependencies and no NEAR dependency, so any contract or tool can use it.
//! Hashing is injected through [`Sha256`], which lets a contract use the host function.
//!
//! The main type is [`VaultSpec`], a two-path script:
//!
//! ```text
//! OP_IF
//!     <signer key> OP_CHECKSIG                             the contract, through MPC
//! OP_ELSE
//!     <escape height> OP_CHECKLOCKTIMEVERIFY OP_DROP
//!     <owner key> OP_CHECKSIG                              the owner, alone, after that block
//! OP_ENDIF
//! ```
//!
//! Bitcoin itself enforces the second path. No contract, signer or relayer can block it.

pub mod bech32;
pub mod error;
pub mod hash;
pub mod script;
pub mod signature;
pub mod tx;

pub use error::Error;
pub use hash::Sha256;
pub use script::{classify_script_pubkey, p2wsh_script_pubkey, ScriptKind, VaultSpec};
pub use signature::{der_signature, low_s, SIGHASH_ALL};
pub use tx::{
    build_spend, owner_path_witness, parse_tx, signer_path_witness, OutPoint, Tx, TxIn, TxOut,
    DUST_SATS, MAX_TX_BYTES, SEQUENCE_RBF,
};
