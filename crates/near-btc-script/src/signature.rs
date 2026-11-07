/// Signs all inputs and outputs. The only sighash type this crate produces.
pub const SIGHASH_ALL: u8 = 0x01;

/// Order of secp256k1.
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// `N / 2`, rounded down.
const HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Bitcoin nodes refuse to relay a signature whose `s` is in the upper half of the curve
/// order. `s` and `N - s` are both valid signatures, so this picks the lower one.
pub fn low_s(s: [u8; 32]) -> [u8; 32] {
    if s <= HALF_N {
        return s;
    }
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let diff = N[i] as i16 - s[i] as i16 - borrow;
        if diff < 0 {
            out[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            out[i] = diff as u8;
            borrow = 0;
        }
    }
    out
}

/// DER-encodes `(r, s)` with `s` lowered, then appends [`SIGHASH_ALL`]. The result is the
/// exact stack item Bitcoin expects.
pub fn der_signature(r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
    let r = der_int(r);
    let s = der_int(&low_s(*s));
    let mut out = Vec::with_capacity(r.len() + s.len() + 7);
    out.push(0x30);
    out.push((r.len() + s.len() + 4) as u8);
    out.push(0x02);
    out.push(r.len() as u8);
    out.extend_from_slice(&r);
    out.push(0x02);
    out.push(s.len() as u8);
    out.extend_from_slice(&s);
    out.push(SIGHASH_ALL);
    out
}

/// A DER integer: no leading zeros, except one zero if the top bit would look negative.
fn der_int(v: &[u8; 32]) -> Vec<u8> {
    let start = v.iter().position(|b| *b != 0).unwrap_or(31);
    let bytes = &v[start..];
    let mut out = Vec::with_capacity(33);
    if bytes[0] & 0x80 != 0 {
        out.push(0);
    }
    out.extend_from_slice(bytes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn half_n_really_is_half() {
        // 2 * HALF_N + 1 == N
        let mut out = [0u8; 32];
        let mut carry = 1u16;
        for i in (0..32).rev() {
            let v = HALF_N[i] as u16 * 2 + carry;
            out[i] = v as u8;
            carry = v >> 8;
        }
        assert_eq!(out, N);
    }

    #[test]
    fn low_s_leaves_low_values_alone() {
        assert_eq!(low_s([1; 32]), [1; 32]);
        assert_eq!(low_s(HALF_N), HALF_N);
    }

    #[test]
    fn low_s_flips_high_values() {
        // HALF_N + 1 is the first high value, and N - (HALF_N + 1) == HALF_N.
        let mut high = HALF_N;
        high[31] += 1;
        assert_eq!(low_s(high), HALF_N);

        // N - 1 maps to 1.
        let mut top = N;
        top[31] -= 1;
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(low_s(top), one);
    }

    #[test]
    fn der_matches_a_published_bip143_signature() {
        // From the Native P2WSH example in BIP-143, re-encoded here and compared whole.
        let r = hex32("27dc95ad6b740fe5129e7e62a75dd00f291a2aeb1200b84b09d9e3789406b6c0");
        let s = hex32("1a9ecd315dd6a0e632ab20bbb98948bc0c6fb204f2c286963bb48517a7058e27");
        let der = der_signature(&r, &s);
        let want = "3044022027dc95ad6b740fe5129e7e62a75dd00f291a2aeb1200b84b09d9e3789406b6c0\
                    02201a9ecd315dd6a0e632ab20bbb98948bc0c6fb204f2c286963bb48517a7058e27";
        let got: String = der[..der.len() - 1]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(got, want);
        assert_eq!(*der.last().unwrap(), SIGHASH_ALL);
    }

    #[test]
    fn der_pads_a_high_r_and_strips_leading_zeros() {
        let high_r = [0x80; 32];
        let mut small_s = [0u8; 32];
        small_s[31] = 5;
        let der = der_signature(&high_r, &small_s);
        // 30 len 02 33 00 80.. 02 01 05 01
        assert_eq!(der[0], 0x30);
        assert_eq!(der[1] as usize, der.len() - 3);
        assert_eq!(&der[2..5], &[0x02, 33, 0x00]);
        assert_eq!(&der[der.len() - 4..], &[0x02, 1, 5, SIGHASH_ALL]);
    }

    #[test]
    fn der_always_emits_a_lowered_s() {
        let r = [0x11; 32];
        let high = [0xee; 32];
        let der = der_signature(&r, &high);
        let s_at = 4 + 32 + 2;
        assert!(der[s_at] < 0x80, "s must be in the lower half");
    }
}
