/// SHA-256 provider.
///
/// A NEAR contract should implement this with `near_sdk::env::sha256_array`, which is far
/// cheaper in gas than hashing in wasm. Tests and tools can use any software hash.
pub trait Sha256 {
    fn sha256(data: &[u8]) -> [u8; 32];

    /// Bitcoin's double SHA-256.
    fn sha256d(data: &[u8]) -> [u8; 32] {
        Self::sha256(&Self::sha256(data))
    }
}
