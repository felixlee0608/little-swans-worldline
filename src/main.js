// 小天鹅舞曲 · 瓷偶世界线
// Boot, render pipeline, camera, timeline, and the bridge between music / swans / ghosts / stage.
// The idea borrowed from "Worldline Dancer": every pose she holds freezes behind her as a sculpture;
// here four porcelain cygnets leave four ghost worldlines rising into the night.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createStage } from './stage.js';
import { Swan, SWAN_LOOP } from './swan.js';
import { Ghosts } from './ghosts.js';
import { Music } from './music.js';
import { UI } from './ui.js';
import { SCORE } from './score.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const LOW = params.has('low');
const SKIP_GATE = params.has('skip');

const SWAN_COUNT = 4;
const SPACING = 0.66;   // shoulder-to-shoulder, close to a real corps line; crossed hands clasp at the neighbours' midline
const SNAP_INTERVAL_DEFAULT = 0.2;
const HISTORY_DEFAULT = 12;

// ---------------------------------------------------------------- renderer / scene
const stageEl = document.getElementById('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
} catch (e) {
  showError('这台设备无法启动 WebGL2。请换用新版 Chrome / Edge / Safari。');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.78;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stageEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 220);
camera.layers.enable(1);   // stage's main-camera-only props (the hard moon core)
camera.position.set(1.85, 1.92, 6.35);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.minDistance = 3.2;
controls.maxDistance = 17;
controls.maxPolarAngle = Math.PI * 0.505;   // never go under the lake
controls.enablePan = false;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.65;
controls.target.set(-0.15, 1.20, -0.95);
controls.autoRotateSpeed = 0.28;

// ---------------------------------------------------------------- composer
const size = new THREE.Vector2();
renderer.getDrawingBufferSize(size);
const composerRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, composerRT);
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), LOW ? 0 : 0.26, 0.52, 1.35);
if (!LOW) composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- state
const app = {
  renderer, scene, camera, controls, composer, bloom,
  stage: null, swans: [], ghosts: null, music: null, ui: null,
  state: 'loading',           // loading → ready (gate) → playing → ended
  T: 0,                       // music / choreography time (seconds)
  time: 0,                    // wall clock
  frozen: false,
  frozenSculptureT: 0,   // while frozen the ghost sculpture holds this T (she can travel inside it)
  grab: null,             // { maxT } while the pointer is scrubbing her past
  rate: 1,
  userTouched: false,
  settings: { history: HISTORY_DEFAULT, interval: SNAP_INTERVAL_DEFAULT, density: 5 },
  muted: false,
  snapAcc: 0,
  lastSnapT: -1,
  duration: SCORE.totalDuration,
};

const smooth = (x) => x * x * (3 - 2 * x);

// UI → app actions (function declarations below are hoisted)
app.actions = { toggleFreeze, toggleMute, restart, toggleHidden: () => app.ui?.toggleHidden() };

// ---------------------------------------------------------------- boot
async function boot() {
  app.stage = await createStage({ renderer, scene, camera, hdriUrl: './assets/stage_1k.hdr' });

  const contactTex = makeContactShadow();
  for (let i = 0; i < SWAN_COUNT; i++) {
    const swan = new Swan({ index: i, spacing: SPACING });
    // the model's lowest point sits ~1.8 cm above its origin: drop the root so the pointe shoes touch the lake
    swan.root.position.set((i - (SWAN_COUNT - 1) / 2) * SPACING, -0.018, 0);
    // a soft contact shadow grounds the porcelain on the mirror (the mirror itself cannot receive cast shadows)
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, 0.55),
      new THREE.MeshBasicMaterial({ map: contactTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false })
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.set(0, 0.022, 0.05);
    contact.renderOrder = 1;
    swan.root.add(contact);
    scene.add(swan.root);
    app.swans.push(swan);
  }

  app.ghosts = new Ghosts({ scene, swans: app.swans, capacity: 80, history: app.settings.history });
  // colour the worldlines like the reference video's blue stage light (fresh = warm white, old = violet)
  const gu = app.ghosts.material.uniforms;
  gu.uPorcelain.value.setRGB(0.86, 0.92, 1.0);
  gu.uCool.value.setRGB(0.30, 0.52, 0.92);
  gu.uIridescence.value = 0.28;
  gu.uRimGlow.value = 0.50;
  app.ghosts.setOpacity?.(0.72);   // let the porcelain swans stay the subject; the trail is accompaniment
  buildHoverPreview();
  app.music = new Music();
  app.ui = new UI(app);

  // put the swans in their first pose and take the first snapshot, so the empty stage is already "her"
  poseSwans(0);
  app.ghosts.snapshot(0);
  app.lastSnapT = 0;

  app.state = 'ready';
  document.getElementById('load').textContent = '轻触进入，开始四小天鹅的夜晚';
  document.getElementById('enter').disabled = false;
  document.getElementById('enter-quiet').disabled = false;
  if (SKIP_GATE) startShow({ silent: true }); else enableGate();
}

