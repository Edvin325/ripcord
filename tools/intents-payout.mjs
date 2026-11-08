#!/usr/bin/env node
// Sends real USDC from a NEAR mainnet account to another chain through NEAR Intents, the
// same way the app delivers a loan, and follows it to a final status. It moves real money,
// so it runs only with --yes, caps the amount, and is only for a run a human has approved.
// The account's key must be in ~/.near-credentials/mainnet, never in this repository.
//
//   node intents-payout.mjs <mainnet account> <base|arb|sol|eth> <recipient address> <dollars> --yes

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, NEAR, view } from './lib/near.mjs';
import { deliveryQuote, describeTransfer, looksLikeAddress, resolveRoutes, status, submitDeposit, tokens, TERMINAL } from './lib/oneclick.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const MAX_DOLLARS = 20;
const REGISTRATION = 1_250_000_000_000_000_000_000n;

const [account, routeId, recipient, dollarsText, flag] = process.argv.slice(2);
if (flag !== '--yes') {
  console.error('This moves real money on mainnet. Run it only with the human\'s approval, adding --yes.');
  console.error('usage: node intents-payout.mjs <mainnet account> <base|arb|sol|eth> <recipient address> <dollars> --yes');
  process.exit(2);
}
const dollars = Number(dollarsText);
if (!(dollars > 0 && dollars <= MAX_DOLLARS)) throw new Error(`amount must be above 0 and at most $${MAX_DOLLARS}`);
const micro = BigInt(Math.round(dollars * 1_000_000));

const route = resolveRoutes(await tokens()).find((r) => r.id === routeId);
if (!route?.listed) throw new Error(`1Click does not list USDC on ${routeId}`);
if (!looksLikeAddress(route, recipient)) throw new Error(`${recipient} is not a ${route.label} address`);

const steps = [];
const save = () => {
  mkdirSync(join(here, '..', 'evidence'), { recursive: true });
  writeFileSync(join(here, '..', 'evidence', 'intents-mainnet-run.json'), `${JSON.stringify({ account, route: route.label, recipient, dollars, steps }, null, 2)}\n`);
};
const log = (step, detail = {}) => {
  steps.push({ step, at: new Date().toISOString(), ...detail });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step} ${JSON.stringify(detail)}`);
  save();
};

const held = BigInt(await view('mainnet', USDC_CONTRACT, 'ft_balance_of', { account_id: account }));
if (held < micro) throw new Error(`${account} holds ${Number(held) / 1e6} USDC, needs ${dollars}`);

const q = await deliveryQuote({ route, microUsdc: micro, recipient, refundTo: account });
const depositAddress = q.quote.depositAddress;
log('committed quote', { deposit_address: depositAddress, amount_out: q.quote.amountOutFormatted, deadline: q.quote.deadline });

const reg = await call('mainnet', account, USDC_CONTRACT, 'storage_deposit', { account_id: depositAddress, registration_only: true }, { deposit: REGISTRATION, tgas: 30n });
log('registered the deposit address with USDC', { near_tx: reg.hash, ok: reg.ok });
if (!reg.ok) throw new Error(reg.failures.join(' | '));

const sent = await call('mainnet', account, USDC_CONTRACT, 'ft_transfer', { receiver_id: depositAddress, amount: q.quote.amountIn }, { deposit: 1n, tgas: 50n });
log('sent USDC to the deposit address', { near_tx: sent.hash, ok: sent.ok, explorer: `https://nearblocks.io/txns/${sent.hash}` });
if (!sent.ok) throw new Error(sent.failures.join(' | '));
await submitDeposit({ txHash: sent.hash, depositAddress, nearSenderAccount: account }).catch((e) => log('deposit notice failed, which is optional', { error: e.message }));

for (let i = 0; i < 180; i++) {
  const s = await status(depositAddress);
  const words = describeTransfer(s, { direction: 'out', chain: route.label, recipient, refundTo: account });
  if (!steps.length || steps.at(-1).status !== s.status) log(words.title, { status: s.status, where: words.where, links: words.links });
  if (TERMINAL.has(s.status)) break;
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(`NEAR left on ${account}: ${Number(BigInt((await view('mainnet', USDC_CONTRACT, 'storage_balance_of', { account_id: account }))?.total ?? 0) / (NEAR / 1000n)) / 1000}`);
