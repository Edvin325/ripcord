#!/usr/bin/env node
// Checks Ripcord's NEAR Intents code against the real 1Click API without moving any money:
// the live token list, a dry quote, two committed quotes that return deposit addresses (one
// for sending a loan out, one for bringing a repayment in), and the status of each address.
// Nothing is ever sent to either deposit address, so both expire unused.
//
//   node intents-check.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryQuote, describeTransfer, inboundQuote, payoutQuote, resolveRoutes, status, tokens, USDC_NEAR } from './lib/oneclick.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIVE_DOLLARS = 5_000_000n;
// An existing NEAR account, used only so the API accepts the request. No money is sent, so
// it never receives or refunds anything. Not `wrap.near`: 1Click accepts that in a dry quote
// but refuses it in a committed one, with only "Failed to get quote" as the reason.
const NAMED_ACCOUNT = 'near';

const list = await tokens();
const routes = resolveRoutes(list);
const near = list.find((t) => t.assetId === USDC_NEAR);
console.log(`1Click lists ${list.length} tokens. USDC on NEAR: ${near ? 'listed' : 'MISSING'}`);
for (const r of routes) console.log(`  ${r.label}: ${r.listed ? r.asset : 'not listed'}`);

const base = routes.find((r) => r.id === 'base');
const dry = await payoutQuote(base, FIVE_DOLLARS, undefined, NAMED_ACCOUNT);
console.log(`dry quote: $5.00 on NEAR -> ${dry.quote.amountOutFormatted} USDC on Base, about ${dry.quote.timeEstimate}s`);

const out = await deliveryQuote({ route: base, microUsdc: FIVE_DOLLARS, recipient: base.sample, refundTo: NAMED_ACCOUNT, minutes: 10 });
const outStatus = await status(out.quote.depositAddress);
const outWords = describeTransfer(outStatus, { direction: 'out', chain: 'Base', recipient: base.sample, refundTo: NAMED_ACCOUNT });
console.log(`committed quote, loan out: deposit address ${out.quote.depositAddress}, status ${outStatus.status}`);

const inb = await inboundQuote({ route: base, microUsdc: FIVE_DOLLARS, recipient: NAMED_ACCOUNT, refundTo: base.sample, minutes: 10 });
const inStatus = await status(inb.quote.depositAddress);
console.log(`committed quote, repayment in: deposit address ${inb.quote.depositAddress}, status ${inStatus.status}`);

const evidence = {
  checked_at: new Date().toISOString(),
  note: 'Run against the real 1Click API. No funds were sent to either deposit address, so both expire unused.',
  tokens_listed: list.length,
  routes: routes.map(({ id, label, asset, listed }) => ({ id, label, asset, listed })),
  dry_quote: { amount_in: dry.quote.amountIn, amount_out: dry.quote.amountOut, seconds: dry.quote.timeEstimate },
  loan_out: {
    deposit_address: out.quote.depositAddress,
    is_near_implicit_account: /^[0-9a-f]{64}$/.test(out.quote.depositAddress),
    amount_in: out.quote.amountIn,
    amount_out: out.quote.amountOut,
    deadline: out.quote.deadline,
    status: outStatus.status,
    shown_as: `${outWords.title}. ${outWords.where}`,
  },
  repayment_in: {
    deposit_address: inb.quote.depositAddress,
    amount_to_send: inb.quote.amountIn,
    amount_arriving: inb.quote.amountOut,
    deadline: inb.quote.deadline,
    status: inStatus.status,
  },
};
mkdirSync(join(here, '..', 'evidence'), { recursive: true });
writeFileSync(join(here, '..', 'evidence', 'intents-api-check.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log('saved evidence/intents-api-check.json');