function poseSwans(t) {
  for (const s of app.swans) {
    s.update(t);
    s.root.updateMatrixWorld(true);
  }
}

function enableGate() {
  const enter = document.getElementById('enter');
  const quiet = document.getElementById('enter-quiet');
  enter.addEventListener('click', () => startShow({ silent: false }), { once: true });
  quiet.addEventListener('click', () => startShow({ silent: true }), { once: true });
  enter.focus({ preventScroll: true });
}

async function startShow({ silent = false } = {}) {
  if (app.state !== 'ready') return;
  app.state = 'playing';
  document.getElementById('gate').classList.add('gone');
  app.T = 0;
  app.snapAcc = 0;
  app.lastSnapT = -0.001;
  app.frozen = false;
  app.swans.forEach((s) => s.root.visible = true);
  app.duration = SCORE.totalDuration;   // music + curtain call (the music buffer length is separate)
  app.ui.onStart(app.duration);      // start the picture right away…
  startLoop();
  // …then bring the score in. The loop must never wait for an AudioContext resume.
  try {
    await app.music.init();
    app.music.setMuted(silent);
    app.duration = SCORE.totalDuration;
    app.ui.onStart(app.duration);    // refresh clock + section map with the real duration
    app.music.start(app.T);
  } catch (e) {
    console.warn('[music] failed, continuing silently', e);
  }
}

// ---------------------------------------------------------------- main loop
const timer = new THREE.Timer();
let running = false;

function frame(ts) {
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  step(dt);
  composer.render(dt);
}

function startLoop() {
  if (running) return;
  running = true;
  timer.connect(document);
  renderer.setAnimationLoop(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) renderer.setAnimationLoop(null);
    else { timer.reset?.(); renderer.setAnimationLoop(frame); }
  });
}

function step(dt) {
  app.time += dt;

  // 1) advance the music clock, then pose the swans at that exact instant
  if (app.state === 'playing' && !app.frozen) {
    app.T += dt * app.rate;
    if (app.T >= app.duration) {
      app.T = app.duration;
      app.state = 'ended';
      app.music?.stop();      // the applause runs under the curtain call; stop it when the stage is dark
      app.ui.onEnd();
    }
  }
  const choreoTime = app.state === 'playing' || app.state === 'ended' ? app.T : 0;
  poseSwans(choreoTime);

  // 2) snapshot the four swans on a music-time cadence (never denser than the ring can hold)
  if (app.state === 'playing' && !app.frozen && app.T < SCORE.danceEnd) {
    const interval = Math.max(app.settings.interval, app.settings.history / 76);
    app.snapAcc += dt * app.rate;
    if (app.snapAcc >= interval) {
      app.snapAcc %= interval;
      app.ghosts.snapshot(app.T);
    }
  }

  // 3) consumers
  const ghostT = app.frozen ? app.frozenSculptureT : Math.min(app.T, SCORE.danceEnd);
  app.ghosts.update(dt, { T: ghostT, history: app.settings.history, camera });
  const outroStart = SCORE.danceEnd + 2.5;   // lights begin to go down as they walk off through the applause
  const curtainLevel = app.T > outroStart
    ? Math.max(0.06, 1 - (app.T - outroStart) / 3.0)
    : 1;
  app.stage.update(dt, app.T, { level: curtainLevel });

  // camera: slow orbit when idle; the user can always take over
  const idle = performance.now() - app.lastInteract;
  controls.autoRotate = !app.frozen && app.state === 'playing' && idle > 5000;
  controls.update(dt);

  if (app.state === 'ended') app.music?.stop();   // the applause ends with the curtain call; never restart it
  else app.music?.update(dt, { T: app.T, frozen: app.frozen, rate: app.rate });
  app.ui?.update(dt);
}

