// The whole protocol, on the real compiled contracts, in a simulated world. Bitcoin here
// enforces the vault's signature and timelock rules, so a passing test means a real spend
// was accepted, not that a flag was set.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNTS as A, INITIAL_RATE, NEAR, USDC, p2wpkhOf } from '../sim/world.mjs';
import { nodeWorld as createWorld } from '../sim/node-world.mjs';
import {
  buildSpend,
  bytesToHex,
  hexToBytes,
  parseVaultScript,
  publicKeyOf,
  signOwnerPath,
  txid as txidOf,
} from '../lib/btc-core.mjs';

const ownerSecret = new Uint8Array(32).fill(0x42);
const ownerPubkey = bytesToHex(publicKeyOf(ownerSecret));
const BORROWER_BTC = p2wpkhOf(0xb0);
const LENDER_BTC = p2wpkhOf(0x1e);
const BIDDER_BTC = p2wpkhOf(0xbd);

const HEAD_START = 500;
const COLLATERAL = 100_000; // sats, at $40,000 per BTC: worth $40 of borrowing power
const PRICE = 40_000n * USDC;

const ftCall = (w, sender, amount, msg) =>
  w.near.call(
    sender,
    w.a.usdc,
    'ft_transfer_call',
    { receiver_id: A.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) },
    { deposit: 1n },
  );

function makeOffer(w, { amount = 1_000n * USDC, term = 20, apr = 900, price = PRICE } = {}) {
  const r = ftCall(w, A.lender, amount, {
    offer: {
      micro_usdc_per_btc: price.toString(),
      apr_bps: apr,
      term_blocks: term,
      btc_script: bytesToHex(LENDER_BTC),
    },
  });
  w.must(r, 'make offer');
  return r.events.find((e) => e.event === 'offer_created').data[0].offer_id;
}

function openVault(w, { escape, expected = COLLATERAL } = {}) {
  const escape_height = escape ?? w.bitcoin.height + HEAD_START;
  const r = w.near.call(
    A.borrower,
    A.ripcord,
    'open_vault',
    { owner_pubkey: ownerPubkey, escape_height, expected_sats: String(expected) },
    { deposit: NEAR },
  );
  w.must(r, 'open vault');
  return r.value;
}

const vaultOf = (w, id) => w.near.view(A.ripcord, 'get_vault', { vault_id: String(id) });
const usdcOf = (w, id) => BigInt(w.near.view(w.a.usdc, 'ft_balance_of', { account_id: id }));
const inside = (w, id) => BigInt(w.near.view(A.ripcord, 'get_balance', { account_id: id }));

function deposit(w, id, sats = COLLATERAL) {
  const v = vaultOf(w, id);
  const coin = w.bitcoin.fund(hexToBytes(v.script_pubkey), sats);
  w.bitcoin.mine(3);
  return coin;
}

function prove(w, id, coin, caller = A.keeper) {
  const { raw_tx, proof } = w.bitcoin.proofFor(coin.txid);
  return w.near.call(caller, A.ripcord, 'prove_deposit', {
    vault_id: String(id),
    raw_tx,
    vout: coin.vout,
    proof,
  });
}

function fundedVault(w, opts) {
  const id = openVault(w, opts);
  w.must(prove(w, id, deposit(w, id)), 'prove');
  return id;
}

const borrow = (w, id, offer, principal, extra = {}) =>
  w.near.call(
    A.borrower,
    A.ripcord,
    'borrow',
    { vault_id: String(id), offer_id: offer, principal: principal.toString(), ...extra },
    { deposit: 1n },
  );

function activeLoan(w, { principal = 30n * USDC, ...opts } = {}) {
  const offer = makeOffer(w);
  const id = fundedVault(w, opts);
  w.must(borrow(w, id, offer, principal), 'borrow');
  return { id, offer, principal };
}

const repay = (w, id, amount, sender = A.borrower) => ftCall(w, sender, amount, { repay: { vault_id: String(id) } });

function pastGrace(w, id) {
  const v = vaultOf(w, id);
  const need = v.loan.grace_end_height + 1 - w.bitcoin.height;
  if (need > 0) w.bitcoin.mine(need);
}

/** Signs the settling spend and puts it on Bitcoin. Returns the txid. */
function settle(w, id, beneficiary, fee = 500) {
  w.must(
    w.near.call(beneficiary, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: String(fee) }),
    'request signature',
  );
  const v = vaultOf(w, id);
  assert.ok(v.signed_tx, 'contract stored the signed transaction');
  const accepted = w.bitcoin.submit(v.signed_tx);
  assert.equal(accepted, v.signed_txid);
  return accepted;
}

// ---- The main path ----

