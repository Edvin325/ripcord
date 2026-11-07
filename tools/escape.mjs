#!/usr/bin/env node
// The ripcord. Builds and signs the owner's own exit from a vault, offline.
//
// It needs no NEAR connection, no Ripcord server and no network at all: the vault file and
// your key are enough. That is deliberate. This is the tool for the day everything else is
// gone. Bitcoin refuses the transaction before the escape height and accepts it after,
// whatever happens on any other chain.
//
//   node escape.mjs --vault vault-7.json --key <hex> --to tb1q... --fee 500 [--out ticket.txt]
//
// The vault file holds what the Ripcord app hands you: the witness script, the coin and the
// network prefix. Every field is checked against the script before anything is signed.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  addressToScript,
  buildSpend,
  bytesToHex,
  encodeSegwit,
  hexToBytes,
  p2wshScriptPubkey,
  parseVaultScript,
  publicKeyOf,
  signOwnerPath,
  txid,
  vaultSpendVbytes,
} from './lib/btc-core.mjs';

const { values: o } = parseArgs({
  options: {
    vault: { type: 'string' },
    key: { type: 'string' },
    to: { type: 'string' },
    fee: { type: 'string' },
    out: { type: 'string' },
  },
});

if (!o.vault || !o.key || !o.to || !o.fee) {
  console.error('usage: node escape.mjs --vault <file> --key <hex> --to <address> --fee <sats> [--out <file>]');
  process.exit(2);
}

const vault = JSON.parse(readFileSync(o.vault, 'utf8'));
const secret = hexToBytes(o.key.trim());
const script = hexToBytes(vault.witness_script);
const { ownerPub, escapeHeight } = parseVaultScript(script);

if (bytesToHex(publicKeyOf(secret)) !== bytesToHex(ownerPub)) {
  console.error("that key is not this vault's owner key");
  process.exit(1);
}

const spk = p2wshScriptPubkey(script);
const address = encodeSegwit(vault.btc_hrp, 0, spk.slice(2));
if (address !== vault.address) {
  console.error(`this script pays ${address}, not ${vault.address}`);
  process.exit(1);
}

const destination = addressToScript(vault.btc_hrp, o.to);
const tx = buildSpend({
  txid: vault.deposit.txid,
  vout: vault.deposit.vout,
  value: vault.deposit.sats,
  destination,
  feeSats: o.fee,
  lockTime: escapeHeight,
});
const raw = bytesToHex(signOwnerPath(tx, script, vault.deposit.sats, secret));

const summary = [
  `Vault address  ${address}`,
  `Coin           ${vault.deposit.txid}:${vault.deposit.vout}`,
  `Sends to       ${o.to}`,
  `Amount         ${tx.outValue} sats, fee ${o.fee} sats (about ${Math.round(Number(o.fee) / vaultSpendVbytes(destination))} sat/vB)`,
  `Valid after    block ${escapeHeight}`,
  `Transaction    ${txid(tx)}`,
];
console.log(summary.join('\n'));
console.log('\nBroadcast this from any Bitcoin node or explorer once that block has passed:\n');
console.log(raw);

if (o.out) {
  writeFileSync(o.out, `${summary.join('\n')}\n\n${raw}\n`);
  console.log(`\nSaved to ${o.out}. It is safe to keep: it can only pay ${o.to}.`);
}
