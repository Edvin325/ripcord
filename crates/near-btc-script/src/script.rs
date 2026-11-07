use crate::{Error, Sha256};

const OP_0: u8 = 0x00;
const OP_1: u8 = 0x51;
const OP_DUP: u8 = 0x76;
const OP_HASH160: u8 = 0xa9;
const OP_EQUAL: u8 = 0x87;
const OP_EQUALVERIFY: u8 = 0x88;
const OP_IF: u8 = 0x63;
const OP_ELSE: u8 = 0x67;
const OP_ENDIF: u8 = 0x68;
const OP_DROP: u8 = 0x75;
const OP_CHECKSIG: u8 = 0xac;
const OP_CHECKLOCKTIMEVERIFY: u8 = 0xb1;

/// `nLockTime` below this is a block height; at or above it, a Unix time.
const LOCKTIME_THRESHOLD: u32 = 500_000_000;

/// Heights 0 to 16 need the small-integer opcodes to be a minimal push. Real Bitcoin
/// heights are never that low, so they are refused instead of adding a code path.
const MIN_ESCAPE_HEIGHT: u32 = 17;

/// The two-path vault. See the crate docs for the script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultSpec {
    /// Compressed key that spends at any time: the contract's Chain Signatures key.
    pub signer_pubkey: [u8; 33],
    /// Compressed key that spends alone once the chain has passed `escape_height`.
    pub owner_pubkey: [u8; 33],
    /// Bitcoin block height at which the owner's path opens.
    pub escape_height: u32,
}

impl VaultSpec {
    pub fn new(
        signer_pubkey: [u8; 33],
        owner_pubkey: [u8; 33],
        escape_height: u32,
    ) -> Result<Self, Error> {
        check_pubkey(&signer_pubkey)?;
        check_pubkey(&owner_pubkey)?;
        if !(MIN_ESCAPE_HEIGHT..LOCKTIME_THRESHOLD).contains(&escape_height) {
            return Err(Error::BadEscapeHeight);
        }
        Ok(Self {
            signer_pubkey,
            owner_pubkey,
            escape_height,
        })
    }

    /// The exact bytes committed to by the address.
    pub fn witness_script(&self) -> Vec<u8> {
        let height = script_num(self.escape_height);
        let mut s = Vec::with_capacity(84);
        s.push(OP_IF);
        push_data(&mut s, &self.signer_pubkey);
        s.push(OP_CHECKSIG);
        s.push(OP_ELSE);
        push_data(&mut s, &height);
        s.push(OP_CHECKLOCKTIMEVERIFY);
        s.push(OP_DROP);
        push_data(&mut s, &self.owner_pubkey);
        s.push(OP_CHECKSIG);
        s.push(OP_ENDIF);
        s
    }

    /// The output script a deposit must pay.
    pub fn script_pubkey<H: Sha256>(&self) -> Vec<u8> {
        p2wsh_script_pubkey::<H>(&self.witness_script())
    }

    /// Reads a script back, accepting only the exact template. This lets anyone holding
    /// a script confirm what it enforces without trusting whoever handed it to them.
    pub fn parse(script: &[u8]) -> Result<Self, Error> {
        let mut r = Cursor { b: script, i: 0 };
        r.expect(OP_IF)?;
        let signer = r.push_33()?;
        r.expect(OP_CHECKSIG)?;
        r.expect(OP_ELSE)?;
        let height = r.push_num()?;
        r.expect(OP_CHECKLOCKTIMEVERIFY)?;
        r.expect(OP_DROP)?;
        let owner = r.push_33()?;
        r.expect(OP_CHECKSIG)?;
        r.expect(OP_ENDIF)?;
        if r.i != script.len() {
            return Err(Error::NotVaultScript);
        }
        let spec = Self::new(signer, owner, height).map_err(|_| Error::NotVaultScript)?;
        if spec.witness_script() != script {
            return Err(Error::NotVaultScript);
        }
        Ok(spec)
    }
}

/// `OP_0 <32-byte SHA-256 of the script>`.
pub fn p2wsh_script_pubkey<H: Sha256>(witness_script: &[u8]) -> Vec<u8> {
    let mut s = Vec::with_capacity(34);
    s.push(OP_0);
    s.push(32);
    s.extend_from_slice(&H::sha256(witness_script));
    s
}

/// Standard output types a contract may safely pay to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptKind {
    P2pkh,
    P2sh,
    P2wpkh,
    P2wsh,
    P2tr,
}