test('a full loan: lend, lock, prove, borrow, repay, get the Bitcoin back', () => {
  const w = createWorld();
  const offer = makeOffer(w);

  const id = openVault(w);
  const opened = vaultOf(w, id);
  assert.equal(opened.status, 'awaiting_deposit');
  assert.ok(opened.address.startsWith('tb1q'));

  // The script read back from the contract is the exact template, and names the right
  // keys. A borrower can check this before sending a coin.
  const parsed = parseVaultScript(hexToBytes(opened.witness_script));
  assert.equal(bytesToHex(parsed.ownerPub), ownerPubkey);
  assert.equal(parsed.escapeHeight, opened.escape_height);

  const coin = deposit(w, id);
  w.must(prove(w, id, coin), 'prove deposit');
  const funded = vaultOf(w, id);
  assert.equal(funded.status, 'funded');
  assert.equal(funded.deposit.sats, String(COLLATERAL));
  assert.equal(funded.deposit.txid, coin.txid);

  const before = usdcOf(w, A.borrower);
  w.must(borrow(w, id, offer, 30n * USDC, { payout_to: A.borrower }), 'borrow');
  assert.equal(usdcOf(w, A.borrower), before + 30n * USDC, 'dollars arrived');
  const loan = vaultOf(w, id).loan;
  assert.equal(vaultOf(w, id).status, 'borrowed');

  w.must(repay(w, id, BigInt(loan.debt)), 'repay');
  assert.equal(vaultOf(w, id).status, 'funded');
  assert.equal(usdcOf(w, A.borrower), before - (BigInt(loan.debt) - 30n * USDC), 'paid principal and interest');

  // Lender earns principal and interest, less the flywheel's share of the interest.
  const interest = BigInt(loan.interest);
  const share = (interest * 1_000n) / 10_000n;
  assert.equal(inside(w, A.lender), BigInt(loan.debt) - share);
  assert.equal(inside(w, A.endowment), share);

  w.must(
    w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }),
    'release',
  );
  settle(w, id, A.borrower, 500);
  w.bitcoin.mine(1);
  assert.equal(w.bitcoin.balanceOf(BORROWER_BTC), BigInt(COLLATERAL) - 500n, 'the Bitcoin came back');

  const stats = w.near.view(A.ripcord, 'get_stats');
  assert.equal(stats.loans_repaid, 1);
  assert.equal(stats.sats_locked, 0);
});

test('a lender can pull their money out after repayment', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const debt = BigInt(vaultOf(w, id).loan.debt);
  w.must(repay(w, id, debt), 'repay');
  const owed = inside(w, A.lender);
  const before = usdcOf(w, A.lender);
  w.must(w.near.call(A.lender, A.ripcord, 'withdraw', {}, { deposit: 1n }), 'withdraw');
  assert.equal(usdcOf(w, A.lender), before + owed);
  assert.equal(inside(w, A.lender), 0n);
});

test('overpaying refunds the difference, and anyone may repay', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const debt = BigInt(vaultOf(w, id).loan.debt);
  const before = usdcOf(w, A.bidder);
  w.must(repay(w, id, debt + 5n * USDC, A.bidder), 'repay by a third party');
  assert.equal(usdcOf(w, A.bidder), before - debt, 'only the debt was taken');
  assert.equal(vaultOf(w, id).status, 'funded');
});

test('a repaid vault can borrow again, and a second loan keeps its own terms', () => {
  const w = createWorld();
  const { id, offer } = activeLoan(w);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(borrow(w, id, offer, 10n * USDC), 'borrow again');
  assert.equal(vaultOf(w, id).loan.principal, (10n * USDC).toString());
  assert.equal(w.near.view(A.ripcord, 'get_stats').loans_opened, 2);
});

// ---- Proofs ----

test('a proof for the wrong amount of confirmations is refused', () => {
  const w = createWorld();
  const id = openVault(w);
  const v = vaultOf(w, id);
  const coin = w.bitcoin.fund(hexToBytes(v.script_pubkey), COLLATERAL);
  w.bitcoin.mine(1); // only one confirmation, two are needed
  const r = prove(w, id, coin);
  assert.equal(r.ok, false);
  assert.equal(vaultOf(w, id).status, 'awaiting_deposit');
});

test('a deposit to some other script is refused', () => {
  const w = createWorld();
  const id = openVault(w);
  const coin = w.bitcoin.fund(p2wpkhOf(0x99), COLLATERAL);
  w.bitcoin.mine(3);
  const r = prove(w, id, coin);
  assert.equal(r.ok, false);
  assert.match(r.error, /does not pay this vault/);
});

