#!/usr/bin/env node
// Proves the vault script on real Bitcoin, with no NEAR account and no NEAR tokens.
//
// It builds a vault address around a real key derived by NEAR's MPC network, pays it from a
// test wallet on Bitcoin testnet3, has the real light client on NEAR verify that deposit
// with a read-only call, tries the owner's exit too early, and sends it on time. Real nodes
// decide each step, and every transaction is recorded in evidence/ so anyone can look it up.
//
//   node prove-script.mjs [sats] [blocks until the exit opens]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { view, viewBytes } from './lib/near.mjs';
import { buildProof, esplora, EXPLORER } from './lib/esplora.mjs';
import { loadWallet, pay } from './lib/btc-wallet.mjs';
import {
  addressToScript,
  buildSpend,
  bytesToHex,
  concat,
  encodeSegwit,
  hexToBytes,
  newOwnerKey,
  p2wshScriptPubkey,
  parseVaultScript,
  reverseHex,
  signOwnerPath,
  txid as txidOf,
  vaultScript,
} from './lib/btc-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NEAR_NETWORK = 'testnet';
const BTC_NETWORK = 'testnet3';
const MPC = 'v1.signer-prod.testnet';
const CLIENT = 'btc-client-v4.testnet';
const CONFIRMATIONS = 2;

const SATS = Number(process.argv[2] ?? 15_000);
const LEAD = Number(process.argv[3] ?? 6);
const FEE = 800;

const api = esplora(BTC_NETWORK);
const wallet = loadWallet();
const steps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const link = (txid) => `${EXPLORER[BTC_NETWORK]}/tx/${txid}`;

function record(step, detail = {}) {
  steps.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step} ${JSON.stringify(detail)}`);
  const dir = join(here, '..', 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bitcoin-run.json'), `${JSON.stringify({ network: BTC_NETWORK, light_client: CLIENT, steps }, null, 2)}\n`);
}

async function waitFor(label, check, everyMs = 20_000, limitMs = 5_400_000) {
  const until = Date.now() + limitMs;
  for (;;) {
    const value = await check().catch((e) => {
      console.log(`  (${label}: ${e.message.slice(0, 140)})`);
      return null;
    });
    if (value) return value;
    if (Date.now() > until) throw new Error(`gave up waiting for ${label}`);
    await sleep(everyMs);
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  return hexToBytes(n.toString(16).padStart(128, '0'));
}

/** The MPC network returns `secp256k1:<base58 of x and y>`. Bitcoin wants the compressed form. */
function compress(key) {
  const raw = base58(key.split(':')[1]);
  return concat(Uint8Array.of(raw[63] & 1 ? 3 : 2), raw.slice(0, 32));
}

function u64le(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

function u32le(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

const hash = (display) => hexToBytes(reverseHex(display));
const hashes = (list) => concat(u32le(list.length), ...list.map(hash));

/** The light client's `ProofArgsV2`, in borsh. The same bytes the contract sends. */
function proofArgs(txid, proof, confirmations) {
  return concat(
    hash(txid),
    hash(proof.block_hash),
    u64le(proof.tx_index),
    hashes(proof.merkle_proof),
    hash(proof.coinbase_txid),
    hashes(proof.coinbase_merkle_proof),
    u64le(confirmations),
  );
}

record('start', { wallet: wallet.address });

await waitFor('a confirmed coin in the test wallet', async () => {
  const utxos = await api.utxos(wallet.address);
  return utxos.some((u) => u.status.confirmed && u.value >= SATS + 2_000);
});

// A real key from the real network. The contract's own account is not needed to derive it.
const derived = await view(NEAR_NETWORK, MPC, 'derived_public_key', {
  path: 'ripcord-script-proof',
  predecessor: 'ripcord-proof.testnet',
  domain_id: 0,
});
const signerPub = compress(derived);
const owner = newOwnerKey();
const tip = await api.tip();
const escape = tip + LEAD;

const script = vaultScript(signerPub, owner.publicKey, escape);
const parsed = parseVaultScript(script);
const address = encodeSegwit('tb', 0, p2wshScriptPubkey(script).slice(2));
record('built the vault', {
  address,
  tip,
  escape_height: parsed.escapeHeight,
  signer_key_from_mpc: bytesToHex(signerPub),
  owner_key: bytesToHex(owner.publicKey),
  witness_script: bytesToHex(script),
});

const depositTx = await pay(api, wallet, address, SATS);
record('paid the vault', { sats: SATS, btc_tx: depositTx, explorer: link(depositTx) });

const clientHeight = await waitFor('confirmations the light client can see', async () => {
  const tx = await api.tx(depositTx);
  if (!tx.status?.confirmed) return null;
  const height = await view(NEAR_NETWORK, CLIENT, 'get_last_block_height');
  return height - tx.status.block_height + 1 >= CONFIRMATIONS ? height : null;
});

const { proof, confirmedAt } = await buildProof(api, depositTx);
const accepted = await viewBytes(NEAR_NETWORK, CLIENT, 'verify_transaction_inclusion_v2', proofArgs(depositTx, proof, CONFIRMATIONS));
const forgedId = `${depositTx.slice(0, 63)}${depositTx[63] === '0' ? '1' : '0'}`;
const refused = await viewBytes(NEAR_NETWORK, CLIENT, 'verify_transaction_inclusion_v2', proofArgs(forgedId, proof, CONFIRMATIONS));
record('the live light client on NEAR checked the deposit', {
  confirmed_at_block: confirmedAt,
  client_height: clientHeight,
  real_proof: accepted,
  forged_txid: refused,
});
if (accepted !== true || refused !== false) throw new Error('the light client did not behave as expected');

const tx = await api.tx(depositTx);
const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === address);
const spend = buildSpend({
  txid: depositTx,
  vout,
  value: SATS,
  destination: addressToScript('tb', wallet.address),
  feeSats: FEE,
  lockTime: escape,
});
const ticket = bytesToHex(signOwnerPath(spend, script, SATS, owner.secret));
record('signed the escape ticket', { txid: txidOf(spend), valid_after_block: escape, raw: ticket });

const now = await api.tip();
if (now < escape) {
  const early = await api.broadcast(ticket).then(
    (id) => ({ accepted: id }),
    (e) => ({ refused: e.message.slice(0, 200) }),
  );
  record('tried the ticket early', { tip: now, escape_height: escape, ...early });
  if (early.accepted) throw new Error('Bitcoin accepted the ticket early');
} else {
  record('blocks moved too fast to try the ticket early', { tip: now, escape_height: escape });
}

const onChain = await waitFor('the escape height', async () => {
  if ((await api.tip()) < escape) return null;
  return api.broadcast(ticket);
});
record('Bitcoin accepted the ticket', { btc_tx: onChain, explorer: link(onChain) });

const final = await waitFor('the ticket to confirm', async () => {
  const t = await api.tx(onChain);
  return t.status?.confirmed ? t : null;
});
record('the coins are out, through the owner path alone', {
  btc_tx: onChain,
  block: final.status.block_height,
  witness_items: final.vin[0].witness.length,
  selector_is_empty: final.vin[0].witness[1] === '',
  paid_sats: final.vout[0].value,
  locktime: final.locktime,
});
