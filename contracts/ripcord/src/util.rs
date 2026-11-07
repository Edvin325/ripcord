use near_sdk::{env, CurveType, PublicKey};

use crate::types::MpcSignature;

const HEX: &[u8; 16] = b"0123456789abcdef";

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char);
    }
    out
}

/// A hash the way explorers print it.
pub fn reverse_hex(bytes: &[u8]) -> String {
    let mut reversed = bytes.to_vec();
    reversed.reverse();
    hex(&reversed)
}

/// Takes internal-order hex and returns explorer-order hex.
pub fn display_txid(internal: &str) -> String {
    reverse_hex(&hex_bytes(internal, "txid"))
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

pub fn hex_bytes(text: &str, what: &str) -> Vec<u8> {
    let raw = text.as_bytes();
    if raw.len() % 2 != 0 {
        env::panic_str(&format!("{what} is not valid hex"));
    }
    raw.chunks(2)
        .map(|pair| match (nibble(pair[0]), nibble(pair[1])) {
            (Some(hi), Some(lo)) => hi << 4 | lo,
            _ => env::panic_str(&format!("{what} is not valid hex")),
        })
        .collect()
}

pub fn hex_array<const N: usize>(text: &str, what: &str) -> [u8; N] {
    hex_bytes(text, what)
        .try_into()
        .unwrap_or_else(|_| env::panic_str(&format!("{what} has the wrong length")))
}

/// Reads a hash printed by an explorer into internal byte order.
pub fn display_hash(text: &str) -> [u8; 32] {
    let mut h: [u8; 32] = hex_array(text, "hash");
    h.reverse();
    h
}

/// The MPC contract returns keys as uncompressed `x || y`. Bitcoin script needs the
/// compressed form: a parity prefix and `x`.
pub fn compress_secp256k1(key: &PublicKey) -> [u8; 33] {
    if key.curve_type() != CurveType::SECP256K1 {
        env::panic_str("the signer returned a key on the wrong curve");
    }
    // `as_bytes` is the curve tag followed by x and y.
    let raw = key.as_bytes();
    if raw.len() != 65 {
        env::panic_str("the signer returned a malformed key");
    }
    let mut out = [0u8; 33];
    out[0] = if raw[64] & 1 == 0 { 2 } else { 3 };
    out[1..].copy_from_slice(&raw[1..33]);
    out
}

impl MpcSignature {
    /// `(r, s)` as raw big-endian scalars. `big_r` is a compressed point, so `r` is its
    /// `x` coordinate without the prefix byte.
    pub fn parts(&self) -> ([u8; 32], [u8; 32]) {
        let point = hex_bytes(&self.big_r.affine_point, "big_r");
        if point.len() != 33 {
            env::panic_str("big_r has the wrong length");
        }
        let mut r = [0u8; 32];
        r.copy_from_slice(&point[1..]);
        (r, hex_array(&self.s.scalar, "s"))
    }
}