test('a forged amount cannot get past the proof', () => {
  // Claiming a bigger output means changing the transaction, which changes its txid, and
  // that txid is not in the block.
  const w = createWorld();
  const id = openVault(w);
  const coin = deposit(w, id);
  const { raw_tx, proof } = w.bitcoin.proofFor(coin.txid);
  const forged = raw_tx.replace(
    Buffer.from(new BigUint64Array([BigInt(COLLATERAL)]).buffer).toString('hex'),
    Buffer.from(new BigUint64Array([BigInt(COLLATERAL) * 1000n]).buffer).toString('hex'),
  );
  assert.notEqual(forged, raw_tx);
  const r = w.near.call(A.keeper, A.ripcord, 'prove_deposit', { vault_id: String(id), raw_tx: forged, vout: 0, proof });
  assert.equal(r.ok, false);
  assert.equal(vaultOf(w, id).status, 'awaiting_deposit');
});

test('a stranger cannot block a vault by proving a tiny deposit first', () => {
  // Proofs are open to anyone. If a dust deposit could count, an attacker could spend a
  // few sats to strand the owner's real deposit until the escape height.
  const w = createWorld();
  const id = openVault(w, { expected: 1_000_000 });
  const dust = deposit(w, id, 10_000);
  const griefed = prove(w, id, dust, A.bidder);
  assert.equal(griefed.ok, false);
  assert.match(griefed.error, /below what this vault expects/);
  assert.equal(vaultOf(w, id).status, 'awaiting_deposit', 'the vault is still open');

  const real = deposit(w, id, 1_000_000);
  w.must(prove(w, id, real), 'the real deposit still works');
  assert.equal(vaultOf(w, id).deposit.sats, '1000000');
});

test('a vault cannot expect less than the protocol minimum', () => {
  const w = createWorld();
  const r = w.near.call(
    A.borrower,
    A.ripcord,
    'open_vault',
    { owner_pubkey: ownerPubkey, escape_height: 6_000_000, expected_sats: '9999' },
    { deposit: NEAR },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /below the minimum/);
});

test('a deposit cannot be proven twice', () => {
  const w = createWorld();
  const id = openVault(w);
  const coin = deposit(w, id);
  w.must(prove(w, id, coin), 'first proof');
  const again = prove(w, id, coin);
  assert.equal(again.ok, false);
  assert.equal(w.near.view(A.ripcord, 'get_stats').sats_locked, COLLATERAL, 'counted once');
});

// ---- Borrow rules ----

test('borrowing above the offered price per BTC is refused', () => {
  const w = createWorld();
  const offer = makeOffer(w);
  const id = fundedVault(w);
  const r = borrow(w, id, offer, 40n * USDC + 1n); // 0.001 BTC at $40,000 is $40
  assert.equal(r.ok, false);
  assert.equal(vaultOf(w, id).status, 'funded');
  assert.ok(r.failures.some((f) => /OverLtv/.test(f)));
});

test('a loan whose default process would not fit before the escape block is refused', () => {
  const w = createWorld();
  const offer = makeOffer(w, { term: 20 });
  // term 20 + grace 6 + auction 12 + safety 12 needs 50 blocks. Deposit mines 3.
  const id = fundedVault(w, { escape: w.bitcoin.height + 40 });
  const r = borrow(w, id, offer, 10n * USDC);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /TimelineTooTight/.test(f)));
});

test('only the owner can borrow against a vault', () => {
  const w = createWorld();
  const offer = makeOffer(w);
  const id = fundedVault(w);
  const r = w.near.call(
    A.bidder,
    A.ripcord,
    'borrow',
    { vault_id: String(id), offer_id: offer, principal: '1000000' },
    { deposit: 1n },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /only the vault owner/);
});

test('borrowing needs a full-access key, so a leaked app key cannot open a loan', () => {
  const w = createWorld();
  const offer = makeOffer(w);
  const id = fundedVault(w);
  const r = w.near.call(A.borrower, A.ripcord, 'borrow', {
    vault_id: String(id),
    offer_id: offer,
    principal: '1000000',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /exactly 1 yoctoNEAR/);
});

test('one vault cannot hold two loans', () => {
  const w = createWorld();
  const { id, offer } = activeLoan(w);
  const r = borrow(w, id, offer, 1n * USDC);
  assert.equal(r.ok, false);
  assert.match(r.error, /no free collateral/);
});

test('an offer cannot lend more than it holds across several loans', () => {
  const w = createWorld();
  const offer = makeOffer(w, { amount: 40n * USDC });
  const a = fundedVault(w);
  const b = fundedVault(w);
  w.must(borrow(w, a, offer, 30n * USDC), 'first loan');
  const r = borrow(w, b, offer, 11n * USDC);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /InsufficientOfferFunds/.test(f)));
  w.must(borrow(w, b, offer, 10n * USDC), 'exactly what is left');
  assert.equal(w.near.view(A.ripcord, 'get_offer', { offer_id: offer }).available, '0');
});

