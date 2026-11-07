#!/usr/bin/env node
// The riskiest path through the real contract, on real networks, with very little NEAR.
//
// It deploys only the lending contract and skips loans, so it needs no USDC: open a vault,
// which asks the MPC contract for a key; pay it on real Bitcoin; prove the deposit through
// the real light client; release it; have the real MPC network sign; and let real Bitcoin
// accept the spend. Every cross-contract call the contract depends on runs for real.
//
//   node spike-contract.mjs <funded account>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountFor, call, view } from './lib/near.mjs';
import { buildProof, esplora, EXPLORER } from './lib/esplora.mjs';
import { loadWallet, pay } from './lib/btc-wallet.mjs';
import { addressToScript, bytesToHex, encodeSegwit, hexToBytes, newOwnerKey, p2wshScriptPubkey, parseVaultScript } from './lib/btc-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [account] = process.argv.slice(2);
if (!account) {
  console.error('usage: node spike-contract.mjs <funded account>');
  process.exit(2);
}

const NETWORK = 'testnet';
const BTC_NETWORK = 'testnet3';
const CLIENT = 'btc-client-v4.testnet';
const MPC = 'v1.signer-prod.testnet';
const SATS = 9_000;
const CONFIRMATIONS = 2;

const api = esplora(BTC_NETWORK);
const wallet = loadWallet();
const steps = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const link = (id) => `${EXPLORER[BTC_NETWORK]}/tx/${id}`;

