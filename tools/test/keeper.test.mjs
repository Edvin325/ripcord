// The keeper, on the compiled contracts. It has no special rights, so these tests also show
// that a stranger with no keys can move every stuck loan forward.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNTS as A, NEAR, USDC, addressOf, p2wpkhOf } from '../sim/world.mjs';
import { nodeWorld } from '../sim/node-world.mjs';
import { bytesToHex, hexToBytes, publicKeyOf } from '../lib/btc-core.mjs';
import { keeperRound } from '../lib/keeper-round.mjs';

const ownerPubkey = bytesToHex(publicKeyOf(new Uint8Array(32).fill(0x42)));
const LENDER_BTC = p2wpkhOf(0x1e);
const BIDDER_BTC = p2wpkhOf(0xbd);
const SATS = 100_000;

function world() {
  const w = nodeWorld();
  const said = [];
  const utxosOf = (address) =>
    [...w.bitcoin.utxos]
      .filter(([, o]) => addressOf(o.script) === address)
      .map(([key, o]) => {
        const [txid, vout] = key.split(':');
        const block = w.bitcoin.txs.get(txid).block;
        return { txid, vout: Number(vout), value: Number(o.value), status: { confirmed: Boolean(block), block_height: block?.height } };
      });

  const env = {
    d: { network: 'sim', ripcord: A.ripcord, usdc: A.usdc, endowment: A.endowment, btcClient: A.client },
    keeper: A.keeper,
    call: async (_n, signer, contract, method, args = {}, options) => {
      const r = w.near.call(signer, contract, method, args, options);
      return { ...r, ok: r.ok && r.failures.length === 0 };
    },
    view: async (_n, contract, method, args) => w.near.view(contract, method, args),
    listAll: async (_n, contract, method) => {
      const all = [];
      for (;;) {
        const page = w.near.view(contract, method, { from_index: all.length, limit: 100 });
        all.push(...page);
        if (page.length < 100) return all;
      }
    },
    api: {
      tip: async () => w.bitcoin.height,
      utxos: async (address) => utxosOf(address),
      tx: async (id) => {
        if (!w.bitcoin.txs.has(id)) throw new Error('not found');
        return w.bitcoin.txs.get(id);
      },
      broadcast: async (hex) => w.bitcoin.submit(hex),
    },
    buildProof: async (_api, txid) => w.bitcoin.proofFor(txid),
    say: (text) => said.push(text),
  };
  return { w, env, said };
}

const ftCall = (w, sender, amount, msg) =>
  w.near.call(sender, w.a.usdc, 'ft_transfer_call', { receiver_id: A.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n });

function offer(w, { apr = 900, term = 20, dollars = 1_000n, price = 40_000n } = {}) {
  const r = ftCall(w, A.lender, dollars * USDC, {
    offer: { micro_usdc_per_btc: (price * USDC).toString(), apr_bps: apr, term_blocks: term, btc_script: bytesToHex(LENDER_BTC) },
  });
  w.must(r, 'offer');
  return r.events.find((e) => e.event === 'offer_created').data[0].offer_id;
}

const vaultOf = (w, id) => w.near.view(A.ripcord, 'get_vault', { vault_id: String(id) });

function fundedVault(w, sats = SATS) {
  const r = w.near.call(
    A.borrower,
    A.ripcord,
    'open_vault',
    { owner_pubkey: ownerPubkey, escape_height: w.bitcoin.height + 2_000, expected_sats: String(sats) },
    { deposit: NEAR },
  );
  w.must(r, 'open');
  const coin = w.bitcoin.fund(hexToBytes(vaultOf(w, r.value).script_pubkey), sats);
  w.bitcoin.mine(3);
  return { id: r.value, coin };
}

const borrow = (w, id, offerId, principal) =>
  w.must(
    w.near.call(A.borrower, A.ripcord, 'borrow', { vault_id: String(id), offer_id: offerId, principal: principal.toString(), auction_open_per_btc: '0' }, { deposit: 1n }),
    'borrow',
  );

test('a keeper proves a deposit nobody else proved', async () => {
  const { w, env, said } = world();
  const { id } = fundedVault(w);
  assert.equal(vaultOf(w, id).status, 'awaiting_deposit');
  await keeperRound(env);
  assert.equal(vaultOf(w, id).status, 'funded');
  assert.ok(said.some((s) => /proved deposit ok/.test(s)));
});

test('a keeper leaves a deposit alone until it has its confirmations', async () => {
  const { w, env } = world();
  const r = w.near.call(
    A.borrower,
    A.ripcord,
    'open_vault',
    { owner_pubkey: ownerPubkey, escape_height: w.bitcoin.height + 2_000, expected_sats: String(SATS) },
    { deposit: NEAR },
  );
  w.must(r, 'open');
  w.bitcoin.fund(hexToBytes(vaultOf(w, r.value).script_pubkey), SATS);
  await keeperRound(env);
  assert.equal(vaultOf(w, r.value).status, 'awaiting_deposit');
});