test('cancelling an offer returns unlent money and leaves live loans alone', () => {
  const w = createWorld();
  const { id, offer } = activeLoan(w, { principal: 30n * USDC });
  w.must(w.near.call(A.lender, A.ripcord, 'cancel_offer', { offer_id: offer }, { deposit: 1n }), 'cancel');
  assert.equal(inside(w, A.lender), 970n * USDC);
  assert.equal(vaultOf(w, id).status, 'borrowed');
  const r = w.near.call(A.lender, A.ripcord, 'cancel_offer', { offer_id: offer }, { deposit: 1n });
  assert.equal(r.ok, false);
});

test('a bad offer refunds the lender in full', () => {
  const w = createWorld();
  const before = usdcOf(w, A.lender);
  ftCall(w, A.lender, 100n * USDC, {
    offer: { micro_usdc_per_btc: '1', apr_bps: 900, term_blocks: 0, btc_script: bytesToHex(LENDER_BTC) },
  });
  assert.equal(usdcOf(w, A.lender), before);
  ftCall(w, A.lender, 100n * USDC, {
    offer: { micro_usdc_per_btc: PRICE.toString(), apr_bps: 900, term_blocks: 20, btc_script: '6a0100' },
  });
  assert.equal(usdcOf(w, A.lender), before, 'an unspendable destination is refused');
});

test('only the configured token is accepted', () => {
  const w = createWorld();
  const r = w.near.call(A.bidder, A.ripcord, 'ft_on_transfer', {
    sender_id: A.bidder,
    amount: '1000000',
    msg: JSON.stringify({ repay: { vault_id: '0' } }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /only the configured USDC/);
});

test('a payment below the debt is refused and refunded', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const debt = BigInt(vaultOf(w, id).loan.debt);
  const before = usdcOf(w, A.borrower);
  repay(w, id, debt - 1n);
  assert.equal(usdcOf(w, A.borrower), before);
  assert.equal(vaultOf(w, id).status, 'borrowed');
});

// ---- Nothing can take the coins early ----

test('no price move can liquidate: the auction cannot start before grace ends', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const graceEnd = vaultOf(w, id).loan.grace_end_height;
  w.bitcoin.mine(graceEnd - w.bitcoin.height); // now exactly on the last protected block
  const r = w.near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(id) });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /not past its grace period/.test(f)));
  assert.equal(vaultOf(w, id).status, 'borrowed');
});

test('a late borrower can still repay until an auction actually starts', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  pastGrace(w, id);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'late repayment');
  assert.equal(vaultOf(w, id).status, 'funded');
});

test('the lender cannot release or sign collateral while a loan is open', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const release = w.near.call(A.lender, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(LENDER_BTC) }, { deposit: 1n });
  assert.equal(release.ok, false);
  const sign = w.near.call(A.lender, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '500' });
  assert.equal(sign.ok, false);
  const owner = w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n });
  assert.equal(owner.ok, false, 'not even the owner while a loan is open');
});

// ---- Default ----

test('default: a Dutch auction pays the lender, returns the surplus and moves the coins', () => {
  const w = createWorld();
  const { id, principal } = activeLoan(w);
  const loan = vaultOf(w, id).loan;
  pastGrace(w, id);

  w.must(w.near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(id) }), 'start auction');
  assert.equal(vaultOf(w, id).status, 'auction');

  const debt = BigInt(loan.debt);
  assert.equal(BigInt(w.near.view(A.ripcord, 'auction_price', { vault_id: String(id) })), debt * 3n, 'opens at three times the debt');

  w.near.advance(1_800); // halfway down
  const price = BigInt(w.near.view(A.ripcord, 'auction_price', { vault_id: String(id) }));
  assert.equal(price, debt * 2n);

  const before = usdcOf(w, A.bidder);
  w.must(
    ftCall(w, A.bidder, price + 7n * USDC, { bid: { vault_id: String(id), btc_script: bytesToHex(BIDDER_BTC) } }),
    'bid',
  );
  assert.equal(usdcOf(w, A.bidder), before - price, 'pays the price, the rest is refunded');

  const interest = BigInt(loan.interest);
  const share = (interest * 1_000n) / 10_000n;
  assert.equal(inside(w, A.lender), debt - share, 'lender made whole');
  assert.equal(inside(w, A.borrower), principal + price - debt, 'surplus goes to the borrower');

  settle(w, id, A.bidder, 700);
  assert.equal(w.bitcoin.balanceOf(BIDDER_BTC), BigInt(COLLATERAL) - 700n, 'the winner has the coins');
});

