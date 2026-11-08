// Records the plain-words explainer: what goes wrong when people borrow against Bitcoin today,
// and how Ripcord fixes it, with no technical words. A voice tells the story and its words
// appear as captions. The drawings are scripts/explainer.html, played in a real browser.
//
//   FFMPEG=path/to/ffmpeg node scripts/record-explainer.mjs ripcord-explained.mp4
//   node scripts/record-explainer.mjs --stills folder     (a picture of each step, to check them)
//
// VOICE and RATE work as in record-demo.mjs. Keep the video under 2:20, for X.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { film } from './film.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The story, in order. Each line is spoken and shown as the caption, and explainer.html draws
// its picture. Keep the words plain enough for anyone.
const LINES = {
  own: 'Say you own some Bitcoin, and you need cash.',
  keep: 'You don’t want to sell it. So you borrow, and offer your Bitcoin as a guarantee, like a gold loan.',
  handOver: 'But today, you have to hand your Bitcoin over to the lender.',
  lost: 'If that company is hacked, or goes bust, your Bitcoin can be lost. In 2022, this happened to many people.',
  price: 'And if the price drops suddenly, even for a few minutes, your Bitcoin can be sold automatically, even though you did nothing wrong.',
  fix: 'Ripcord fixes both problems.',
  safe: 'Your Bitcoin goes into a safe of its own, on the Bitcoin network. It never leaves, and no company holds it.',
  keyOne: 'The safe has two keys. The first belongs to the loan program, which follows fixed rules. When you repay, it gives your Bitcoin back.',
  keyTwo: 'The second key is yours alone. It only works after a date you choose at the start.',
  crash: 'Nobody watches the price. If it crashes, nothing happens. You just repay on time.',
  unpaid: 'If you don’t repay, your Bitcoin is sold to pay the lender, and you get the rest.',
  breaks: 'And if everything breaks, the website, the company, even the NEAR network itself, your key still works.',
  home: 'After your date, you take your Bitcoin back, and Bitcoin itself allows it.',
  ripcord: 'That’s the ripcord. Like the cord on a parachute, it’s your way out when everything else fails.',
  near: 'Every loan also gives back. Part of the fees helps secure the NEAR network, for good.',
  end: 'Ripcord. Borrow against your Bitcoin, and keep it yours. Built at NEAR HACKATHON.',
};

/** Serves the drawings and the app's own fonts from one made-up address. */
async function serve(page) {
  const fonts = join(here, '..', 'node_modules', '@fontsource');
  await page.route('http://explainer.local/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ path: join(here, 'explainer.html') });
    const font = path.match(/^\/fonts\/((barlow-condensed|ibm-plex-sans)-latin-\d00-normal\.woff2)$/);
    if (font) return route.fulfill({ path: join(fonts, font[2], 'files', font[1]) });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('http://explainer.local/');
  await page.evaluate(() => document.fonts.ready);
}

if (process.argv[2] === '--stills') {
  // Each step with all its parts in, and its caption, to check the drawings without a voice.
  const folder = resolve(process.argv[3] ?? 'explainer-stills');
  mkdirSync(folder, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.UI_BROWSER ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serve(page);
  let n = 0;
  for (const [key, words] of Object.entries(LINES)) {
    await page.evaluate(([k, w]) => {
      window.stage(k);
      window.cue(k, w, 0);
      const caption = document.getElementById('demo-caption');
      caption.textContent = w;
      caption.classList.add('on');
    }, [key, words]);
    await page.waitForTimeout(2600);
    await page.screenshot({ path: join(folder, `${String(++n).padStart(2, '0')}-${key}.png`) });
  }
  await browser.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`${n} stills in ${folder}`);
} else {
  const out = resolve(process.argv[2] ?? 'ripcord-explained.mp4');
  const shoot = await film({ lines: LINES, voice: process.env.VOICE ?? 'Heera', rate: process.env.RATE ?? '1', pause: 0.45 });
  const { page, wait } = shoot;
  await serve(page);
  await shoot.roll();
  await wait(400);
  for (const key of Object.keys(LINES)) {
    await shoot.say(key, async () => {
      // A new scene fades in before its first line is said.
      if (await page.evaluate((k) => window.stage(k), key)) await wait(750);
      await page.evaluate(([k, w, s]) => window.cue(k, w, s), [key, LINES[key], shoot.seconds(key)]);
    });
  }
  await shoot.settle();
  await wait(900); // hold the last picture
  await shoot.wrap(out);
}
