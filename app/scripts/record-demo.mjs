// Records the demo video from the built site, in a real browser: a whole loan, a price
// crash, and the ripcord with everything switched off. Captions and a cursor are drawn into
// the page, so what you see is the real app, running the real compiled contracts.
//
//   npx vite preview --port 4179 --strictPort &
//   FFMPEG=path/to/ffmpeg node scripts/record-demo.mjs ripcord-demo.mp4 http://localhost:4179/
//
// Set PROOF_TX to a Bitcoin testnet3 transaction to close on it in a public block explorer.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const out = resolve(process.argv[2] ?? 'ripcord-demo.mp4');
const base = process.argv[3] ?? 'http://localhost:4179/';
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const proofTx = process.env.PROOF_TX;
const WIDTH = 1920;
const HEIGHT = 1080;
const ZOOM = 1.5; // the page lays out as if 1280 wide, and draws crisply at 1920

const dir = mkdtempSync(join(tmpdir(), 'ripcord-demo-'));
const browser = await chromium.launch({ channel: process.env.UI_BROWSER ?? 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, bypassCSP: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Frames arrive only when something on screen changes, each with its own timestamp. A cut
// marks a frame whose gap to the next one is dropped, for skipping a page load.
const frames = [];
const cuts = new Set();
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  const name = `f${String(frames.length).padStart(6, '0')}.jpg`;
  writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
  frames.push({ name, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});

const wait = (ms) => page.waitForTimeout(ms);

async function dress(tag = 'Simulator: the real contracts, with Bitcoin simulated') {
  await page.addStyleTag({
    content: `
      #demo-caption {
        position: fixed; left: 50%; bottom: 58px; transform: translateX(-50%);
        z-index: 99999; width: max-content; max-width: 1040px; padding: 14px 26px;
        background: rgba(22, 20, 15, .94); color: #fff; border-left: 7px solid #d3350c;
        font: 600 25px/1.32 'IBM Plex Sans', system-ui, sans-serif;
        opacity: 0; transition: opacity .28s;
      }
      #demo-caption.on { opacity: 1; }
      #demo-cursor {
        position: fixed; left: 640px; top: 300px; width: 20px; height: 20px; border-radius: 50%;
        background: rgba(211, 53, 12, .88); border: 2px solid #fff; box-shadow: 0 1px 6px rgba(0,0,0,.45);
        z-index: 99998; pointer-events: none; transform: translate(-50%, -50%);
        transition: left .5s cubic-bezier(.3,.7,.2,1), top .5s cubic-bezier(.3,.7,.2,1), width .12s, height .12s;
      }
      #demo-cursor.down { width: 12px; height: 12px; }
      #demo-tag {
        position: fixed; right: 14px; top: 104px; z-index: 99997; padding: 4px 10px;
        background: #16140f; color: #f3eee3; border-radius: 3px;
        font: 500 13px/1.3 'IBM Plex Sans', system-ui, sans-serif;
      }
      html { scroll-behavior: smooth; zoom: ${ZOOM}; }
    `,
  });
  await page.evaluate((text) => {
    for (const id of ['demo-caption', 'demo-cursor', 'demo-tag']) {
      const el = document.createElement('div');
      el.id = id;
      document.body.append(el);
    }
    const tag = document.getElementById('demo-tag');
    tag.textContent = text;
    tag.style.display = text ? 'block' : 'none';
  }, tag);
}

async function caption(text, ms) {
  await page.evaluate((t) => {
    const el = document.getElementById('demo-caption');
    el.textContent = t;
    el.classList.toggle('on', Boolean(t));
  }, text);
  if (ms) await wait(ms);
}

async function scrollTo(y, ms = 900) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
  await wait(ms);
}

/** Scrolls an element to a comfortable height, clear of the caption and the bottom bar. */
async function reveal(locator, offset = 110) {
  await locator.evaluate((el, margin) => {
    el.style.scrollMarginTop = `${margin}px`;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, offset);
  await wait(950);
}

async function press(locator) {
  const box = await locator.boundingBox();
  await page.evaluate(
    ([x, y]) => {
      const c = document.getElementById('demo-cursor');
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    },
    [(box.x + box.width / 2) / ZOOM, (box.y + box.height / 2) / ZOOM],
  );
  await wait(620);
  await page.evaluate(() => document.getElementById('demo-cursor').classList.add('down'));
  await wait(130);
  await locator.click();
  await page.evaluate(() => document.getElementById('demo-cursor').classList.remove('down'));
}

/**
 * The caption says this price is live, so it has to be. The API can refuse a burst of calls
 * from a shared connection, so ask again, and stop rather than film a false claim.
 */
async function liveQuote(select) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await select.selectOption('base');
    const line = page.locator('.intents p').filter({ hasText: /Live quote from NEAR Intents|No live quote/ }).first();
    await line.waitFor({ timeout: 20000 });
    if (/Live quote from NEAR Intents/.test(await line.textContent())) return;
    await select.selectOption('near');
    await wait(5000);
  }
  throw new Error('NEAR Intents gave no live quote, so this take would be false');
}

const button = (name, exact = false) => page.getByRole('button', { name, exact }).first();
const notice = (text) => page.locator('.notice').filter({ hasText: text }).first().waitFor({ timeout: 15000 });

await page.goto(base);
await page.getByText('Borrow against Bitcoin that never leaves Bitcoin').first().waitFor();
await dress();
await wait(500);
const screencast = { format: 'jpeg', quality: 88, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 };
await cdp.send('Page.startScreencast', screencast);

// The problem.
await wait(500);
await caption('To borrow against Bitcoin, you hand it to someone. And a price feed can liquidate you in a dip.', 4800);
await caption('');
await wait(300);

