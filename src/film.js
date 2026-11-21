// Film mode: a deterministic, cinematic overlay for recording a video of the piece.
// Adds a title card, captions, a bottom timeline (acts + playhead + timecode) and a
// "worldline history" rail showing the last 12 s of four worldlines as snapshot dots.
// The camera follows a scripted move list instead of user input.
//
// Used by main.js when the URL has ?film=1 and by tools/render-film.mjs for frame capture.

import { SCORE, ACT_NAMES } from './score.js';

const TAU = Math.PI * 2;
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, u) => a + (b - a) * u;

// four worldline colours, matched to ghosts.js (cyan / azure / periwinkle / lilac)
const LINE_COLORS = ['#6fe0ff', '#4b9dff', '#9b86ff', '#d9a8ff'];
const LINE_LABELS = ['I', 'II', 'III', 'IV'];

const CAPTIONS = [
  { t0: 3.0, t1: 12.0, text: '四只小天鹅，在月夜湖面上起舞' },
  { t0: 16.0, t1: 29.0, text: '她们停留过的每一个姿态，都在身后冻结成瓷偶' },
  { t0: 33.0, t1: 47.0, text: '四条世界线，是四个舞者过去的时间' },
  { t0: 59.0, t1: 73.0, text: '每一个残影，都是她曾经跳过的某一秒' },
  { t0: 80.5, t1: 88.6, text: '最后两小节，收势' },
  { t0: 90.8, t1: 94.4, text: '掌声响起，谢幕' },
];

// camera keyframes: [time, position, look-at target]
const CAMERA = [
  [0.0, [2.60, 2.15, 7.40], [-0.15, 1.32, -1.20]],
  [7.0, [2.25, 2.00, 6.95], [-0.15, 1.30, -1.12]],
  [18.0, [1.95, 1.92, 6.90], [-0.18, 1.27, -1.05]],
  [30.0, [2.80, 1.95, 6.80], [-0.50, 1.38, -1.30]],
  [34.0, [4.70, 2.10, 6.00], [-0.75, 1.55, -1.95]],
  [46.0, [4.40, 2.05, 5.90], [-0.70, 1.50, -1.90]],
  [56.0, [3.20, 1.85, 6.10], [-0.45, 1.28, -1.00]],
  [66.0, [1.50, 1.45, 4.30], [-0.70, 1.10, -0.40]],
  [79.0, [2.10, 1.80, 6.20], [-0.20, 1.20, -0.90]],
  [88.0, [1.90, 2.00, 7.40], [0.00, 1.18, -0.90]],
  [91.0, [2.20, 1.90, 7.00], [0.00, 1.08, -0.70]],
  [93.4, [3.10, 2.00, 8.00], [1.10, 1.18, -0.80]],
  [96.8, [4.10, 2.10, 8.50], [2.10, 1.18, -0.80]],
];

