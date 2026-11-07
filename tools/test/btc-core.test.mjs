// Runs with `node --test`. Checks the JavaScript against the same bitcoinjs-lib vectors the
// Rust library must match, plus the published address and Merkle cases.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  addressToScript,
  buildSpend,
  bytesToHex,
  classifyScript,
  concat,
  decodeSegwit,
  derSignature,
  encodeSegwit,
  hexToBytes,
  merkleProof,
  p2wshScriptPubkey,
  parseVaultScript,
  publicKeyOf,
  reverseHex,
  scriptNum,
  serializeSigned,
  sha256d,
  sighashAll,
  signOwnerPath,
  txid,
  vaultScript,
} from '../lib/btc-core.mjs';

const { cases } = JSON.parse(
  readFileSync(
    new URL('../../crates/near-btc-script/tests/fixtures/bitcoinjs.json', import.meta.url),
    'utf8',
  ),
);

const specOf = (c) =>
  vaultScript(hexToBytes(c.signer_pubkey), hexToBytes(c.owner_pubkey), c.escape_height);

const spendOf = (c, lockTime) =>
  buildSpend({
    txid: reverseHex(c.prev_txid_internal),
    vout: c.vout,
    value: c.value,
    destination: hexToBytes(c.destination),
    feeSats: c.fee,
    lockTime,
  });

test('there are vectors to check', () => assert.equal(cases.length, 5));

test('scripts and addresses match bitcoinjs', () => {
  for (const c of cases) {
    const script = specOf(c);
    assert.equal(bytesToHex(script), c.witness_script, c.name);
    const spk = p2wshScriptPubkey(script);
    assert.equal(bytesToHex(spk), c.script_pubkey, c.name);
    assert.equal(encodeSegwit(c.hrp, 0, spk.slice(2)), c.address, c.name);
    assert.equal(bytesToHex(addressToScript(c.hrp, c.address)), c.script_pubkey, c.name);
    assert.equal(parseVaultScript(script).escapeHeight, c.escape_height, c.name);
  }
});

test('signer path matches bitcoinjs to the byte', () => {
  for (const c of cases) {
    const script = specOf(c);
    const tx = spendOf(c, 0);
    const p = c.signer_path;
    assert.equal(bytesToHex(sighashAll(tx, script, c.value)), p.sighash, c.name);
    const der = derSignature(hexToBytes(p.r), hexToBytes(p.s));
    assert.equal(bytesToHex(der), p.der, c.name);
    const raw = serializeSigned(tx, [der, Uint8Array.of(1), script]);
    assert.equal(bytesToHex(raw), p.raw_tx, c.name);
    assert.equal(txid(tx), p.txid, c.name);
  }
});

test('owner path matches bitcoinjs to the byte', () => {
  for (const c of cases) {
    const script = specOf(c);
    const tx = spendOf(c, c.escape_height);
    const p = c.owner_path;
    assert.equal(bytesToHex(sighashAll(tx, script, c.value)), p.sighash, c.name);
    const der = derSignature(hexToBytes(p.r), hexToBytes(p.s));
    const raw = serializeSigned(tx, [der, new Uint8Array(0), script]);
    assert.equal(bytesToHex(raw), p.raw_tx, c.name);
    assert.equal(txid(tx), p.txid, c.name);
  }
});

test('owner path signing makes a transaction with a valid low-S signature', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const secret = new Uint8Array(32).fill(0x22);
  const c = cases[0];
  assert.equal(bytesToHex(publicKeyOf(secret)), c.owner_pubkey);

  const script = specOf(c);
  const tx = spendOf(c, c.escape_height);
  const raw = signOwnerPath(tx, script, c.value, secret);

  // The witness starts after version, marker, flag, body (82 bytes here).
  const body = 4 + 2 + 1 + 36 + 1 + 4 + 1 + 8 + 1 + tx.destination.length;
  assert.equal(raw[body], 3, 'three witness items');
  const sigLen = raw[body + 1];
  const der = raw.slice(body + 2, body + 2 + sigLen);
  assert.equal(der[der.length - 1], 1, 'SIGHASH_ALL');
  const parsed = secp256k1.Signature.fromDER(der.slice(0, -1));
  assert.equal(parsed.hasHighS(), false);
  assert.ok(
    secp256k1.verify(parsed, sighashAll(tx, script, c.value), publicKeyOf(secret)),
    'signature verifies against the owner key',
  );
  assert.equal(raw[body + 2 + sigLen], 0, 'selector is the empty item for OP_ELSE');
});