// The idea.
await reveal(page.locator('figure.locks, .locks').first(), 100);
await caption('Ripcord keeps your coins on Bitcoin, in an address with two locks.', 3600);
await caption('One opens for a NEAR contract. One opens for you alone, after a set block. Bitcoin enforces it.', 4600);
await caption('');

// A loan.
await scrollTo(0, 500);
await press(page.getByRole('link', { name: 'Borrow', exact: true }).first());
await page.getByText('Open offers').first().waitFor();
await wait(700);
await caption('Lenders name their own price per bitcoin. No oracle.', 2600);
const openVault = button('Open vault');
await reveal(openVault, 300);
await press(openVault);
await notice('Vault opened');
await page.getByText('Save your recovery key').first().waitFor();
await wait(500);

const sendCoins = button('Send from the simulated wallet');
await reveal(sendCoins, 260);
await caption('You lock Bitcoin in an address of your own.', 900);
await press(sendCoins);
await notice('confirmed');
await wait(600);
await caption('A NEAR contract proves the deposit through the Bitcoin light client. Nothing is bridged.', 900);
const proof = button('Submit proof');
await reveal(proof, 300);
await press(proof);
await notice('Deposit proven');
await wait(1600);
await caption('');

// Borrow, with a live price from Intents.
const deliver = page.getByLabel('Deliver the dollars to');
await reveal(page.getByLabel('If you default, the auction opens at this price per BTC'), 160);
await caption('You borrow dollars, delivered to any chain through NEAR Intents. This is a live price.', 700);
await liveQuote(deliver);
await wait(3000);
await press(button('Borrow', true));
await notice('The Bitcoin has not moved');
await page.getByText('No price can touch this loan').first().waitFor();
await wait(500);
await caption('');

// The crash.
await reveal(page.locator('.stats').first(), 120);
await wait(400);
await caption('Bitcoin halves.', 900);
await press(button('Crash 50%'));
await wait(900);
await caption('Nothing happens. The contract has no idea what the price is.', 3400);
await caption('');

// The ticket.
const sign = button('Sign my escape ticket');
await reveal(sign, 420);
await caption('You sign your own way out, and keep it as a file.', 900);
await press(sign);
await notice('Ticket signed');
await wait(2000);
await caption('');

// Everything off.
await scrollTo(0, 500);
await press(page.getByRole('link', { name: 'Try to switch it off' }).first());
await page.getByText('Pull everything').first().waitFor();
await wait(600);
const handle = button('Pull the ripcord');
await reveal(page.locator('.room').first(), 90);
await caption('Now switch everything off. The website. 1Click. The signers. NEAR itself.', 900);
await press(handle);
await page.getByText('Everything is off', { exact: false }).first().waitFor({ timeout: 40000 });
await caption('Everything is off. Bitcoin refuses the ticket until its block.');
await page.getByText('Bitcoin keeps making blocks', { exact: false }).first().waitFor({ timeout: 40000 });
const logBox = page.locator('ol.log');
await reveal(logBox, 90);
await page.getByText('is back in the borrower', { exact: false }).first().waitFor({ timeout: 40000 });
await caption('Then it accepts it. The coins are home, with nothing else running.', 4200);
await caption('');

// What NEAR gets.
await scrollTo(0, 500);
await press(page.getByRole('link', { name: 'What NEAR gets' }).first());
await page.getByText('Every Bitcoin loan makes NEAR stronger').first().waitFor();
await wait(800);
await reveal(page.getByText('Four things NEAR gets').first(), 90);
await caption('Every loan stakes NEAR with validators, for good, through a contract with no keys.', 4200);
await caption('');

// The same contracts, on real networks.
if (proofTx) {
  // Skip the page load: the viewer goes straight from the app to the loaded explorer.
  await cdp.send('Page.stopScreencast');
  cuts.add(frames.length - 1);
  await page.goto(`https://mempool.space/testnet/tx/${proofTx}`, { waitUntil: 'domcontentloaded' });
  await page.getByText(proofTx.slice(0, 8), { exact: false }).first().waitFor({ timeout: 30000 });
  await dress('');
  await page.getByRole('button', { name: /Details/ }).first().click({ timeout: 8000 });
  const script = page.getByText('OP_IF', { exact: true }).first();
  await script.waitFor({ timeout: 8000 });
  await page.evaluate(() => document.getElementById('demo-cursor').remove());
  await script.evaluate((el) => {
    el.style.scrollMarginTop = '140px';
    el.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await wait(1200);
  await cdp.send('Page.startScreencast', screencast);
  await wait(500);
  await caption('And on real networks. A NEAR contract signed this spend on Bitcoin testnet, through this script.', 5400);
}
await caption('Every hash is in the repo. Try switching it off yourself. Built at NEAR HACKATHON.', 4200);

await cdp.send('Page.stopScreencast');
await browser.close();

if (errors.length) {
  console.error(`page errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}

// Each frame stays on screen until the next one arrived.
const lines = [];
frames.forEach((f, i) => {
  const next = frames[i + 1]?.t ?? f.t + 2;
  lines.push(`file '${f.name}'`, `duration ${(cuts.has(i) ? 0.2 : next - f.t).toFixed(4)}`);
});
lines.push(`file '${frames.at(-1).name}'`);
const list = join(dir, 'frames.txt');
writeFileSync(list, `${lines.join('\n')}\n`);

const r = spawnSync(
  ffmpeg,
  ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-threads', '2', '-movflags', '+faststart', out],
  { stdio: 'inherit' },
);
rmSync(dir, { recursive: true, force: true });
if (r.status !== 0) throw new Error('ffmpeg failed');
console.log(`${out}: ${frames.length} frames`);
