// A small test wallet, for paying vaults during real-network runs. Its key lives in
// wallets/, which git ignores. Testnet only: nothing here is for real funds.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
const here = dirname(fileURLToPath(import.meta.url));
const network = bitcoin.networks.testnet;

export function loadWallet() {
  const w = JSON.parse(readFileSync(join(here, '..', '..', 'wallets', 'btc-testnet.json'), 'utf8'));
  const pair = ECPair.fromWIF(w.wif, network);
  const payment = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pair.publicKey), network });
  return { address: payment.address, script: payment.output, pair };
}

const INPUT_VBYTES = 68;
const OUTPUT_VBYTES = 34;
const OVERHEAD_VBYTES = 11;

/** Pays `address` from the wallet and returns the broadcast txid. */
export async function pay(api, wallet, address, sats, feeRate = 2) {
  const utxos = (await api.utxos(wallet.address)).filter((u) => u.status.confirmed);
  utxos.sort((a, b) => b.value - a.value);

  const psbt = new bitcoin.Psbt({ network });
  let total = 0;
  let inputs = 0;
  let fee = 0;
  for (const u of utxos) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: wallet.script, value: u.value },
    });
    total += u.value;
    inputs += 1;
    fee = Math.ceil((OVERHEAD_VBYTES + inputs * INPUT_VBYTES + 2 * OUTPUT_VBYTES) * feeRate);
    if (total >= sats + fee) break;
  }
  if (total < sats + fee) throw new Error(`wallet holds ${total} sats, needs ${sats + fee}`);

  psbt.addOutput({ address, value: sats });
  const change = total - sats - fee;
  if (change > 546) psbt.addOutput({ address: wallet.address, value: change });

  const signer = {
    publicKey: Buffer.from(wallet.pair.publicKey),
    sign: (hash) => Buffer.from(wallet.pair.sign(hash)),
  };
  psbt.signAllInputs(signer);
  psbt.finalizeAllInputs();
  return api.broadcast(psbt.extractTransaction().toHex());
}
