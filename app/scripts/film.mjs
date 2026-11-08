// Films a page in a real browser, with a voice. Each line of a script is spoken by a voice
// built into Windows (voice.ps1) and appears in the page's #demo-caption element. A line's
// voice starts with the first frame drawn after its caption was set, and the next line waits
// for it to finish, so voice and captions stay together. record-demo.mjs and
// record-explainer.mjs use it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const clock = () => Date.now() / 1000;

// A voice may spell a word in capitals letter by letter, so it is given them in lower case.
const spoken = (text) => text.replace(/\bNEAR\b/g, 'Near').replace(/\bHACKATHON\b/g, 'Hackathon').replaceAll('’', "'");

const stamp = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Opens a browser and readies the voice for `lines`, which maps a name to its words. `voice`
 * picks a Windows voice by name, or 'off' for captions only. `pause` is the quiet, in seconds,
 * between two lines.
 */
export async function film({ lines, voice = 'Heera', rate = '1', pause = 0.3, width = 1920, height = 1080 }) {
  const dir = mkdtempSync(join(tmpdir(), 'ripcord-film-'));
  const clips = voice === 'off' ? null : speakAll(lines, voice, rate, dir);
  const browser = await chromium.launch({ channel: process.env.UI_BROWSER ?? 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width, height }, bypassCSP: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const wait = (ms) => page.waitForTimeout(ms);

  // Frames arrive only when something on screen changes, so a still screen while a line is
  // spoken sends none. Each carries the time it was drawn, by the same clock as Date.now(), and
  // can be drawn up to half a second after the change it shows. A cut skips a page load: the
  // last frame before it stays up until the recording paused, and the rest of the gap is dropped.
  const frames = [];
  const cuts = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    const name = `f${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
    frames.push({ name, t: metadata.timestamp, seen: clock() });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const screencast = { format: 'jpeg', quality: 88, maxWidth: width, maxHeight: height, everyNthFrame: 1 };

  const said = [];
  /** How long a line takes to say. Without a voice, long enough to read its caption. */
  const seconds = (key) => (clips ? clips[key].seconds : 0.8 + lines[key].split(' ').length / 3);
  /** When a line's voice starts: with the first frame drawn after its caption was set. */
  const voiceStart = ({ shown }) => frames.find((f) => f.t >= shown)?.t ?? shown;

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

  /** Waits until the line being said is finished. */
  async function settle() {
    const line = said.at(-1);
    if (!line) return;
    // Its voice starts with the first frame drawn after its caption was set, so wait for that
    // frame to arrive before working out when the line ends.
    for (let i = 0; i < 40 && !frames.some((f) => f.t >= line.shown); i++) await wait(25);
    const left = voiceStart(line) + line.seconds + pause - clock();
    if (left > 0) await wait(Math.ceil(left * 1000));
  }

  return {
    page,
    wait,
    seconds,
    settle,

    /** Starts recording. */
    roll: () => cdp.send('Page.startScreencast', screencast),

    /** Runs `first`, if given, then shows a line as the caption and starts saying it. */
    async say(key, first) {
      await settle();
      if (first) await first();
      const shown = await caption(lines[key]);
      said.push({ key, shown, seconds: seconds(key) });
    },

    /** Waits for the line being said, then clears the caption. */
    async quiet(ms = 300) {
      await settle();
      await caption('');
      if (ms) await wait(ms);
    },

    /** Pauses the recording while `during` runs, such as a page load the viewer need not see. */
    async cut(during) {
      await wait(600); // let the last change be drawn, so the cut lands after it
      cuts.push(clock());
      await cdp.send('Page.stopScreencast');
      await during();
      await cdp.send('Page.startScreencast', screencast);
    },

    /** Lets the last line finish, stops, and writes the video with its sound track. */
    async wrap(out, ffmpeg = process.env.FFMPEG ?? 'ffmpeg') {
      await settle();
      await wait(600);
      const ended = clock();
      await cdp.send('Page.stopScreencast');
      await browser.close();
      if (errors.length) {
        console.error(`page errors:\n${errors.join('\n')}`);
        process.exitCode = 1;
      }

      // Frame times and Date.now() share one clock here: a frame reaches this script a moment
      // after it was drawn. If a browser ever used another clock, the voice could not be placed.
      const lag = frames.map((f) => f.seen - f.t).sort((a, b) => a - b)[frames.length >> 1];
      if (!(Math.abs(lag) < 5)) throw new Error(`frame times are ${lag}s off Date.now(), so the voice cannot be placed`);

      // Each frame stays on screen until the next one was drawn, or the recording paused for a
      // cut, and the last until the recording ended.
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
      const inVideo = (t) => {
        let i = frames.length - 1;
        while (i > 0 && frames[i].t > t) i--;
        return starts[i] + Math.min(Math.max(t - frames[i].t, 0), durations[i]);
      };

      // Where each line starts in the finished video. A line still being said when the next
      // one starts would be cut off, so that fails the take.
      const placed = said.map((line) => ({ key: line.key, at: inVideo(voiceStart(line)) }));
      placed.forEach(({ key, at }, i) => {
        console.log(`${stamp(at)}  ${lines[key]}`);
        const until = at + (clips ? clips[key].seconds : 0);
        const next = placed[i + 1]?.at ?? total;
        if (until > next + 0.05) {
          console.error(`  This line is cut off ${(until - next).toFixed(1)}s before its end.`);
          process.exitCode = 1;
        }
      });

      const list = frames.flatMap((f, i) => [`file '${f.name}'`, `duration ${durations[i].toFixed(4)}`]);
      list.push(`file '${frames.at(-1).name}'`);
      writeFileSync(join(dir, 'frames.txt'), `${list.join('\n')}\n`);

      // One sound track: each line placed where its caption appeared, silence between.
      const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt')];
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
      return { total, placed };
    },
  };
}

/** Speaks every line into its own clip before recording, so each scene can wait for its words. */
function speakAll(lines, voice, rate, dir) {
  const file = join(dir, 'lines.json');
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(lines).map(([k, t]) => [k, spoken(t)]))));
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'voice.ps1'), '-Lines', file, '-Out', join(dir, 'voice'), '-Voice', voice, '-Rate', String(rate)],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`voice.ps1 failed. Set VOICE=off to record without a voice.\n${r.stderr || r.stdout || r.error}`);
  console.log(r.stdout.trim());
  const made = Object.fromEntries(Object.keys(lines).map((k) => [k, trimmed(readWav(join(dir, 'voice', `${k}.wav`)))]));
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