test('a keeper starts the auction once grace ends, not a block before, and earns the bounty', async () => {
  const { w, env } = world();
  w.near.call(A.bidder, A.endowment, 'receive_fee', {}, { deposit: 2n * NEAR });
  const { id } = fundedVault(w);
  await keeperRound(env);
  borrow(w, id, offer(w), 30n * USDC);
  const graceEnd = vaultOf(w, id).loan.grace_end_height;

  w.bitcoin.mine(graceEnd - w.bitcoin.height);
  await keeperRound(env);
  assert.equal(vaultOf(w, id).status, 'borrowed', 'still protected');

  const before = w.near.balance(A.keeper);
  w.bitcoin.mine(1);
  await keeperRound(env);
  assert.equal(vaultOf(w, id).status, 'auction');
  assert.ok(w.near.balance(A.keeper) > before, 'the keeper was paid');
});

test('a keeper hands the coins to the lender when an auction ends with no bids', async () => {
  const { w, env } = world();
  const { id } = fundedVault(w);
  await keeperRound(env);
  borrow(w, id, offer(w), 30n * USDC);
  w.bitcoin.mine(vaultOf(w, id).loan.grace_end_height + 1 - w.bitcoin.height);
  await keeperRound(env);
  await keeperRound(env);
  assert.equal(vaultOf(w, id).status, 'auction', 'not while it is running');

  w.near.advance(3_600);
  await keeperRound(env);
  const v = vaultOf(w, id);
  assert.equal(v.status, 'settling');
  assert.equal(v.settle_reason, 'NoBids');
  assert.equal(v.destination, bytesToHex(LENDER_BTC));
});

test('a keeper broadcasts a signed spend, once', async () => {
  const { w, env, said } = world();
  const { id } = fundedVault(w);
  await keeperRound(env);
  borrow(w, id, offer(w), 30n * USDC);
  w.bitcoin.mine(vaultOf(w, id).loan.grace_end_height + 1 - w.bitcoin.height);
  await keeperRound(env);
  const price = BigInt(w.near.view(A.ripcord, 'auction_price', { vault_id: String(id) }));
  w.must(ftCall(w, A.bidder, price, { bid: { vault_id: String(id), btc_script: bytesToHex(BIDDER_BTC) } }), 'bid');
  w.must(w.near.call(A.bidder, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '500' }, { deposit: 1n }), 'sign');

  await keeperRound(env);
  w.bitcoin.mine(1);
  assert.equal(w.bitcoin.balanceOf(BIDDER_BTC), BigInt(SATS) - 500n, 'the winner has the coins, with no action of their own');

  const broadcasts = () => said.filter((s) => /broadcast/.test(s)).length;
  const once = broadcasts();
  await keeperRound(env);
  assert.equal(broadcasts(), once, 'a transaction already on chain is left alone');
});

test('a keeper turns the endowment\'s interest into a sale, and a sale into stake', async () => {
  const { w, env, said } = world();
  // Enough interest to clear the one-dollar minimum for a sale.
  const big = fundedVault(w, 5_000_000);
  await keeperRound(env);
  const offerId = offer(w, { dollars: 2_000n, apr: 90_000, term: 400 });
  borrow(w, big.id, offerId, 2_000n * USDC);
  w.must(ftCall(w, A.borrower, BigInt(vaultOf(w, big.id).loan.debt), { repay: { vault_id: String(big.id) } }), 'repay');

  await keeperRound(env);
  assert.ok(said.some((s) => /collected interest ok/.test(s)));
  assert.ok(said.some((s) => /opened a sale ok/.test(s)));
  assert.ok(w.near.view(A.endowment, 'current_rate'), 'the sale is running');

  // A second round must not open a second sale over the first.
  const sales = () => said.filter((s) => /opened a sale/.test(s)).length;
  const first = sales();
  await keeperRound(env);
  assert.equal(sales(), first);

  // Rewards or fees pile up, and the keeper stakes them.
  w.near.call(A.bidder, A.endowment, 'receive_fee', {}, { deposit: 10n * NEAR });
  await keeperRound(env);
  assert.ok(said.some((s) => /staked ok/.test(s)));
  assert.ok(BigInt(w.near.view(A.endowment, 'get_stats').principal_staked) > 0n);
});

test('one vault that errors does not stop the keeper reaching the others', async () => {
  const { w, env, said } = world();
  const bad = fundedVault(w);
  const good = fundedVault(w);
  const realUtxos = env.api.utxos;
  const badAddress = vaultOf(w, bad.id).address;
  env.api.utxos = async (address) => {
    if (address === badAddress) throw new Error('the API fell over');
    return realUtxos(address);
  };
  await keeperRound(env);
  assert.equal(vaultOf(w, good.id).status, 'funded');
  assert.ok(said.some((s) => /the API fell over/.test(s)));
});
