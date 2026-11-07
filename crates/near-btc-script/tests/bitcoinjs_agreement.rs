//! Every byte here was produced by bitcoinjs-lib, a separate implementation, by
//! `tools/fixtures.mjs`. This crate has to agree on scripts, addresses, the digests to
//! sign, and whole signed transactions for both vault paths.

use near_btc_script::bech32::{decode_segwit, encode_segwit};
use near_btc_script::{
    build_spend, classify_script_pubkey, der_signature, owner_path_witness, parse_tx,
    signer_path_witness, OutPoint, Sha256, VaultSpec,
};

struct Soft;

impl Sha256 for Soft {
    fn sha256(data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }
}

const FIXTURE: &str = include_str!("fixtures/bitcoinjs.json");

/// Reads one string field from one case. The fixture format is fixed and this avoids
/// giving a dependency-free crate a JSON dependency for one test.
fn field<'a>(case: &'a str, name: &str) -> &'a str {
    let key = format!("\"{name}\": \"");
    let start = case.find(&key).unwrap_or_else(|| panic!("no field {name}")) + key.len();
    let end = start + case[start..].find('"').unwrap();
    &case[start..end]
}

fn number(case: &str, name: &str) -> u64 {
    let key = format!("\"{name}\": ");
    let start = case.find(&key).unwrap_or_else(|| panic!("no field {name}")) + key.len();
    let digits: String = case[start..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap()
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn array<const N: usize>(s: &str) -> [u8; N] {
    hex(s).try_into().unwrap()
}

/// Everything after one `"xxx_path": {` up to its closing brace.
fn section<'a>(case: &'a str, name: &str) -> &'a str {
    let start = case.find(&format!("\"{name}\": {{")).unwrap();
    let end = start + case[start..].find('}').unwrap();
    &case[start..end]
}

fn cases() -> Vec<&'static str> {
    let cases: Vec<&str> = FIXTURE.split("\"name\": ").skip(1).collect();
    assert_eq!(cases.len(), 5, "fixture changed shape");
    cases
}

fn spec_of(case: &str) -> VaultSpec {
    VaultSpec::new(
        array(field(case, "signer_pubkey")),
        array(field(case, "owner_pubkey")),
        number(case, "escape_height") as u32,
    )
    .unwrap()
}

#[test]
fn scripts_and_addresses_match() {
    for case in cases() {
        let spec = spec_of(case);
        assert_eq!(
            to_hex(&spec.witness_script()),
            field(case, "witness_script"),
            "witness script"
        );
        let spk = spec.script_pubkey::<Soft>();
        assert_eq!(to_hex(&spk), field(case, "script_pubkey"), "script pubkey");
        assert_eq!(
            encode_segwit(field(case, "hrp"), 0, &spk[2..]).unwrap(),
            field(case, "address"),
            "address"
        );
        assert_eq!(
            decode_segwit(field(case, "hrp"), field(case, "address"))
                .unwrap()
                .1,
            spk[2..].to_vec()
        );
        assert_eq!(VaultSpec::parse(&spec.witness_script()).unwrap(), spec);
    }
}

fn outpoint(case: &str) -> OutPoint {
    OutPoint {
        txid: array(field(case, "prev_txid_internal")),
        vout: number(case, "vout") as u32,
    }
}

#[test]
fn signer_path_spend_matches_to_the_byte() {
    for case in cases() {
        let spec = spec_of(case);
        let script = spec.witness_script();
        let value = number(case, "value");
        let dest = hex(field(case, "destination"));
        assert!(classify_script_pubkey(&dest).is_some());

        let tx = build_spend(outpoint(case), value, &dest, number(case, "fee"), 0).unwrap();
        let path = section(case, "signer_path");
        assert_eq!(
            to_hex(&tx.sighash_all::<Soft>(0, &script, value).unwrap()),
            field(path, "sighash"),
            "sighash"
        );

        let der = der_signature(&array(field(path, "r")), &array(field(path, "s")));
        assert_eq!(to_hex(&der), field(path, "der"), "DER signature");

        let raw = tx
            .serialize_with_witness(&[signer_path_witness(&der, &script)])
            .unwrap();
        assert_eq!(to_hex(&raw), field(path, "raw_tx"), "signed transaction");

        let mut txid = parse_tx(&raw).unwrap().txid::<Soft>();
        txid.reverse();
        assert_eq!(to_hex(&txid), field(path, "txid"), "txid");
    }
}

#[test]
fn owner_path_spend_matches_to_the_byte() {
    for case in cases() {
        let spec = spec_of(case);
        let script = spec.witness_script();
        let value = number(case, "value");
        let dest = hex(field(case, "destination"));

        let tx = build_spend(
            outpoint(case),
            value,
            &dest,
            number(case, "fee"),
            spec.escape_height,
        )
        .unwrap();
        let path = section(case, "owner_path");
        assert_eq!(
            to_hex(&tx.sighash_all::<Soft>(0, &script, value).unwrap()),
            field(path, "sighash"),
            "sighash"
        );

        let der = der_signature(&array(field(path, "r")), &array(field(path, "s")));
        let raw = tx
            .serialize_with_witness(&[owner_path_witness(&der, &script)])
            .unwrap();
        assert_eq!(to_hex(&raw), field(path, "raw_tx"), "signed transaction");
    }
}
