// Generates test vectors with bitcoinjs-lib, a separate and widely used implementation.
// The Rust library must reproduce every byte, including fully signed transactions for
// both vault paths. Keys are fixed test values, so the output is deterministic.
//
//   node fixtures.mjs   writes ../crates/near-btc-script/tests/fixtures/bitcoinjs.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const here = dirname(fileURLToPath(import.meta.url));

const key = (byte) => ECPair.fromPrivateKey(Buffer.alloc(32, byte), { compressed: true });

// Bitcoin script numbers, as bitcoinjs encodes them.
const num = (n) => bitcoin.script.number.encode(n);

function vaultScript(signerPub, ownerPub, escapeHeight) {
  const o = bitcoin.opcodes;
  return bitcoin.script.compile([
    o.OP_IF,
    signerPub,
    o.OP_CHECKSIG,
    o.OP_ELSE,
    num(escapeHeight),
    o.OP_CHECKLOCKTIMEVERIFY,
    o.OP_DROP,
    ownerPub,
    o.OP_CHECKSIG,
    o.OP_ENDIF,
  ]);
}

function destination(kind) {
  const hash20 = Buffer.alloc(20, 0x77);
  const hash32 = Buffer.alloc(32, 0x88);
  switch (kind) {
    case 'p2wpkh':
      return bitcoin.script.compile([bitcoin.opcodes.OP_0, hash20]);
    case 'p2wsh':
      return bitcoin.script.compile([bitcoin.opcodes.OP_0, hash32]);
    case 'p2pkh':
      return bitcoin.payments.p2pkh({ hash: hash20 }).output;
    case 'p2sh':
      return bitcoin.payments.p2sh({ hash: hash20 }).output;
    case 'p2tr':
      return bitcoin.script.compile([bitcoin.opcodes.OP_1, hash32]);
    default:
      throw new Error(kind);
  }
}

const RBF = 0xfffffffd;

function spendTx(txidBytes, vout, value, dest, fee, lockTime) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.locktime = lockTime;
  // addInput takes the hash in internal byte order.
  tx.addInput(txidBytes, vout, RBF);
  tx.addOutput(dest, value - fee);
  return tx;
}

function sign(pair, tx, script, value) {
  const hash = tx.hashForWitnessV0(0, script, value, bitcoin.Transaction.SIGHASH_ALL);
  const compact = Buffer.from(pair.sign(hash, true)); // low-R grinding, deterministic
  return {
    hash,
    r: compact.subarray(0, 32),
    s: compact.subarray(32, 64),
    der: bitcoin.script.signature.encode(compact, bitcoin.Transaction.SIGHASH_ALL),
  };
}

const cases = [
  { name: 'testnet3 height, p2wpkh', hrp: 'tb', network: bitcoin.networks.testnet, escape: 5_302_900, value: 100_000, fee: 500, dest: 'p2wpkh', signer: 0x11, owner: 0x22, vout: 0 },
  { name: 'mainnet height, p2wsh', hrp: 'bc', network: bitcoin.networks.bitcoin, escape: 974_932, value: 2_500_000, fee: 1_234, dest: 'p2wsh', signer: 0x33, owner: 0x44, vout: 1 },
  { name: 'height with a padded top byte, p2pkh', hrp: 'bc', network: bitcoin.networks.bitcoin, escape: 0x00ff_8000, value: 54_321, fee: 321, dest: 'p2pkh', signer: 0x55, owner: 0x66, vout: 7 },
  { name: 'small height, p2sh', hrp: 'tb', network: bitcoin.networks.testnet, escape: 300, value: 10_000, fee: 150, dest: 'p2sh', signer: 0x77, owner: 0x12, vout: 2 },
  { name: 'near the height limit, p2tr', hrp: 'bc', network: bitcoin.networks.bitcoin, escape: 499_999_999, value: 2_100_000_000_000, fee: 99_999, dest: 'p2tr', signer: 0x13, owner: 0x14, vout: 0 },
];

const out = cases.map((c) => {
  const signer = key(c.signer);
  const owner = key(c.owner);
  const script = vaultScript(signer.publicKey, owner.publicKey, c.escape);
  const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: script }, network: c.network });

  const txid = Buffer.alloc(32, c.signer ^ 0xa5);
  const dest = destination(c.dest);

  // Signer path: no lock time.
  const signerTx = spendTx(txid, c.vout, c.value, dest, c.fee, 0);
  const signerSig = sign(signer, signerTx, script, c.value);
  signerTx.setWitness(0, [signerSig.der, Buffer.from([1]), script]);

  // Owner path: lock time at the escape height.
  const ownerTx = spendTx(txid, c.vout, c.value, dest, c.fee, c.escape);
  const ownerSig = sign(owner, ownerTx, script, c.value);
  ownerTx.setWitness(0, [ownerSig.der, Buffer.alloc(0), script]);

  return {
    name: c.name,
    hrp: c.hrp,
    escape_height: c.escape,
    value: c.value,
    fee: c.fee,
    vout: c.vout,
    signer_pubkey: signer.publicKey.toString('hex'),
    owner_pubkey: owner.publicKey.toString('hex'),
    witness_script: script.toString('hex'),
    script_pubkey: p2wsh.output.toString('hex'),
    address: p2wsh.address,
    prev_txid_internal: txid.toString('hex'),
    destination: dest.toString('hex'),
    signer_path: {
      sighash: signerSig.hash.toString('hex'),
      r: signerSig.r.toString('hex'),
      s: signerSig.s.toString('hex'),
      der: signerSig.der.toString('hex'),
      raw_tx: signerTx.toHex(),
      txid: signerTx.getId(),
    },
    owner_path: {
      sighash: ownerSig.hash.toString('hex'),
      r: ownerSig.r.toString('hex'),
      s: ownerSig.s.toString('hex'),
      der: ownerSig.der.toString('hex'),
      raw_tx: ownerTx.toHex(),
      txid: ownerTx.getId(),
    },
  };
});

const target = join(here, '..', 'crates', 'near-btc-script', 'tests', 'fixtures');
mkdirSync(target, { recursive: true });
const file = join(target, 'bitcoinjs.json');
writeFileSync(file, JSON.stringify({ generator: 'bitcoinjs-lib', cases: out }, null, 2) + '\n');
console.log(`wrote ${out.length} cases to ${file}`);
