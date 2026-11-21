// little-swans / src / ghosts.js
//
// 残影引擎：把四只小天鹅的历史姿态冻结成瓷白雕塑，沿各自的世界线排开。
//
// 数据流（每帧）：
//   main.js:  poseSwans(T)（保证 root.updateMatrixWorld(true)）
//             → snapshot(T)（每 0.2s 一次）         ← 本文件
//                └ swans[i].captureWorldPose(pose, off)：12 个部件的 matrixWorld，平移已减去 anchor
//             → update(dt, {T, history, camera})     ← 本文件
//                ├ worldlines[i].update(dt, swans[i].anchor)：每帧重建世界线 LUT（锚点不动则跳过）
//                ├ age = clamp((T - birth) / history, 0, 1)
//                ├ 每个可见快照 × 每只天鹅：Frame = worldline.matrixAtAge(age)
//                ├ instanceMatrix = Frame × pose（锚点相对矩阵）
//                ├ 按相机距离从远到近排序（预乘透明重叠会好看很多）
//                └ 写 17 个 InstancedMesh 的 instanceMatrix + 共享的 aData(age, density, tint)
//
// 渲染：
//   · 17 个 InstancedMesh（每个部件一个），共享 1 个 ShaderMaterial，共 17 个 draw call。
//   · 每实例 aData = vec2(归一化年龄, 沿视线的密度补偿)；shader 里算年龄淡出、新生暖光、
//     fresnel 边缘、极淡虹彩、老残影尾端的微光闪烁。
//   · 预乘近似加性混合（One, OneMinusSrcAlpha），不写深度、写测试，所以几百层重叠会累加成
//     "发光密度"而不是互相遮挡。
//   · 全部缓冲预分配：快照位姿 / instanceMatrix / 排序表 / aData，每帧零大分配。
//
// 约定：只 import 'three' 与同目录的 worldline.js；无全局副作用；API 与 CONTRACT.md 完全一致。

import * as THREE from 'three';
import { SwanWorldline, createWorldlines } from './worldline.js';

/** 部件数量（17：脊柱两段 + 手臂两段 + 腿两段；顺序 = swan.captureWorldPose 写入顺序）。 */
const PART_COUNT = 17;
/** 每个部件的矩阵 float 数。 */
const MAT4_FLOATS = 16;
/** 快照里一只天鹅占的 float 数（17 个部件 × 16）。 */
const SWAN_POSE_FLOATS = PART_COUNT * MAT4_FLOATS;
/** 契约建议的部件名；只在无法从 swan 上发现部件名时兜底。 */
const FALLBACK_PARTS = [
  'body', 'tutu', 'chest', 'head', 'bun', 'wingL', 'wingR',
  'armUpperL', 'armForeL', 'armUpperR', 'armForeR',
  'thighL', 'thighR', 'shinL', 'shinR', 'slipperL', 'slipperR',
];
/** 视线方向的密度补偿：|dot(tangent, view)| = 1（顺着世界线看）时压到 MIN 倍，避免叠爆。 */
const DENSITY_MIN = 0.45;
const DENSITY_POW = 2.2;
/** 幽灵材质共享 uniform 的默认值（可在 update 里由外部微调，但当前主程序不需要）。 */
const DEFAULTS = {
  porcelain: new THREE.Color(0.92, 0.94, 1.0),
  warm: new THREE.Color(1.0, 0.60, 0.34),
  cool: new THREE.Color(0.55, 0.68, 0.95),
};

// --------------------------------------------------------------------------------------------- 小工具
/**
 * 发现 17 个部件名 → captureWorldPose 行号的映射。
 *
 * 注意：swan.meshes 的键顺序不一定等于 SWAN_PARTS 顺序（例如腿可能在纱裙之前建），
 * 而 captureWorldPose 严格按 SWAN_PARTS 顺序写。所以这里在第一只天鹅上拍一张参考姿态，
 * 用每个部件 mesh 的 world 平移（减 anchor）去匹配快照行的平移，得到真实行号；
 * 匹配失败时退回契约建议顺序。
 */