const STYLE = `
  body.film #bar, body.film #hud-right, body.film #state, body.film #label,
  body.film #hint, body.film #panel, body.film #copy { display: none !important; }

  #film-root { position: fixed; inset: 0; z-index: 30; pointer-events: none; overflow: hidden;
    font-family: 'Cormorant', Georgia, 'Songti SC', 'PingFang SC', serif; color: rgba(238,242,252,.94); }
  #film-vignette { position: absolute; inset: 0;
    background: radial-gradient(115% 85% at 50% 44%, rgba(0,0,0,0) 46%, rgba(2,4,9,.42) 100%); }
  #film-title { position: absolute; left: 50%; top: 27%; transform: translate(-50%,-50%);
    text-align: center; letter-spacing: .06em; }
  #film-title .k { font-size: 11px; letter-spacing: .42em; color: rgba(200,220,255,.55); }
  #film-title .m { margin-top: 14px; font-size: 66px; font-weight: 300; letter-spacing: .14em; color: #f3f6ff;
    text-shadow: 0 2px 40px rgba(120,170,255,.28); }
  #film-title .s { margin-top: 10px; font-size: 15px; letter-spacing: .30em; color: rgba(214,226,248,.72); }

  #film-caption { position: absolute; left: 50%; bottom: 206px; transform: translateX(-50%);
    font-size: 21px; letter-spacing: .16em; color: rgba(242,246,255,.95); white-space: nowrap;
    padding: 7px 26px; border-radius: 22px;
    background: radial-gradient(60% 120% at 50% 50%, rgba(3,6,12,.62) 0%, rgba(3,6,12,0) 100%);
    text-shadow: 0 2px 22px rgba(0,0,0,.9); }

  #film-end { position: absolute; left: 50%; top: 38%; transform: translate(-50%,-50%); text-align: center; }
  #film-end .e { font-size: 44px; letter-spacing: .36em; color: #f3f6ff; text-shadow: 0 2px 34px rgba(120,170,255,.3); }
  #film-end .sub { margin-top: 12px; font-size: 13px; letter-spacing: .30em; color: rgba(205,220,245,.62); }

  #film-bottom { position: absolute; left: 0; right: 0; bottom: 0; height: 236px;
    background: linear-gradient(to top, rgba(2,4,9,.97) 0%, rgba(2,4,9,.82) 34%, rgba(2,4,9,0) 100%);
    padding: 0 7vw 26px; display: flex; flex-direction: column; justify-content: flex-end; }
  .fb-head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 10px; }
  .fb-brand { font-size: 12px; letter-spacing: .26em; color: rgba(206,222,248,.62); }
  .fb-brand em { font-style: normal; letter-spacing: .12em; color: rgba(206,222,248,.4); }
  .fb-clock { font-size: 13px; letter-spacing: .16em; color: rgba(214,228,250,.72); }
  .fb-clock b { font-weight: 400; color: #eaf2ff; }

  #film-track { position: relative; height: 42px; border-radius: 3px; overflow: visible;
    background: rgba(120,150,200,.07); border: 1px solid rgba(180,210,255,.10); }
  #film-track .block { position: absolute; top: 0; bottom: 0; border-right: 1px solid rgba(160,190,240,.10); }
  #film-track .block .lab { position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
    font-size: 11.5px; letter-spacing: .12em; color: rgba(220,234,255,.72); white-space: nowrap; }
  #film-track .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
    background: linear-gradient(90deg, rgba(110,220,255,.16), rgba(150,140,255,.12)); }
  #film-track .head { position: absolute; top: -6px; bottom: -6px; width: 1px; left: 0;
    background: rgba(235,244,255,.92); box-shadow: 0 0 14px rgba(150,200,255,.75); }
  #film-track .head::after { content: ''; position: absolute; left: 50%; top: -4px; width: 7px; height: 7px;
    transform: translateX(-50%) rotate(45deg); background: #eaf3ff; box-shadow: 0 0 12px rgba(150,200,255,.85); }

  #film-hist { display: flex; gap: 14px; align-items: center; margin-top: 12px; height: 62px; }
  #film-hist .side { width: 128px; flex: none; font-size: 10.5px; letter-spacing: .18em; color: rgba(200,218,246,.5); line-height: 1.8; }
  #film-hist .side b { display: block; font-weight: 400; font-size: 11px; letter-spacing: .16em; color: rgba(224,236,255,.78); }
  #film-hist { margin-top: 14px; height: 66px; }
  #film-hist canvas { flex: 1; height: 62px; width: 100%; }
`;

/**
 * @param {{ app: any }} deps
 * @returns {{ update: (T:number)=>void, applyCamera: ()=>void, dispose: ()=>void }}
 */