function record(step, detail = {}) {
  steps.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step} ${JSON.stringify(detail)}`);
  const dir = join(here, '..', 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'contract-spike.json'), `${JSON.stringify({ near_network: NETWORK, btc_network: BTC_NETWORK, contract: account, steps }, null, 2)}\n`);
}

async function waitFor(label, check, everyMs = 15_000, limitMs = 5_400_000) {
  const until = Date.now() + limitMs;
  for (;;) {
    const value = await check().catch((e) => {
      console.log(`  (${label}: ${e.message.slice(0, 160)})`);
      return null;
    });
    if (value) return value;
    if (Date.now() > until) throw new Error(`gave up waiting for ${label}`);
    await sleep(everyMs);
  }
}

const must = (r, step) => {
  record(step, { near_tx: r.hash, ok: r.ok, ...(r.ok ? {} : { failures: r.failures }) });
  if (!r.ok) throw new Error(`${step}: ${r.failures.join(' | ')}`);
  return r;
};

const vaultOf = (id) => view(NETWORK, account, 'get_vault', { vault_id: String(id) });

// ---- Deploy ----

const code = readFileSync(join(here, '..', 'contracts', 'wasm', 'ripcord.wasm'));
const initialised = await view(NETWORK, account, 'get_config').then(
  () => true,
  () => false,
);
if (!initialised) {
  const deployed = await accountFor(NETWORK, account).deployContract(code);
  record('deployed the contract', { near_tx: deployed.transaction.hash, bytes: code.length });
  must(
    await call(NETWORK, account, account, 'new', {
      config: {
        mpc: MPC,
        btc_client: CLIENT,
        // Loans are not part of this run, so these two are never paid.
        usdc: 'usdc.fakes.testnet',
        endowment: account,
        btc_hrp: 'tb',
        confirmations: CONFIRMATIONS,
        vault_fee: '0',
        params: {
          min_collateral_sats: 5_000,
          grace_blocks: 2,
          start_window_blocks: 3,
          auction_seconds: 900,
          auction_blocks: 4,
          safety_blocks: 12,
          auction_start_bps: 30_000,
          flywheel_share_bps: 0,
          max_btc_fee_bps: 1_000,
          max_tip_age_seconds: 3_000,
        },
      },
    }),
    'initialised',
  );
}

// ---- A vault: the contract asks the MPC contract for this vault's key ----

const tip = await view(NETWORK, CLIENT, 'get_last_block_height');
const owner = newOwnerKey();
const escape = tip + 500;
const config = await view(NETWORK, account, 'get_config');
const opened = await call(
  NETWORK,
  account,
  account,
  'open_vault',
  { owner_pubkey: bytesToHex(owner.publicKey), escape_height: escape, expected_sats: String(SATS) },
  { deposit: BigInt(config.vault_fee) + BigInt(config.vault_storage) },
);
// This run has no endowment, so the contract's fee call to it fails. That call is separate
// by design: a failed fee must not undo a vault. What counts is the vault_opened event.
const event = opened.events.find((e) => e.event === 'vault_opened');
record('opened a vault', { near_tx: opened.hash, opened: Boolean(event), side_failures: opened.failures.length });
if (!event) throw new Error(`no vault_opened event: ${opened.failures.join(' | ')}`);
const { vault_id: id, address } = event.data[0];
const vault = await vaultOf(id);

// Rebuild the address here rather than trust the contract's word for it.
const script = hexToBytes(vault.witness_script);
const parsed = parseVaultScript(script);
const rebuilt = encodeSegwit('tb', 0, p2wshScriptPubkey(script).slice(2));
if (rebuilt !== address) throw new Error(`address mismatch: ${rebuilt} against ${address}`);
const expectedKey = await view(NETWORK, MPC, 'derived_public_key', {
  path: `ripcord-vault-${id}`,
  predecessor: account,
  domain_id: 0,
});
record('the contract built the vault from a key the MPC network derived', {
  vault: id,
  address,
  escape_height: parsed.escapeHeight,
  signer_key: bytesToHex(parsed.signerPub),
  mpc_says: expectedKey,
});

// ---- Bitcoin ----

const depositTx = await waitFor('confirmed coins to spend', async () => {
  const coins = await api.utxos(wallet.address);
  if (!coins.some((u) => u.status.confirmed && u.value >= SATS + 2_000)) return null;
  return pay(api, wallet, address, SATS);
});
record('paid the vault on Bitcoin', { sats: SATS, btc_tx: depositTx, explorer: link(depositTx) });

await waitFor('confirmations the light client can see', async () => {
  const tx = await api.tx(depositTx);
  if (!tx.status?.confirmed) return null;
  const height = await view(NETWORK, CLIENT, 'get_last_block_height');
  return height - tx.status.block_height + 1 >= CONFIRMATIONS;
});

const { raw_tx, proof } = await buildProof(api, depositTx);
const tx = await api.tx(depositTx);
const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === address);
must(await call(NETWORK, account, account, 'prove_deposit', { vault_id: String(id), raw_tx, vout, proof }), 'proved the deposit through the real light client');
const funded = await vaultOf(id);
if (funded.status !== 'funded') throw new Error(`vault is ${funded.status} after the proof`);
record('the contract accepted the deposit', { sats: funded.deposit.sats, txid: funded.deposit.txid });

// ---- The contract path: real MPC, real Bitcoin ----

const destination = bytesToHex(addressToScript('tb', wallet.address));
must(await call(NETWORK, account, account, 'release', { vault_id: String(id), destination }, { deposit: 1n }), 'released the vault');

const started = Date.now();
await call(NETWORK, account, account, 'request_signature', { vault_id: String(id), fee_sats: '700' }, { deposit: 1n }).then(
  (r) => record('asked the MPC network to sign', { near_tx: r.hash, ok: r.ok, failures: r.failures }),
  (e) => record('the signature request is still running', { note: e.message.slice(0, 200) }),
);
const signed = await waitFor(
  'the MPC signature',
  async () => {
    const v = await vaultOf(id);
    return v.signed_tx ? v : null;
  },
  8_000,
  900_000,
);
record('the contract stored a transaction signed by the MPC network', {
  seconds: Math.round((Date.now() - started) / 1000),
  signed_txid: signed.signed_txid,
  raw_tx: signed.signed_tx,
});

const accepted = await api.broadcast(signed.signed_tx);
record('Bitcoin accepted the contract-signed spend', { btc_tx: accepted, explorer: link(accepted) });

const final = await waitFor('the spend to confirm', async () => {
  const t = await api.tx(accepted);
  return t.status?.confirmed ? t : null;
});
record('confirmed on Bitcoin, through lock 1', {
  btc_tx: accepted,
  block: final.status.block_height,
  selector: final.vin[0].witness[1],
  paid_sats: final.vout[0].value,
});
