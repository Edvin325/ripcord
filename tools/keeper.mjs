#!/usr/bin/env node
// A keeper for Ripcord. It holds no special rights: everything here is an ordinary call
// that any account can make, which is why stopping it costs nobody their funds. Run one,
// run ten, or run none and use the app.
//
// What it does each round:
//   - proves confirmed deposits for vaults that are waiting
//   - starts auctions for loans past their grace period, which earns a NEAR bounty
//   - sends the coins to the lender when an auction ends with no bids
//   - broadcasts signed Bitcoin transactions that are not on chain yet
//   - tends the endowment: collects its interest, opens a sale, stakes what it can
//
//   node keeper.mjs <account> [--once]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, listAll, view } from './lib/near.mjs';
import { buildProof, esplora } from './lib/esplora.mjs';
import { keeperRound } from './lib/keeper-round.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(process.env.RIPCORD_DEPLOYMENT ?? join(here, 'deployment.json'), 'utf8'));

const [keeper, flag] = process.argv.slice(2);
if (!keeper) {
  console.error('usage: node keeper.mjs <account> [--once]');
  process.exit(2);
}

const say = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);
const env = { d, keeper, call, view, listAll, api: esplora(d.btcNetwork), buildProof, say };

await keeperRound(env);
if (flag !== '--once') {
  setInterval(() => keeperRound(env).catch((e) => say(e.message)), 60_000);
}