// ---------------------------------------------------------------- interaction
renderer.domElement.addEventListener('pointerdown', userTakeover, { passive: true });
controls.addEventListener('start', userTakeover);
function userTakeover() {
  app.userTouched = true;
  app.lastInteract = performance.now();
}
app.lastInteract = performance.now();

function toggleFreeze(force) {
  if (app.state !== 'playing' && app.state !== 'ended') return;
  const next = force ?? !app.frozen;
  if (next && !app.frozen) app.frozenSculptureT = app.T;
  app.frozen = next;
  app.ui?.setFrozen(app.frozen);
}

// ---------------------------------------------------------------- grabbing her past
const _pickM = new THREE.Matrix4();
const _pickV = new THREE.Vector3();
const labelEl = document.getElementById('label');
let hoverInfo = null;
let hoverPreview = null;     // { group, meshes[], pose, frame, m }

// ------------------------------------------------------------------ hover preview
// Hovering the past (a ghost or the worldline itself, even in the gaps between frozen poses) shows
// THE FIGURE OF THAT MOMENT: a bright porcelain stand-in posed with the stored snapshot and placed on
// the worldline where that moment lives. Built from the first swan's part geometries.
function buildHoverPreview() {
  const ghosts = app.ghosts;
  if (!ghosts || !app.swans.length) return;
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xfff4e6, roughness: 0.26, metalness: 0.0,
    clearcoat: 1, clearcoatRoughness: 0.18,
    emissive: 0x93b8ff, emissiveIntensity: 0.34,
    transparent: true, opacity: 0.55, depthWrite: false,
  });
  const group = new THREE.Group();
  group.name = 'hover-preview';
  group.visible = false;
  const names = ghosts.partOrder;
  // one preview figure per swan: the chain keeps holding hands in the frozen tableau
  const figures = [];
  for (const swan of app.swans) {
    const f = new THREE.Group();
    const meshes = [];
    for (let p = 0; p < names.length; p++) {
      const geo = swan.meshes[names[p]]?.geometry;
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 12;
      f.add(mesh);
      meshes.push(mesh);
    }
    group.add(f);
    figures.push({ group: f, meshes });
  }
  scene.add(group);
  hoverPreview = {
    group, figures, mat, names,
    pose: new Float32Array(names.length * 16),
    frame: new THREE.Matrix4(),
    m: new THREE.Matrix4(),
    partM: new THREE.Matrix4(),
  };
}

const _hidePreview = () => { if (hoverPreview) hoverPreview.group.visible = false; };

function updateHoverPreview(cand) {
  if (!hoverPreview) return;
  if (!cand || app.grab) { _hidePreview(); return; }
  const ghosts = app.ghosts;
  const near = ghosts.nearestSlot(cand.T);
  if (near.slot < 0) { _hidePreview(); return; }
  const baseT = app.frozen ? app.frozenSculptureT : app.T;
  const age = THREE.MathUtils.clamp((baseT - near.T) / Math.max(0.5, app.settings.history), 0.0005, 0.999);
  const names = hoverPreview.names;
  for (let si = 0; si < hoverPreview.figures.length; si++) {
    const wl = ghosts.worldlines[si] || ghosts.worldlines[0];
    if (!wl) continue;
    wl.matrixAtAge(age, hoverPreview.frame);
    ghosts.poseAt(near.slot, si, hoverPreview.pose);
    const fig = hoverPreview.figures[si];
    const n = Math.min(fig.meshes.length, names.length);
    for (let p = 0; p < n; p++) {
      hoverPreview.partM.fromArray(hoverPreview.pose, p * 16);
      hoverPreview.m.multiplyMatrices(hoverPreview.frame, hoverPreview.partM);
      const mesh = fig.meshes[p];
      mesh.matrix.copy(hoverPreview.m);
      mesh.matrixWorldNeedsUpdate = true;
    }
  }
  hoverPreview.group.visible = true;
}

