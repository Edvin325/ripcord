// Bitcoin logic for the browser and the command line, with two small audited
// dependencies. It mirrors crates/near-btc-script. Both are checked byte for byte against
// the same bitcoinjs-lib fixtures, so three implementations have to agree.
//
// Nothing here talks to a network, so it runs offline: that is the point of an escape
// ticket, which must still work on a day when everything else is gone.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

export const SATS_PER_BTC = 100_000_000n;
export const SEQUENCE_RBF = 0xfffffffd;
export const DUST_SATS = 546n;
const SIGHASH_ALL = 1;

const OP = {
  OP_0: 0x00,
  OP_1: 0x51,
  DUP: 0x76,
  HASH160: 0xa9,
  EQUAL: 0x87,
  EQUALVERIFY: 0x88,
  IF: 0x63,
  ELSE: 0x67,
  ENDIF: 0x68,
  DROP: 0x75,
  CHECKSIG: 0xac,
  CLTV: 0xb1,
};

export function hexToBytes(text) {
  if (typeof text !== 'string' || text.length % 2 || /[^0-9a-fA-F]/.test(text)) {
    throw new Error('not valid hex');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const sha256d = (data) => sha256(sha256(data));

/** Reverses a hash between explorer order and internal order. */
export const reverseHex = (text) => bytesToHex(hexToBytes(text).reverse());

function u32le(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function u64le(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

function varint(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return concat(Uint8Array.of(0xfe), u32le(n));
}

/** Bitcoin script number: little-endian, minimal, with a sign bit on the top byte. */
export function scriptNum(n) {
  const out = [];
  let v = n;
  while (v > 0) {
    out.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (out.length && out[out.length - 1] & 0x80) out.push(0);
  return Uint8Array.from(out);
}

const push = (data) => concat(Uint8Array.of(data.length), data);

/** The vault script. See crates/near-btc-script. */
export function vaultScript(signerPub, ownerPub, escapeHeight) {
  if (signerPub.length !== 33 || ownerPub.length !== 33) throw new Error('keys must be 33 bytes');
  if (escapeHeight < 17 || escapeHeight >= 500_000_000) throw new Error('bad escape height');
  return concat(
    Uint8Array.of(OP.IF),
    push(signerPub),
    Uint8Array.of(OP.CHECKSIG, OP.ELSE),
    push(scriptNum(escapeHeight)),
    Uint8Array.of(OP.CLTV, OP.DROP),
    push(ownerPub),
    Uint8Array.of(OP.CHECKSIG, OP.ENDIF),
  );
}

/**
 * Reads a script and accepts only the exact template. A wallet or page should do this
 * before funding: it shows what the address enforces without trusting whoever sent it.
 */
export function parseVaultScript(script) {
  const fail = () => {
    throw new Error('this is not a Ripcord vault script');
  };
  let i = 0;
  const expect = (op) => {
    if (script[i++] !== op) fail();
  };
  const take33 = () => {
    expect(33);
    const key = script.slice(i, i + 33);
    if (key.length !== 33) fail();
    i += 33;
    return key;
  };
  expect(OP.IF);
  const signerPub = take33();
  expect(OP.CHECKSIG);
  expect(OP.ELSE);
  const len = script[i++];
  if (!(len >= 1 && len <= 5)) fail();
  let escapeHeight = 0;
  for (let k = 0; k < len; k++) escapeHeight += script[i + k] * 2 ** (8 * k);
  i += len;
  expect(OP.CLTV);
  expect(OP.DROP);
  const ownerPub = take33();
  expect(OP.CHECKSIG);
  expect(OP.ENDIF);
  if (i !== script.length) fail();
  const rebuilt = vaultScript(signerPub, ownerPub, escapeHeight);
  if (bytesToHex(rebuilt) !== bytesToHex(script)) fail();
  return { signerPub, ownerPub, escapeHeight };
}

export const p2wshScriptPubkey = (script) => concat(Uint8Array.of(OP.OP_0, 32), sha256(script));

/** Output types the contract accepts as a destination. */
export function classifyScript(spk) {
  const n = spk.length;
  if (n === 25 && spk[0] === OP.DUP && spk[1] === OP.HASH160 && spk[2] === 20 && spk[23] === OP.EQUALVERIFY && spk[24] === OP.CHECKSIG) return 'p2pkh';
  if (n === 23 && spk[0] === OP.HASH160 && spk[1] === 20 && spk[22] === OP.EQUAL) return 'p2sh';
  if (n === 22 && spk[0] === OP.OP_0 && spk[1] === 20) return 'p2wpkh';
  if (n === 34 && spk[0] === OP.OP_0 && spk[1] === 32) return 'p2wsh';
  if (n === 34 && spk[0] === OP.OP_1 && spk[1] === 32) return 'p2tr';
  return null;
}

// ---- bech32 ----

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    GEN.forEach((g, i) => {
      if ((top >>> i) & 1) chk = (chk ^ g) >>> 0;
    });
  }
  return chk;
}

const hrpExpand = (hrp) => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

const checksumConst = (version) => (version === 0 ? 1 : 0x2bc830a3);

function regroup(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max)) {
    return null;
  }
  return out;
}

export function encodeSegwit(hrp, version, program) {
  const data = [version, ...regroup(program, 8, 5, true)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ checksumConst(version);
  let out = `${hrp}1`;
  for (const d of data) out += CHARSET[d];
  for (let i = 0; i < 6; i++) out += CHARSET[(chk >>> (5 * (5 - i))) & 31];
  return out;
}

export function decodeSegwit(hrp, address) {
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) throw new Error('mixed-case address');
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || lower.slice(0, sep) !== hrp) throw new Error(`address is not on network ${hrp}`);
  const data = [...lower.slice(sep + 1)].map((c) => {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error('bad address character');
    return v;
  });
  if (data.length < 7) throw new Error('address too short');
  const version = data[0];
  if (polymod([...hrpExpand(hrp), ...data]) !== checksumConst(version)) {
    throw new Error('address checksum failed');
  }
  const program = regroup(data.slice(1, -6), 5, 8, false);
  if (!program) throw new Error('bad address padding');
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error('bad address length');
  }
  return { version, program: Uint8Array.from(program) };
}

