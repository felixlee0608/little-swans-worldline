// little-swans / src / worldline.js
//
// 世界线：把「残影的年龄 age∈[0,1]」映射成一条从天鹅骨盆 anchor 升向夜空的曲线。
//
// 机制（参考 worldline-dancer 的 spline 思路，独立实现）：
//   1. 6 个控制点的向心 Catmull-Rom（centripetal, α=0.5）。
//      向心参数化可以避免控制点在密集/靠近时曲线过冲打结。
//   2. 每帧重建：
//        a. 在 5 段曲线上按局部参数采样 241 个原始点，累计弦长；
//        b. 按等弧长重采样成 160 点的 LUT（契约要求 128~256 点）——位置、切线；
//        c. 从起点切线出发做平行传输（parallel transport）得到每点的朝向四元数，
//           起点朝向严格为单位四元数，所以 a=0 的残影与天鹅本体完全对齐；
//        d. 生成 age→u 的映射 LUT（默认 u = a^0.75：近端（新残影）疏、远端（老残影）密，
//           让一尊尊姿态雕塑在近处读得清；把 density 设为 1 就是纯等弧长均布）。
//   3. 控制点 = 舞台上的 home 锚点 + 预设偏移 + (当前 anchor − home) × FOLLOW[j]。
//      近端完全跟随天鹅（FOLLOW[0]=1，所以 a=0 永远在 anchor 上），远端几乎钉在舞台上——
//      小跳/侧移不会把整座雕塑拖着走，构图稳定（这是从参考作品学到的关键一招）。
//   4. matrixAtAge(a, out) = T(位置) · R(朝向)，残影的世界矩阵 = 它 × 姿态的锚点相对矩阵。
//
// 约定：y 向上，地面 y=0；世界线向 -Z（舞台深处）/ +Y 升起；四条线由 createWorldlines 左右张开。
// 只 import 'three'；无全局副作用；热路径零分配（所有缓冲在构造函数里预分配）。

import * as THREE from 'three';

/** 控制点数量（契约固定 6 个）。 */
export const WORLDLINE_HANDLES = 6;
/** 等弧长 LUT 的点数（契约要求 128~256）。 */
export const WORLDLINE_LUT_SIZE = 160;

const LUT_N = WORLDLINE_LUT_SIZE;
const SEGMENTS = WORLDLINE_HANDLES - 1;
const RAW_PER_SEG = 48;                            // 每段原始采样数
const RAW_COUNT = SEGMENTS * RAW_PER_SEG + 1;      // 241
const ALPHA = 0.5;                                 // 向心 Catmull-Rom：节点间距 = |ΔP|^α
const KNOT_MIN = 1e-4;                             // 退化控制点的节点间距下限
/** 控制点跟随天鹅的比例：0 = 钉死在舞台，1 = 完全跟随当前 anchor。 */
const FOLLOW = [1.0, 0.72, 0.45, 0.25, 0.12, 0.05];

// 预设：anchor 相对坐标（单位米）。x 列是 0..1 的左右张开曲线，由 side × fan 缩放。
// 默认 'arc'：约 5.9m 长、尖端相对 anchor 升高 3.15m、退到 z=-3.85m，
// 正好落在主程序 fov 34 / target(0,1.12,-1.35) 的取景里。
const PRESETS = {
  arc: {
    x: [0.0, 0.08, 0.27, 0.54, 0.81, 1.0],
    y: [0.0, 0.40, 1.00, 1.62, 2.35, 3.15],
    z: [0.0, -0.95, -1.85, -2.65, -3.35, -3.85],
  },
  // 备用：更低更宽的一道弧，尾端几乎水平，适合把雕塑压进画面下缘的机位。
  sweep: {
    x: [0.0, 0.14, 0.40, 0.70, 0.92, 1.08],
    y: [0.0, 0.34, 0.82, 1.30, 1.80, 2.25],
    z: [0.0, -1.10, -2.20, -3.15, -3.95, -4.55],
  },
};

const ONE = new THREE.Vector3(1, 1, 1);
const clamp = THREE.MathUtils.clamp;