/// Recognises standard outputs. A contract should refuse anything else, so that coins
/// can never be sent somewhere that nodes will not relay or nobody can spend.
pub fn classify_script_pubkey(spk: &[u8]) -> Option<ScriptKind> {
    match spk {
        [OP_DUP, OP_HASH160, 20, hash @ .., OP_EQUALVERIFY, OP_CHECKSIG] if hash.len() == 20 => {
            Some(ScriptKind::P2pkh)
        }
        [OP_HASH160, 20, hash @ .., OP_EQUAL] if hash.len() == 20 => Some(ScriptKind::P2sh),
        [OP_0, 20, hash @ ..] if hash.len() == 20 => Some(ScriptKind::P2wpkh),
        [OP_0, 32, hash @ ..] if hash.len() == 32 => Some(ScriptKind::P2wsh),
        [OP_1, 32, key @ ..] if key.len() == 32 => Some(ScriptKind::P2tr),
        _ => None,
    }
}

fn check_pubkey(key: &[u8; 33]) -> Result<(), Error> {
    if key[0] == 0x02 || key[0] == 0x03 {
        Ok(())
    } else {
        Err(Error::BadPublicKey)
    }
}

/// Direct push. Everything pushed here is under 76 bytes.
fn push_data(s: &mut Vec<u8>, data: &[u8]) {
    debug_assert!(data.len() < 76);
    s.push(data.len() as u8);
    s.extend_from_slice(data);
}

