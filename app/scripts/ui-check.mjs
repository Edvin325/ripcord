// Drives the built site in a real browser, through the paths a visitor takes, and fails on
// any console error. Screenshots go to the folder given as the first argument.
//
//   npx vite preview --port 4173 &
//   node scripts/ui-check.mjs <screenshot folder>

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? 'shots';
const base = process.argv[3] ?? 'http://localhost:4173/';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.UI_BROWSER ?? 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const step = (text) => console.log(`- ${text}`);
const click = (name) => page.getByRole('button', { name, exact: false }).first().click();
const visible = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 8000 });

const BASE_WALLET = '0x2f3b1a3e7c1d9a8b6c5d4e3f2a1b0c9d8e7f6a5b';
const transfer = (text) => page.locator('.transfer').filter({ hasText: text }).first().waitFor({ timeout: 20000 });

async function notice(text) {
  await page.locator('.notice').filter({ hasText: text }).first().waitFor({ timeout: 8000 });
}

await page.goto(base);
await visible('Borrow against Bitcoin that never leaves Bitcoin');
await shot('01-home');
step('home renders');

// The headline flow: pull the ripcord.
await page.goto(`${base}#/switch`);
await visible('Pull everything');
await click('Pull the ripcord');
await page.getByText('is back in the borrower', { exact: false }).waitFor({ timeout: 40000 });
await visible('Everything was off');
await shot('02-switch-off');
step('the ripcord run finished: everything off, coins home');

// A full loan through the pages, from a clean world.
await page.getByRole('button', { name: 'Reset' }).click();
await notice('reset');
await page.goto(`${base}#/borrow`);
await visible('Open offers');
await shot('03-borrow');
await click('Open vault');
await notice('Vault opened');
await visible('Save your recovery key');
await shot('04-vault-deposit');
step('vault opened');

await click('Send from the simulated wallet');
await notice('confirmed');
await click('Submit proof');
await notice('Deposit proven');
await visible('Borrow');
await shot('05-vault-funded');
step('deposit proven');

// A live NEAR Intents price, fetched by this page from the real 1Click API.
await page.getByLabel('Deliver the dollars to').selectOption('base');
const quoted = await page
  .locator('.quote-line, .intents .muted')
  .filter({ hasText: /Live quote from NEAR Intents|No live quote/ })
  .first()
  .textContent({ timeout: 15000 });
step(`intents says: ${quoted}`);
await page.getByLabel('Your address on Base').fill(BASE_WALLET);
await shot('05b-live-quote');

// Borrow straight into a NEAR Intents deposit address. The simulated 1Click moves through
// the real statuses until the dollars are delivered on Base.
await page.getByRole('button', { name: 'Borrow and send to Base' }).click();
await notice('NEAR Intents is taking the dollars to Base');
await visible('No price can touch this loan');
await transfer('Delivered on Base');
await visible('Where your money is');
await shot('06-vault-borrowed');
step('borrowed, and the simulated NEAR Intents delivered the dollars on Base');

// A crash does nothing.
await click('Crash 50%');
await visible('No price can touch this loan');
step('price crash changed nothing');

// Sign the ticket, and let Bitcoin refuse it early.
await click('Sign my escape ticket');
await notice('Ticket signed');
await click('Try it now');
await notice('Bitcoin refused it');
await shot('07-ticket-refused');
step('Bitcoin refused the ticket early');

// Bring the repayment from another chain, then repay on NEAR.
await page.getByLabel('Repay from').selectOption('base');
await page.getByLabel(/Your address on Base, for a refund/).fill(BASE_WALLET);
await click('Get a deposit address on Base');
await notice('Deposit address ready');
await visible('Send exactly');
await click('Pay from the simulated Base wallet');
await transfer('Delivered on NEAR');
await shot('07b-repay-from-base');
step('dollars brought from Base arrived on NEAR');

// Repay and take the coins back through the contract path.
await page.locator('button', { hasText: /^Repay/ }).click();
await notice('Repaid');
await click('Release the coins');
await notice('Released');
await click('Ask the signers to sign');
await notice('Signed by the MPC network');
await click('Broadcast to Bitcoin');
await notice('Bitcoin accepted');
await shot('08-settled');
step('repaid, signed by the simulated MPC network, accepted by Bitcoin');

// Default: a second loan left to run out.
await page.goto(`${base}#/borrow`);
await click('Open vault');
await notice('Vault opened');
await click('Send from the simulated wallet');
await notice('confirmed');
await click('Submit proof');
await notice('Deposit proven');
// This time NEAR Intents refunds the delivery, and the page says where the money went.
await page.getByLabel('What the simulated NEAR Intents does next').selectOption('refund');
await page.getByLabel('Deliver the dollars to').selectOption('base');
await page.getByLabel('Your address on Base').fill(BASE_WALLET);
await page.getByRole('button', { name: 'Borrow and send to Base' }).click();
await notice('NEAR Intents is taking the dollars to Base');
await transfer('Refunded');
await visible('Back in borrower.test on NEAR');
await shot('08b-refunded');
step('a refunded delivery is shown, with the money back on NEAR');
await page.getByLabel('What the simulated NEAR Intents does next').selectOption('deliver');
for (let i = 0; i < 4; i++) await click('Mine 10');
await page.goto(`${base}#/auctions`);
await click('Start auction');
await notice('auction is running');
await page.getByLabel('Act as').selectOption({ label: 'Bidder' });
await click('+30 min');
await page.waitForTimeout(200);
await shot('09-auction');
await click('Buy at this price');
await notice('You won');
step('default went to auction and sold');

// A failed delivery, shown as such.
await page.getByLabel('Act as').selectOption({ label: 'Borrower' });
await page.getByLabel('What the simulated NEAR Intents does next').selectOption('fail');
await page.goto(`${base}#/borrow`);
await click('Open vault');
await notice('Vault opened');
await click('Send from the simulated wallet');
await notice('confirmed');
await click('Submit proof');
await notice('Deposit proven');
await page.getByLabel('Deliver the dollars to').selectOption('base');
await page.getByLabel('Your address on Base').fill(BASE_WALLET);
await page.getByRole('button', { name: 'Borrow and send to Base' }).click();
await transfer('The transfer failed');
await visible('Keep the address below');
await shot('09b-failed');
step('a failed delivery is shown, with what to keep');
await page.getByLabel('What the simulated NEAR Intents does next').selectOption('deliver');

// Every step, with a link where there is something real to look up.
await page.goto(`${base}#/history`);
await visible('What happened, step by step');
for (const text of ['Borrowed, sent to Base through NEAR Intents', 'Delivered on Base (simulated)', 'Refunded (simulated)', 'The transfer failed (simulated)', 'Repaid the loan']) {
  await visible(text);
}
await shot('10b-history');
step('the history lists every step');

await page.goto(`${base}#/lend`);
await visible('Lend dollars against native Bitcoin');
await page.getByLabel('Act as').selectOption({ label: 'Lender' });
await page.waitForTimeout(200);
await shot('10-lend');
await page.goto(`${base}#/near`);
await visible('Every Bitcoin loan makes NEAR stronger');
await shot('11-near');
step('lend and NEAR pages render');

// Phone width and dark mode, the two easiest things to break.
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${base}#/`);
await page.waitForTimeout(250);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await shot('12-phone');
if (overflow > 1) errors.push(`page scrolls sideways by ${overflow}px at phone width`);
await page.emulateMedia({ colorScheme: 'dark' });
await page.setViewportSize({ width: 1280, height: 860 });
await page.waitForTimeout(150);
await shot('13-dark');

await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log('\nno console errors');