export class SwanWorldline {
  /**
   * @param {object} [opts]
   * @param {THREE.Vector3} [opts.anchor] 起点（天鹅骨盆世界位置）
   * @param {string} [opts.preset='arc'] 曲线预设（'arc' | 'sweep'）
   * @param {number} [opts.side=1] 左右张开方向：-1 向左，+1 向右
   * @param {number} [opts.fan=2.4] 尖端相对起点在 x 方向张开的米数
   * @param {number} [opts.density=0.75] 年龄映射：u = a^density（1 = 等弧长均布，越小近端越疏）
   */
  constructor({
    anchor = new THREE.Vector3(0, 0.95, 0),
    preset = 'arc',
    side = 1,
    fan = 2.4,
    density = 0.75,
  } = {}) {
    this.preset = PRESETS[preset] ? preset : 'arc';
    this.profile = PRESETS[this.preset];
    this.side = side < 0 ? -1 : 1;
    this.fan = Number.isFinite(fan) ? fan : 2.4;
    this.density = clamp(Number.isFinite(density) ? density : 0.75, 0.3, 3.0);

    /** 当前锚点（世界坐标，a=0 的位置）。 */
    this.anchor = new THREE.Vector3().copy(anchor);
    /** 舞台上的「家」锚点；远端控制点钉在这里附近。 */
    this._home = new THREE.Vector3().copy(anchor);
    this._needsHome = true;                 // 第一次 update 时采纳调用者给的 anchor 作为 home
    this._lastAnchor = new THREE.Vector3(anchor.x, anchor.y, anchor.z);

    /** 当前曲线长度（米）。 */
    this.length = 1;
    /** LUT 尖端（age=1）的世界坐标，便于外部机位/调试取景。 */
    this.tip = new THREE.Vector3();
    /** 每次重建自增，可用于外部缓存失效。 */
    this.version = 0;
    /** createWorldlines 会填上序号与对应的天鹅。 */
    this.index = 0;
    this.swan = null;

    // 6 个控制点（每帧原地改写，不 new）。
    this.points = new Array(WORLDLINE_HANDLES);
    for (let j = 0; j < WORLDLINE_HANDLES; j++) this.points[j] = new THREE.Vector3();

    // 预分配缓冲。
    this._raw = new Float32Array(RAW_COUNT * 3);
    this._rawLen = new Float32Array(RAW_COUNT);
    this.pos = new Float32Array(LUT_N * 3);      // 等弧长位置
    this.tan = new Float32Array(LUT_N * 3);      // 单位切线
    this.quat = new Float32Array(LUT_N * 4);     // 平行传输朝向
    this.ageLUT = new Float32Array(LUT_N);       // 每个弧长点对应的归一化年龄（单调递增 0..1）

    // scratch（热路径零分配）。
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._dq = new THREE.Quaternion();
    this._tPrev = new THREE.Vector3();
    this._tCur = new THREE.Vector3();
    this._extA = new THREE.Vector3();
    this._extB = new THREE.Vector3();
    this._knot = new Float32Array(9);

    this._place();
    this._rebuild();
  }

  // ------------------------------------------------------------------ 公共 API（契约）
  /**
   * 每帧更新：跟随 anchor、重建 LUT。
   * 锚点没动（例如冻结时）会跳过重建——画面完全等价，省掉几千次浮点。
   * @param {number} dt 帧间隔（当前不参与阻尼，保留以符合契约）
   * @param {THREE.Vector3} [anchor] 天鹅骨盆世界位置；省略则沿用上次
   * @returns {this}
   */
  update(dt, anchor) {
    if (anchor) this.anchor.copy(anchor);
    let force = false;
    if (this._needsHome) {
      this._home.copy(this.anchor);
      this._needsHome = false;
      force = true;
    }
    const a = this.anchor, l = this._lastAnchor;
    const dx = a.x - l.x, dy = a.y - l.y, dz = a.z - l.z;
    if (force || dx * dx + dy * dy + dz * dz > 1e-10) {
      l.copy(a);
      this._place();
      this._rebuild();
      this.version++;
    }
    return this;
  }

