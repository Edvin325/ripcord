//! BIP-173 and BIP-350 addresses, for segwit outputs. Small on purpose: it needs to show
//! a vault's address and read a destination back, nothing more.

use crate::Error;

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST: u32 = 1;
const BECH32M_CONST: u32 = 0x2bc8_30a3;

fn polymod(values: impl Iterator<Item = u8>) -> u32 {
    const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ v as u32;
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = hrp.iter().map(|c| c >> 5).collect();
    out.push(0);
    out.extend(hrp.iter().map(|c| c & 31));
    out
}

fn checksum_const(version: u8) -> u32 {
    if version == 0 {
        BECH32_CONST
    } else {
        BECH32M_CONST
    }
}

fn regroup(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let max = (1u32 << to) - 1;
    let mut out = Vec::with_capacity(data.len() * from as usize / to as usize + 1);
    for v in data {
        if (*v as u32) >> from != 0 {
            return None;
        }
        acc = (acc << from) | *v as u32;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & max) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & max) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & max) != 0 {
        return None;
    }
    Some(out)
}

/// Encodes a segwit address. `hrp` is `bc`, `tb` or `bcrt`.
pub fn encode_segwit(hrp: &str, version: u8, program: &[u8]) -> Result<String, Error> {
    if version > 16 || !(2..=40).contains(&program.len()) {
        return Err(Error::BadAddress);
    }
    let mut data = vec![version];
    data.extend(regroup(program, 8, 5, true).ok_or(Error::BadAddress)?);

    let hrp_bytes = hrp.as_bytes();
    let mut values = hrp_expand(hrp_bytes);
    values.extend_from_slice(&data);
    values.extend_from_slice(&[0; 6]);
    let chk = polymod(values.into_iter()) ^ checksum_const(version);

    let mut out = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    out.push_str(hrp);
    out.push('1');
    for d in &data {
        out.push(CHARSET[*d as usize] as char);
    }
    for i in 0..6 {
        out.push(CHARSET[((chk >> (5 * (5 - i))) & 31) as usize] as char);
    }
    Ok(out)
}

/// Decodes a segwit address on network `hrp`, returning `(version, program)`.
pub fn decode_segwit(hrp: &str, addr: &str) -> Result<(u8, Vec<u8>), Error> {
    let bytes = addr.as_bytes();
    if bytes.iter().any(u8::is_ascii_uppercase) && bytes.iter().any(u8::is_ascii_lowercase) {
        return Err(Error::BadAddress);
    }
    let lower = addr.to_ascii_lowercase();
    let sep = lower.rfind('1').ok_or(Error::BadAddress)?;
    if &lower[..sep] != hrp || lower.len() < sep + 8 || lower.len() > 90 {
        return Err(Error::BadAddress);
    }
    let mut data = Vec::with_capacity(lower.len() - sep - 1);
    for c in lower[sep + 1..].bytes() {
        let v = CHARSET
            .iter()
            .position(|x| *x == c)
            .ok_or(Error::BadAddress)?;
        data.push(v as u8);
    }
    let (payload, _) = data.split_at(data.len() - 6);
    let version = *payload.first().ok_or(Error::BadAddress)?;

    let mut values = hrp_expand(hrp.as_bytes());
    values.extend_from_slice(&data);
    if polymod(values.into_iter()) != checksum_const(version) {
        return Err(Error::BadAddress);
    }

    let program = regroup(&payload[1..], 5, 8, false).ok_or(Error::BadAddress)?;
    let valid_len = match version {
        0 => program.len() == 20 || program.len() == 32,
        1..=16 => (2..=40).contains(&program.len()),
        _ => false,
    };
    if valid_len {
        Ok((version, program))
    } else {
        Err(Error::BadAddress)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    // Valid addresses from the BIP-173 and BIP-350 test vectors.
    #[test]
    fn encodes_the_published_vectors() {
        assert_eq!(
            encode_segwit("bc", 0, &hex("751e76e8199196d454941c45d1b3a323f1433bd6")).unwrap(),
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        );
        assert_eq!(
            encode_segwit(
                "tb",
                0,
                &hex("1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262")
            )
            .unwrap(),
            "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7"
        );
        assert_eq!(
            encode_segwit(
                "bc",
                1,
                &hex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
            )
            .unwrap(),
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
        );
    }

    #[test]
    fn round_trips_a_p2wsh_address() {
        let program = [0xab; 32];
        let addr = encode_segwit("tb", 0, &program).unwrap();
        assert_eq!(decode_segwit("tb", &addr).unwrap(), (0, program.to_vec()));
    }

    #[test]
    fn decodes_uppercase_but_never_mixed_case() {
        let addr = "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4";
        assert_eq!(
            decode_segwit("bc", addr).unwrap().1,
            hex("751e76e8199196d454941c45d1b3a323f1433bd6")
        );
        let mixed = "bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4";
        assert_eq!(decode_segwit("bc", mixed), Err(Error::BadAddress));
    }

    #[test]
    fn refuses_a_typo() {
        let good = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
        let typo = good.replace("w508", "w509");
        assert_eq!(decode_segwit("bc", &typo), Err(Error::BadAddress));
    }

    #[test]
    fn refuses_the_wrong_network() {
        let main = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
        assert_eq!(decode_segwit("tb", main), Err(Error::BadAddress));
    }

    #[test]
    fn refuses_a_v1_address_with_the_old_checksum() {
        // Taproot needs bech32m. The BIP-350 list marks this one invalid.
        let bad = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd";
        assert_eq!(decode_segwit("bc", bad), Err(Error::BadAddress));
    }
}
