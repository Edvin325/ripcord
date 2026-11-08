// NEAR Intents, end to end on the compiled contracts. Intents has no testnet, so the 1Click
// service is simulated, but the request code is the real one: `simFetch` answers the same
// routes, and the contract really pays the deposit address.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACCOUNTS as A, NEAR, USDC } from '../sim/world.mjs';
import { nodeWorld } from '../sim/node-world.mjs';
import { simFetch, simIntents } from '../sim/intents.mjs';
import { bytesToHex, hexToBytes, publicKeyOf } from '../lib/btc-core.mjs';
import {
  deliveryQuote,
  describeTransfer,
  inboundQuote,
  looksLikeAddress,
  resolveRoutes,
  status,
  TERMINAL,
  USDC_NEAR,
  USDC_ROUTES,
} from '../lib/oneclick.mjs';

const TOKENS = JSON.parse(readFileSync(new URL('./fixtures/oneclick-usdc-tokens.json', import.meta.url), 'utf8')).tokens;
const BASE = USDC_ROUTES.find((r) => r.id === 'base');
const BASE_WALLET = '0x2f3b1a3e7c1d9a8b6c5d4e3f2a1b0c9d8e7f6a5b';
const ownerPubkey = bytesToHex(publicKeyOf(new Uint8Array(32).fill(0x42)));

// ---- The 1Click layer, against the real token list ----

test('every route uses the asset id 1Click itself lists, as the near-intents skill requires', () => {
  for (const route of resolveRoutes(TOKENS)) {
    assert.ok(route.listed, `${route.label} is listed`);
    assert.equal(route.asset, USDC_ROUTES.find((r) => r.id === route.id).asset, `${route.label} fallback id is current`);
    assert.equal(route.decimals, 6);
  }
  assert.equal(TOKENS.find((t) => t.blockchain === 'near').assetId, USDC_NEAR, 'the USDC we lend is the one 1Click knows');
});

test('a route 1Click stops listing is marked, not guessed', () => {
  const routes = resolveRoutes(TOKENS.filter((t) => t.blockchain !== 'sol'));
  assert.equal(routes.find((r) => r.id === 'sol').listed, false);
});