test('default with no bids: the coins go to the lender on Bitcoin', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  pastGrace(w, id);
  w.must(w.near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(id) }), 'start');

  const early = w.near.call(A.keeper, A.ripcord, 'claim_collateral', { vault_id: String(id) });
  assert.equal(early.ok, false);
  assert.match(early.error, /still running/);

  w.near.advance(3_600);
  assert.equal(w.near.view(A.ripcord, 'auction_price', { vault_id: String(id) }), null);
  const before = usdcOf(w, A.bidder);
  ftCall(w, A.bidder, 500n * USDC, { bid: { vault_id: String(id), btc_script: bytesToHex(BIDDER_BTC) } });
  assert.equal(vaultOf(w, id).status, 'auction', 'a bid after the end does nothing');
  assert.equal(usdcOf(w, A.bidder), before, 'and it is refunded');

  w.must(w.near.call(A.keeper, A.ripcord, 'claim_collateral', { vault_id: String(id) }), 'claim');
  const v = vaultOf(w, id);
  assert.equal(v.status, 'settling');
  assert.equal(v.destination, bytesToHex(LENDER_BTC));
  settle(w, id, A.lender, 600);
  assert.ok(w.bitcoin.balanceOf(LENDER_BTC) > 0n);
});

test('a bid below the current price is refused', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  pastGrace(w, id);
  w.must(w.near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(id) }), 'start');
  const price = BigInt(w.near.view(A.ripcord, 'auction_price', { vault_id: String(id) }));
  const before = usdcOf(w, A.bidder);
  ftCall(w, A.bidder, price / 2n, { bid: { vault_id: String(id), btc_script: bytesToHex(BIDDER_BTC) } });
  assert.equal(usdcOf(w, A.bidder), before, 'refunded');
  assert.equal(vaultOf(w, id).status, 'auction');
});

test('if nobody starts the auction in time, the lender takes the coins directly', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const v = vaultOf(w, id);
  w.bitcoin.mine(v.escape_height - w.bitcoin.height - 5); // inside the safety margin
  w.must(w.near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(id) }), 'start');
  const after = vaultOf(w, id);
  assert.equal(after.status, 'settling');
  assert.equal(after.settle_reason, 'LateClaim');
  assert.equal(after.destination, bytesToHex(LENDER_BTC));
});

// ---- The ripcord ----

function ticket(w, id, height, fee = 400) {
  const v = vaultOf(w, id);
  const tx = buildSpend({
    txid: v.deposit.txid,
    vout: v.deposit.vout,
    value: Number(v.deposit.sats),
    destination: BORROWER_BTC,
    feeSats: fee,
    lockTime: height,
  });
  const raw = signOwnerPath(tx, hexToBytes(v.witness_script), Number(v.deposit.sats), ownerSecret);
  return { hex: bytesToHex(raw), txid: txidOf(tx) };
}

test('the ripcord: Bitcoin refuses the escape ticket early and accepts it on time, with NEAR gone', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const v = vaultOf(w, id);
  const t = ticket(w, id, v.escape_height);

  // Signed in advance. Before the block it is simply invalid.
  assert.throws(() => w.bitcoin.submit(t.hex), /lock time has not passed/);

  // A ticket with an earlier lock time does not get around the script.
  const early = ticket(w, id, v.escape_height - 1);
  w.bitcoin.mine(v.escape_height - w.bitcoin.height + 1);
  assert.throws(() => w.bitcoin.submit(early.hex), /below the script height/);

  // NEAR has stopped: signer offline, light client paused, no contract call from here on.
  w.mpc.state.offline = true;
  w.client.state.paused = true;

  assert.equal(w.bitcoin.submit(t.hex), t.txid);
  w.bitcoin.mine(1);
  assert.equal(w.bitcoin.balanceOf(BORROWER_BTC), BigInt(COLLATERAL) - 400n, 'the coins are home');
});

test('only the owner key opens the ripcord', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  const v = vaultOf(w, id);
  const tx = buildSpend({
    txid: v.deposit.txid,
    vout: v.deposit.vout,
    value: Number(v.deposit.sats),
    destination: LENDER_BTC,
    feeSats: 400,
    lockTime: v.escape_height,
  });
  const wrongKey = new Uint8Array(32).fill(0x24);
  const raw = signOwnerPath(tx, hexToBytes(v.witness_script), Number(v.deposit.sats), wrongKey);
  w.bitcoin.mine(v.escape_height - w.bitcoin.height + 1);
  assert.throws(() => w.bitcoin.submit(bytesToHex(raw)), /signature does not verify/);
});

test('a contract spend and an escape cannot both happen: Bitcoin keeps one', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }), 'release');
  settle(w, id, A.borrower);
  const v = vaultOf(w, id);
  const t = ticket(w, id, v.escape_height);
  w.bitcoin.mine(v.escape_height - w.bitcoin.height + 1);
  assert.throws(() => w.bitcoin.submit(t.hex), /already spent/);
});

