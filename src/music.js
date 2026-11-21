/**
 * music.js — 《四小天鹅舞曲 · 瓷偶世界线》配乐引擎（参考视频原声版）
 *
 * 音频来自用户提供的参考演出视频，已抽成 `assets/audio/swan-lake-source.mp3`
 * （103.7s，AAC → MP3 160k，双声道；曲目为柴可夫斯基《天鹅湖》公版作品）。
 *
 * 播放模型（与旧的实时合成版一致，便于保留交互）：
 *   - 播放头 = 作品时间轴 T，每帧向 T 对齐；偏差 > 0.25s 才硬 seek（避免频繁重启音源）；
 *   - frozen=true：磁带停转（playbackRate 指数降到 0.05 + 渐隐），解冻时从当前位置重新起转；
 *   - rate 参数支持变速（保留接口，当前主程序里固定为 1）；
 *   - 未 init() 前所有方法安全 no-op；init() 必须在用户手势里调用（Autoplay policy）。
 */

import { SCORE } from './score.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export class Music {
  constructor() {
    this.duration = SCORE.duration;
    this.bpm = SCORE.bpm;
    this.sections = SCORE.sections;
    this.muted = true;
    this.failed = false;
    this.ctx = null;
    this.buffer = null;
    this.master = null;
    this.src = null;
    this.srcGain = null;
    this.clock = null;        // { t0, pos0, r0, rate, ramp }
    this.tapeStopped = false;
    this._lastT = 0;
  }

  get ready() {
    return !!(this.ctx && this.buffer);
  }

  /** Must be called from a user gesture (the Enter click). Safe to call twice. */
  async init() {
    if (this.ctx && this.buffer) return true;
    if (this.ctx) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 3;
    comp.attack.value = 0.01; comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);
    try { await ctx.resume(); } catch {}
    const res = await fetch('./assets/audio/swan-lake-source.mp3');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.arrayBuffer();
    this.buffer = await new Promise((ok, no) => ctx.decodeAudioData(data, ok, no));
    this.duration = this.buffer.duration || SCORE.duration;
    return true;
  }

  setMuted(m) {
    this.muted = !!m;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : 0.9, now + (this.muted ? 0.25 : 0.6));
  }

  start(T = 0) {
    if (!this.ready) return;
    this.tapeStopped = false;
    this._playAt(clamp(T, 0, this.duration), { fade: 0.25 });
  }

  stop() {
    this._stopSrc(0.15);
  }

  _playAt(pos, { fade = 0.05, rate = 1, rateFrom = null, rampTime = 0.35 } = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.buffer) return;
    this._stopSrc(fade);
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = false;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fade);
    src.connect(gain).connect(this.master);
    const r0 = rateFrom ?? rate;
    src.playbackRate.setValueAtTime(r0, now);
    if (r0 !== rate) src.playbackRate.linearRampToValueAtTime(rate, now + rampTime);
    const p = clamp(pos, 0, Math.max(0, this.buffer.duration - 0.02));
    src.start(now, p);
    this.src = src;
    this.srcGain = gain;
    this.clock = { t0: now, pos0: p, r0, rate, ramp: r0 !== rate ? rampTime : 0 };
  }

  _stopSrc(fade = 0.15) {
    if (!this.src) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const g = this.srcGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    try { this.src.stop(now + fade + 0.02); } catch {}
    this.src = null;
    this.srcGain = null;
  }

  /** Position of the playhead, integrating the rate ramp exactly. */
  _position() {
    const c = this.clock;
    if (!c) return this._lastT;
    const el = this.ctx.currentTime - c.t0;
    if (!c.ramp) return c.pos0 + el * c.rate;
    const r = Math.min(el, c.ramp);
    return c.pos0 + r * (c.r0 + (c.rate - c.r0) * (r / c.ramp) * 0.5) + Math.max(0, el - c.ramp) * c.rate;
  }

  _tapeStop() {
    const src = this.src;
    if (!src) { this.tapeStopped = true; return; }
    const ctx = this.ctx;
    const now = ctx.currentTime;
    src.playbackRate.cancelScheduledValues(now);
    src.playbackRate.setValueAtTime(src.playbackRate.value, now);
    src.playbackRate.exponentialRampToValueAtTime(0.05, now + 0.75);
    this.srcGain.gain.setTargetAtTime(0, now + 0.35, 0.12);
    try { src.stop(now + 1.3); } catch {}
    this.src = null;
    this.srcGain = null;
    this.tapeStopped = true;
  }

  /**
   * @param {number} dt
   * @param {{T?:number, frozen?:boolean, rate?:number}} s
   */
  update(dt, s = {}) {
    if (!this.ctx || this.muted) return;
    const T = Number.isFinite(s.T) ? s.T : this._lastT;
    this._lastT = T;
    const rate = Number.isFinite(s.rate) && s.rate > 0 ? s.rate : 1;

    if (s.frozen) {
      if (!this.tapeStopped) this._tapeStop();
      return;
    }
    if (this.tapeStopped) {              // unfreeze: the tape spins back up from the new moment
      this.tapeStopped = false;
      this._playAt(clamp(T, 0, this.duration), { fade: 0.06, rateFrom: 0.2, rampTime: 0.4, rate });
      return;
    }
    if (T >= this.duration - 0.02) { this._stopSrc(0.05); this.clock = null; return; }
    if (!this.src) { this._playAt(T, { fade: 0.15, rate }); return; }

    const ramping = this.clock && this.clock.ramp && this.ctx.currentTime - this.clock.t0 < this.clock.ramp;
    if (this.clock && Math.abs(this.clock.rate - rate) > 0.015 && !ramping) {
      const pos = this._position();
      const now = this.ctx.currentTime;
      this.src.playbackRate.cancelScheduledValues(now);
      this.src.playbackRate.setValueAtTime(rate, now);
      this.clock = { t0: now, pos0: pos, r0: rate, rate, ramp: 0 };
    }
    const drift = this._position() - T;
    if (Math.abs(drift) > 0.25) this._playAt(clamp(T, 0, this.duration), { fade: 0.18, rate });
  }

  dispose() {
    this._stopSrc(0.05);
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
    this.buffer = null;
  }
}
