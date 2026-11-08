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

import { resolve } from 'node:path';
import { film } from './film.mjs';

const out = resolve(process.argv[2] ?? 'ripcord-demo.mp4');
const base = process.argv[3] ?? 'http://localhost:4179/';
const proofTx = process.env.PROOF_TX;
const ZOOM = 1.5; // the page lays out as if 1280 wide, and draws crisply at 1920

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

const shoot = await film({ lines: LINES, voice: process.env.VOICE ?? 'Heera', rate: process.env.RATE ?? '1.08', pause: 0.25 });
const { page, wait, say, settle, quiet } = shoot;

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
await shoot.roll();

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
  // Skip the page load: the viewer goes straight from the app to the loaded explorer.
  await shoot.cut(async () => {
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
  });
  await wait(500);
  await say('real');
}
await say('end');
await shoot.wrap(out);