/// Bitcoin's script number: little-endian, minimal, with a sign bit on the top byte. If
/// the top byte would look negative, a zero byte is added.
fn script_num(mut n: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(5);
    while n > 0 {
        out.push((n & 0xff) as u8);
        n >>= 8;
    }
    if out.last().is_some_and(|b| b & 0x80 != 0) {
        out.push(0);
    }
    out
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn byte(&mut self) -> Result<u8, Error> {
        let v = *self.b.get(self.i).ok_or(Error::NotVaultScript)?;
        self.i += 1;
        Ok(v)
    }

    fn expect(&mut self, v: u8) -> Result<(), Error> {
        if self.byte()? == v {
            Ok(())
        } else {
            Err(Error::NotVaultScript)
        }
    }

    fn push_33(&mut self) -> Result<[u8; 33], Error> {
        self.expect(33)?;
        let end = self.i + 33;
        let key = self.b.get(self.i..end).ok_or(Error::NotVaultScript)?;
        let out = key.try_into().map_err(|_| Error::NotVaultScript)?;
        self.i = end;
        Ok(out)
    }

    fn push_num(&mut self) -> Result<u32, Error> {
        let len = self.byte()? as usize;
        if !(1..=5).contains(&len) {
            return Err(Error::NotVaultScript);
        }
        let end = self.i + len;
        let bytes = self.b.get(self.i..end).ok_or(Error::NotVaultScript)?;
        self.i = end;
        let mut n: u64 = 0;
        for (idx, byte) in bytes.iter().enumerate() {
            n |= (*byte as u64) << (8 * idx);
        }
        u32::try_from(n).map_err(|_| Error::NotVaultScript)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Soft;
    impl Sha256 for Soft {
        fn sha256(data: &[u8]) -> [u8; 32] {
            use sha2::Digest;
            sha2::Sha256::digest(data).into()
        }
    }

    fn signer() -> [u8; 33] {
        let mut k = [0x11; 33];
        k[0] = 0x02;
        k
    }

    fn owner() -> [u8; 33] {
        let mut k = [0x22; 33];
        k[0] = 0x03;
        k
    }

    #[test]
    fn script_num_matches_bitcoin_encoding() {
        assert_eq!(script_num(17), vec![0x11]);
        assert_eq!(script_num(127), vec![0x7f]);
        // 128 would read as negative zero without the padding byte.
        assert_eq!(script_num(128), vec![0x80, 0x00]);
        assert_eq!(script_num(255), vec![0xff, 0x00]);
        assert_eq!(script_num(256), vec![0x00, 0x01]);
        // Real heights from the live chains.
        assert_eq!(script_num(974_932), vec![0x54, 0xe0, 0x0e]);
        assert_eq!(script_num(5_302_843), vec![0x3b, 0xea, 0x50]);
        assert_eq!(script_num(499_999_999), vec![0xff, 0x64, 0xcd, 0x1d]);
    }

    #[test]
    fn witness_script_has_the_exact_expected_bytes() {
        let spec = VaultSpec::new(signer(), owner(), 974_932).unwrap();
        let mut want = vec![0x63, 33];
        want.extend_from_slice(&signer());
        want.extend_from_slice(&[0xac, 0x67, 3, 0x54, 0xe0, 0x0e, 0xb1, 0x75, 33]);
        want.extend_from_slice(&owner());
        want.extend_from_slice(&[0xac, 0x68]);
        assert_eq!(spec.witness_script(), want);
        // IF, 34-byte key push, CHECKSIG, ELSE, 4-byte height push, CLTV, DROP,
        // 34-byte key push, CHECKSIG, ENDIF.
        assert_eq!(spec.witness_script().len(), 79);
    }

    #[test]
    fn script_pubkey_is_op0_and_32_bytes() {
        let spec = VaultSpec::new(signer(), owner(), 974_932).unwrap();
        let spk = spec.script_pubkey::<Soft>();
        assert_eq!(&spk[..2], &[0x00, 32]);
        assert_eq!(spk.len(), 34);
        assert_eq!(classify_script_pubkey(&spk), Some(ScriptKind::P2wsh));
    }

    #[test]
    fn different_escape_height_gives_a_different_address() {
        let a = VaultSpec::new(signer(), owner(), 974_932).unwrap();
        let b = VaultSpec::new(signer(), owner(), 974_933).unwrap();
        assert_ne!(a.script_pubkey::<Soft>(), b.script_pubkey::<Soft>());
    }

    #[test]
    fn refuses_bad_keys_and_heights() {
        let mut bad = signer();
        bad[0] = 0x04;
        assert_eq!(
            VaultSpec::new(bad, owner(), 100),
            Err(Error::BadPublicKey)
        );
        assert_eq!(
            VaultSpec::new(signer(), bad, 100),
            Err(Error::BadPublicKey)
        );
        assert_eq!(
            VaultSpec::new(signer(), owner(), 16),
            Err(Error::BadEscapeHeight)
        );
        // A value this large means a Unix time to Bitcoin. Accepting it would turn
        // "after block N" into a date without anyone noticing.
        assert_eq!(
            VaultSpec::new(signer(), owner(), 500_000_000),
            Err(Error::BadEscapeHeight)
        );
    }

    #[test]
    fn parse_round_trips_and_refuses_anything_else() {
        let spec = VaultSpec::new(signer(), owner(), 5_302_843).unwrap();
        let script = spec.witness_script();
        assert_eq!(VaultSpec::parse(&script).unwrap(), spec);

        let mut extra = script.clone();
        extra.push(0x51);
        assert_eq!(VaultSpec::parse(&extra), Err(Error::NotVaultScript));

        let mut swapped = script.clone();
        *swapped.last_mut().unwrap() = OP_ELSE;
        assert_eq!(VaultSpec::parse(&swapped), Err(Error::NotVaultScript));

        assert_eq!(
            VaultSpec::parse(&script[..script.len() - 1]),
            Err(Error::NotVaultScript)
        );
        assert_eq!(VaultSpec::parse(&[]), Err(Error::NotVaultScript));
    }

    #[test]
    fn parse_refuses_a_non_minimal_height() {
        // Same height, one wasteful extra byte. It must not read as the template.
        let spec = VaultSpec::new(signer(), owner(), 974_932).unwrap();
        let canonical = spec.witness_script();
        let at = 37; // IF(1) + key push(34) + CHECKSIG(1) + ELSE(1)
        assert_eq!(canonical[at], 3);
        let mut padded = canonical[..at].to_vec();
        padded.extend_from_slice(&[4, 0x54, 0xe0, 0x0e, 0x00]);
        padded.extend_from_slice(&canonical[at + 4..]);
        assert_eq!(VaultSpec::parse(&padded), Err(Error::NotVaultScript));
    }

    #[test]
    fn classifies_every_standard_output_and_nothing_else() {
        let pkh: Vec<u8> = [&[0x76, 0xa9, 20][..], &[1; 20], &[0x88, 0xac]].concat();
        let sh: Vec<u8> = [&[0xa9, 20][..], &[1; 20], &[0x87]].concat();
        let wpkh: Vec<u8> = [&[0x00, 20][..], &[1; 20]].concat();
        let wsh: Vec<u8> = [&[0x00, 32][..], &[1; 32]].concat();
        let tr: Vec<u8> = [&[0x51, 32][..], &[1; 32]].concat();
        assert_eq!(classify_script_pubkey(&pkh), Some(ScriptKind::P2pkh));
        assert_eq!(classify_script_pubkey(&sh), Some(ScriptKind::P2sh));
        assert_eq!(classify_script_pubkey(&wpkh), Some(ScriptKind::P2wpkh));
        assert_eq!(classify_script_pubkey(&wsh), Some(ScriptKind::P2wsh));
        assert_eq!(classify_script_pubkey(&tr), Some(ScriptKind::P2tr));

        assert_eq!(classify_script_pubkey(&[]), None);
        assert_eq!(classify_script_pubkey(&[0x6a, 1, 0x00]), None); // OP_RETURN burns coins
        assert_eq!(classify_script_pubkey(&[0x00, 19, 1]), None);
        let short: Vec<u8> = [&[0x00, 20][..], &[1; 19]].concat();
        assert_eq!(classify_script_pubkey(&short), None);
    }
}