// ------------------------------------------------------------------ hover picking
// Two candidates compete: a frozen pose's pivot (precise) and the worldline itself (works in the gaps
// and on the faint parts of the trail). Nearest screen distance wins.
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 > 1e-6 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2)) : 0;
  const dx = wx - vx * t, dy = wy - vy * t;
  return Math.hypot(dx, dy);
}

function hoverCandidate(clientX, clientY) {
  const ghosts = app.ghosts;
  const meshes = ghosts?.meshes;
  if (!meshes || !meshes.length || app.state === 'loading' || app.state === 'ready') return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const cx = clientX - rect.left, cy = clientY - rect.top;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const pivotR = coarse ? 64 : 26;
  const lineR = coarse ? 58 : 22;
  let best = null;
  const consider = (d, cand) => { if (d <= cand.radius && (!best || d < best.d)) best = { ...cand, d }; };

  // (A) the pivots of the frozen poses
  const count = meshes[0].count;
  for (let p = 0; p < meshes.length; p++) {
    const mesh = meshes[p];
    for (let i = 0; i < count; i++) {
      mesh.getMatrixAt(i, _pickM);
      _pickV.setFromMatrixPosition(_pickM).project(camera);
      if (_pickV.z > 1) continue;
      const sx = (_pickV.x * 0.5 + 0.5) * w, sy = (-_pickV.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d > pivotR) continue;
      const info = ghosts.timeOfInstance(i);
      if (info) consider(d, { T: info.T, swan: info.swan, radius: pivotR, kind: 'ghost' });
    }
  }

  // (B) the worldline itself: sample its arc-length LUT and measure the pointer to the projected polyline
  const baseT = app.frozen ? app.frozenSculptureT : app.T;
  for (let i = 0; i < ghosts.worldlines.length; i++) {
    const wl = ghosts.worldlines[i];
    const P = wl.pos;
    if (!P || P.length < 6) continue;
    const n = P.length / 3;
    let hasPrev = false, px = 0, py = 0, prevU = 0;
    for (let k = 0; k < n; k += 2) {
      _pickV.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).project(camera);
      if (_pickV.z > 1) { hasPrev = false; continue; }
      const sx = (_pickV.x * 0.5 + 0.5) * w, sy = (-_pickV.y * 0.5 + 0.5) * h;
      const u = k / (n - 1);
      if (hasPrev) {
        const d = distToSegment(cx, cy, px, py, sx, sy);
        if (d <= lineR) {
          const age = wl.ageOfU((u + prevU) * 0.5);
          const T = Math.max(0, baseT - age * app.settings.history);
          consider(d, { T, swan: i, radius: lineR, kind: 'line' });
        }
      }
      px = sx; py = sy; prevU = u; hasPrev = true;
    }
  }
  return best;
}

function showLabel(clientX, clientY, info) {
  if (!labelEl) return;
  if (!info) { labelEl.classList.remove('on'); return; }
  const dt = info.T - app.T;
  labelEl.textContent = (dt <= 0 ? '−' : '+') + Math.abs(dt).toFixed(1) + ' s';
  labelEl.style.left = clientX + 'px';
  labelEl.style.top = clientY + 'px';
  labelEl.classList.add('on');
}

function beginGrab(info, x, y) {
  if (!info) return false;
  if (app.state === 'ended') return false;
  if (!app.frozen) { app.frozenSculptureT = app.T; app.frozen = true; app.ui?.setFrozen(true); }
  app.T = Math.min(app.T, info.T);
  app.grab = { maxT: app.frozenSculptureT, x, y };
  app.controls.enabled = false;
  _hidePreview();
  app.ui?.setState('抓住她的过去 · 拖动换时刻 · 松手继续');
  return true;
}

function moveGrab(x, y) {
  if (!app.grab) return;
  const info = hoverCandidate(x, y);
  if (info) {
    app.T = Math.min(app.grab.maxT, Math.max(0, info.T));
    showLabel(x, y, info);
  }
}

function endGrab() {
  if (!app.grab) return;
  app.grab = null;
  app.controls.enabled = true;
  labelEl?.classList.remove('on');
  app.frozen = false;                      // the ghost engine shifts births on the T jump, so the sculpture stays continuous
  app.ui?.setFrozen(false);
  app.ui?.setState('回到现在 · 继续');
  _hidePreview();
}

