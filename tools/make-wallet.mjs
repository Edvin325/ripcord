import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const file = '../wallets/btc-testnet.json';
let w;
if (existsSync(file)) { w = JSON.parse(readFileSync(file, 'utf8')); }
else {
  const pair = ECPair.makeRandom({ network: bitcoin.networks.testnet });
  const { address } = bitcoin.payments.p2wpkh({ pubkey: pair.publicKey, network: bitcoin.networks.testnet });
  w = { network: 'testnet3', address, publicKey: pair.publicKey.toString('hex'), wif: pair.toWIF() };
  writeFileSync(file, JSON.stringify(w, null, 2));
}
console.log(JSON.stringify({ address: w.address, publicKey: w.publicKey }, null, 2));
