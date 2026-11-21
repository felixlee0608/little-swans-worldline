#!/usr/bin/env node
// Render the deterministic film version of little-swans.
//
//   node tools/render-film.mjs                 # 1080p30 → film/little-swans-film-1080p30.mp4
//   node tools/render-film.mjs --fps 60 ...    # slower, smoother
//
// Requirements: a local Chrome/Chromium (Google Chrome or the Playwright cache) and ffmpeg.
// playwright-core is optional: install it (`npm i -D playwright-core`) or point WD_PLAYWRIGHT_DIR
// at a directory that already has it (same mechanism as tools/capture.mjs).
//
// The page is loaded in film mode (?film=1): scripted camera, title/captions, bottom timeline and
// the four-worldline history rail. Every frame is stepped deterministically (no wall-clock timing),
// captured as JPEG and piped straight into ffmpeg together with the original soundtrack.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = join(HERE, '..');
const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
if (!chromium && process.env.WD_PLAYWRIGHT_DIR) {
  const req2 = createRequire(join(process.env.WD_PLAYWRIGHT_DIR, 'noop.js'));
  ({ chromium } = req2('playwright-core'));
}
if (!chromium) {
  console.error('需要 playwright-core：`npm i -D playwright-core`，或设置 WD_PLAYWRIGHT_DIR。');
  process.exit(2);
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const FPS = Number(arg('fps', 30));
const W = Number(arg('width', 1920));
const H = Number(arg('height', 1080));
const CRF = String(arg('crf', 18));
const PRESET = arg('preset', 'medium');
const AUDIO = arg('audio', join(PROJ, 'assets/audio/swan-lake-source.mp3'));
const OUT = arg('out', join(PROJ, 'film', `little-swans-film-${W}x${H}-${FPS}fps.mp4`));
const URL_BASE = arg('url', 'http://127.0.0.1:8782/?debug&skip&film=1');
mkdirSync(dirname(OUT), { recursive: true });

function findChromium() {
  if (process.env.WD_CHROMIUM) return process.env.WD_CHROMIUM;
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const base = join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  if (!existsSync(base)) return existsSync(sys) ? sys : null;
  const builds = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
  for (const b of builds) {
    for (const sub of [['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
                       ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
                       ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
      const p = join(base, b, ...sub);
      if (existsSync(p)) return p;
    }
  }
  return existsSync(sys) ? sys : null;
}

const exe = findChromium();
if (!exe) { console.error('找不到 Chrome/Chromium，可用 WD_CHROMIUM 指定路径。'); process.exit(2); }

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  timeout: 120000,
  args: ['--use-angle=metal', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu',
         '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultNavigationTimeout(180000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

console.log(`[film] opening ${URL_BASE}`);
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__ls && window.__ls.app.state === 'playing', null, { timeout: 150000 });
await page.waitForTimeout(600);

const total = await page.evaluate(() => {
  window.__ls.filmStart();
  return window.__ls.app.duration;
});
const frames = Math.round(total * FPS);
console.log(`[film] duration ${total.toFixed(3)}s, ${frames} frames @ ${FPS}fps → ${OUT}`);

// ffmpeg: JPEG frames from stdin + the original soundtrack
const ff = spawn('ffmpeg', [
  '-y', '-v', 'warning',
  '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-i', AUDIO,
  '-t', String(total),
  '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-shortest', '-movflags', '+faststart',
  OUT,
], { stdio: ['pipe', 'inherit', 'inherit'] });

let ffErr = null;
ff.on('error', (e) => { ffErr = e; });
ff.on('close', (code) => { ffErr = code === 0 ? null : new Error('ffmpeg exited ' + code); });

const t0 = Date.now();
let lastReport = 0;
for (let i = 0; i < frames; i++) {
  const T = Math.min(total, (i + 1) / FPS);
  await page.evaluate(({ dt, T }) => window.__ls.filmStep(dt, T), { dt: 1 / FPS, T });
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  if (i - lastReport >= 120 || i === frames - 1) {
    lastReport = i;
    const el = (Date.now() - t0) / 1000;
    console.log(`[film] ${i + 1}/${frames}  ${(el).toFixed(1)}s  ~${((el / (i + 1)) * (frames - i - 1)).toFixed(0)}s left`);
  }
}
ff.stdin.end();
await once(ff, 'close');
if (ffErr) throw ffErr;
await browser.close();

if (errors.length) console.log('[film] page errors:', errors.slice(0, 8));

// verify + report
const probe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate',
  '-of', 'json', OUT], { stdio: ['ignore', 'pipe', 'inherit'] });
let json = '';
probe.stdout.on('data', (d) => { json += d; });
await once(probe, 'close');
const info = JSON.parse(json);
const v = info.streams.find((s) => s.codec_name && s.codec_name !== 'aac') || {};
const a = info.streams.find((s) => s.codec_name === 'aac');
console.log(`[film] done: ${OUT}`);
console.log(`[film] ${v.codec_name || 'video'} ${v.width}x${v.height} @ ${v.r_frame_rate}, audio ${a ? a.codec_name : 'none'}, duration ${Number(info.format.duration).toFixed(2)}s, ${(Number(info.format.size) / 1048576).toFixed(1)} MB`);
writeFileSync(join(dirname(OUT), 'render-info.json'), JSON.stringify({ out: OUT, fps: FPS, frames, total, info, errors }, null, 2));