function resolvePartNames(swans) {
  const swan = swans && swans[0];
  const keysOf = (obj, exact) => {
    if (!obj || typeof obj !== 'object') return null;
    const keys = Object.keys(obj);
    return keys.length === exact ? keys : null;
  };
  const names = keysOf(swan && swan.meshes, PART_COUNT) || keysOf(swan && swan.parts, PART_COUNT);
  if (!names) return FALLBACK_PARTS.slice();
  // 名字集合与契约建议一致时，先准备好契约顺序作为兜底（往往就是 SWAN_PARTS 顺序）。
  const contractOrder = (() => {
    const set = new Set(names);
    return FALLBACK_PARTS.every((n) => set.has(n)) ? FALLBACK_PARTS.slice() : names.slice();
  })();
  if (!swan || typeof swan.captureWorldPose !== 'function') return contractOrder;

  const scratch = new Float32Array(PART_COUNT * 16);
  try {
    swan.captureWorldPose(scratch, 0);
  } catch (e) {
    return contractOrder;
  }
  if (swan.root && typeof swan.root.updateMatrixWorld === 'function') {
    swan.root.updateMatrixWorld(true);
  }
  const objects = swan.meshes || swan.parts || {};
  const anchor = swan.anchor || null;
  const ordered = new Array(PART_COUNT).fill(null);
  let matched = 0;
  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    const obj = objects[name];
    if (!obj || !obj.matrixWorld) continue;
    const e = obj.matrixWorld.elements;
    const tx = e[12] - (anchor ? anchor.x : 0);
    const ty = e[13] - (anchor ? anchor.y : 0);
    const tz = e[14] - (anchor ? anchor.z : 0);
    let bestRow = -1;
    let bestDist = 2e-3;                 // 部件平移两两相距 ≥4cm，2mm 容差足够
    for (let row = 0; row < PART_COUNT; row++) {
      const o = row * MAT4_FLOATS;
      const d =
        Math.abs(scratch[o + 12] - tx) +
        Math.abs(scratch[o + 13] - ty) +
        Math.abs(scratch[o + 14] - tz);
      if (d < bestDist) {
        bestDist = d;
        bestRow = row;
      }
    }
    if (bestRow >= 0 && ordered[bestRow] === null) {
      ordered[bestRow] = name;
      matched++;
    }
  }
  return matched === PART_COUNT ? ordered : contractOrder;
}

/** 懒创建的兜底几何体：只有当 swan 还没提供几何体时才用（集成早期不崩）。 */
let _placeholderGeometry = null;
function getPlaceholderGeometry() {
  if (!_placeholderGeometry) {
    _placeholderGeometry = new THREE.IcosahedronGeometry(0.14, 1);
  }
  return _placeholderGeometry;
}

/**
 * out[o..o+15] = a[ao..ao+15] × b[bo..bo+15]，列主序，与 THREE.Matrix4.elements 同布局。
 * 内联标量乘法，避免每帧创建 Matrix4/Vector3（3456 次/帧的多压在热路径上）。
 */
