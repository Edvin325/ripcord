#!/usr/bin/env node
// A real loan on real networks: NEAR testnet, the real MPC signers, the real Bitcoin light
// client and real Bitcoin testnet3. Every step's transaction goes into evidence/, so
// anyone can look each one up.
//
// Part one runs the contract path: lock, prove, borrow, repay, get the coins signed back.
// Part two runs the ripcord: a short vault whose coins leave through the owner's path, on
// real Bitcoin, with no contract call at all.
//
//   node e2e-testnet.mjs <borrower> <lender> [sats]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, NEAR, view } from './lib/near.mjs';
import { buildProof, esplora, EXPLORER } from './lib/esplora.mjs';
import { loadWallet, pay } from './lib/btc-wallet.mjs';
import { addressToScript, buildSpend, bytesToHex, hexToBytes, newOwnerKey, parseVaultScript, signOwnerPath, txid as txidOf } from './lib/btc-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(join(here, 'deployment.json'), 'utf8'));
const [borrower, lender, satsArg] = process.argv.slice(2);
if (!lender) {
  console.error('usage: node e2e-testnet.mjs <borrower> <lender> [sats]');
  process.exit(2);
}

const SATS = Number(satsArg ?? 12_000);
const USDC = 1_000_000n;
const api = esplora(d.btcNetwork);
const wallet = loadWallet();
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(step, detail = {}) {
  log.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step} ${JSON.stringify(detail)}`);
  const dir = join(here, '..', 'evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'testnet-run.json'), `${JSON.stringify({ deployment: d, steps: log }, null, 2)}\n`);
}

const must = (r, step) => {
  record(step, { near_tx: r.hash, ok: r.ok });
  if (!r.ok) throw new Error(`${step}: ${r.failures.join(' | ')}`);
  return r;
};

const vault = (id) => view(d.network, d.ripcord, 'get_vault', { vault_id: String(id) });
const config = () => view(d.network, d.ripcord, 'get_config');

async function waitFor(label, check, { everyMs = 30_000, limitMs = 3_600_000 } = {}) {
  const until = Date.now() + limitMs;
  for (;;) {
    const value = await check().catch((e) => {
      console.log(`  (${label}: ${e.message.slice(0, 120)})`);
      return null;
    });
    if (value) return value;
    if (Date.now() > until) throw new Error(`gave up waiting for ${label}`);
    console.log(`  waiting for ${label}`);
    await sleep(everyMs);
  }
}

async function openVault(blocks) {
  const c = await config();
  const tip = await view(d.network, d.btcClient, 'get_last_block_height');
  const key = newOwnerKey();
  const escape = tip + blocks;
  const r = must(
    await call(
      d.network,
      borrower,
      d.ripcord,
      'open_vault',
      { owner_pubkey: bytesToHex(key.publicKey), escape_height: escape, expected_sats: String(SATS) },
      { deposit: BigInt(c.vault_fee) + BigInt(c.vault_storage) },
    ),
    'open vault',
  );
  const { vault_id: id, address } = r.events.find((e) => e.event === 'vault_opened').data[0];
  const v = await vault(id);

  // Before sending a coin, confirm what the address enforces.
  const parsed = parseVaultScript(hexToBytes(v.witness_script));
  if (bytesToHex(parsed.ownerPub) !== bytesToHex(key.publicKey) || parsed.escapeHeight !== escape) {
    throw new Error('the script does not match what was asked for');
  }
  record('checked the script', { vault: id, address, escape_height: escape, signer_key: bytesToHex(parsed.signerPub) });
  return { id, address, key, escape };
}

async function fundAndProve({ id, address }) {
  const txid = await pay(api, wallet, address, SATS);
  record('paid the vault on Bitcoin', { btc_tx: txid, explorer: `${EXPLORER[d.btcNetwork]}/tx/${txid}` });

  const c = await config();
  await waitFor('Bitcoin confirmations seen by the light client', async () => {
    const tx = await api.tx(txid);
    if (!tx.status?.confirmed) return false;
    const client = await view(d.network, d.btcClient, 'get_last_block_height');
    return client - tx.status.block_height + 1 >= c.confirmations;
  });

  const { raw_tx, proof } = await buildProof(api, txid);
  const tx = await api.tx(txid);
  const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === address);
  must(await call(d.network, borrower, d.ripcord, 'prove_deposit', { vault_id: String(id), raw_tx, vout, proof }), 'proved the deposit');
  const v = await vault(id);
  if (v.status !== 'funded') throw new Error(`vault is ${v.status} after the proof`);
  return txid;
}

/** Registers both accounts with the test token and hands them test dollars. */
async function setup() {
  for (const account of [borrower, lender]) {
    const registered = await view(d.network, d.usdc, 'storage_balance_of', { account_id: account });
    if (!registered) {
      must(await call(d.network, account, d.usdc, 'storage_deposit', {}, { deposit: NEAR / 100n }), `registered ${account}`);
    }
    must(await call(d.network, account, d.usdc, 'faucet', { amount: (200n * USDC).toString() }), `test dollars for ${account}`);
  }
}

async function contractPath() {
  record('PART ONE: the contract path');
  const offer = must(
    await call(
      d.network,
      lender,
      d.usdc,
      'ft_transfer_call',
      {
        receiver_id: d.ripcord,
        amount: (100n * USDC).toString(),
        msg: JSON.stringify({
          offer: {
            micro_usdc_per_btc: (40_000n * USDC).toString(),
            apr_bps: 900,
            term_blocks: 3,
            btc_script: bytesToHex(addressToScript('tb', wallet.address)),
          },
        }),
      },
      { deposit: 1n },
    ),
    'lender made an offer',
  );
  const offerId = offer.events.find((e) => e.event === 'offer_created').data[0].offer_id;

  // Testnet3 makes blocks in bursts, so leave room: the loan needs 13 blocks to fit.
  const opened = await openVault(120);
  await fundAndProve(opened);

  const principal = (BigInt(SATS) * 40_000n * USDC) / 100_000_000n / 2n;
  must(
    await call(d.network, borrower, d.ripcord, 'borrow', { vault_id: String(opened.id), offer_id: offerId, principal: principal.toString() }, { deposit: 1n }),
    'borrowed',
  );
  const loan = (await vault(opened.id)).loan;
  record('loan open', { principal: loan.principal, debt: loan.debt, due_height: loan.due_height });

  must(await call(d.network, borrower, d.ripcord, 'withdraw', {}, { deposit: 1n }), 'borrower withdrew the dollars');
  must(
    await call(
      d.network,
      borrower,
      d.usdc,
      'ft_transfer_call',
      { receiver_id: d.ripcord, amount: loan.debt, msg: JSON.stringify({ repay: { vault_id: String(opened.id) } }) },
      { deposit: 1n },
    ),
    'repaid',
  );
  must(
    await call(
      d.network,
      borrower,
      d.ripcord,
      'release',
      { vault_id: String(opened.id), destination: bytesToHex(addressToScript('tb', wallet.address)) },
      { deposit: 1n },
    ),
    'released the coins',
  );

  // The signers can take a while, and the RPC call may time out while they work. What
  // counts is the signed transaction showing up in the contract, so that is what we watch.
  await call(d.network, borrower, d.ripcord, 'request_signature', { vault_id: String(opened.id), fee_sats: '600' }).then(
    (r) => record('requested an MPC signature', { near_tx: r.hash, ok: r.ok, failures: r.failures }),
    (e) => record('signature request is still running', { note: e.message.slice(0, 160) }),
  );
  const signed = await waitFor(
    'the MPC signature',
    async () => {
      const v = await vault(opened.id);
      return v.signed_tx ? v : null;
    },
    { everyMs: 10_000, limitMs: 600_000 },
  );
  record('the contract stored a transaction signed by the MPC network', { signed_txid: signed.signed_txid });

  const txid = await api.broadcast(signed.signed_tx);
  record('Bitcoin accepted the contract-signed spend', { btc_tx: txid, explorer: `${EXPLORER[d.btcNetwork]}/tx/${txid}` });
}

async function ripcordPath() {
  record('PART TWO: the ripcord, on real Bitcoin');
  const opened = await openVault(5);
  await fundAndProve(opened);
  const v = await vault(opened.id);

  const tx = buildSpend({
    txid: v.deposit.txid,
    vout: v.deposit.vout,
    value: Number(v.deposit.sats),
    destination: addressToScript('tb', wallet.address),
    feeSats: 600,
    lockTime: v.escape_height,
  });
  const ticket = bytesToHex(signOwnerPath(tx, hexToBytes(v.witness_script), Number(v.deposit.sats), opened.key.secret));
  record('signed the escape ticket', { txid: txidOf(tx), valid_after_block: v.escape_height });

  const tip = await api.tip();
  if (tip < v.escape_height) {
    const early = await api.broadcast(ticket).then(
      (id) => ({ accepted: id }),
      (e) => ({ refused: e.message }),
    );
    record('tried the ticket early', { tip, ...early });
    if (early.accepted) throw new Error('Bitcoin accepted the ticket early');
  }

  const accepted = await waitFor(
    'the escape height',
    async () => {
      if ((await api.tip()) < v.escape_height) return false;
      return api.broadcast(ticket);
    },
    { everyMs: 30_000, limitMs: 7_200_000 },
  );
  record('Bitcoin accepted the escape ticket, with no contract call', {
    btc_tx: accepted,
    explorer: `${EXPLORER[d.btcNetwork]}/tx/${accepted}`,
  });
}

record('start', { wallet: wallet.address });
if (!existsSync(join(here, '..', 'wallets', 'btc-testnet.json'))) throw new Error('no test wallet');
await setup();
await contractPath();
await ripcordPath();
record('done');
