#!/usr/bin/env node
// Prints live NEAR Intents quotes for each way a Ripcord loan touches another chain. These
// are `dry` quotes from the real 1Click API: real solvers and real prices, nothing moved.
//
//   node quotes.mjs

import { btcSaleQuote, payoutQuote, repayQuote, USDC_ROUTES } from './lib/oneclick.mjs';

const PRINCIPAL = 100_000_000; // $100
const DEBT = 100_500_000; // $100.50
// 1Click needs NEAR accounts in a quote to exist. Any existing account prices the same.
const CONTRACT = 'wrap.near';

const show = (label, q) =>
  console.log(
    `${label.padEnd(34)} ${q.amountInFormatted.padStart(11)} in  ->  ${q.amountOutFormatted.padStart(11)} out  in about ${q.timeEstimate}s`,
  );

let failures = 0;
async function attempt(label, run) {
  try {
    show(label, (await run()).quote);
  } catch (e) {
    failures += 1;
    console.log(`${label.padEnd(34)} no quote: ${e.message}`);
  }
}

console.log('Payout: borrowed USDC on NEAR, delivered elsewhere');
for (const route of USDC_ROUTES) {
  await attempt(`  to ${route.label}`, () => payoutQuote(route, PRINCIPAL, undefined, CONTRACT));
}

console.log('\nRepayment: exact USDC on NEAR, paid from elsewhere');
for (const route of USDC_ROUTES) {
  await attempt(`  from ${route.label}`, () => repayQuote(route, DEBT, CONTRACT, 7));
}

console.log('\nCollateral: native Bitcoin sold for USDC on NEAR');
await attempt('  0.01 BTC', () =>
  btcSaleQuote(1_000_000, CONTRACT, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'),
);

process.exitCode = failures ? 1 : 0;