// ---- Spending rules ----

test('a high-S signature from the network is lowered so nodes will relay it', () => {
  const w = createWorld();
  w.mpc.state.highS = true;
  const { id } = activeLoan(w);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }), 'release');
  settle(w, id, A.borrower);
});

test('the Bitcoin fee is capped and only the beneficiary sets it', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }), 'release');

  const someoneElse = w.near.call(A.keeper, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '500' });
  assert.equal(someoneElse.ok, false);
  assert.match(someoneElse.error, /only the beneficiary/);

  const greedy = w.near.call(A.borrower, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '5001' });
  assert.equal(greedy.ok, false);
  assert.match(greedy.error, /above the cap/);
});

test('a fee bump replaces the transaction, and counts the coins out only once', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  fundedVault(w); // keeps some coins locked, so a double subtraction would show
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }), 'release');

  w.must(w.near.call(A.borrower, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '300' }), 'sign low');
  const first = vaultOf(w, id).signed_txid;
  const locked = w.near.view(A.ripcord, 'get_stats').sats_locked;

  w.must(w.near.call(A.borrower, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '900' }), 'sign high');
  const second = vaultOf(w, id);
  assert.notEqual(second.signed_txid, first);
  assert.equal(w.near.view(A.ripcord, 'get_stats').sats_locked, locked, 'not subtracted twice');
  w.bitcoin.submit(second.signed_tx);
});

test('a wrong signature from the signer is refused, not stored', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }), 'release');

  const realSign = w.near.accounts.get(A.mpc).mock.sign;
  w.near.accounts.get(A.mpc).mock.sign = (args, ctx) => {
    const r = realSign(args, ctx);
    r.s.scalar = (BigInt(`0x${r.s.scalar}`) + 1n).toString(16).padStart(64, '0');
    return r;
  };
  w.near.call(A.borrower, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '500' });
  assert.equal(vaultOf(w, id).signed_tx, null);
});

test('when the signer is offline the call fails cleanly and can be retried', () => {
  const w = createWorld();
  const { id } = activeLoan(w);
  w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  w.must(w.near.call(A.borrower, A.ripcord, 'release', { vault_id: String(id), destination: bytesToHex(BORROWER_BTC) }, { deposit: 1n }), 'release');
  w.mpc.state.offline = true;
  w.near.call(A.borrower, A.ripcord, 'request_signature', { vault_id: String(id), fee_sats: '500' });
  assert.equal(vaultOf(w, id).signed_tx, null);
  w.mpc.state.offline = false;
  settle(w, id, A.borrower);
});

// ---- Payouts ----

test('a failed payout puts the money back in the balance', () => {
  const w = createWorld();
  const offer = makeOffer(w);
  const id = fundedVault(w);
  // keeper.test never registered with the token, so the transfer fails.
  w.near.call(A.borrower, A.ripcord, 'borrow', { vault_id: String(id), offer_id: offer, principal: (5n * USDC).toString(), payout_to: A.keeper }, { deposit: 1n });
  assert.equal(vaultOf(w, id).status, 'borrowed', 'the loan stands');
  assert.equal(inside(w, A.borrower), 5n * USDC, 'and the dollars are safe');
  w.must(w.near.call(A.borrower, A.ripcord, 'withdraw', {}, { deposit: 1n }), 'withdraw');
  assert.equal(inside(w, A.borrower), 0n);
});

test('nothing to withdraw is refused', () => {
  const w = createWorld();
  const r = w.near.call(A.keeper, A.ripcord, 'withdraw', {}, { deposit: 1n });
  assert.equal(r.ok, false);
});

// ---- The NEAR flywheel ----

test('each vault fee reaches the endowment and gets staked with a validator', () => {
  const w = createWorld();
  for (let i = 0; i < 12; i++) openVault(w);
  const stats = w.near.view(A.endowment, 'get_stats');
  assert.equal(stats.total_received, (12n * (NEAR / 10n)).toString());

  // Give the endowment room beyond its reserve and float, as a real deployment has.
  w.near.call(A.keeper, A.endowment, 'receive_fee', {}, { deposit: 2n * NEAR });
  w.must(w.near.call(A.keeper, A.endowment, 'stake'), 'anyone can trigger staking');
  const after = w.near.view(A.endowment, 'get_stats');
  assert.ok(BigInt(after.principal_staked) > 0n);
  assert.equal(w.pool.state.staked.get(A.endowment), BigInt(after.principal_staked));
});

