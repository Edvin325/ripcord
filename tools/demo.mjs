#!/usr/bin/env node
// The whole story in a terminal, on the real compiled contracts: a loan, a default that
// sells at auction, and the ripcord with everything switched off. No wallet, no tokens and
// no network. Bitcoin here is a small simulation that enforces this script's real rules.
//
//   node demo.mjs

import { ACCOUNTS as A, NEAR, USDC, p2wpkhOf } from './sim/world.mjs';
import { nodeWorld } from './sim/node-world.mjs';
import { buildSpend, bytesToHex, hexToBytes, newOwnerKey, parseVaultScript, signOwnerPath } from './lib/btc-core.mjs';

const SATS = 1_000_000;
// The borrower's own opening price for the auction, if they ever default.
const OPEN_PER_BTC = 120_000n * USDC;
const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const btc = (sats) => `${(Number(sats) / 1e8).toFixed(8)} BTC`;
const say = (text = '') => console.log(text);
const title = (text) => say(`\n=== ${text} ===`);
const ok = (r) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

const w = nodeWorld();
const { near, bitcoin } = w;

const token = (sender, amount, msg) =>
  near.call(sender, A.usdc, 'ft_transfer_call', { receiver_id: A.ripcord, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n });
const vault = (id) => near.view(A.ripcord, 'get_vault', { vault_id: String(id) });
const inside = (id) => near.view(A.ripcord, 'get_balance', { account_id: id });

function lend() {
  const r = token(A.lender, 1_000n * USDC, {
    offer: {
      micro_usdc_per_btc: (40_000n * USDC).toString(),
      apr_bps: 900,
      term_blocks: 20,
      btc_script: bytesToHex(p2wpkhOf(0x1e)),
    },
  });
  return r.events.find((e) => e.event === 'offer_created').data[0].offer_id;
}

function openAndFund(key, blocks = 300) {
  const opened = ok(
    near.call(
      A.borrower,
      A.ripcord,
      'open_vault',
      { owner_pubkey: bytesToHex(key.publicKey), escape_height: bitcoin.height + blocks, expected_sats: String(SATS) },
      { deposit: NEAR },
    ),
  );
  const id = opened.value;
  const v = vault(id);
  const coin = bitcoin.fund(hexToBytes(v.script_pubkey), SATS);
  bitcoin.mine(3);
  const { raw_tx, proof } = bitcoin.proofFor(coin.txid);
  ok(near.call(A.keeper, A.ripcord, 'prove_deposit', { vault_id: String(id), raw_tx, vout: coin.vout, proof }));
  return id;
}

const borrow = (id, offer, dollars) =>
  ok(near.call(A.borrower, A.ripcord, 'borrow', { vault_id: String(id), offer_id: offer, principal: (dollars * USDC).toString(), auction_open_per_btc: OPEN_PER_BTC.toString() }, { deposit: 1n }));

title('1. A loan that is repaid');
const offer = lend();
say('A lender offers $40,000 per BTC at 9% for 20 blocks.');
const key1 = newOwnerKey();
const a = openAndFund(key1);
const v1 = vault(a);
const script = parseVaultScript(hexToBytes(v1.witness_script));
say(`The borrower locks ${btc(SATS)} at ${v1.address}`);
say(`The address commits to two locks: the contract's key, or the owner's key after block ${script.escapeHeight}.`);
say('A keeper submits a Merkle proof. The contract computes the txid itself and the light client accepts it.');
borrow(a, offer, 300n);
const debt = BigInt(vault(a).loan.debt);
say(`The borrower takes $300.00 and owes ${usd(debt)}. The Bitcoin has not moved.`);
ok(token(A.borrower, debt, { repay: { vault_id: String(a) } }));
ok(near.call(A.borrower, A.ripcord, 'release', { vault_id: String(a), destination: bytesToHex(p2wpkhOf(0xb0)) }, { deposit: 1n }));
ok(near.call(A.borrower, A.ripcord, 'request_signature', { vault_id: String(a), fee_sats: '500' }, { deposit: 1n }));
const signed = vault(a);
bitcoin.submit(signed.signed_tx);
bitcoin.mine(1);
say(`Repaid. The signer signs ${signed.signed_txid.slice(0, 12)}…, and Bitcoin accepts it.`);
say(`${btc(bitcoin.balanceOf(p2wpkhOf(0xb0)))} is back with the borrower, less the fee.`);

