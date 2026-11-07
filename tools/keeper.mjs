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
import { call, listAll, NEAR, view } from './lib/near.mjs';
import { buildProof, esplora } from './lib/esplora.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(process.env.RIPCORD_DEPLOYMENT ?? join(here, 'deployment.json'), 'utf8'));

const [keeper, flag] = process.argv.slice(2);
if (!keeper) {
  console.error('usage: node keeper.mjs <account> [--once]');
  process.exit(2);
}

const api = esplora(d.btcNetwork);
const say = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

async function tryProve(v, config) {
  const coin = (await api.utxos(v.address)).find((u) => BigInt(u.value) >= BigInt(v.expected_sats));
  if (!coin?.status?.confirmed) return;
  const tip = await api.tip();
  if (tip - coin.status.block_height + 1 < config.confirmations) return;
  const { raw_tx, proof } = await buildProof(api, coin.txid);
  const r = await call(d.network, keeper, d.ripcord, 'prove_deposit', { vault_id: v.id, raw_tx, vout: coin.vout, proof });
  say(`vault ${v.id}: proved deposit ${r.ok ? 'ok' : 'refused'}`);
}

async function tryBroadcast(v) {
  const seen = await api.tx(v.signed_txid).then(
    () => true,
    () => false,
  );
  if (seen) return;
  const id = await api.broadcast(v.signed_tx).catch((e) => `refused: ${e.message}`);
  say(`vault ${v.id}: broadcast ${id}`);
}

/** The endowment's upkeep. These calls earn no bounty, and each one is open to anyone. */
async function upkeep() {
  const dollar = 1_000_000n; // the smallest sale the endowment will open
  const [e, owed, held, rate] = await Promise.all([
    view(d.network, d.endowment, 'get_stats'),
    view(d.network, d.ripcord, 'get_balance', { account_id: d.endowment }),
    view(d.network, d.usdc, 'ft_balance_of', { account_id: d.endowment }),
    view(d.network, d.endowment, 'current_rate'),
  ]);
  const step = async (label, method) => {
    const r = await call(d.network, keeper, d.endowment, method);
    say(`endowment: ${label} ${r.ok ? 'ok' : 'refused'}`);
  };
  if (BigInt(owed) >= dollar) await step('collected interest', 'collect_usdc');
  if (BigInt(held) >= dollar && rate === null) await step('opened a sale', 'start_sale');
  if (BigInt(e.liquid_balance) > BigInt(e.keeper_float) + 5n * NEAR) await step('staked', 'stake');
}

async function round() {
  const [vaults, config, tip] = await Promise.all([
    listAll(d.network, d.ripcord, 'list_vaults'),
    view(d.network, d.ripcord, 'get_config'),
    view(d.network, d.btcClient, 'get_last_block_height'),
  ]);
  for (const v of vaults) {
    try {
      if (v.status === 'awaiting_deposit') {
        await tryProve(v, config);
      } else if (v.status === 'borrowed' && tip > v.loan.grace_end_height) {
        const r = await call(d.network, keeper, d.ripcord, 'start_auction', { vault_id: v.id });
        say(`vault ${v.id}: started auction ${r.ok ? 'ok' : 'refused'}`);
      } else if (v.status === 'auction') {
        const price = await view(d.network, d.ripcord, 'auction_price', { vault_id: v.id });
        if (price === null) {
          const r = await call(d.network, keeper, d.ripcord, 'claim_collateral', { vault_id: v.id });
          say(`vault ${v.id}: no bids, coins go to the lender ${r.ok ? 'ok' : 'refused'}`);
        }
      } else if (v.status === 'settling' && v.signed_tx) {
        await tryBroadcast(v);
      }
    } catch (e) {
      say(`vault ${v.id}: ${e.message.slice(0, 160)}`);
    }
  }
  await upkeep().catch((e) => say(`endowment: ${e.message.slice(0, 160)}`));
}

await round();
if (flag !== '--once') {
  setInterval(() => round().catch((e) => say(e.message)), 60_000);
}
