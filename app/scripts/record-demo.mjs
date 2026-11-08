// Records the demo video from the built site, in a real browser: a whole loan, a price
// crash, and the ripcord with everything switched off. A voice explains each step, and its
// words appear as captions. Captions and a cursor are drawn into the page, so what you see is
// the real app, running the real compiled contracts.
//
//   npx vite preview --port 4179 --strictPort &
//   FFMPEG=path/to/ffmpeg node scripts/record-demo.mjs ripcord-demo.mp4 http://localhost:4179/
//
// Set PROOF_TX to a Bitcoin testnet3 transaction to close on it in a public block explorer.
// The voice is one built into Windows, spoken through scripts/voice.ps1. VOICE picks it by name
// (default Heera), RATE sets its speed (default 1.08), and VOICE=off records captions only,
// which also works on other systems. Keep the video under 2:20, the longest X takes from
// accounts without Premium.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? 'ripcord-demo.mp4');
const base = process.argv[3] ?? 'http://localhost:4179/';
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const proofTx = process.env.PROOF_TX;
const voice = process.env.VOICE ?? 'Heera';
const rate = process.env.RATE ?? '1.08';
const WIDTH = 1920;
const HEIGHT = 1080;
const ZOOM = 1.5; // the page lays out as if 1280 wide, and draws crisply at 1920
const PAUSE = 0.25; // seconds of quiet between two lines

// What the voice says, in the order it says it. Each line is the caption while it is spoken.
const LINES = {
  problem: 'To borrow against Bitcoin today, you hand your coins to someone else.',
  dip: 'And a sudden price dip can get them sold.',
  locks: 'Ripcord keeps your coins on Bitcoin, in an address with two locks.',
  lockOne: 'Lock one opens for a NEAR contract, which runs the loan.',
  lockTwo: 'Lock two opens only for you, after a set block. Bitcoin itself enforces it.',
  offers: 'Lenders set their own price per bitcoin, so there is no price feed.',
  vault: 'You open a vault, and save a recovery key only you hold.',
  send: 'You send bitcoin to the vault. Here Bitcoin is simulated, but the contracts are real.',
  prove: 'NEAR checks the deposit with its Bitcoin light client. Nothing is bridged.',
  borrow: 'Now you borrow dollars. NEAR Intents can deliver them to another chain, like Base. This price is live.',
  where: 'The app shows where your money is at every step.',
  simulated: 'This delivery is simulated, because Intents has no test network.',
  crash: 'Now the price of Bitcoin falls by half.',
  nothing: 'Nothing happens. The contract never looks at a price.',
  repay: 'You just repay by the due date, and your coins are released.',
  ticket: 'Next, you sign an escape ticket and keep it as a file. It uses lock two, and works only after your block.',
  off: 'This runs a loan, then switches everything off: the website, NEAR Intents, the signers, even NEAR.',
  refuse: 'Bitcoin refuses the ticket, because your block has not come yet.',
  home: 'When your block comes, Bitcoin accepts it. Your coins are home, with nothing else running.',
  near: 'Ripcord helps NEAR too. Its fees are staked with NEAR validators, for good, by a contract with no keys.',
  real: 'This part is real. A NEAR contract signed this spend on Bitcoin’s test network.',
  end: 'Built at NEAR HACKATHON.',
};
// A voice may spell a word in capitals letter by letter, so it is given them in lower case.
const spoken = (text) => text.replace(/\bNEAR\b/g, 'Near').replace(/\bHACKATHON\b/g, 'Hackathon').replaceAll('’', "'");

const clock = () => Date.now() / 1000;
const dir = mkdtempSync(join(tmpdir(), 'ripcord-demo-'));
const clips = voice === 'off' ? null : speakAll();