test('a script that is not the template is refused', () => {
  const script = specOf(cases[0]);
  assert.throws(() => parseVaultScript(script.slice(0, -1)));
  assert.throws(() => parseVaultScript(new Uint8Array([...script, 0x51])));
  const swapped = script.slice();
  swapped[swapped.length - 1] = 0x67;
  assert.throws(() => parseVaultScript(swapped));
  assert.throws(() => parseVaultScript(new Uint8Array(0)));
});

test('script numbers match the Rust tests', () => {
  assert.equal(bytesToHex(scriptNum(128)), '8000');
  assert.equal(bytesToHex(scriptNum(974932)), '54e00e');
  assert.equal(bytesToHex(scriptNum(5302843)), '3bea50');
  assert.equal(bytesToHex(scriptNum(499999999)), 'ff64cd1d');
});

test('published bech32 and bech32m vectors', () => {
  assert.equal(
    encodeSegwit('bc', 0, hexToBytes('751e76e8199196d454941c45d1b3a323f1433bd6')),
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  );
  assert.equal(
    encodeSegwit(
      'bc',
      1,
      hexToBytes('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
    ),
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
  );
  assert.throws(() => decodeSegwit('bc', 'bc1qw509d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'));
  assert.throws(() => decodeSegwit('tb', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'));
});

test('destinations are classified like the contract does', () => {
  assert.equal(classifyScript(hexToBytes(`0014${'11'.repeat(20)}`)), 'p2wpkh');
  assert.equal(classifyScript(hexToBytes(`0020${'11'.repeat(32)}`)), 'p2wsh');
  assert.equal(classifyScript(hexToBytes(`5120${'11'.repeat(32)}`)), 'p2tr');
  assert.equal(classifyScript(hexToBytes(`a914${'11'.repeat(20)}87`)), 'p2sh');
  assert.equal(classifyScript(hexToBytes(`76a914${'11'.repeat(20)}88ac`)), 'p2pkh');
  assert.equal(classifyScript(hexToBytes('6a0100')), null);
  assert.throws(() =>
    buildSpend({
      txid: '00'.repeat(32),
      vout: 0,
      value: 10000,
      destination: hexToBytes('6a0100'),
      feeSats: 100,
    }),
  );
});

test('spend building refuses dust and zero fees', () => {
  const destination = hexToBytes(`0014${'11'.repeat(20)}`);
  const base = { txid: '00'.repeat(32), vout: 0, destination };
  assert.throws(() => buildSpend({ ...base, value: 1000, feeSats: 455 }));
  assert.ok(buildSpend({ ...base, value: 1000, feeSats: 454 }));
  assert.throws(() => buildSpend({ ...base, value: 1000, feeSats: 0 }));
});

test('Merkle proof reproduces the root of a real block', () => {
  // Every transaction in Bitcoin testnet3 block 5302842, with the root from its header.
  // Five leaves also exercises duplicating the last odd node.
  const txids = [
    '3a1d0551bd4ee1b55b32095df41019716c252d38a38d8d6227629f1a46c3d2b3',
    'e0137ef71031620dc825bb4295aadbfd11a5a0b929dc4d330ebc7bf625a6c71b',
    'f939316737f99bbe1d127a19ba27d2045b440f2f2a10449ed9296e0c2dc86dd6',
    '1cdcb394d96750a2c512beb8a4c91ee0c3f3236d657b7bc0ab5012ee9dbf7108',
    'b419b205b519d77c6c22c9d63dfcca711aa7af5673fa91a58407955599f95631',
  ];
  const headerRoot = '1d15a7c0395c5ff5125234654ad121ea8cae6ce07f8b9348e2d4fb96008b33c1';

  for (let index = 0; index < txids.length; index++) {
    const { proof, root } = merkleProof(txids, index);
    assert.equal(root, headerRoot, `leaf ${index}`);
    assert.equal(proof.length, 3);

    // Walk the proof back up by hand, the way the light client does.
    let hash = hexToBytes(reverseHex(txids[index]));
    let at = index;
    for (const sibling of proof) {
      const other = hexToBytes(reverseHex(sibling));
      hash = sha256d(at % 2 ? concat(other, hash) : concat(hash, other));
      at >>= 1;
    }
    assert.equal(bytesToHex([...hash].reverse()), headerRoot, `walk from leaf ${index}`);
  }
});
