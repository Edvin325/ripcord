#!/usr/bin/env node
// A real loan on real networks: NEAR testnet, the real MPC signers, the real Bitcoin light
// client, a real staking pool and real Bitcoin testnet3. Every step's transaction goes into
// evidence/, so anyone can look each one up. The steps themselves are in lib/e2e.mjs.
//
//   node e2e-testnet.mjs <borrower> <lender> <keeper> [sats]
//
// Set E2E_PARTS=2,3 to run only some parts, and E2E_APPEND=1 to add to the last evidence
// file instead of replacing it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, view } from './lib/near.mjs';
import { buildProof, esplora, EXPLORER } from './lib/esplora.mjs';
import { loadWallet, pay } from './lib/btc-wallet.mjs';
import { runE2E } from './lib/e2e.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(join(here, 'deployment.json'), 'utf8'));
const [borrower, lender, keeper, satsArg] = process.argv.slice(2);
if (!keeper) {
  console.error('usage: node e2e-testnet.mjs <borrower> <lender> <keeper> [sats]');
  process.exit(2);
}

const api = esplora(d.btcNetwork);
const wallet = loadWallet();
const dir = join(here, '..', 'evidence');
const file = join(dir, 'testnet-run.json');
const log = process.env.E2E_APPEND && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).steps : [];

function record(step, detail = {}) {
  log.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step} ${JSON.stringify(detail)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ deployment: d, steps: log }, null, 2)}\n`);
}

await runE2E(
  {
    d,
    call,
    view,
    api,
    buildProof,
    pay: (address, sats) => pay(api, wallet, address, sats),
    explorer: (txid) => `${EXPLORER[d.btcNetwork]}/tx/${txid}`,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    walletAddress: wallet.address,
    record,
  },
  {
    borrower,
    lender,
    keeper,
    sats: Number(satsArg ?? 12_000),
    parts: process.env.E2E_PARTS?.split(',') ?? ['1', '2', '3', '4'],
  },
);