function multiplyMat4(out, o, a, ao, b, bo) {
  const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3];
  const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7];
  const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11];
  const a30 = a[ao + 12], a31 = a[ao + 13], a32 = a[ao + 14], a33 = a[ao + 15];
  const b00 = b[bo], b01 = b[bo + 1], b02 = b[bo + 2], b03 = b[bo + 3];
  const b10 = b[bo + 4], b11 = b[bo + 5], b12 = b[bo + 6], b13 = b[bo + 7];
  const b20 = b[bo + 8], b21 = b[bo + 9], b22 = b[bo + 10], b23 = b[bo + 11];
  const b30 = b[bo + 12], b31 = b[bo + 13], b32 = b[bo + 14], b33 = b[bo + 15];
  out[o] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
  out[o + 1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
  out[o + 2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
  out[o + 3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;
  out[o + 4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
  out[o + 5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
  out[o + 6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
  out[o + 7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;
  out[o + 8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
  out[o + 9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
  out[o + 10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
  out[o + 11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;
  out[o + 12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
  out[o + 13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
  out[o + 14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
  out[o + 15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
}

// --------------------------------------------------------------------------------------------- 残影材质
/**
 * 幽灵材质：一个共享的 ShaderMaterial。
 * 顶点着色器：world = modelMatrix · instanceMatrix；把 aData(age, density, tint) 递给片元。
 * 片元着色器：
 *   fade   = exp(-1.9·age) · (1 - smoothstep(0.86,1,age)) · smoothstep(0,0.28s,age秒)  年龄淡出 + 出生淡入
 *   alpha  = (base + rim·fresnel) · fade · occlude
 *   color  = 瓷白顶光 · alpha + 瓷白·fresnel·rimGlow + 虹彩·fresnel
 *            + 暖色·fresh（新生暖光，会越过 bloom 阈值）+ 老尾端微光闪烁
 * 混合：预乘近似加性（blendSrc=One, blendDst=OneMinusSrcAlpha）。
 */
function createGhostMaterial() {
  const uniforms = {
    uTime: { value: 0 },
    uHistory: { value: 14 },
    uPorcelain: { value: DEFAULTS.porcelain.clone() },
    uWarm: { value: DEFAULTS.warm.clone() },
    uCool: { value: DEFAULTS.cool.clone() },
    uAlphaBase: { value: 0.012 },
    uAlphaRim: { value: 0.26 },
    uRimPow: { value: 2.6 },
    uRimGlow: { value: 0.50 },
    uIridescence: { value: 0.28 },
    uOcclude: { value: 0.42 },
    uLight: { value: 1.0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      attribute vec3 aData;      // x: 归一化年龄 0..1；y: 视线密度补偿；z: 天鹅序号 0..1
      uniform float uHistory;
      varying float vAge;
      varying float vDensity;
      varying float vTint;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      void main() {
        vAge = aData.x;
        vDensity = aData.y;
        vTint = aData.z;

        mat4 world = modelMatrix * instanceMatrix;
        vec4 worldPos = world * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vWorldNormal = mat3(world) * normal;

        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uHistory;
      uniform vec3 uPorcelain;
      uniform vec3 uWarm;
      uniform vec3 uCool;
      uniform float uAlphaBase;
      uniform float uAlphaRim;
      uniform float uRimPow;
      uniform float uRimGlow;
      uniform float uIridescence;
      uniform float uOcclude;
      uniform float uLight;

      varying float vAge;
      varying float vDensity;
      varying float vTint;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float ndv = abs(dot(N, V));
        float fres = pow(clamp(1.0 - ndv, 0.0, 1.0), uRimPow);

        // 年龄淡出：指数衰减 + 尾端硬淡出 + 出生淡入（避免与本体在 anchor 处硬叠）。
        float ageSec = vAge * uHistory;
        float fade = exp(-1.9 * vAge) * (1.0 - smoothstep(0.86, 1.0, vAge));
        fade *= smoothstep(0.0, 0.28, ageSec);

        // 老残影尾端有极轻微的闪烁，像瓷尘（warmth 之外唯一会动的东西）。
        float tail = smoothstep(0.55, 0.95, vAge);
        float spark = 0.5 + 0.5 * sin(uTime * 1.35 + hash13(floor(vWorldPos * 4.0)) * 37.0);
        fade *= mix(1.0, 0.62 + 0.72 * spark, tail);

        float a = (uAlphaBase + uAlphaRim * fres) * fade * uOcclude;

        // 颜色参考原视频的蓝调舞台：每只天鹅一条世界线，各带一点不同的蓝；
        // 新鲜残影偏暖白，中段转为青蓝，最老的尾端漂向紫。
        // 四只天鹅各有一条不同蓝调的世界线：青 → 天蓝 → 蓝紫 → 淡紫
        vec3 c0 = vec3(0.42, 0.92, 1.00), c1 = vec3(0.26, 0.68, 1.00);
        vec3 c2 = vec3(0.66, 0.56, 1.00), c3 = vec3(0.84, 0.72, 1.00);
        vec3 swanTint = vTint < 0.3333 ? mix(c0, c1, vTint * 3.0)
                      : (vTint < 0.6667 ? mix(c1, c2, (vTint - 0.3333) * 3.0)
                                        : mix(c2, c3, (vTint - 0.6667) * 3.0));
        // 时间方向：新鲜残影偏冷白，中段是舞台的青蓝，最老的尾端漂向蓝紫
        vec3 ageTint = mix(vec3(0.80, 0.94, 1.00), vec3(0.66, 0.50, 1.00), smoothstep(0.25, 0.95, vAge));
        vec3 tint = mix(swanTint, ageTint, 0.35);

        // 瓷质高光 + 彩色的边缘光（参考原视频的蓝色舞台灯）
        float top = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 base = mix(uCool, uPorcelain, 0.20 + 0.55 * top);
        base = mix(base, tint, 0.78);
        vec3 col = base * (0.26 + 0.74 * top) * a;
        col += tint * fres * uRimGlow * 1.45 * fade;
        vec3 iri = 0.5 + 0.5 * cos(6.2831853 * (fres * 1.6 + vAge * 0.35 + vec3(0.0, 0.33, 0.67)));
        col += iri * fres * uIridescence * fade;

        // 新生暖光：出生后 ~0.55s 指数冷却，最新的边缘会越过 bloom 阈值。
        float fresh = exp(-ageSec / 0.55);
        col += uWarm * fresh * (0.10 + 0.90 * fres) * smoothstep(0.0, 0.20, ageSec);
        col += uWarm * fresh * fresh * pow(fres, 1.5) * 4.0 * smoothstep(0.0, 0.12, ageSec);

        // 顺着世界线看时把亮度压下来（几百层叠加才不会烧成一片白）。
        col *= uLight * vDensity;
        a *= uLight * vDensity;

        gl_FragColor = vec4(min(col, vec3(6.0)), a);
      }
    `,
  });
  material.name = 'ghost-porcelain';
  material.userData.uniforms = uniforms;
  return material;
}

// --------------------------------------------------------------------------------------------- Ghosts
export class Ghosts {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene 舞台场景（残影网格会 add 进去）
   * @param {Array} opts.swans Swan 实例数组（4 只）
   * @param {number} [opts.capacity=72] 快照环形缓冲容量（每快照含 4 只天鹅 × 12 部件）
   * @param {number} [opts.history=14] 历史秒数：age = (T - birth) / history
   */
  constructor({ scene, swans, capacity = 72, history = 14 } = {}) {
    if (!scene) throw new Error('Ghosts: 需要传入 THREE.Scene');
    this.scene = scene;
    this.swans = Array.isArray(swans) ? swans : [];
    this.swanCount = Math.max(1, this.swans.length);
    this.capacity = Math.max(1, Math.floor(capacity) || 72);
    this._history = Math.max(0.5, Number.isFinite(history) ? history : 14);
    this.partNames = resolvePartNames(this.swans);

    const maxInstances = (this._maxInstances = this.capacity * this.swanCount);

    // ---- 快照数据（全部预分配）
    // pose[slot][swan][part] = 锚点相对的 4×4 世界矩阵。布局 = ((slot*swanCount+i)*12 + part)*16。
    this._pose = new Float32Array(this.capacity * this.swanCount * SWAN_POSE_FLOATS);
    this._birth = new Float32Array(this.capacity).fill(NaN);
    this._next = 0;                    // 下一个写入的环形槽位
    this._filled = 0;                  // 环形缓冲里有效快照数（≤ capacity）
    this._lastT = NaN;

    // ---- 每帧代价数据：世界线矩阵 / 年龄 / 排序 / 密度（全部按实例 id 索引）
    this._frames = new Float32Array(maxInstances * 16);
    this._instAge = new Float32Array(maxInstances);
    this._instDensity = new Float32Array(maxInstances);
    this._dist = new Float32Array(maxInstances);
    this._mark = new Uint32Array(maxInstances);
    this._mask = new Uint32Array(maxInstances);
    this._stamp = 0;
    this._order = new Uint16Array(maxInstances);
    this._orderLen = 0;
    this._slotList = new Uint16Array(this.capacity);
    this._visibleCount = 0;

    // ---- 排序/采样 scratch
    this._m = new THREE.Matrix4();
    this._tan = new THREE.Vector3();

    // ---- 世界线（内部创建；a=0 永远在各自 anchor 上）
    this.worldlines = createWorldlines(this.swans);
    while (this.worldlines.length < this.swanCount) {
      const wl = new SwanWorldline({ side: 1, fan: 0 });
      wl.index = this.worldlines.length;
      this.worldlines.push(wl);
    }

    // ---- 材质 + 17 个 InstancedMesh
    this._material = createGhostMaterial();
    this._material.uniforms.uHistory.value = this._history;
    // 每实例 (age, density) 共用一份属性：12 个几何体引用同一个对象，每帧只上传一次。
    this._ageAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3);
    this._ageAttr.setUsage(THREE.DynamicDrawUsage);

    this._meshes = new Array(PART_COUNT);
    for (let p = 0; p < PART_COUNT; p++) {
      const name = this.partNames[p] || FALLBACK_PARTS[p];
      const geo = this._createPartGeometry(name);
      geo.setAttribute('aData', this._ageAttr);
      const mesh = new THREE.InstancedMesh(geo, this._material, maxInstances);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;      // 实例位置每帧都在动，包围球没有意义
      mesh.renderOrder = 10;           // 不透明物体之后、其他透明物体之前的残影层
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `ghosts:${name}`;
      mesh.userData.ghostPart = name;
      this.scene.add(mesh);
      this._meshes[p] = mesh;
    }

    this._time = 0;
    this._disposed = false;
  }

  // ------------------------------------------------------------------ 契约 API
  /** 当前每只天鹅可见的残影数（四只同一时刻拍，所以同一个值）。 */
  get count() {
    return this._visibleCount;
  }

  /** 残影共享材质（高级微调入口：统一参数在 material.uniforms 上，见 docs/ghost-engine.md）。 */
  get material() {
    return this._material;
  }

  /** 12 个部件 InstancedMesh（同一实例次序；供拾取/调试使用）。 */
  get meshes() {
    return this._meshes;
  }

  /** 把某个实例（任意部件共用同一实例次序）映射回它的快照时刻。拾取交互用。 */
  timeOfInstance(instanceId) {
    if (instanceId < 0 || instanceId >= this._orderLen) return null;
    const id = this._order[instanceId];
    const slot = Math.floor(id / this.swanCount);
    const birth = this._birth[slot];
    if (birth !== birth) return null;
    return { T: birth, swan: id % this.swanCount, age: this._instAge[id] };
  }

  /** 离给定时间最近的有效快照（hover 预览用）。返回 { slot, T, dist }，无快照时 slot = -1。 */
  nearestSlot(T) {
    let best = -1, bd = Infinity;
    for (let s = 0; s < this.capacity; s++) {
      const b = this._birth[s];
      if (b !== b) continue;
      const d = Math.abs(b - T);
      if (d < bd) { bd = d; best = s; }
    }
    return { slot: best, T: best >= 0 ? this._birth[best] : NaN, dist: bd };
  }

  /** 把某个槽位、某只天鹅的 12 个部件（锚点相对世界矩阵）写到 out。 */
  poseAt(slot, swanIndex, out) {
    const count = this.swanCount;
    const i = Math.max(0, Math.min(count - 1, swanIndex | 0));
    const off = (slot * count + i) * SWAN_POSE_FLOATS;
    for (let k = 0; k < SWAN_POSE_FLOATS; k++) out[k] = this._pose[off + k];
    return out;
  }

  /** 每个部件网格在 SWAN_POSE_FLOATS 行序里的名字（预览/拾取用）。 */
  get partOrder() {
    return this.partNames;
  }

  /**
   * 视觉总量调节（快捷入口）：1 = 默认；0 = 完全隐去；>1 更亮。
   * 内部改 uLight，同时缩放颜色与 alpha；主程序可用于淡入/淡出/画质。
   * @param {number} k
   */
  setOpacity(k) {
    const v = Number.isFinite(k) ? Math.min(4, Math.max(0, k)) : 1;
    this._material.uniforms.uLight.value = v;
  }

  /**
   * 拍一次照：对每只天鹅调用 captureWorldPose，写入自己的环形槽位。
   * 调用前主循环必须已经 swan.update(t) + root.updateMatrixWorld(true)。
   * @param {number} T 音乐时间（秒）
   */
  snapshot(T) {
    if (this._disposed) return;
    const t = Number.isFinite(T) ? T : this._lastT;
    if (!Number.isFinite(t)) return;
    const slot = this._next;
    this._birth[slot] = t;
    const pose = this._pose;
    for (let i = 0; i < this.swanCount; i++) {
      const swan = this.swans[i];
      const off = (slot * this.swanCount + i) * SWAN_POSE_FLOATS;
      if (swan && typeof swan.captureWorldPose === 'function') {
        swan.captureWorldPose(pose, off);
      } else {
        this._captureFallback(swan, pose, off);
      }
    }
    this._next = (slot + 1) % this.capacity;
    if (this._filled < this.capacity) this._filled++;
  }

  /**
   * 每帧摆位：世界线跟随锚点、按年龄取世界线矩阵、合成残影矩阵、排序、写实例缓冲。
   * @param {number} dt 帧间隔（秒）
   * @param {{T?:number, history?:number, camera?:THREE.Camera}} [opts]
   */
  update(dt = 0, opts = {}) {
    if (this._disposed) return;
    const options = opts || {};
    let T = options.T;
    if (!Number.isFinite(T)) T = this._lastT;
    const history =
      Number.isFinite(options.history) && options.history > 0.05 ? options.history : this._history;
    const camera = options.camera || null;
    this._history = history;
    const step = Number.isFinite(dt) ? dt : 0;
    this._time += step;

    // T 往回跳（循环 / 重开）：整体平移出生时间，残影年龄保持连续，不会瞬间消失或堆在 anchor。
    if (Number.isFinite(T) && Number.isFinite(this._lastT) && T < this._lastT - 1e-3) {
      const shift = T - this._lastT;
      const births = this._birth;
      for (let s = 0; s < this.capacity; s++) {
        const b = births[s];
        if (b === b) births[s] = b + shift;
      }
    }
    if (Number.isFinite(T)) this._lastT = T;

    // ---- 1) 世界线跟随各自 anchor 重建
    for (let i = 0; i < this.swanCount; i++) {
      const swan = this.swans[i];
      const wl = this.worldlines[i];
      if (wl) wl.update(step, swan && swan.anchor ? swan.anchor : undefined);
    }

    // ---- 2) 可见快照 → 每个 (快照, 天鹅) 实例的世界线矩阵 / 年龄 / 排序距离 / 密度
    const cap = this.capacity;
    const swanCount = this.swanCount;
    const births = this._birth;
    const frames = this._frames;
    const instAge = this._instAge;
    const instDensity = this._instDensity;
    const dist = this._dist;
    const mark = this._mark;
    const slotList = this._slotList;
    const stamp = ++this._stamp;
    const cam = camera && camera.position ? camera.position : null;
    const start = (this._next - this._filled + cap) % cap;
    let visible = 0;

    for (let s = 0; s < this._filled; s++) {
      const slot = (start + s) % cap;
      const birth = births[slot];
      if (birth !== birth) continue;
      let age = (T - birth) / history;
      if (!(age < 1)) continue;       // NaN 或已经老过 history 的快照直接不画
      if (age < 0) age = 0;
      slotList[visible++] = slot;

      for (let i = 0; i < swanCount; i++) {
        const id = slot * swanCount + i;
        const wl = this.worldlines[i];
        const fOff = id * 16;
        wl.matrixAtAge(age, this._m);          // Frame(age) = T(worldline 位置) · R(平行传输朝向)
        this._m.toArray(frames, fOff);         // 摊平成 Float32Array，后续手写 4×4 乘法
        instAge[id] = age;
        mark[id] = stamp;
        if (cam) {
          const dx = frames[fOff + 12] - cam.x;
          const dy = frames[fOff + 13] - cam.y;
          const dz = frames[fOff + 14] - cam.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          dist[id] = d2;
          const inv = 1 / Math.sqrt(d2 > 1e-8 ? d2 : 1e-8);
          wl.tangentAtU(wl.uOfAge(age), this._tan);
          const along = Math.abs(
            this._tan.x * dx * inv + this._tan.y * dy * inv + this._tan.z * dz * inv,
          );
          instDensity[id] = 1 - (1 - DENSITY_MIN) * Math.pow(along, DENSITY_POW);
        } else {
          dist[id] = 0;
          instDensity[id] = 1;
        }
      }
    }
    this._visibleCount = visible;

    // ---- 3) 排序：按相机距离从远到近（预乘透明混合下，近的必须最后画）
    // 复用上一帧的次序做插入排序：成员每帧只增删一个，几乎已排好，接近 O(n)。
    const order = this._order;
    const mask = this._mask;
    let w = 0;
    const prevLen = this._orderLen;
    for (let j = 0; j < prevLen; j++) {
      const id = order[j];
      if (mark[id] === stamp) {
        mask[id] = stamp;
        order[w++] = id;
      }
    }
    for (let s = 0; s < visible; s++) {
      const slot = slotList[s];
      for (let i = 0; i < swanCount; i++) {
        const id = slot * swanCount + i;
        if (mask[id] !== stamp) {
          mask[id] = stamp;
          order[w++] = id;
        }
      }
    }
    if (cam && w > 1) {
      // 从远到近：dist 大的先画。上一帧次序接近有序，插入排序代价极低。
      for (let a = 1; a < w; a++) {
        const id = order[a];
        const d = dist[id];
        let b = a - 1;
        while (b >= 0 && dist[order[b]] < d) {
          order[b + 1] = order[b];
          b--;
        }
        order[b + 1] = id;
      }
    }
    this._orderLen = w;

    // ---- 4) 每实例数据（age, density）：12 个几何体共享同一份属性，只写一次
    const instanceData = this._ageAttr.array;
    for (let j = 0; j < w; j++) {
      const id = order[j];
      instanceData[j * 3] = instAge[id];
      instanceData[j * 3 + 1] = instDensity[id];
      instanceData[j * 3 + 2] = swanCount > 1 ? (id % swanCount) / (swanCount - 1) : 0.5;
    }
    if (w > 0) {
      const attr = this._ageAttr;
      if (attr.clearUpdateRanges) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, w * 3);
      }
      attr.needsUpdate = true;
    }

    // ---- 5) 12 个 instanced matrix：instanceMatrix = worldline.matrixAtAge(age) × pose
    const pose = this._pose;
    const n = w;
    for (let p = 0; p < PART_COUNT; p++) {
      const mesh = this._meshes[p];
      const im = mesh.instanceMatrix.array;
      const partOffset = p * MAT4_FLOATS;
      for (let j = 0; j < n; j++) {
        const id = order[j];
        multiplyMat4(im, j * 16, frames, id * 16, pose, id * SWAN_POSE_FLOATS + partOffset);
      }
      mesh.count = n;
      if (n > 0) {
        const ia = mesh.instanceMatrix;
        if (ia.clearUpdateRanges) {
          ia.clearUpdateRanges();
          ia.addUpdateRange(0, n * 16);
        }
        ia.needsUpdate = true;
      }
    }

    // ---- 6) 共享 uniform
    const u = this._material.uniforms;
    u.uTime.value = this._time;
    u.uHistory.value = history;
  }

  /** 清空所有残影（重开一曲 / 换段时调用）。 */
  reset() {
    if (this._disposed) return;
    this._next = 0;
    this._filled = 0;
    this._lastT = NaN;
    this._visibleCount = 0;
    this._orderLen = 0;
    this._birth.fill(NaN);
    this._mark.fill(0);
    this._mask.fill(0);
    for (const mesh of this._meshes) mesh.count = 0;
  }

  /** 释放场景里的网格、几何体与材质。可重复调用。 */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const mesh of this._meshes) {
      if (this.scene && this.scene.remove) this.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (typeof mesh.dispose === 'function') mesh.dispose();
    }
    this._meshes.length = 0;
    this._material.dispose();
    this._orderLen = 0;
    this._filled = 0;
    this._visibleCount = 0;
  }

  // ------------------------------------------------------------------ 内部
  /** 某个部件的 ghost 几何体：优先问 swan.getPartGeometry，其次直接拿 mesh.geometry，都没有就兜底。 */
  _createPartGeometry(name) {
    let source = null;
    for (let i = 0; i < this.swans.length; i++) {
      const swan = this.swans[i];
      if (!swan) continue;
      if (typeof swan.getPartGeometry === 'function') {
        const g = swan.getPartGeometry(name);
        if (g && g.isBufferGeometry) { source = g; break; }
      }
      const mesh = swan.meshes && swan.meshes[name];
      if (mesh && mesh.geometry) { source = mesh.geometry; break; }
    }
    const geo = source ? source.clone() : getPlaceholderGeometry().clone();
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    return geo;
  }

  /** 没有 captureWorldPose 时的兜底：直接从 parts/meshes 的 matrixWorld 抄，平移减 anchor。 */
  _captureFallback(swan, pose, off) {
    const anchor = swan && swan.anchor ? swan.anchor : null;
    const objects = (swan && (swan.meshes || swan.parts)) || null;
    for (let p = 0; p < PART_COUNT; p++) {
      const o = off + p * MAT4_FLOATS;
      const obj = objects ? objects[this.partNames[p]] : null;
      if (obj && obj.matrixWorld) {
        const e = obj.matrixWorld.elements;
        for (let k = 0; k < 16; k++) pose[o + k] = e[k];
        if (anchor) {
          pose[o + 12] -= anchor.x;
          pose[o + 13] -= anchor.y;
          pose[o + 14] -= anchor.z;
        }
      } else {
        pose[o] = 1; pose[o + 5] = 1; pose[o + 10] = 1; pose[o + 15] = 1;
      }
    }
  }
}