test('the keeper who starts an auction is paid from the endowment', () => {
  const w = createWorld();
  w.near.call(A.keeper, A.endowment, 'receive_fee', {}, { deposit: 2n * NEAR });
  const { id } = activeLoan(w);
  pastGrace(w, id);
  const before = w.near.balance(A.keeper);
  w.must(w.near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(id) }), 'start');
  assert.equal(w.near.balance(A.keeper), before + NEAR / 100n);
  assert.equal(w.near.view(A.endowment, 'get_stats').keeper_payments, 1);
});

test('nobody but Ripcord can spend the keeper float', () => {
  const w = createWorld();
  const r = w.near.call(A.bidder, A.endowment, 'pay_keeper', { keeper: A.bidder });
  assert.equal(r.ok, false);
  assert.match(r.error, /only ripcord/);
});

test('rewards can be unstaked but the principal stays staked', () => {
  const w = createWorld();
  w.near.call(A.keeper, A.endowment, 'receive_fee', {}, { deposit: 3n * NEAR });
  w.must(w.near.call(A.keeper, A.endowment, 'stake'), 'stake');
  const principal = BigInt(w.near.view(A.endowment, 'get_stats').principal_staked);

  // The pool earns: 1 NEAR of rewards.
  w.pool.state.staked.set(A.endowment, principal + NEAR);
  w.must(w.near.call(A.keeper, A.endowment, 'harvest_rewards'), 'harvest');
  assert.equal(w.pool.state.staked.get(A.endowment), principal, 'principal is untouched');
  assert.equal(w.pool.state.unstaked.get(A.endowment), NEAR, 'only the rewards moved');
});

/** Runs a loan to repayment so the endowment has interest to sell. */
function earnInterest(w, loans = 3) {
  for (let i = 0; i < loans; i++) {
    const offer = makeOffer(w, { amount: 2_000n * USDC, apr: 90_000, term: 400 });
    const id = openVault(w, { escape: w.bitcoin.height + 2_000, expected: 5_000_000 });
    w.must(prove(w, id, deposit(w, id, 5_000_000)), 'prove');
    w.must(borrow(w, id, offer, 2_000n * USDC), 'borrow');
    w.must(repay(w, id, BigInt(vaultOf(w, id).loan.debt)), 'repay');
  }
  return inside(w, A.endowment);
}

test('interest becomes staked NEAR: a Dutch sale swaps USDC for NEAR with no price feed', () => {
  const w = createWorld();
  const earned = earnInterest(w);
  assert.ok(earned > 0n, 'interest share reached the endowment');

  w.must(w.near.call(A.keeper, A.endowment, 'collect_usdc'), 'collect');
  assert.equal(inside(w, A.endowment), 0n);
  assert.equal(usdcOf(w, A.endowment), earned);

  w.must(w.near.call(A.keeper, A.endowment, 'start_sale'), 'start sale');
  assert.equal(BigInt(w.near.view(A.endowment, 'current_rate')), INITIAL_RATE * 2n, 'opens at twice the last rate');

  w.near.advance(1_800);
  const rate = BigInt(w.near.view(A.endowment, 'current_rate'));
  assert.ok(rate < INITIAL_RATE * 2n && rate > INITIAL_RATE / 2n, 'the rate is falling');

  // Buy half at this rate. The contract refunds any NEAR it could not use.
  const want = earned / 2n;
  const nearBefore = w.near.balance(A.bidder);
  const usdcBefore = usdcOf(w, A.bidder);
  w.must(w.near.call(A.bidder, A.endowment, 'buy_usdc', {}, { deposit: want * rate + 12345n }), 'buy');
  assert.equal(usdcOf(w, A.bidder), usdcBefore + want);
  assert.equal(w.near.balance(A.bidder), nearBefore - want * rate, 'paid exactly the rate, dust refunded');

  const stats = w.near.view(A.endowment, 'get_stats');
  assert.equal(BigInt(stats.near_from_sales), want * rate);
  assert.equal(BigInt(stats.usdc_sold), want);
  assert.equal(BigInt(stats.sale.usdc_left), earned - want);

  // That NEAR now goes to a validator.
  w.must(w.near.call(A.keeper, A.endowment, 'stake'), 'stake');
  assert.ok(BigInt(w.near.view(A.endowment, 'get_stats').principal_staked) > 0n);
});

test('a buyer who takes everything pays only for what is left and ends the sale', () => {
  const w = createWorld();
  const earned = earnInterest(w);
  w.must(w.near.call(A.keeper, A.endowment, 'collect_usdc'), 'collect');
  w.must(w.near.call(A.keeper, A.endowment, 'start_sale'), 'start sale');
  const rate = BigInt(w.near.view(A.endowment, 'current_rate'));
  const before = w.near.balance(A.bidder);
  w.must(w.near.call(A.bidder, A.endowment, 'buy_usdc', {}, { deposit: 50n * NEAR }), 'buy all');
  assert.equal(w.near.balance(A.bidder), before - earned * rate);
  assert.equal(w.near.view(A.endowment, 'get_stats').sale, null);
  assert.equal(usdcOf(w, A.endowment), 0n);
  const again = w.near.call(A.bidder, A.endowment, 'buy_usdc', {}, { deposit: NEAR });
  assert.equal(again.ok, false);
  assert.match(again.error, /no sale is running/);
});