test('addresses are checked against the chain they are for', () => {
  assert.ok(looksLikeAddress(BASE, BASE_WALLET));
  assert.ok(!looksLikeAddress(BASE, 'alice.near'));
  assert.ok(!looksLikeAddress(BASE, `${BASE_WALLET}00`));
  const sol = USDC_ROUTES.find((r) => r.id === 'sol');
  assert.ok(looksLikeAddress(sol, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'));
  assert.ok(!looksLikeAddress(sol, BASE_WALLET));
});

test('every status reads as plain words, and says where the money is', () => {
  const statuses = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'];
  for (const direction of ['out', 'in']) {
    for (const code of statuses) {
      const d = describeTransfer({ status: code, swapDetails: {} }, { direction, chain: 'Base', recipient: 'r', refundTo: 'f' });
      assert.equal(d.code, code);
      assert.equal(d.terminal, TERMINAL.has(code), code);
      assert.ok(d.title.length > 4 && d.where.length > 4, `${direction} ${code}`);
      assert.ok(!/undefined|null/.test(`${d.title} ${d.where}`), `${direction} ${code} has no missing words`);
    }
  }
  const done = describeTransfer(
    {
      status: 'SUCCESS',
      swapDetails: {
        amountOut: '29925000',
        destinationChainTxHashes: [{ hash: '0xabc123def4567890abc123', explorerUrl: 'https://basescan.org/tx/0xabc123def4567890abc123' }],
      },
    },
    { direction: 'out', chain: 'Base', recipient: BASE_WALLET, refundTo: 'borrower.near' },
  );
  assert.match(done.where, /on Base: 29\.92 USDC/);
  assert.equal(done.links[0].url, 'https://basescan.org/tx/0xabc123def4567890abc123');
  const back = describeTransfer(
    { status: 'REFUNDED', swapDetails: { refundedAmount: '30000000', refundReason: 'Quote expired' } },
    { direction: 'out', chain: 'Base', recipient: BASE_WALLET, refundTo: 'borrower.near' },
  );
  assert.match(back.where, /borrower\.near on NEAR: 30\.00 USDC\. Reason: Quote expired/);
  assert.equal(back.tone, 'bad');
});

// ---- On the compiled contracts ----

const ftCall = (w, sender, amount, msg) =>
  w.near.call(sender, w.a.usdc, 'ft_transfer_call', { receiver_id: A.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n });
const vaultOf = (w, id) => w.near.view(A.ripcord, 'get_vault', { vault_id: String(id) });
const usdcOf = (w, id) => BigInt(w.near.view(w.a.usdc, 'ft_balance_of', { account_id: id }) ?? '0');
const inside = (w, id) => BigInt(w.near.view(A.ripcord, 'get_balance', { account_id: id }));

function setup({ outcome = 'deliver' } = {}) {
  const w = nodeWorld();
  const sim = simIntents(w);
  sim.state.outcome = outcome;
  const offer = ftCall(w, A.lender, 1_000n * USDC, {
    offer: { micro_usdc_per_btc: (40_000n * USDC).toString(), apr_bps: 900, term_blocks: 20, btc_script: `0014${'1e'.repeat(20)}` },
  });
  w.must(offer, 'offer');
  const offerId = offer.events.find((e) => e.event === 'offer_created').data[0].offer_id;
  const opened = w.near.call(
    A.borrower,
    A.ripcord,
    'open_vault',
    { owner_pubkey: ownerPubkey, escape_height: w.bitcoin.height + 500, expected_sats: '100000' },
    { deposit: NEAR },
  );
  w.must(opened, 'open');
  const coin = w.bitcoin.fund(hexToBytes(vaultOf(w, opened.value).script_pubkey), 100_000);
  w.bitcoin.mine(3);
  const { raw_tx, proof } = w.bitcoin.proofFor(coin.txid);
  w.must(w.near.call(A.keeper, A.ripcord, 'prove_deposit', { vault_id: String(opened.value), raw_tx, vout: coin.vout, proof }), 'prove');
  return { w, sim, fetchImpl: simFetch(sim), vault: opened.value, offerId };
}

const borrowInto = (w, vault, offerId, payoutTo) =>
  w.near.call(
    A.borrower,
    A.ripcord,
    'borrow',
    { vault_id: String(vault), offer_id: offerId, principal: (30n * USDC).toString(), auction_open_per_btc: '0', payout_to: payoutTo },
    { deposit: 1n },
  );

async function follow(depositAddress, fetchImpl) {
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const s = await status(depositAddress, { fetchImpl });
    seen.push(s.status);
    if (TERMINAL.has(s.status)) return { seen, last: s };
  }
  return { seen, last: null };
}

/** What the app does: a committed quote, the deposit address registered, the loan paid in. */
async function deliverLoan(ctx, { register = true } = {}) {
  const { w, fetchImpl, vault, offerId } = ctx;
  const q = await deliveryQuote({ route: BASE, microUsdc: 30n * USDC, recipient: BASE_WALLET, refundTo: A.borrower }, { fetchImpl });
  const depositAddress = q.quote.depositAddress;
  assert.match(depositAddress, /^[0-9a-f]{64}$/, 'a NEAR deposit address is an implicit account');
  if (register) {
    w.must(w.near.call(A.borrower, w.a.usdc, 'storage_deposit', { account_id: depositAddress, registration_only: true }, { deposit: NEAR / 100n }), 'register');
  }
  w.must(borrowInto(w, vault, offerId, depositAddress), 'borrow');
  return { q, depositAddress };
}

test('a loan sent to another chain moves through every status to delivery', async () => {
  const ctx = setup();
  const { q, depositAddress } = await deliverLoan(ctx);
  assert.equal(q.quoteRequest.dry, false);
  assert.equal(q.quoteRequest.originAsset, USDC_NEAR);
  assert.equal(q.quoteRequest.refundTo, A.borrower, 'a refund comes back to the borrower on NEAR');
  assert.equal(usdcOf(ctx.w, depositAddress), 30n * USDC, 'the contract paid the deposit address directly');
  const { seen, last } = await follow(depositAddress, ctx.fetchImpl);
  assert.deepEqual(seen, ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS']);
  assert.ok(BigInt(last.swapDetails.amountOut) > 29n * USDC);
  assert.equal(usdcOf(ctx.w, depositAddress), 0n, 'the dollars left NEAR');
  assert.equal(inside(ctx.w, A.borrower), 0n, 'nothing was left behind in the contract');
});

test('a refunded delivery puts the dollars back in the borrower\'s own NEAR account', async () => {
  const ctx = setup({ outcome: 'refund' });
  const before = usdcOf(ctx.w, A.borrower);
  const { depositAddress } = await deliverLoan(ctx);
  const { seen, last } = await follow(depositAddress, ctx.fetchImpl);
  assert.equal(seen.at(-1), 'REFUNDED');
  assert.equal(usdcOf(ctx.w, A.borrower), before + 30n * USDC);
  const words = describeTransfer(last, { direction: 'out', chain: 'Base', recipient: BASE_WALLET, refundTo: A.borrower });
  assert.match(words.where, /borrower\.test on NEAR: 30\.00 USDC/);
});

test('a failed delivery is reported, and the deposit address still holds the money', async () => {
  const ctx = setup({ outcome: 'fail' });
  const { depositAddress } = await deliverLoan(ctx);
  const { seen } = await follow(depositAddress, ctx.fetchImpl);
  assert.equal(seen.at(-1), 'FAILED');
  assert.equal(usdcOf(ctx.w, depositAddress), 30n * USDC);
});

test('if the deposit address cannot take tokens, the dollars stay safe in the contract', async () => {
  const ctx = setup();
  const { depositAddress } = await deliverLoan(ctx, { register: false });
  assert.equal(usdcOf(ctx.w, depositAddress), 0n);
  assert.equal(inside(ctx.w, A.borrower), 30n * USDC, 'the borrower can withdraw it');
  const s = await status(depositAddress, { fetchImpl: ctx.fetchImpl });
  assert.equal(s.status, 'PENDING_DEPOSIT', 'and NEAR Intents saw nothing arrive');
});

test('dollars from another chain arrive in the borrower\'s account, ready to repay', async () => {
  const ctx = setup();
  const { w, fetchImpl, vault, offerId } = ctx;
  w.must(borrowInto(w, vault, offerId, A.borrower), 'borrow');
  const debt = BigInt(vaultOf(w, vault).loan.debt);
  const before = usdcOf(w, A.borrower);
  const q = await inboundQuote({ route: BASE, microUsdc: debt, recipient: A.borrower, refundTo: BASE_WALLET }, { fetchImpl });
  assert.equal(q.quoteRequest.swapType, 'EXACT_OUTPUT', 'exactly the debt arrives');
  ctx.sim.payFromOtherChain(q.quote.depositAddress);
  const { seen } = await follow(q.quote.depositAddress, fetchImpl);
  assert.deepEqual(seen, ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS']);
  assert.equal(usdcOf(w, A.borrower), before + debt);
  w.must(ftCall(w, A.borrower, debt, { repay: { vault_id: String(vault) } }), 'repay');
  assert.equal(vaultOf(w, vault).status, 'funded');
});

test('nothing moves until the user really pays from the other chain', async () => {
  const ctx = setup();
  const q = await inboundQuote({ route: BASE, microUsdc: 10n * USDC, recipient: A.borrower, refundTo: BASE_WALLET }, { fetchImpl: ctx.fetchImpl });
  for (let i = 0; i < 3; i++) {
    assert.equal((await status(q.quote.depositAddress, { fetchImpl: ctx.fetchImpl })).status, 'PENDING_DEPOSIT');
  }
});