title('2. A loan that defaults');
const b = openAndFund(newOwnerKey());
borrow(b, offer, 300n);
const loan = vault(b).loan;
bitcoin.mine(loan.grace_end_height - bitcoin.height);
const early = near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(b) });
say(`On the last block of grace, a keeper tries to start the auction: ${early.failures.at(-1) ?? 'accepted'}`);
bitcoin.mine(1);
ok(near.call(A.keeper, A.ripcord, 'start_auction', { vault_id: String(b) }));
say(`One block later it starts. The price opens at ${usd(near.view(A.ripcord, 'auction_price', { vault_id: String(b) }))}: this coin at the $120,000 per BTC the borrower named.`);
near.advance(2_400);
const price = BigInt(near.view(A.ripcord, 'auction_price', { vault_id: String(b) }));
say(`Forty minutes later it is ${usd(price)}, and a bidder takes it.`);
ok(token(A.bidder, price, { bid: { vault_id: String(b), btc_script: bytesToHex(p2wpkhOf(0xbd)) } }));
say(`The lender is paid in full: ${usd(inside(A.lender))} in total so far.`);
say(`The surplus goes back to the borrower: ${usd(BigInt(inside(A.borrower)) - 600n * USDC)}.`);
ok(near.call(A.bidder, A.ripcord, 'request_signature', { vault_id: String(b), fee_sats: '500' }, { deposit: 1n }));
bitcoin.submit(vault(b).signed_tx);
bitcoin.mine(1);
say(`The bidder has ${btc(bitcoin.balanceOf(p2wpkhOf(0xbd)))} on Bitcoin.`);

title('3. The ripcord');
const key3 = newOwnerKey();
const c = openAndFund(key3, 120);
borrow(c, offer, 300n);
const v3 = vault(c);
const tx = buildSpend({
  txid: v3.deposit.txid,
  vout: v3.deposit.vout,
  value: SATS,
  destination: p2wpkhOf(0xb0),
  feeSats: 400,
  lockTime: v3.escape_height,
});
const ticket = bytesToHex(signOwnerPath(tx, hexToBytes(v3.witness_script), SATS, key3.secret));
say(`The borrower signs an escape ticket, valid after block ${v3.escape_height}, and keeps it as a file.`);

w.mpc.state.offline = true;
w.client.state.paused = true;
say('NEAR stops: the signers are offline and the light client is paused. Nothing below touches NEAR.');

const before = bitcoin.balanceOf(p2wpkhOf(0xb0));
try {
  bitcoin.submit(ticket);
  say('Bitcoin accepted the ticket early. THIS SHOULD NOT HAPPEN.');
  process.exitCode = 1;
} catch (e) {
  say(`The ticket is tried at block ${bitcoin.height}. Bitcoin refuses it: ${e.message}`);
}
bitcoin.mine(v3.escape_height - bitcoin.height + 1);
bitcoin.submit(ticket);
bitcoin.mine(1);
say(`At block ${bitcoin.height} Bitcoin accepts it.`);
say(`${btc(bitcoin.balanceOf(p2wpkhOf(0xb0)) - before)} came home with NEAR switched off.`);

title('What NEAR got');
ok(near.call(A.keeper, A.endowment, 'stake'));
const e = near.view(A.endowment, 'get_stats');
const nearText = (yocto) => (Number(BigInt(yocto) / 10n ** 21n) / 1000).toFixed(3);
const interest = Number(near.view(A.ripcord, 'get_stats').usdc_to_flywheel) / 1e6;
say(`Vault fees received by the endowment: ${nearText(e.total_received)} NEAR.`);
say(`Staked with a validator, for good, by a contract with no keys: ${nearText(e.principal_staked)} NEAR.`);
say(`Interest set aside to buy more NEAR: $${interest.toFixed(4)}.`);
say(`Keeper bounties paid: ${e.keeper_payments}.`);