  /** 归一化年龄 a∈[0,1] → 弧长参数 u∈[0,1]。 */
  uOfAge(a) {
    if (!(a > 0)) return 0;
    if (a >= 1) return 1;
    const A = this.ageLUT;
    let lo = 0, hi = LUT_N - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (A[mid] <= a) lo = mid; else hi = mid;
    }
    const span = A[hi] - A[lo];
    const f = span > 1e-9 ? (a - A[lo]) / span : 0;
    return (lo + f) / (LUT_N - 1);
  }

  /** 弧长参数 u∈[0,1] → 归一化年龄 a∈[0,1]。 */
  ageOfU(u) {
    const x = clamp(u, 0, 1) * (LUT_N - 1);
    let k = Math.floor(x);
    if (k >= LUT_N - 1) return 1;
    if (k < 0) k = 0;
    const f = x - k;
    const A = this.ageLUT;
    return A[k] + (A[k + 1] - A[k]) * f;
  }

  /** 弧长参数 u 处的单位切线，写入 out。 */
  tangentAtU(u, out = new THREE.Vector3()) {
    const x = clamp(u, 0, 1) * (LUT_N - 1);
    let k = Math.floor(x);
    if (k >= LUT_N - 1) k = LUT_N - 2;
    if (k < 0) k = 0;
    const f = x - k;
    const T = this.tan;
    const ax = T[k * 3], ay = T[k * 3 + 1], az = T[k * 3 + 2];
    const bx = T[k * 3 + 3], by = T[k * 3 + 4], bz = T[k * 3 + 5];
    return out.set(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f).normalize();
  }

  /** 归一化年龄 a 对应的世界坐标，写入 out。 */
  pointAtU(u, out = new THREE.Vector3()) {
    const x = clamp(u, 0, 1) * (LUT_N - 1);
    let k = Math.floor(x);
    if (k >= LUT_N - 1) k = LUT_N - 2;
    if (k < 0) k = 0;
    const f = x - k;
    const P = this.pos;
    return out.set(
      P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * f,
      P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * f,
      P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * f,
    );
  }

  /**
   * 年龄 a∈[0,1] → 世界矩阵（位置 + 朝向；a=0 在 anchor，a=1 在曲线尖端）。
   * 残影的世界矩阵 = 本矩阵 × 姿态的锚点相对矩阵。
   * @param {number} a 归一化年龄
   * @param {THREE.Matrix4} [out] 复用的输出矩阵
   */
  matrixAtAge(a, out = new THREE.Matrix4()) {
    const u = this.uOfAge(a);
    const x = u * (LUT_N - 1);
    let k = Math.floor(x);
    if (k >= LUT_N - 1) k = LUT_N - 2;
    if (k < 0) k = 0;
    const f = x - k;

    const P = this.pos, Q = this.quat, p = this._p, q = this._q;
    p.set(
      P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * f,
      P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * f,
      P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * f,
    );
    q.set(Q[k * 4], Q[k * 4 + 1], Q[k * 4 + 2], Q[k * 4 + 3]);
    this._q2.set(Q[k * 4 + 4], Q[k * 4 + 5], Q[k * 4 + 6], Q[k * 4 + 7]);
    q.slerp(this._q2, f);
    return out.compose(p, q, ONE);
  }

  // ------------------------------------------------------------------ 内部
  /** 根据 home / 当前 anchor / 预设，摆放 6 个控制点。 */
  _place() {
    const a = this.anchor, h = this._home, pts = this.points;
    const pr = this.profile;
    const sideFan = this.side * this.fan;
    for (let j = 0; j < WORLDLINE_HANDLES; j++) {
      const f = FOLLOW[j];
      pts[j].set(
        h.x + sideFan * pr.x[j] + (a.x - h.x) * f,
        h.y + pr.y[j] + (a.y - h.y) * f,
        h.z + pr.z[j] + (a.z - h.z) * f,
      );
    }
  }

  /** 重建：原始采样 → 等弧长 LUT → 切线 → 朝向 → 年龄映射。 */
  _rebuild() {
    const pts = this.points;
    const raw = this._raw, rawLen = this._rawLen;
    const knot = this._knot;
    const extA = this._extA, extB = this._extB;
    let w = 0;          // 原始采样游标
    let len = 0;        // 累计弧长

    for (let seg = 0; seg < SEGMENTS; seg++) {
      const p1 = pts[seg];
      const p2 = pts[seg + 1];
      // 端点延拓：用镜像点代替缺失的邻居，避免向心参数化出现重合节点。
      const p0 = seg === 0 ? extA.copy(p1).multiplyScalar(2).sub(p2) : pts[seg - 1];
      const p3 = seg === SEGMENTS - 1 ? extB.copy(p2).multiplyScalar(2).sub(p1) : pts[seg + 2];

      // 节点参数（向心：距离^0.5）与倒数，段内每点复用。
      const d01 = Math.max(Math.sqrt(Math.sqrt(p1.distanceToSquared(p0))), KNOT_MIN);
      const d12 = Math.max(Math.sqrt(Math.sqrt(p2.distanceToSquared(p1))), KNOT_MIN);
      const d23 = Math.max(Math.sqrt(Math.sqrt(p3.distanceToSquared(p2))), KNOT_MIN);
      const t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23;
      const r01 = 1 / (t1 - t0);
      const r12 = 1 / (t2 - t1);
      const r23 = 1 / (t3 - t2);
      const r02 = 1 / (t2 - t0);
      const r13 = 1 / (t3 - t1);

      const samples = seg === SEGMENTS - 1 ? RAW_PER_SEG + 1 : RAW_PER_SEG;
      for (let i = 0; i < samples; i++) {
        const u = i / RAW_PER_SEG;
        const t = t1 + (t2 - t1) * u;
        // Barry–Goldman：A1/A2/A3 → B1/B2 → C。
        const a1x = (t1 - t) * r01 * p0.x + (t - t0) * r01 * p1.x;
        const a1y = (t1 - t) * r01 * p0.y + (t - t0) * r01 * p1.y;
        const a1z = (t1 - t) * r01 * p0.z + (t - t0) * r01 * p1.z;
        const a2x = (t2 - t) * r12 * p1.x + (t - t1) * r12 * p2.x;
        const a2y = (t2 - t) * r12 * p1.y + (t - t1) * r12 * p2.y;
        const a2z = (t2 - t) * r12 * p1.z + (t - t1) * r12 * p2.z;
        const a3x = (t3 - t) * r23 * p2.x + (t - t2) * r23 * p3.x;
        const a3y = (t3 - t) * r23 * p2.y + (t - t2) * r23 * p3.y;
        const a3z = (t3 - t) * r23 * p2.z + (t - t2) * r23 * p3.z;
        const b1x = (t2 - t) * r02 * a1x + (t - t0) * r02 * a2x;
        const b1y = (t2 - t) * r02 * a1y + (t - t0) * r02 * a2y;
        const b1z = (t2 - t) * r02 * a1z + (t - t0) * r02 * a2z;
        const b2x = (t3 - t) * r13 * a2x + (t - t1) * r13 * a3x;
        const b2y = (t3 - t) * r13 * a2y + (t - t1) * r13 * a3y;
        const b2z = (t3 - t) * r13 * a2z + (t - t1) * r13 * a3z;
        const px = (t2 - t) * r12 * b1x + (t - t1) * r12 * b2x;
        const py = (t2 - t) * r12 * b1y + (t - t1) * r12 * b2y;
        const pz = (t2 - t) * r12 * b1z + (t - t1) * r12 * b2z;

        if (w > 0) {
          const dx = px - raw[(w - 1) * 3];
          const dy = py - raw[(w - 1) * 3 + 1];
          const dz = pz - raw[(w - 1) * 3 + 2];
          len += Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        raw[w * 3] = px;
        raw[w * 3 + 1] = py;
        raw[w * 3 + 2] = pz;
        rawLen[w] = len;
        w++;
      }
    }
    this.length = Math.max(len, 1e-4);

    // 等弧长重采样。
    const pos = this.pos;
    let cursor = 0;
    const total = this.length;
    for (let k = 0; k < LUT_N; k++) {
      const s = (k / (LUT_N - 1)) * total;
      while (cursor < RAW_COUNT - 2 && rawLen[cursor + 1] < s) cursor++;
      const l0 = rawLen[cursor];
      const l1 = rawLen[cursor + 1];
      const f = l1 > l0 + 1e-12 ? clamp((s - l0) / (l1 - l0), 0, 1) : 0;
      pos[k * 3] = raw[cursor * 3] + (raw[cursor * 3 + 3] - raw[cursor * 3]) * f;
      pos[k * 3 + 1] = raw[cursor * 3 + 1] + (raw[cursor * 3 + 4] - raw[cursor * 3 + 1]) * f;
      pos[k * 3 + 2] = raw[cursor * 3 + 2] + (raw[cursor * 3 + 5] - raw[cursor * 3 + 2]) * f;
    }

    // 切线（中心差分）。
    const tan = this.tan;
    for (let k = 0; k < LUT_N; k++) {
      const a = Math.max(0, k - 1);
      const b = Math.min(LUT_N - 1, k + 1);
      let x = pos[b * 3] - pos[a * 3];
      let y = pos[b * 3 + 1] - pos[a * 3 + 1];
      let z = pos[b * 3 + 2] - pos[a * 3 + 2];
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      tan[k * 3] = x / l;
      tan[k * 3 + 1] = y / l;
      tan[k * 3 + 2] = z / l;
    }

    // 年龄映射 LUT：u_k = k/(N-1) 是等弧长参数；age = u^(1/density) ↔ u = age^density。
    const age = this.ageLUT;
    const invDensity = 1 / this.density;
    age[0] = 0;
    age[LUT_N - 1] = 1;
    for (let k = 1; k < LUT_N - 1; k++) {
      age[k] = Math.pow(k / (LUT_N - 1), invDensity);
    }

    // 平行传输朝向：起点为单位四元数（a=0 与本体对齐），逐点把上一段切线转到下一段切线。
    const quat = this.quat;
    const q = this._q.identity();
    const dq = this._dq;
    const tPrev = this._tPrev, tCur = this._tCur;
    tPrev.set(tan[0], tan[1], tan[2]);
    quat[0] = 0; quat[1] = 0; quat[2] = 0; quat[3] = 1;
    for (let k = 1; k < LUT_N; k++) {
      tCur.set(tan[k * 3], tan[k * 3 + 1], tan[k * 3 + 2]);
      dq.setFromUnitVectors(tPrev, tCur);
      q.premultiply(dq);
      const ql = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
      q.x /= ql; q.y /= ql; q.z /= ql; q.w /= ql;
      tPrev.copy(tCur);
      quat[k * 4] = q.x;
      quat[k * 4 + 1] = q.y;
      quat[k * 4 + 2] = q.z;
      quat[k * 4 + 3] = q.w;
    }

    this.tip.set(pos[(LUT_N - 1) * 3], pos[(LUT_N - 1) * 3 + 1], pos[(LUT_N - 1) * 3 + 2]);
  }
}

/**
 * 为每只天鹅建一条世界线：起点 = 各自 anchor，向 -Z/+Y 升起，并按左右侧张开。
 * 同一侧的两条线 x 间隔保持 ≈ 天鹅间距（默认 1.8m），内圈两条向上逐渐分开，形成对称的「羽翼」。
 * @param {Array} swans Swan 实例数组（读取 swan.anchor）
 * @returns {SwanWorldline[]}
 */
export function createWorldlines(swans) {
  const list = Array.isArray(swans) ? swans : [];
  const n = list.length;
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const swan = list[i];
    const side = n > 1 ? (i < n / 2 ? -1 : 1) : 1;
    const wl = new SwanWorldline({
      anchor: swan && swan.anchor ? swan.anchor : undefined,
      preset: 'arc',
      side,
      fan: 1.35,
    });
    wl.index = i;
    wl.swan = swan || null;
    lines[i] = wl;
  }
  return lines;
}
