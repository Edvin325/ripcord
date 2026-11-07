// Records the demo video from the built site, in a real browser: a whole loan, a price
// crash, and the ripcord with everything switched off. Captions and a cursor are drawn into
// the page, so what you see is the real app, running the real compiled contracts.
//
//   npx vite preview --port 4179 --strictPort &
//   FFMPEG=path/to/ffmpeg node scripts/record-demo.mjs ripcord-demo.mp4 http://localhost:4179/

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const out = resolve(process.argv[2] ?? 'ripcord-demo.mp4');
const base = process.argv[3] ?? 'http://localhost:4179/';
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 1.5; // so the frames are 1920x1080 and the text stays crisp

const dir = mkdtempSync(join(tmpdir(), 'ripcord-demo-'));
const browser = await chromium.launch({ channel: process.env.UI_BROWSER ?? 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Frames arrive only when something on screen changes, each with its own timestamp.
const frames = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  const name = `f${String(frames.length).padStart(6, '0')}.jpg`;
  writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
  frames.push({ name, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});

const wait = (ms) => page.waitForTimeout(ms);

async function dress() {
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
      html { scroll-behavior: smooth; }
    `,
  });
  await page.evaluate(() => {
    for (const id of ['demo-caption', 'demo-cursor']) {
      const el = document.createElement('div');
      el.id = id;
      document.body.append(el);
    }
  });
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
  const top = await locator.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  await scrollTo(Math.max(0, top - offset));
}

async function press(locator) {
  const box = await locator.boundingBox();
  await page.evaluate(
    ([x, y]) => {
      const c = document.getElementById('demo-cursor');
      c.style.left = `${x}px`;
      c.style.top = `${y}px`;
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  await wait(620);
  await page.evaluate(() => document.getElementById('demo-cursor').classList.add('down'));
  await wait(130);
  await locator.click();
  await page.evaluate(() => document.getElementById('demo-cursor').classList.remove('down'));
}

const button = (name, exact = false) => page.getByRole('button', { name, exact }).first();
const notice = (text) => page.locator('.notice').filter({ hasText: text }).first().waitFor({ timeout: 15000 });

await page.goto(base);
await page.getByText('Borrow against Bitcoin that never leaves Bitcoin').first().waitFor();
await dress();
await wait(500);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: WIDTH * SCALE, maxHeight: HEIGHT * SCALE, everyNthFrame: 1 });

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
await caption('You lock real Bitcoin in your own vault address.', 900);
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
await deliver.selectOption('base');
await page.locator('.quote-line, .intents .muted').filter({ hasText: /Live quote from NEAR Intents|No live quote/ }).first().waitFor({ timeout: 15000 });
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
await caption('Every loan stakes NEAR with validators, for good, through a contract with no keys.', 4200);
await caption('Try switching it off yourself. Built at NEAR HACKATHON.', 3800);

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
  lines.push(`file '${f.name}'`, `duration ${(next - f.t).toFixed(4)}`);
});
lines.push(`file '${frames.at(-1).name}'`);
const list = join(dir, 'frames.txt');
writeFileSync(list, `${lines.join('\n')}\n`);

const r = spawnSync(
  ffmpeg,
  ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-threads', '2', '-movflags', '+faststart', out],
  { stdio: 'inherit' },
);
const seconds = frames.at(-1).t - frames[0].t + 2;
rmSync(dir, { recursive: true, force: true });
if (r.status !== 0) throw new Error('ffmpeg failed');
console.log(`${out}: ${frames.length} frames, ${seconds.toFixed(1)} seconds`);