/** The output script for a segwit address. */
export function addressToScript(hrp, address) {
  const { version, program } = decodeSegwit(hrp, address);
  const op = version === 0 ? 0 : 0x50 + version;
  return concat(Uint8Array.of(op, program.length), program);
}

// ---- Transactions ----

/** One input, one output, nothing left over. `txid` is in explorer order. */
export function buildSpend({ txid, vout, value, destination, feeSats, lockTime = 0 }) {
  if (!classifyScript(destination)) throw new Error('destination is not a standard output');
  const out = BigInt(value) - BigInt(feeSats);
  if (BigInt(feeSats) <= 0n || out < DUST_SATS) throw new Error('fee leaves a dust output');
  return {
    version: 2,
    prevTxid: hexToBytes(reverseHex(txid)),
    vout,
    sequence: SEQUENCE_RBF,
    outValue: out,
    destination,
    lockTime,
  };
}

function serializeBody(tx) {
  return concat(
    varint(1),
    tx.prevTxid,
    u32le(tx.vout),
    varint(0),
    u32le(tx.sequence),
    varint(1),
    u64le(tx.outValue),
    varint(tx.destination.length),
    tx.destination,
  );
}

/** BIP-143 digest for `SIGHASH_ALL`. */
export function sighashAll(tx, scriptCode, value) {
  const outpoint = concat(tx.prevTxid, u32le(tx.vout));
  const output = concat(u64le(tx.outValue), varint(tx.destination.length), tx.destination);
  const preimage = concat(
    u32le(tx.version),
    sha256d(outpoint),
    sha256d(u32le(tx.sequence)),
    outpoint,
    varint(scriptCode.length),
    scriptCode,
    u64le(value),
    u32le(tx.sequence),
    sha256d(output),
    u32le(tx.lockTime),
    u32le(SIGHASH_ALL),
  );
  return sha256d(preimage);
}

function derInt(v) {
  let i = 0;
  while (i < 31 && v[i] === 0) i++;
  const bytes = v.slice(i);
  return bytes[0] & 0x80 ? concat(Uint8Array.of(0), bytes) : bytes;
}

/** DER signature with the sighash byte. `s` must already be low. */
export function derSignature(r, s) {
  const rr = derInt(r);
  const ss = derInt(s);
  return concat(
    Uint8Array.of(0x30, rr.length + ss.length + 4, 0x02, rr.length),
    rr,
    Uint8Array.of(0x02, ss.length),
    ss,
    Uint8Array.of(SIGHASH_ALL),
  );
}

export function serializeSigned(tx, witness) {
  let stack = varint(witness.length);
  for (const item of witness) stack = concat(stack, varint(item.length), item);
  return concat(
    u32le(tx.version),
    Uint8Array.of(0x00, 0x01),
    serializeBody(tx),
    stack,
    u32le(tx.lockTime),
  );
}

export function txid(tx) {
  const stripped = concat(u32le(tx.version), serializeBody(tx), u32le(tx.lockTime));
  return bytesToHex(sha256d(stripped).reverse());
}

/** Signs the owner's path. The key is used here and nowhere else. */
export function signOwnerPath(tx, witnessScript, value, ownerSecret) {
  const digest = sighashAll(tx, witnessScript, value);
  const sig = secp256k1.sign(digest, ownerSecret, { lowS: true });
  const compact = sig.toCompactRawBytes();
  const der = derSignature(compact.slice(0, 32), compact.slice(32));
  return serializeSigned(tx, [der, new Uint8Array(0), witnessScript]);
}

/** A fresh Bitcoin key for the owner's path. */
export function newOwnerKey() {
  const secret = secp256k1.utils.randomPrivateKey();
  return { secret, publicKey: secp256k1.getPublicKey(secret, true) };
}

export const publicKeyOf = (secret) => secp256k1.getPublicKey(secret, true);

// ---- Merkle proofs ----

/**
 * Sibling hashes for the transaction at `index`, bottom to top, in explorer order.
 * `txids` is the whole block in explorer order, coinbase first.
 */
export function merkleProof(txids, index) {
  let level = txids.map((t) => hexToBytes(reverseHex(t)));
  let i = index;
  const proof = [];
  while (level.length > 1) {
    if (level.length % 2) level = [...level, level[level.length - 1]];
    proof.push(bytesToHex([...level[i ^ 1]].reverse()));
    const next = [];
    for (let k = 0; k < level.length; k += 2) next.push(sha256d(concat(level[k], level[k + 1])));
    level = next;
    i >>= 1;
  }
  return { proof, root: bytesToHex([...level[0]].reverse()) };
}

/** Rough virtual size of a vault spend, for fee estimates. */
export function vaultSpendVbytes(destination) {
  const base = 10 + 41 + 9 + destination.length;
  const witness = 2 + 1 + 73 + 2 + 1 + 79 + 1;
  return Math.ceil(base + witness / 4);
}
