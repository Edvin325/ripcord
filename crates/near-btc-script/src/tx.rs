use crate::script::classify_script_pubkey;
use crate::signature::SIGHASH_ALL;
use crate::{Error, Sha256};

/// Largest transaction this crate reads. A deposit needs far less, and a limit keeps the
/// gas cost of parsing bounded for a contract that takes these bytes from anyone.
pub const MAX_TX_BYTES: usize = 32 * 1024;

/// Above every standard output type's dust limit, so a spend is always relayable.
pub const DUST_SATS: u64 = 546;

/// Signals replace-by-fee, so a stuck spend can be rebroadcast with a higher fee. Being
/// below `0xffffffff` is also what makes `nLockTime` enforceable.
pub const SEQUENCE_RBF: u32 = 0xffff_fffd;

const SEGWIT_MARKER: u8 = 0x00;
const SEGWIT_FLAG: u8 = 0x01;

/// A coin. `txid` is in internal byte order, the reverse of what explorers display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutPoint {
    pub txid: [u8; 32],
    pub vout: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxIn {
    pub previous_output: OutPoint,
    pub script_sig: Vec<u8>,
    pub sequence: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxOut {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tx {
    pub version: u32,
    pub inputs: Vec<TxIn>,
    pub outputs: Vec<TxOut>,
    pub lock_time: u32,
}

impl Tx {
    /// The serialization a txid commits to: no marker, flag or witness.
    pub fn serialize_stripped(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(128);
        out.extend_from_slice(&self.version.to_le_bytes());
        self.write_body(&mut out);
        out.extend_from_slice(&self.lock_time.to_le_bytes());
        out
    }

    /// The serialization a node relays. `witnesses` holds one stack per input.
    pub fn serialize_with_witness(&self, witnesses: &[Vec<Vec<u8>>]) -> Result<Vec<u8>, Error> {
        if witnesses.len() != self.inputs.len() {
            return Err(Error::WitnessMismatch);
        }
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(&self.version.to_le_bytes());
        out.push(SEGWIT_MARKER);
        out.push(SEGWIT_FLAG);
        self.write_body(&mut out);
        for stack in witnesses {
            write_varint(&mut out, stack.len() as u64);
            for item in stack {
                write_varint(&mut out, item.len() as u64);
                out.extend_from_slice(item);
            }
        }
        out.extend_from_slice(&self.lock_time.to_le_bytes());
        Ok(out)
    }

    fn write_body(&self, out: &mut Vec<u8>) {
        write_varint(out, self.inputs.len() as u64);
        for input in &self.inputs {
            write_outpoint(out, &input.previous_output);
            write_varint(out, input.script_sig.len() as u64);
            out.extend_from_slice(&input.script_sig);
            out.extend_from_slice(&input.sequence.to_le_bytes());
        }
        write_varint(out, self.outputs.len() as u64);
        for output in &self.outputs {
            write_output(out, output);
        }
    }

    /// Transaction id, in internal byte order.
    pub fn txid<H: Sha256>(&self) -> [u8; 32] {
        H::sha256d(&self.serialize_stripped())
    }

    /// The exact bytes BIP-143 hashes for `SIGHASH_ALL`. `script_code` excludes its
    /// length prefix; for a P2WSH spend it is the whole witness script.
    pub fn sighash_preimage<H: Sha256>(
        &self,
        index: usize,
        script_code: &[u8],
        value: u64,
    ) -> Result<Vec<u8>, Error> {
        let input = self.inputs.get(index).ok_or(Error::BadInputIndex)?;

        let mut prevouts = Vec::with_capacity(36 * self.inputs.len());
        let mut sequences = Vec::with_capacity(4 * self.inputs.len());
        for i in &self.inputs {
            write_outpoint(&mut prevouts, &i.previous_output);
            sequences.extend_from_slice(&i.sequence.to_le_bytes());
        }
        let mut outputs = Vec::with_capacity(64 * self.outputs.len());
        for o in &self.outputs {
            write_output(&mut outputs, o);
        }

        let mut p = Vec::with_capacity(156 + script_code.len());
        p.extend_from_slice(&self.version.to_le_bytes());
        p.extend_from_slice(&H::sha256d(&prevouts));
        p.extend_from_slice(&H::sha256d(&sequences));
        write_outpoint(&mut p, &input.previous_output);
        write_varint(&mut p, script_code.len() as u64);
        p.extend_from_slice(script_code);
        p.extend_from_slice(&value.to_le_bytes());
        p.extend_from_slice(&input.sequence.to_le_bytes());
        p.extend_from_slice(&H::sha256d(&outputs));
        p.extend_from_slice(&self.lock_time.to_le_bytes());
        p.extend_from_slice(&(SIGHASH_ALL as u32).to_le_bytes());
        Ok(p)
    }

    /// The 32-byte digest to sign for input `index`.
    pub fn sighash_all<H: Sha256>(
        &self,
        index: usize,
        script_code: &[u8],
        value: u64,
    ) -> Result<[u8; 32], Error> {
        Ok(H::sha256d(&self.sighash_preimage::<H>(
            index,
            script_code,
            value,
        )?))
    }
}

/// One input, one output, nothing left over. Spending the whole coin means no change
/// output, so a contract never has to track or re-prove leftovers.
///
/// `lock_time` is 0 for a spend through the signer path. An owner-path spend must set it
/// to at least the vault's escape height.
pub fn build_spend(
    previous_output: OutPoint,
    input_value: u64,
    destination: &[u8],
    fee_sats: u64,
    lock_time: u32,
) -> Result<Tx, Error> {
    if classify_script_pubkey(destination).is_none() {
        return Err(Error::UnsupportedDestination);
    }
    if fee_sats == 0 {
        return Err(Error::BadFee);
    }
    let value = input_value.checked_sub(fee_sats).ok_or(Error::BadFee)?;
    if value < DUST_SATS {
        return Err(Error::DustOutput);
    }
    Ok(Tx {
        version: 2,
        inputs: vec![TxIn {
            previous_output,
            script_sig: Vec::new(),
            sequence: SEQUENCE_RBF,
        }],
        outputs: vec![TxOut {
            value,
            script_pubkey: destination.to_vec(),
        }],
        lock_time,
    })
}

/// Witness stack for the signer path: `<sig> 1 <script>`. The `1` selects `OP_IF`.
pub fn signer_path_witness(der_signature: &[u8], witness_script: &[u8]) -> Vec<Vec<u8>> {
    vec![
        der_signature.to_vec(),
        vec![0x01],
        witness_script.to_vec(),
    ]
}

/// Witness stack for the owner path: `<sig> <empty> <script>`. The empty item selects
/// `OP_ELSE`. Standardness requires exactly empty here, not a zero byte.
pub fn owner_path_witness(der_signature: &[u8], witness_script: &[u8]) -> Vec<Vec<u8>> {
    vec![der_signature.to_vec(), Vec::new(), witness_script.to_vec()]
}

/// Reads a raw transaction, with or without witness data, and refuses anything that is
/// not one canonical transaction. The caller can trust `Tx::txid` afterwards: because
/// encodings are checked to be canonical, re-serializing reproduces what was hashed.
pub fn parse_tx(raw: &[u8]) -> Result<Tx, Error> {
    if raw.len() > MAX_TX_BYTES {
        return Err(Error::TxTooLarge);
    }
    let mut r = Reader { b: raw, i: 0 };
    let version = r.u32()?;

    let segwit = r.peek(0) == Some(SEGWIT_MARKER) && r.peek(1) == Some(SEGWIT_FLAG);
    if segwit {
        r.skip(2)?;
    }

    let input_count = r.varint()?;
    if input_count == 0 {
        return Err(Error::EmptyTx);
    }
    // Each input takes at least 41 bytes, so a huge count fails here, before allocating.
    if input_count > (raw.len() / 41) as u64 {
        return Err(Error::TruncatedTx);
    }
    let mut inputs = Vec::with_capacity(input_count as usize);
    for _ in 0..input_count {
        let txid = r.bytes32()?;
        let vout = r.u32()?;
        let script_sig = r.var_bytes()?.to_vec();
        let sequence = r.u32()?;
        inputs.push(TxIn {
            previous_output: OutPoint { txid, vout },
            script_sig,
            sequence,
        });
    }

    let output_count = r.varint()?;
    if output_count == 0 {
        return Err(Error::EmptyTx);
    }
    if output_count > (raw.len() / 9) as u64 {
        return Err(Error::TruncatedTx);
    }
    let mut outputs = Vec::with_capacity(output_count as usize);
    for _ in 0..output_count {
        let value = r.u64()?;
        let script_pubkey = r.var_bytes()?.to_vec();
        outputs.push(TxOut {
            value,
            script_pubkey,
        });
    }

    if segwit {
        for _ in 0..inputs.len() {
            let items = r.varint()?;
            for _ in 0..items {
                r.var_bytes()?;
            }
        }
    }

    let lock_time = r.u32()?;
    if r.i != raw.len() {
        return Err(Error::TrailingBytes);
    }

    let tx = Tx {
        version,
        inputs,
        outputs,
        lock_time,
    };
    if tx.serialize_stripped().len() == 64 {
        return Err(Error::Forgeable64ByteTx);
    }
    Ok(tx)
}

fn write_outpoint(out: &mut Vec<u8>, p: &OutPoint) {
    out.extend_from_slice(&p.txid);
    out.extend_from_slice(&p.vout.to_le_bytes());
}

fn write_output(out: &mut Vec<u8>, o: &TxOut) {
    out.extend_from_slice(&o.value.to_le_bytes());
    write_varint(out, o.script_pubkey.len() as u64);
    out.extend_from_slice(&o.script_pubkey);
}

fn write_varint(out: &mut Vec<u8>, v: u64) {
    match v {
        0..=0xfc => out.push(v as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(v as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xfe);
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
        _ => {
            out.push(0xff);
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn peek(&self, ahead: usize) -> Option<u8> {
        self.b.get(self.i + ahead).copied()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.i.checked_add(n).ok_or(Error::TruncatedTx)?;
        let out = self.b.get(self.i..end).ok_or(Error::TruncatedTx)?;
        self.i = end;
        Ok(out)
    }

    fn skip(&mut self, n: usize) -> Result<(), Error> {
        self.take(n).map(|_| ())
    }

    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn bytes32(&mut self) -> Result<[u8; 32], Error> {
        Ok(self.take(32)?.try_into().unwrap())
    }

    /// Refuses non-minimal encodings: if the same number could be written shorter, then
    /// two byte strings would describe one transaction and the txid check would not bind.
    fn varint(&mut self) -> Result<u64, Error> {
        let first = self.u8()?;
        let value = match first {
            0xfd => {
                let v = self.u16()? as u64;
                if v < 0xfd {
                    return Err(Error::NonCanonicalVarInt);
                }
                v
            }
            0xfe => {
                let v = self.u32()? as u64;
                if v <= 0xffff {
                    return Err(Error::NonCanonicalVarInt);
                }
                v
            }
            0xff => {
                let v = self.u64()?;
                if v <= 0xffff_ffff {
                    return Err(Error::NonCanonicalVarInt);
                }
                v
            }
            v => v as u64,
        };
        Ok(value)
    }

    fn var_bytes(&mut self) -> Result<&'a [u8], Error> {
        let len = self.varint()?;
        let len = usize::try_from(len).map_err(|_| Error::TruncatedTx)?;
        self.take(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{der_signature, ScriptKind, VaultSpec};

    struct Soft;
    impl Sha256 for Soft {
        fn sha256(data: &[u8]) -> [u8; 32] {
            use sha2::Digest;
            sha2::Sha256::digest(data).into()
        }
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    fn to_hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// How explorers print a hash.
    fn display(hash: [u8; 32]) -> String {
        let mut h = hash;
        h.reverse();
        to_hex(&h)
    }

    // BIP-143 "Native P2WPKH".
    const BIP143_P2WPKH_TX: &str = "0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000";

    // BIP-143 "P2SH-P2WSH" 6-of-6. The witness-script hashing path Ripcord relies on.
    const BIP143_P2WSH_TX: &str = "010000000136641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e0100000000ffffffff0200e9a435000000001976a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688acc0832f05000000001976a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac00000000";
    const BIP143_P2WSH_SCRIPT: &str = "56210307b8ae49ac90a048e9b53357a2354b3334e9c8bee813ecb98e99a7e07e8c3ba32103b28f0c28bfab54554ae8c658ac5c3e0ce6e79ad336331f78c428dd43eea8449b21034b8113d703413d57761b8b9781957b8c0ac1dfe69f492580ca4195f50376ba4a21033400f6afecb833092a9a21cfdf1ed1376e58c5d1f47de74683123987e967a8f42103a6d48b1131e94ba04d9737d61acdaa1322008af9602b3b14862c07a1789aac162102d8b661b0b3302ee2f162b09e07a55ad5dfbe673a9f01d9f0c19617681024306b56ae";

    // Real mainnet transactions, fetched from a block explorer.
    const REAL_SEGWIT_TX: &str = "02000000000101c10e0eece710ff58d67543cb128214c0324edcfd28286b2d941e984f01b662320000000000ffffffff02175d18000000000016001456ffbd5cf46db1c760563fe35583805ce550baeef69d0300000000001976a91426f77e1dad6d499e5aa052428449971f7bd1893588ac0247304402200b9734d6292c304fea107ef557a38b190e3954121aac7d24f8b12ef2c7c35c4f02207f836bcf170c231b796ea3d67e72b69679a9e587eaa6ac9d0a5a2b712ebea8140121020e2d3c5f2f835d58e41d3e8ac2f7546ff6031744268deada7e127e605ba96b9900000000";
    const REAL_SEGWIT_TXID: &str =
        "e3afbd821b76c7276907b7dd8dd3e02134935df933c44b82c35d173ed4c33449";

    // The first Bitcoin payment between two people, Satoshi to Hal Finney, block 170.
    const REAL_LEGACY_TX: &str = "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000";
    const REAL_LEGACY_TXID: &str =
        "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16";

    #[test]
    fn bip143_p2wpkh_preimage_and_sighash() {
        let tx = parse_tx(&hex(BIP143_P2WPKH_TX)).unwrap();
        let code = hex("76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac");
        let preimage = tx.sighash_preimage::<Soft>(1, &code, 600_000_000).unwrap();
        assert_eq!(
            to_hex(&preimage),
            "0100000096b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd3752b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3bef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a010000001976a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac0046c32300000000ffffffff863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e51100000001000000"
        );
        assert_eq!(
            to_hex(&tx.sighash_all::<Soft>(1, &code, 600_000_000).unwrap()),
            "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670"
        );
    }

    #[test]
    fn bip143_witness_script_sighash() {
        let tx = parse_tx(&hex(BIP143_P2WSH_TX)).unwrap();
        let script = hex(BIP143_P2WSH_SCRIPT);
        assert_eq!(
            to_hex(&tx.sighash_all::<Soft>(0, &script, 987_654_321).unwrap()),
            "185c0be5263dce5b4bb50a047973c1b6272bfbd0103a89444597dc40b248ee7c"
        );
    }

    #[test]
    fn sighash_refuses_an_input_that_does_not_exist() {
        let tx = parse_tx(&hex(BIP143_P2WSH_TX)).unwrap();
        assert_eq!(
            tx.sighash_all::<Soft>(1, &[], 1),
            Err(Error::BadInputIndex)
        );
    }

    #[test]
    fn real_segwit_transaction_gets_its_real_txid() {
        let tx = parse_tx(&hex(REAL_SEGWIT_TX)).unwrap();
        assert_eq!(display(tx.txid::<Soft>()), REAL_SEGWIT_TXID);
        assert_eq!(tx.outputs.len(), 2);
        assert_eq!(tx.outputs[0].value, 1_596_695);
        assert_eq!(
            classify_script_pubkey(&tx.outputs[0].script_pubkey),
            Some(ScriptKind::P2wpkh)
        );
        assert_eq!(
            classify_script_pubkey(&tx.outputs[1].script_pubkey),
            Some(ScriptKind::P2pkh)
        );
    }

    #[test]
    fn real_legacy_transaction_gets_its_real_txid() {
        let tx = parse_tx(&hex(REAL_LEGACY_TX)).unwrap();
        assert_eq!(display(tx.txid::<Soft>()), REAL_LEGACY_TXID);
        assert_eq!(tx.outputs[0].value, 1_000_000_000); // 10 BTC to Hal
        assert_eq!(tx.outputs[1].value, 4_000_000_000); // 40 BTC change
    }

    #[test]
    fn stripped_serialization_of_a_legacy_transaction_is_unchanged() {
        let raw = hex(REAL_LEGACY_TX);
        assert_eq!(parse_tx(&raw).unwrap().serialize_stripped(), raw);
    }

    #[test]
    fn every_truncation_is_refused_without_panicking() {
        for source in [REAL_SEGWIT_TX, REAL_LEGACY_TX, BIP143_P2WPKH_TX] {
            let raw = hex(source);
            for cut in 0..raw.len() {
                assert!(parse_tx(&raw[..cut]).is_err(), "accepted a {cut}-byte prefix");
            }
        }
    }

    #[test]
    fn single_byte_corruption_never_panics() {
        // Corruption may still parse: a flipped value is a valid, different transaction.
        // What matters is that nothing panics and the txid moves.
        let raw = hex(REAL_SEGWIT_TX);
        let original = parse_tx(&raw).unwrap().txid::<Soft>();
        for at in 0..raw.len() {
            for flip in [0x01u8, 0x80, 0xff] {
                let mut m = raw.clone();
                m[at] ^= flip;
                if let Ok(tx) = parse_tx(&m) {
                    let witness_only = at >= 4 + 2 + 41 + 1 + 31 + 34 && at < raw.len() - 4;
                    if !witness_only && at != 4 && at != 5 {
                        assert_ne!(tx.txid::<Soft>(), original, "flip at byte {at} kept the txid");
                    }
                }
            }
        }
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let mut raw = hex(REAL_LEGACY_TX);
        raw.push(0);
        assert_eq!(parse_tx(&raw), Err(Error::TrailingBytes));
    }

    #[test]
    fn oversized_input_is_refused_before_reading() {
        assert_eq!(
            parse_tx(&vec![0u8; MAX_TX_BYTES + 1]),
            Err(Error::TxTooLarge)
        );
    }

    #[test]
    fn a_huge_declared_count_fails_without_allocating() {
        // version, then an input count of 2^32 - 1.
        let mut raw = vec![1, 0, 0, 0, 0xfe, 0xff, 0xff, 0xff, 0xff];
        raw.extend_from_slice(&[0; 40]);
        assert_eq!(parse_tx(&raw), Err(Error::TruncatedTx));
    }

    #[test]
    fn non_canonical_varints_are_refused() {
        // version, then the count 1 written in three bytes instead of one.
        let mut raw = hex(REAL_LEGACY_TX);
        raw.splice(4..5, [0xfd, 0x01, 0x00]);
        assert_eq!(parse_tx(&raw), Err(Error::NonCanonicalVarInt));

        let mut raw = hex(REAL_LEGACY_TX);
        raw.splice(4..5, [0xfe, 0x01, 0x00, 0x00, 0x00]);
        assert_eq!(parse_tx(&raw), Err(Error::NonCanonicalVarInt));

        let mut raw = hex(REAL_LEGACY_TX);
        raw.splice(4..5, [0xff, 0x01, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(parse_tx(&raw), Err(Error::NonCanonicalVarInt));
    }

    #[test]
    fn varint_boundaries_round_trip() {
        for v in [0u64, 1, 0xfc, 0xfd, 0xfe, 0xff, 0x100, 0xffff, 0x1_0000, 0xffff_ffff, 0x1_0000_0000] {
            let mut out = Vec::new();
            write_varint(&mut out, v);
            let mut r = Reader { b: &out, i: 0 };
            assert_eq!(r.varint().unwrap(), v);
            assert_eq!(r.i, out.len());
        }
    }

    #[test]
    fn empty_input_or_output_lists_are_refused() {
        // Version, zero inputs, then the flag byte is not 01, so it reads as non-segwit.
        let raw = [1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(parse_tx(&raw), Err(Error::EmptyTx));

        let mut no_outputs = vec![1u8, 0, 0, 0, 1];
        no_outputs.extend_from_slice(&[0; 36]);
        no_outputs.push(0);
        no_outputs.extend_from_slice(&[0xff; 4]);
        no_outputs.push(0);
        no_outputs.extend_from_slice(&[0; 4]);
        assert_eq!(parse_tx(&no_outputs), Err(Error::EmptyTx));
    }

    #[test]
    fn a_64_byte_transaction_is_refused() {
        // version(4) + count(1) + input(41) + count(1) + output(8 + 1 + 4) + locktime(4).
        let mut raw = vec![1u8, 0, 0, 0, 1];
        raw.extend_from_slice(&[0x11; 36]);
        raw.push(0);
        raw.extend_from_slice(&[0xff; 4]);
        raw.push(1);
        raw.extend_from_slice(&[0; 8]);
        raw.push(4);
        raw.extend_from_slice(&[0x51; 4]);
        raw.extend_from_slice(&[0; 4]);
        assert_eq!(raw.len(), 64);
        assert_eq!(parse_tx(&raw), Err(Error::Forgeable64ByteTx));
    }

    fn vault() -> VaultSpec {
        let mut signer = [0x11; 33];
        signer[0] = 2;
        let mut owner = [0x22; 33];
        owner[0] = 3;
        VaultSpec::new(signer, owner, 5_302_900).unwrap()
    }

    fn coin() -> OutPoint {
        OutPoint {
            txid: [0xab; 32],
            vout: 1,
        }
    }

    fn wpkh() -> Vec<u8> {
        [&[0x00, 20][..], &[9; 20]].concat()
    }

    #[test]
    fn build_spend_pays_everything_but_the_fee() {
        let tx = build_spend(coin(), 100_000, &wpkh(), 500, 0).unwrap();
        assert_eq!(tx.outputs.len(), 1);
        assert_eq!(tx.outputs[0].value, 99_500);
        assert_eq!(tx.outputs[0].script_pubkey, wpkh());
        assert_eq!(tx.inputs[0].previous_output, coin());
        assert_eq!(tx.inputs[0].sequence, SEQUENCE_RBF);
        assert_eq!(tx.lock_time, 0);
    }

    #[test]
    fn build_spend_refuses_bad_fees_dust_and_unknown_destinations() {
        assert_eq!(
            build_spend(coin(), 100_000, &wpkh(), 0, 0),
            Err(Error::BadFee)
        );
        assert_eq!(
            build_spend(coin(), 100_000, &wpkh(), 100_001, 0),
            Err(Error::BadFee)
        );
        assert_eq!(
            build_spend(coin(), 1_000, &wpkh(), 455, 0),
            Err(Error::DustOutput)
        );
        assert!(build_spend(coin(), 1_000, &wpkh(), 454, 0).is_ok());
        assert_eq!(
            build_spend(coin(), 100_000, &[0x6a, 0x01, 0x00], 500, 0),
            Err(Error::UnsupportedDestination)
        );
    }

    #[test]
    fn a_signed_vault_spend_serializes_and_keeps_its_txid() {
        let spec = vault();
        let script = spec.witness_script();
        let tx = build_spend(coin(), 100_000, &wpkh(), 500, 0).unwrap();
        let sig = der_signature(&[0x33; 32], &[0x44; 32]);

        let raw = tx
            .serialize_with_witness(&[signer_path_witness(&sig, &script)])
            .unwrap();
        // Read back, the witness must not change the txid.
        let parsed = parse_tx(&raw).unwrap();
        assert_eq!(parsed, tx);
        assert_eq!(parsed.txid::<Soft>(), tx.txid::<Soft>());

        // Marker and flag sit right after the version.
        assert_eq!(&raw[4..6], &[0x00, 0x01]);
    }

    #[test]
    fn witness_stacks_select_the_right_branch() {
        let script = vault().witness_script();
        let sig = vec![0xaa];
        assert_eq!(signer_path_witness(&sig, &script)[1], vec![0x01]);
        assert!(owner_path_witness(&sig, &script)[1].is_empty());
    }

    #[test]
    fn serializing_needs_one_witness_per_input() {
        let tx = build_spend(coin(), 100_000, &wpkh(), 500, 0).unwrap();
        assert_eq!(
            tx.serialize_with_witness(&[]),
            Err(Error::WitnessMismatch)
        );
    }

    #[test]
    fn the_sighash_changes_with_everything_the_signer_must_commit_to() {
        let script = vault().witness_script();
        let base = build_spend(coin(), 100_000, &wpkh(), 500, 0).unwrap();
        let hash = |tx: &Tx, value| tx.sighash_all::<Soft>(0, &script, value).unwrap();
        let original = hash(&base, 100_000);

        // Different destination.
        let other = [&[0x00, 20][..], &[8; 20]].concat();
        let t = build_spend(coin(), 100_000, &other, 500, 0).unwrap();
        assert_ne!(hash(&t, 100_000), original);

        // Different fee.
        let t = build_spend(coin(), 100_000, &wpkh(), 501, 0).unwrap();
        assert_ne!(hash(&t, 100_000), original);

        // Different coin.
        let mut c = coin();
        c.vout = 2;
        let t = build_spend(c, 100_000, &wpkh(), 500, 0).unwrap();
        assert_ne!(hash(&t, 100_000), original);

        // Different lock time.
        let t = build_spend(coin(), 100_000, &wpkh(), 500, 7).unwrap();
        assert_ne!(hash(&t, 100_000), original);

        // A wrong input value. Without this, a fee could be hidden from a signer.
        assert_ne!(hash(&base, 100_001), original);

        // A different script, so a signature for one vault cannot spend another.
        let mut other_owner = [0x55; 33];
        other_owner[0] = 2;
        let other_spec =
            VaultSpec::new(vault().signer_pubkey, other_owner, 5_302_900).unwrap();
        let other_hash = base
            .sighash_all::<Soft>(0, &other_spec.witness_script(), 100_000)
            .unwrap();
        assert_ne!(other_hash, original);
    }
}
