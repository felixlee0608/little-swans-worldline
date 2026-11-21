// Deterministic headless capture for little-swans.
// Uses playwright-core + a local Chrome/Chromium (Playwright cache or Google Chrome).
//
//   1)  node tools/serve.mjs &
//   2)  node tools/capture.mjs
//
// Writes qa/screenshots/{00-gate,01-opening,02-line,03-worldlines,04-closeup,05-mobile}.png,
// qa/console.log and qa/run-data.json.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  console.error('capture.mjs 需要 playwright-core：`npm i -D playwright-core`，或设置 WD_PLAYWRIGHT_DIR 指向已安装它的目录。');
  process.exit(2);
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const URL_BASE = arg('url', 'http://127.0.0.1:8782/');
const OUT = join(arg('out', PROJ), 'qa', 'screenshots');
const DATA = join(arg('out', PROJ), 'qa', 'run-data.json');
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.WD_CHROMIUM) return process.env.WD_CHROMIUM;
  // fall back to the installed Google Chrome when the Playwright cache has been cleaned
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

const LAUNCH = {
  args: ['--use-angle=metal', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu',
         '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--mute-audio'],
  headless: true, timeout: 120000,
};

const logs = [];
const errors = [];
const shots = [];
const snap = (page) => page.evaluate(() => window.__ls.snap());
const shoot = async (page, file, note) => {
  await page.waitForTimeout(280);
  await page.screenshot({ path: join(OUT, file) });
  shots.push({ file: `qa/screenshots/${file}`, note });
};

