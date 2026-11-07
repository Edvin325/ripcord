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
await shot('05b-live-quote');
await page.getByLabel('Deliver the dollars to').selectOption('near');

await page.getByRole('button', { name: 'Borrow', exact: true }).click();
await notice('The Bitcoin has not moved');
await visible('No price can touch this loan');
await shot('06-vault-borrowed');
step('borrowed');

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
await page.getByRole('button', { name: 'Borrow', exact: true }).click();
await notice('The Bitcoin has not moved');
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
