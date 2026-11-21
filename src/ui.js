// The quiet HUD: clock, act label, hint, and the three small controls (history length, ghost density, restart).
// The interface is deliberately sparse: this is a 2-minute piece, not a tool. The panel can be hidden entirely.

const fmt = (s) => {
  const m = Math.floor(Math.max(0, s) / 60), r = Math.floor(Math.max(0, s) % 60);
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
};

import { ACT_NAMES } from './score.js';
const _UNUSED_ACT_NAMES = {
  intro: 'i · 入场', theme: 'ii · 队列', middle: 'iii · 回响', reprise: 'iv · 分岔', coda: 'v · 终幕',
};
const ACTS = [
  { at: 0.00, text: 'i · 入场' },
  { at: 0.10, text: 'ii · 队列' },
  { at: 0.40, text: 'iii · 回响' },
  { at: 0.62, text: 'iv · 分岔' },
  { at: 0.84, text: 'v · 终幕' },
];

export class UI {
  constructor(app) {
    this.app = app;
    this.el = {
      time: document.getElementById('time'),
      state: document.getElementById('state'),
      hint: document.getElementById('hint'),
      panel: document.getElementById('panel'),
      history: document.getElementById('history'),
      historyV: document.getElementById('history-v'),
      density: document.getElementById('density'),
      densityV: document.getElementById('density-v'),
      sound: document.getElementById('sound'),
      freeze: document.getElementById('freeze'),
      reset: document.getElementById('reset'),
      hide: document.getElementById('hide'),
    };
    this.hidden = false;
    this.frozen = false;
    this.muted = false;
    this.hintTimer = 0;
    this.act = -1;
    this.stateText = '';
    this.panelIdle = 0;

    this.el.sound.addEventListener('click', () => app.actions?.toggleMute());
    this.el.freeze.addEventListener('click', () => app.actions?.toggleFreeze());
    this.el.reset.addEventListener('click', () => app.actions?.restart());
    this.el.hide.addEventListener('click', () => this.toggleHidden());
    this.el.history.addEventListener('input', () => {
      const v = +this.el.history.value;
      this.app.settings.history = v;
      this.el.historyV.textContent = v + 's';
    });
    this.el.density.addEventListener('input', () => {
      const v = +this.el.density.value;
      const map = { 1: 0.5, 2: 0.4, 3: 0.3, 4: 0.22, 5: 0.16, 6: 0.12 };
      this.app.settings.interval = map[v] || 0.2;
      this.el.densityV.textContent = v <= 2 ? '疏' : v >= 5 ? '密' : '中';
    });
    // panel fades only while the pointer is far away; reaching for it wakes it
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const r = this.el.panel.getBoundingClientRect();
      const near = e.clientX > r.left - 60 && e.clientX < r.right + 60 && e.clientY > r.top - 60 && e.clientY < r.bottom + 60;
      if (near) this.panelIdle = 0;
    }, { passive: true });
  }

  onStart(duration) {
    this.duration = duration || 96.8;
    // if the score ships a section map, the act label follows the music instead of fixed fractions
    const secs = this.app.music?.sections;
    this.sectionCues = Array.isArray(secs) && secs.length
      ? secs.map((sec) => ({ at: sec.t, text: ACT_NAMES[sec.name] || sec.name }))
      : null;
    this.hintTimer = 10;
    this.el.time.textContent = '00:00 / ' + fmt(this.duration);
    this.el.hint.textContent = matchMedia('(pointer: coarse)').matches
      ? '按住残影回到那一刻 · 悬停看身影 · 双指旋转'
      : '悬停看她过去的某个身影 · 按住回到那一刻 · 空格冻结';
    this.el.hint.style.opacity = '1';
    this.setState('i · 入场');
  }

  onEnd() {
    this.setState('终 · 谢幕');
    this.el.hint.textContent = '谢幕 · 按 R 或「重新开始」，再看一遍';
    this.el.hint.style.opacity = '1';
    this.hintTimer = 12;
  }

  setState(text) {
    if (text === this.stateText) return;
    this.stateText = text;
    this.el.state.textContent = text;
    this.el.state.classList.add('on');
    clearTimeout(this._stateT);
    this._stateT = setTimeout(() => this.el.state.classList.remove('on'), 3200);
  }

  setFrozen(on) {
    this.frozen = on;
    this.el.freeze.classList.toggle('active', on);
    this.el.freeze.style.background = on ? 'rgba(220,232,255,.22)' : '';
    this.setState(on ? '时间冻结 · 按 F 继续' : (this.act >= 0 ? ACTS[this.act].text : ''));
  }

  setMuted(on) {
    this.muted = on;
    this.el.sound.classList.toggle('muted', on);
    this.setState(on ? '静音' : '');
  }

  toggleHidden() {
    this.hidden = !this.hidden;
    for (const id of ['bar', 'hud-right', 'panel', 'hint', 'state', 'copy']) {
      const el = document.getElementById(id);
      if (el) el.style.opacity = this.hidden ? '0' : '';
      if (el) el.style.pointerEvents = this.hidden ? 'none' : '';
    }
    if (this.hidden) setTimeout(() => { if (this.hidden) this.hidden = false; }, 4000);
  }

  togglePanel() {
    this.el.panel.classList.toggle('faded');
  }

  update(dt) {
    const app = this.app;
    if (!this.duration) return;
    this.el.time.textContent = fmt(app.T) + ' / ' + fmt(this.duration);

    // act label follows the music position
    if (app.state === 'playing' && !app.frozen) {
      const cues = this.sectionCues;
      if (cues) {
        let idx = 0;
        for (let i = 0; i < cues.length; i++) if (app.T >= cues[i].at) idx = i;
        if (idx !== this.act) {
          this.act = idx;
          this.setState(cues[idx].text);
        }
      } else {
        const p = app.T / this.duration;
        let idx = 0;
        for (let i = 0; i < ACTS.length; i++) if (p >= ACTS[i].at) idx = i;
        if (idx !== this.act) { this.act = idx; this.setState(ACTS[idx].text); }
      }
    }

    // hint fades after a while, but comes back when frozen / ended
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.el.hint.style.opacity = '0';
    }

    // the panel sleeps when the pointer is away (and wakes on approach, above)
    this.panelIdle += dt;
    if (this.panelIdle > 6 && !this.el.panel.classList.contains('faded')) this.el.panel.classList.add('faded');
    if (this.panelIdle === 0) this.el.panel.classList.remove('faded');
  }
}