async function main() {
  const exe = findChromium();
  if (!exe) throw new Error('no cached Chromium found; set WD_CHROMIUM');
  const browser = await chromium.launch({ ...LAUNCH, executablePath: exe });
  const data = { url: URL_BASE, browserVersion: browser.version(), shots, notes: [] };

  // ---- 1) the opening gate, then a real Enter click (that gesture starts the music) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(120000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ tag: 'gate', type: m.type(), text: m.text() }); });
    page.on('pageerror', (e) => errors.push({ tag: 'gate', text: String(e) }));
    await page.goto(URL_BASE + '?debug', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ls && window.__ls.app.state === 'ready' && !document.getElementById('enter').disabled, null, { timeout: 120000 });
    await page.waitForTimeout(900);
    await shoot(page, '00-gate.png', 'opening gate: title + Enter (the click unlocks the soundtrack)');
    data.gate = await page.evaluate(() => ({ title: document.title, load: document.getElementById('load')?.textContent }));

    await page.click('#enter');
    await page.waitForFunction(() => window.__ls && window.__ls.app.state === 'playing', null, { timeout: 90000 });
    await page.waitForTimeout(2600);       // gate fade (1.4s) + music start
    data.audio = await page.evaluate(() => {
      const m = window.__ls.app.music;
      if (!m) return null;
      const pos = typeof m._position === 'function' && m.ready ? m._position() : null;
      const dur = m.buffer?.duration ?? m.duration ?? 0;
      return { ctx: m.ctx?.state, ready: m.ready, muted: m.muted, duration: +dur.toFixed(2), bpm: m.bpm, sections: m.sections, pos: pos == null ? null : +pos.toFixed(2) };
    });
    await page.evaluate(() => { window.__ls.app.controls.autoRotate = false; });
    await page.evaluate(() => window.__ls.frames(60 * 4));
    await shoot(page, '01-opening.png', 'after Enter: the four cygnets in the dark, first poses freezing');

    // T ≈ 22s: the line dances, worldlines have started to rise
    await page.evaluate(() => window.__ls.frames(60 * 14));
    await page.evaluate(() => window.__ls.look([2.9, 2.45, 9.3], [-0.35, 1.42, -1.8]));
    await page.evaluate(() => window.__ls.frames(3));
    await shoot(page, '02-line.png', 'T≈22s: the little swans line up; four ghost worldlines rising behind them');
    data.line = await snap(page);

    // hover the past: the figure of that moment should appear on the worldline
    const hoverPt = await page.evaluate(() => {
      const app = window.__ls.app, THREE = window.__ls.THREE;
      const wl = app.ghosts.worldlines[1];
      const n = wl.pos.length / 3, v = new THREE.Vector3();
      const k = Math.floor(n * 0.42);
      v.set(wl.pos[k * 3], wl.pos[k * 3 + 1], wl.pos[k * 3 + 2]).project(app.camera);
      return { x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight) };
    });
    await page.mouse.move(hoverPt.x, hoverPt.y);
    await page.waitForTimeout(350);
    await shoot(page, '06-hover.png', 'hovering the past: the figure of that moment appears on the worldline');
    data.hover = await snap(page);
    await page.mouse.move(40, 850);
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__ls.look([2.9, 2.45, 9.3], [-0.35, 1.42, -1.8]));

    // T ≈ 38s: side view to read the worldline arcs
    await page.evaluate(() => window.__ls.frames(60 * 16));
    await page.evaluate(() => window.__ls.look([5.4, 2.25, 7.4], [-0.7, 1.65, -2.3]));
    await page.evaluate(() => window.__ls.frames(3));
    await shoot(page, '03-worldlines.png', 'T≈38s: side view — four sculptures of frozen poses along the worldlines');

    // T ≈ 76s: close-up of the porcelain and the ghost feathers
    await page.evaluate(() => window.__ls.frames(60 * 38));
    await page.evaluate(() => window.__ls.look([1.7, 1.45, 4.3], [-0.9, 1.05, -0.5]));
    await page.evaluate(() => window.__ls.frames(3));
    await shoot(page, '04-closeup.png', 'T≈76s: close-up — porcelain cygnet, gold trim, feathery ghost trail');

    // curtain call: the bow in the last bars, then the line walking off
    await page.evaluate(() => window.__ls.look([2.9, 2.45, 9.3], [-0.35, 1.42, -1.8]));
    await page.evaluate(() => { const a = window.__ls.app; a.frozen = true; a.T = 90.9; a.ui.setState('vi · 谢幕'); });
    await page.evaluate(() => window.__ls.frames(1));
    await shoot(page, '07-bow.png', 'curtain call: the four bow together while the last bars play');
    data.bow = await snap(page);

    await page.evaluate(() => { window.__ls.app.T = 93.6; window.__ls.app.ui.setState('vi · 谢幕'); });
    await page.evaluate(() => window.__ls.frames(1));
    await shoot(page, '08-exit.png', 'curtain call: the linked line walks off stage right, the stage dims');
    data.exit = await snap(page);
    await page.evaluate(() => { window.__ls.app.frozen = false; });

    data.perf = await page.evaluate(() => window.__ls.perf(2));
    data.mid = await snap(page);
    data.musicAtEnd = await page.evaluate(() => {
      const m = window.__ls.app.music;
      if (!m) return null;
      const pos = typeof m._position === 'function' && m.ready ? m._position() : null;
      return { pos: pos == null ? null : +pos.toFixed(2), ctx: m.ctx?.state, muted: m.muted };
    });
    await ctx.close();
  }

  // ---- 2) mobile portrait ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(120000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ tag: 'mobile', type: m.type(), text: m.text() }); });
    page.on('pageerror', (e) => errors.push({ tag: 'mobile', text: String(e) }));
    await page.goto(URL_BASE + '?debug&skip', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ls && window.__ls.app.state === 'playing', null, { timeout: 90000 });
    await page.waitForTimeout(2200);
    await page.evaluate(() => { window.__ls.app.controls.autoRotate = false; });
    await page.evaluate(() => window.__ls.frames(60 * 10));
    await page.evaluate(() => window.__ls.look([2.6, 2.1, 13.4], [-0.3, 1.5, -1.7]));
    await page.evaluate(() => window.__ls.frames(3));
    await shoot(page, '05-mobile.png', 'mobile 390×844');
    data.mobile = await snap(page);
    await ctx.close();
  }

  await browser.close();
  data.logs = logs;
  data.errors = errors;
  writeFileSync(DATA, JSON.stringify(data, null, 1));
  writeFileSync(join(PROJ, 'qa', 'console.log'),
    logs.map((l) => `[${l.tag}/${l.type}] ${l.text}`).join('\n') +
    (errors.length ? (logs.length ? '\n' : '') + errors.map((e) => `[${e.tag}/pageerror] ${e.text}`).join('\n') : ''));
  console.log(JSON.stringify({ shots, errors, logs, audio: data.audio, gate: data.gate, line: data.line, mid: data.mid, perf: data.perf, mobile: data.mobile }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