test('a sale that finds no buyer reopens lower, which is how it finds the market', () => {
  const w = createWorld();
  earnInterest(w);
  w.must(w.near.call(A.keeper, A.endowment, 'collect_usdc'), 'collect');
  w.must(w.near.call(A.keeper, A.endowment, 'start_sale'), 'start sale');

  const running = w.near.call(A.keeper, A.endowment, 'start_sale');
  assert.equal(running.ok, false);
  assert.match(running.error, /still running/);

  w.near.advance(3_600);
  assert.equal(w.near.view(A.endowment, 'current_rate'), null);
  const late = w.near.call(A.bidder, A.endowment, 'buy_usdc', {}, { deposit: NEAR });
  assert.equal(late.ok, false);

  w.must(w.near.call(A.keeper, A.endowment, 'start_sale'), 'reopen');
  const reopened = BigInt(w.near.view(A.endowment, 'current_rate'));
  assert.equal(reopened, INITIAL_RATE, 'opens at twice the old closing rate');
});

test('if a buyer cannot receive USDC the sale is undone and the NEAR returned', () => {
  const w = createWorld();
  const earned = earnInterest(w);
  w.must(w.near.call(A.keeper, A.endowment, 'collect_usdc'), 'collect');
  w.must(w.near.call(A.keeper, A.endowment, 'start_sale'), 'start sale');
  const before = w.near.balance(A.keeper);
  w.near.call(A.keeper, A.endowment, 'buy_usdc', {}, { deposit: NEAR / 100n }); // never registered
  assert.equal(w.near.balance(A.keeper), before, 'made whole');
  const stats = w.near.view(A.endowment, 'get_stats');
  assert.equal(stats.near_from_sales, '0');
  assert.equal(BigInt(stats.sale.usdc_left), earned, 'the USDC is back on sale');
});

test('selling needs USDC to sell', () => {
  const w = createWorld();
  w.near.call(A.keeper, A.endowment, 'start_sale');
  assert.equal(w.near.view(A.endowment, 'get_stats').sale, null);
});

// ---- Safety of the whole state machine ----

test('every vault action on an unknown vault is refused', () => {
  const w = createWorld();
  const id = { vault_id: '999' };
  for (const [method, args, deposit] of [
    ['start_auction', id, 0n],
    ['claim_collateral', id, 0n],
    ['release', { ...id, destination: bytesToHex(BORROWER_BTC) }, 1n],
    ['request_signature', { ...id, fee_sats: '500' }, 0n],
  ]) {
    const r = w.near.call(A.borrower, A.ripcord, method, args, { deposit });
    assert.equal(r.ok, false, method);
    assert.match(r.error, /no such vault/, method);
  }
});

test('opening a vault with a bad key, height or too little NEAR is refused', () => {
  const w = createWorld();
  const open = (args, deposit = NEAR) =>
    w.near.call(A.borrower, A.ripcord, 'open_vault', { expected_sats: '100000', ...args }, { deposit });
  assert.equal(open({ owner_pubkey: '04'.repeat(33), escape_height: 6_000_000 }).ok, false);
  assert.equal(open({ owner_pubkey: ownerPubkey, escape_height: 10 }).ok, false);
  assert.equal(open({ owner_pubkey: ownerPubkey, escape_height: 500_000_000 }).ok, false);
  assert.equal(open({ owner_pubkey: 'zz', escape_height: 6_000_000 }).ok, false);
  assert.equal(open({ owner_pubkey: ownerPubkey, escape_height: 6_000_000 }, 1n).ok, false);
  assert.equal(open({ owner_pubkey: ownerPubkey, escape_height: 6_000_000 }).ok, true);
});

test('overpaying for a vault refunds everything above the fee and storage', () => {
  const w = createWorld();
  const before = w.near.balance(A.borrower);
  w.must(
    w.near.call(
      A.borrower,
      A.ripcord,
      'open_vault',
      { owner_pubkey: ownerPubkey, escape_height: 6_000_000, expected_sats: '100000' },
      { deposit: 5n * NEAR },
    ),
    'open',
  );
  const spent = before - w.near.balance(A.borrower);
  const fee = NEAR / 10n;
  const storage = NEAR / 50n;
  assert.equal(spent, fee + storage);
});
