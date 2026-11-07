/// Everything that can go wrong. Every variant is a refusal, never a partial result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// A public key is not 33 bytes with an 02 or 03 prefix.
    BadPublicKey,
    /// Escape height is too small for a minimal push, or is a Unix time, not a height.
    BadEscapeHeight,
    /// A script is not the exact vault template.
    NotVaultScript,
    /// Transaction bytes end early.
    TruncatedTx,
    /// Transaction bytes continue after the end of the transaction.
    TrailingBytes,
    /// Transaction is larger than [`crate::MAX_TX_BYTES`].
    TxTooLarge,
    /// A length uses more bytes than needed, so two encodings could mean one value.
    NonCanonicalVarInt,
    /// The transaction has no inputs or no outputs.
    EmptyTx,
    /// Without witness data the transaction is 64 bytes, which can impersonate an inner
    /// node of a Merkle tree. See <https://www.bitmex.com/blog/64-Byte-Transactions>.
    Forgeable64ByteTx,
    /// An input index does not exist.
    BadInputIndex,
    /// Output would be below the dust limit, so nodes would refuse to relay it.
    DustOutput,
    /// The fee is zero or larger than the coins being spent.
    BadFee,
    /// A destination is not a standard output script.
    UnsupportedDestination,
    /// An address failed bech32 decoding or has the wrong network or length.
    BadAddress,
    /// A witness list does not match the transaction's inputs.
    WitnessMismatch,
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for Error {}