export function createFilm({ app, camera, controls }) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  document.body.classList.add('film');

  const root = document.createElement('div');
  root.id = 'film-root';
  root.innerHTML = `
    <div id="film-vignette"></div>
    <div id="film-title">
      <div class="k">DANSE DES PETITS CYGNES</div>
      <div class="m">小天鹅舞曲</div>
      <div class="s">瓷偶世界线 · WORLDLINE CYGNETS</div>
    </div>
    <div id="film-caption"></div>
    <div id="film-end"><div class="e">谢幕</div><div class="sub">掌声里，她们慢慢退场</div></div>
    <div id="film-bottom">
      <div class="fb-head">
        <div class="fb-brand">WORLDLINE CYGNETS <em>· 四小天鹅</em></div>
        <div class="fb-clock"><b id="film-now">00:00</b> / <span id="film-total">01:36</span></div>
      </div>
      <div id="film-track"><div class="fill"></div></div>
      <div id="film-hist">
        <div class="side"><b>世界线 · 过去 12s</b>四只天鹅的残影<br><span id="film-ghosts">0</span> 尊瓷偶</div>
        <canvas id="film-history"></canvas>
      </div>
    </div>`;
  document.body.appendChild(root);

  const el = {
    root, title: root.querySelector('#film-title'), caption: root.querySelector('#film-caption'),
    end: root.querySelector('#film-end'), now: root.querySelector('#film-now'),
    total: root.querySelector('#film-total'), track: root.querySelector('#film-track'),
    fill: root.querySelector('#film-track .fill'), head: root.querySelector('#film-track .head'),
    canvas: root.querySelector('#film-history'), ghosts: root.querySelector('#film-ghosts'),
  };

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const x = Math.floor(s % 60);
    return String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0');
  };
  el.total.textContent = fmt(SCORE.totalDuration);

  // ---- timeline act blocks ----
  const blocks = [];
  for (const sec of SCORE.sections) {
    const d = document.createElement('div');
    d.className = 'block';
    const lab = document.createElement('span');
    lab.className = 'lab';
    lab.textContent = ACT_NAMES[sec.name] || sec.name;
    d.appendChild(lab);
    el.track.appendChild(d);
    blocks.push({ sec, el: d });
  }
  const head = document.createElement('div');
  head.className = 'head';
  el.track.appendChild(head);
  el.head = head;

  // retina canvas
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ctx = el.canvas.getContext('2d');
  let cw = 0;
  let ch = 0;
  function sizeCanvas() {
    const r = el.canvas.getBoundingClientRect();
    cw = Math.max(1, Math.round(r.width));
    ch = Math.max(1, Math.round(r.height));
    el.canvas.width = Math.round(cw * dpr);
    el.canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas();

  // ---- camera ----
  const _pos = [0, 0, 0];
  const _tgt = [0, 0, 0];
  function cameraAt(T) {
    let i = 0;
    while (i < CAMERA.length - 2 && T > CAMERA[i + 1][0]) i++;
    const [t0, p0, q0] = CAMERA[i];
    const [t1, p1, q1] = CAMERA[i + 1] || CAMERA[i];
    const u = smooth(clamp01((T - t0) / Math.max(1e-4, t1 - t0)));
    for (let k = 0; k < 3; k++) {
      _pos[k] = p0[k] + (p1[k] - p0[k]) * u;
      _tgt[k] = q0[k] + (q1[k] - q0[k]) * u;
    }
    // a very slow drift so the shot never feels locked off
    _pos[0] += 0.035 * Math.sin(T * 0.13);
    _pos[1] += 0.020 * Math.sin(T * 0.17 + 1.2);
    return { pos: _pos, target: _tgt };
  }

  function applyCamera() {
    const c = cameraAt(app.T);
    camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
    controls.target.set(c.target[0], c.target[1], c.target[2]);
    camera.lookAt(controls.target);
  }

  // ---- per-frame overlay ----
  const trackW = () => Math.max(1, el.track.clientWidth);
  let lastHistoryT = -1;

  function drawHistory(T) {
    const span = app.settings.history || 12;
    const t0 = Math.max(0, T - span);
    const w = cw;
    const h = ch;
    const padL = 18;
    const padR = 12;
    const plotW = w - padL - padR;
    ctx.clearRect(0, 0, w, h);

    // faint act bands in the background
    for (const sec of SCORE.sections) {
      const a = Math.max(sec.t, t0);
      const b = Math.min(sec.t + sec.dur, T);
      if (b <= a) continue;
      const x0 = padL + ((a - t0) / span) * plotW;
      const x1 = padL + ((b - t0) / span) * plotW;
      ctx.fillStyle = 'rgba(130,160,210,.045)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }

    const rowH = h / 4;
    for (let s = 0; s < 4; s++) {
      const y = rowH * (s + 0.5);
      ctx.strokeStyle = 'rgba(170,200,240,.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();

      // snapshot dots: the ghost engine snapshots every 0.2 s
      const step = 0.2;
      const first = Math.ceil(t0 / step) * step;
      for (let t = first; t <= T + 1e-6; t += step) {
        const age = (T - t) / span;
        const x = padL + ((t - t0) / span) * plotW;
        const a = (1 - age) * 0.85;
        ctx.fillStyle = LINE_COLORS[s];
        ctx.globalAlpha = Math.max(0, a);
        ctx.beginPath();
        ctx.arc(x, y, 1.5 + 1.2 * (1 - age), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      ctx.fillStyle = LINE_COLORS[s];
      ctx.font = '10px "Cormorant", Georgia, serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(LINE_LABELS[s], 2, y);
    }

    // playhead at the right edge of the window
    const xh = w - padR;
    ctx.strokeStyle = 'rgba(235,244,255,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xh, 2);
    ctx.lineTo(xh, h - 2);
    ctx.stroke();
    ctx.fillStyle = '#eef5ff';
    ctx.beginPath();
    ctx.arc(xh, h / 2, 2.2, 0, TAU);
    ctx.fill();

    // left/right time labels
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#dfeaff';
    ctx.font = '9px "Cormorant", Georgia, serif';
    ctx.textBaseline = 'top';
    ctx.fillText('t' + fmt(t0), padL + 2, 1);
    ctx.textBaseline = 'bottom';
    ctx.fillText('now', xh - 18, h - 1);
    ctx.globalAlpha = 1;
  }

  function update(T) {
    const total = SCORE.totalDuration;
    const p = clamp01(T / total);

    // title card: in at 0, out by 5.6 s
    const titleA = T < 4.4 ? 1 : 1 - smooth(clamp01((T - 4.4) / 1.4));
    el.title.style.opacity = titleA.toFixed(3);
    el.title.style.transform = `translate(-50%,-50%) translateY(${(-8 * (1 - titleA)).toFixed(2)}px)`;

    // captions
    let cap = null;
    for (const c of CAPTIONS) if (T >= c.t0 && T <= c.t1) { cap = c; break; }
    if (cap) {
      const fin = smooth(clamp01((T - cap.t0) / 0.6));
      const fout = 1 - smooth(clamp01((T - (cap.t1 - 0.7)) / 0.7));
      el.caption.style.opacity = Math.min(fin, fout).toFixed(3);
      el.caption.textContent = cap.text;
    } else el.caption.style.opacity = '0';

    // end card during the applause
    const endA = smooth(clamp01((T - 94.3) / 1.1));
    el.end.style.opacity = endA.toFixed(3);

    // during the curtain call the worldline is frozen; let it recede so the exit reads
    if (T > SCORE.danceEnd) {
      app.ghosts.setOpacity?.(0.46 * Math.max(0.16, 1 - (T - SCORE.danceEnd) / 3.2));
    }

    // clock + timeline
    el.now.textContent = fmt(T);
    const w = trackW();
    for (const b of blocks) {
      const left = (b.sec.t / total) * w;
      const width = Math.max(2, (b.sec.dur / total) * w);
      b.el.style.left = left.toFixed(1) + 'px';
      b.el.style.width = width.toFixed(1) + 'px';
    }
    const x = p * w;
    el.fill.style.width = x.toFixed(1) + 'px';
    el.head.style.left = x.toFixed(1) + 'px';
    el.ghosts.textContent = String(app.ghosts?.count ?? 0);

    if (Math.abs(T - lastHistoryT) > 1e-6) {
      lastHistoryT = T;
      sizeCanvasIfNeeded();
      drawHistory(T);
    }
  }

  function sizeCanvasIfNeeded() {
    const r = el.canvas.getBoundingClientRect();
    if (Math.round(r.width) !== cw || Math.round(r.height) !== ch) sizeCanvas();
  }

  window.addEventListener('resize', () => { sizeCanvas(); });

  return {
    update,
    applyCamera,
    _debug: () => ({ camera: camera.position.toArray(), target: controls.target.toArray(), look: camera.rotation.toArray() }),
    dispose() {
      root.remove();
      style.remove();
      document.body.classList.remove('film');
    },
  };
}