window.addEventListener('pointerdown', (e) => {
  if (e.target !== renderer.domElement) return;
  if (app.state !== 'playing') return;
  const info = hoverCandidate(e.clientX, e.clientY);
  if (info) { beginGrab(info, e.clientX, e.clientY); e.preventDefault(); e.stopPropagation(); }
}, true);
window.addEventListener('pointermove', (e) => {
  if (app.grab) { moveGrab(e.clientX, e.clientY); return; }
  if (app.state !== 'playing' || e.target !== renderer.domElement) {
    labelEl?.classList.remove('on');
    _hidePreview();
    return;
  }
  hoverInfo = hoverCandidate(e.clientX, e.clientY);
  if (hoverInfo) {
    hoverInfo.kind === 'line'
      ? showLabel(e.clientX, e.clientY, { T: hoverInfo.T })
      : showLabel(e.clientX, e.clientY, { T: hoverInfo.T });
    updateHoverPreview(hoverInfo);
  } else {
    labelEl?.classList.remove('on');
    _hidePreview();
  }
  renderer.domElement.style.cursor = hoverInfo ? 'grab' : '';
}, true);
window.addEventListener('pointerleave', () => { labelEl?.classList.remove('on'); _hidePreview(); }, true);
window.addEventListener('pointerup', endGrab, true);
window.addEventListener('pointercancel', endGrab, true);
function toggleMute() {
  app.muted = !app.muted;
  app.music?.setMuted(app.muted);
  app.ui?.setMuted(app.muted);
}
function restart() {
  if (!app.music) return;
  app.T = 0;
  app.state = 'playing';
  app.frozen = false;
  app.ghosts.reset();
  app.music.start(0);
  app.ui.onStart(app.duration);
  app.ui.setFrozen(false);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'f') { e.preventDefault(); toggleFreeze(); }
  else if (k === 'm') toggleMute();
  else if (k === 'h') app.ui?.toggleHidden();
  else if (k === 'r') restart();
  else if (k === 'shift' || k === 's') app.ui?.togglePanel();
});

// ---------------------------------------------------------------- resize
function resize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(w, h);
  composer.setSize(w, h);
  app.stage?.resize();
}
window.addEventListener('resize', resize);



// A soft round shadow used as a contact decal under each swan.
function makeContactShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.95)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- error / capabilities
function showError(msg) {
  const el = document.getElementById('err');
  if (el) el.textContent = msg;
  const load = document.getElementById('load');
  if (load) load.textContent = '';
}
{
  const probe = (() => { try { return document.createElement('canvas').getContext('webgl2'); } catch { return null; } })();
  if (!probe) showError('这件作品需要 WebGL2。请用新版 Chrome / Edge / Firefox / Safari 打开。');
}

// ---------------------------------------------------------------- debug hooks (?debug)
if (DEBUG) {
  window.__ls = {
    app, THREE,
    frames(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); composer.render(dt); return snap(); },
    look(pos, target) {
      app.lastInteract = performance.now();
      camera.position.set(...pos); controls.target.set(...target); controls.update();
    },
    perf(seconds = 2) {
      const t0 = performance.now(); let n = 0;
      while (performance.now() - t0 < seconds * 1000) { step(1 / 60); composer.render(1 / 60); renderer.getContext().finish(); n++; }
      return { frames: n, msPerFrame: (performance.now() - t0) / n, ghosts: app.ghosts?.count ?? 0, T: app.T };
    },
    snap,
  };
  function snap() {
    return {
      state: app.state, T: +app.T.toFixed(2), frozen: app.frozen,
      ghosts: app.ghosts?.count ?? 0,
      swans: app.swans.length,
      music: app.music ? { duration: app.music.duration, bpm: app.music.bpm, muted: app.music.muted } : null,
      preview: !!(hoverPreview && hoverPreview.group.visible),
      label: labelEl ? labelEl.textContent : '',
      camera: { pos: camera.position.toArray().map((v) => +v.toFixed(2)), target: controls.target.toArray().map((v) => +v.toFixed(2)) },
    };
  }
}

boot().catch((e) => { console.error(e); showError('舞台布景失败：' + (e?.message || e)); });