const browser = await chromium.launch({ channel: process.env.UI_BROWSER ?? 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, bypassCSP: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Frames arrive only when something on screen changes, so a still screen while a line is
// spoken sends none. Each carries the time it was drawn, by the same clock as Date.now(), and
// can be drawn up to half a second after the change it shows. A cut skips a page load: the
// last frame before it stays up until the recording paused, and the rest of the gap is dropped.
const frames = [];
const cuts = []; // when the recording paused, by clock()
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  const name = `f${String(frames.length).padStart(6, '0')}.jpg`;
  writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
  frames.push({ name, t: metadata.timestamp, seen: clock() });
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

/** Sets the caption, and returns when the page made the change, in seconds. */
async function caption(text) {
  const ms = await page.evaluate((t) => {
    const el = document.getElementById('demo-caption');
    el.textContent = t;
    el.classList.toggle('on', Boolean(t));
    return Date.now();
  }, text);
  return ms / 1000;
}

// The voice. A line starts with the first frame that can show its caption, the page can act
// while it is spoken, and the next line waits for it to finish.
const said = [];

/** Shows a line as the caption and starts saying it. */
async function say(key) {
  await settle();
  const shown = await caption(LINES[key]);
  // Without a voice, each caption stays up long enough to read.
  const seconds = clips ? clips[key].seconds : 0.8 + LINES[key].split(' ').length / 3;
  said.push({ key, shown, seconds });
}

/** When a line's voice starts: with the first frame drawn after its caption was set. */
const voiceStart = ({ shown }) => frames.find((f) => f.t >= shown)?.t ?? shown;

/** Waits until the line being said is finished. */
async function settle() {
  const line = said.at(-1);
  const left = line ? voiceStart(line) + line.seconds + PAUSE - clock() : 0;
  if (left > 0) await wait(Math.ceil(left * 1000));
}

/** Waits for the line being said, then clears the caption. */
async function quiet(ms = 300) {
  await settle();
  await caption('');
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
  await wait(800);
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
 * The voice says this price is live, so it has to be. The API can refuse a burst of calls
 * from a shared connection, so ask again, and stop rather than film a false claim.
 */
async function liveQuote(select) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await select.selectOption('base');
    const line = page.locator('.intents p').filter({ hasText: /Live quote from NEAR Intents|No live quote/ }).first();
    await line.waitFor({ timeout: 20000 });
    if (/Live quote from NEAR Intents/.test(await line.textContent())) {
      if (attempt > 1) console.warn(`The live quote took ${attempt} tries. Check the take for a "No live quote" flash.`);
      return;
    }
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
await say('problem');
await say('dip');
await quiet();

// The idea.
await reveal(page.locator('figure.locks, .locks').first(), 100);
await say('locks');
await say('lockOne');
await say('lockTwo');
await quiet(0);

// A loan.
await scrollTo(0, 500);
await press(page.getByRole('link', { name: 'Borrow', exact: true }).first());
await page.getByText('Open offers').first().waitFor();
await wait(300);
await say('offers');
await settle();
const openVault = button('Open vault');
await reveal(openVault, 300);
await say('vault');
await press(openVault);
await notice('Vault opened');
await page.getByText('Save your recovery key').first().waitFor();

const sendCoins = button('Send from the simulated wallet');
await settle();
await reveal(sendCoins, 260);
await say('send');
await press(sendCoins);
await notice('confirmed');
const proof = button('Submit proof');
await settle();
await reveal(proof, 300);
await say('prove');
await press(proof);
await notice('Deposit proven');
await quiet();

// Borrow, with a live price from Intents.
const deliver = page.getByLabel('Deliver the dollars to');
await reveal(page.getByLabel('If you default, the auction opens at this price per BTC'), 160);
await say('borrow');
await liveQuote(deliver);
await page.getByLabel('Your address on Base').fill('0x2f3b1a3e7c1d9a8b6c5d4e3f2a1b0c9d8e7f6a5b');
await settle();
await press(button('Borrow and send to Base'));
await notice('NEAR Intents is taking the dollars to Base');
await say('where');
await page.getByText('No price can touch this loan').first().waitFor();
await reveal(page.locator('.money').first(), 120);
await say('simulated');
await page.locator('.transfer').filter({ hasText: 'Delivered on Base' }).first().waitFor({ timeout: 20000 });
await quiet();

// The crash.
await reveal(page.locator('.stats').first(), 120);
await say('crash');
await press(button('Crash 50%'));
await say('nothing');
await say('repay');
await quiet();

// The ticket.
const sign = button('Sign my escape ticket');
await reveal(sign, 420);
await say('ticket');
await press(sign);
await notice('Ticket signed');
await quiet();

// Everything off.
await scrollTo(0, 500);
await press(page.getByRole('link', { name: 'Try to switch it off' }).first());
await page.getByText('Pull everything').first().waitFor();
await wait(300);
const handle = button('Pull the ripcord');
await reveal(page.locator('.room').first(), 90);
await say('off');
await press(handle);
await page.getByText('Everything is off', { exact: false }).first().waitFor({ timeout: 40000 });
await say('refuse');
await page.getByText('Bitcoin keeps making blocks', { exact: false }).first().waitFor({ timeout: 40000 });
await reveal(page.locator('ol.log'), 90);
await page.getByText('is back in the borrower', { exact: false }).first().waitFor({ timeout: 40000 });
await say('home');
await quiet();

// What NEAR gets.
await scrollTo(0, 500);
await press(page.getByRole('link', { name: 'What NEAR gets' }).first());
await page.getByText('Every Bitcoin loan makes NEAR stronger').first().waitFor();
await wait(300);
await reveal(page.getByText('Four things NEAR gets').first(), 90);
await say('near');
await quiet(0);

// The same contracts, on real networks.
if (proofTx) {
  // Skip the page load: the viewer goes straight from the app to the loaded explorer. Let the
  // caption's fade be drawn first, so the cut lands after it.
  await wait(600);
  cuts.push(clock());
  await cdp.send('Page.stopScreencast');
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
  await say('real');
}
await say('end');
await settle();
await wait(600);
const ended = clock();

await cdp.send('Page.stopScreencast');
await browser.close();

if (errors.length) {
  console.error(`page errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}

// Frame times and Date.now() share one clock here: a frame reaches this script a moment after
// it was drawn. If a browser ever used another clock, the voice could not be placed.
const lag = frames.map((f) => f.seen - f.t).sort((a, b) => a - b)[frames.length >> 1];
if (!(Math.abs(lag) < 5)) throw new Error(`frame times are ${lag}s off Date.now(), so the voice cannot be placed`);

// Each frame stays on screen until the next one was drawn, or the recording paused for a cut,
// and the last until the recording ended.
const durations = frames.map((f, i) => {
  const next = i + 1 < frames.length ? frames[i + 1].t : ended;
  const cut = cuts.find((c) => c > f.t && c < next);
  return Math.max((cut ?? next) - f.t, 0.02);
});
const starts = [];
let total = 0;
for (const d of durations) {
  starts.push(total);
  total += d;
}

/** Where a moment of the recording falls in the finished video, after the cuts. */
function inVideo(t) {
  let i = frames.length - 1;
  while (i > 0 && frames[i].t > t) i--;
  return starts[i] + Math.min(Math.max(t - frames[i].t, 0), durations[i]);
}

const lines = [];
frames.forEach((f, i) => lines.push(`file '${f.name}'`, `duration ${durations[i].toFixed(4)}`));
lines.push(`file '${frames.at(-1).name}'`);
const list = join(dir, 'frames.txt');
writeFileSync(list, `${lines.join('\n')}\n`);

// Where each line starts in the finished video. A line still being said when the next one
// starts would be cut off, so that fails the take.
const placed = said.map((line) => ({ key: line.key, at: inVideo(voiceStart(line)) }));
const stamp = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
placed.forEach(({ key, at }, i) => {
  console.log(`${stamp(at)}  ${LINES[key]}`);
  const until = at + (clips ? clips[key].seconds : 0);
  const next = placed[i + 1]?.at ?? total;
  if (until > next + 0.05) {
    console.error(`  This line is cut off ${(until - next).toFixed(1)}s before its end.`);
    process.exitCode = 1;
  }
});

// One sound track: each line placed where its caption appeared, silence between.
const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
if (clips) {
  const hz = Object.values(clips)[0].rate;
  const track = new Int16Array(Math.ceil(total * hz));
  for (const { key, at } of placed) {
    const from = Math.round(at * hz);
    const room = Math.max(0, track.length - from);
    if (room > 0) track.set(clips[key].samples.subarray(0, room), from);
  }
  writeWav(join(dir, 'voice.wav'), hz, track);
  args.push('-i', join(dir, 'voice.wav'), '-map', '0:v', '-map', '1:a');
}
args.push('-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-threads', '2');
if (clips) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '128k');
args.push('-movflags', '+faststart', out);

const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
rmSync(dir, { recursive: true, force: true });
if (r.status !== 0) throw new Error('ffmpeg failed');
console.log(`${out}: ${stamp(total)} long, ${frames.length} frames, ${clips ? `${said.length} lines spoken` : 'no voice'}`);
if (total > 140) console.warn('This is longer than 2:20, so X will refuse it from an account without Premium.');

/** Speaks every line into its own clip before recording, so each scene can wait for its words. */
function speakAll() {
  const file = join(dir, 'lines.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(LINES).map(([k, t]) => [k, spoken(t)]))));
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'voice.ps1'), '-Lines', file, '-Out', join(dir, 'voice'), '-Voice', voice, '-Rate', rate],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`voice.ps1 failed. Set VOICE=off to record without a voice.\n${r.stderr || r.stdout || r.error}`);
  console.log(r.stdout.trim());
  const made = Object.fromEntries(Object.keys(LINES).map((k) => [k, trimmed(readWav(join(dir, 'voice', `${k}.wav`)))]));
  if (new Set(Object.values(made).map((c) => c.rate)).size !== 1) throw new Error('the voice gave clips at different sample rates');
  return made;
}

/** The samples of a 16-bit mono WAV file, which is what Windows' voices write. */
function readWav(file) {
  const b = readFileSync(file);
  let format;
  let data;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') format = { channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
    if (id === 'data') data = b.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (!format || !data || format.channels !== 1 || format.bits !== 16) throw new Error(`${file} is not 16-bit mono PCM`);
  const samples = new Int16Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { rate: format.rate, samples };
}

/** Cuts the silence a voice leaves at each end, keeping a breath of it. */
function trimmed({ rate: hz, samples }) {
  const first = samples.findIndex((s) => Math.abs(s) > 400);
  const last = samples.findLastIndex((s) => Math.abs(s) > 400);
  if (first < 0) return { rate: hz, samples, seconds: samples.length / hz };
  const breath = Math.round(hz * 0.05);
  const cut = samples.slice(Math.max(0, first - breath), Math.min(samples.length, last + breath));
  return { rate: hz, samples: cut, seconds: cut.length / hz };
}

function writeWav(file, hz, samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(hz, 24);
  b.writeUInt32LE(hz * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  writeFileSync(file, b);
}
