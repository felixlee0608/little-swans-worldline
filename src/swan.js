/**
 * little-swans / src/swan.js
 * ============================================================================
 * 《小天鹅舞曲 · 瓷偶世界线》—— 程序化「瓷白芭蕾小天鹅」
 *
 * 纯 three.js 几何体拼装（不加载任何外部模型/贴图）：
 *   - 17 个刚体部件（SWAN_PARTS 顺序固定：脊柱两段、手臂两段、腿两段），可父子层级；
 *   - 共享瓷白材质（高 clearcoat + 低粗糙 + 微虹彩 + 一点点金饰）；
 *   - 8 秒循环编舞：双臂在身前交叉、手递向相邻天鹅，侧向小跳 / plié、
 *     头微侧、纱裙与翅羽轻颤，动作全部由解析式周期函数给出（确定性）。
 *
 * 坐标系（见 CONTRACT.md）：
 *   - y 向上，地面 y=0，1 单位 = 1 米；面朝 +Z（观众在 +Z）；
 *   - 四只并排：root.position.x = (index - 1.5) * spacing，
 *     默认 spacing=1.8 → x = [-2.7, -0.9, 0.9, 2.7]；
 *   - 骨盆锚点 anchor ≈ (root.x, 0.95, 0)，是 worldline / ghost 的发射点。
 *
 * 热路径约定：
 *   - update(t) 只做标量数学 + 写 Object3D transform，不创建任何对象；
 *   - captureWorldPose(out, off) 直接把 matrixWorld 写进预分配数组；
 *   - 同一 t 必得同一姿态（无时间累积、无随机数、无状态残留）。
 * ============================================================================
 */

import * as THREE from 'three';
import { SCORE, BEAT } from './score.js';

/** 17 个刚体部件名（顺序固定，ghost 快照按此顺序写矩阵）。 */
export const SWAN_PARTS = Object.freeze([
  'body',        // 骨盆/下躯干（总枢轴；tutu、chest 挂在它下面）
  'tutu',        // 短纱裙
  'chest',       // 上躯干（脊柱枢轴在腰；头/翅/双臂挂在它下面）
  'head',        // 头颈（颈根枢轴）
  'bun',         // 发髻（挂在 head 上）
  'wingL',       // 左翅（挂在 chest 上）
  'wingR',       // 右翅
  'armUpperL',   // 左上臂（肩枢轴；上臂 → 肘球）
  'armForeL',    // 左前臂（肘枢轴；前臂 → 手腕 → 手）
  'armUpperR',   // 右上臂
  'armForeR',    // 右前臂
  'thighL',      // 左大腿（髋枢轴）
  'thighR',      // 右大腿
  'shinL',       // 左小腿（膝枢轴）
  'shinR',       // 右小腿
  'slipperL',    // 左足尖鞋（踝枢轴）
  'slipperR',    // 右足尖鞋
]);

/** 编舞循环长度（秒）。 */
export const SWAN_LOOP = SCORE.totalDuration;   // music + curtain call; choreography is authored on the score's beat grid

// ---------------------------------------------------------------------------
// 基本比例（米）—— 总高约 1.65m（发髻顶），足尖 y=0，骨盆 y=0.95
// ---------------------------------------------------------------------------
const PELVIS_Y = 0.95;   // body 枢轴（骨盆 / 锚点）世界高度
const HIP_Y = 0.92;      // 髋关节（腿的枢轴）世界高度
const HIP_X = 0.082;     // 髋关节左右偏移
const THIGH_L = 0.400;   // 髋 → 膝
const SHIN_L = 0.430;    // 膝 → 踝（合起来 0.83，与旧单段腿一致）
const ANKLE_Y = 0.090;   // 立脚尖时踝的世界高度（足尖落地 y=0）
const KNEE_POS = Object.freeze({ x: 0.004, y: -THIGH_L, z: 0.014 });  // 膝枢轴（thigh-local）
const ANKLE_POS = Object.freeze({ x: 0.000, y: -SHIN_L, z: 0.004 });  // 踝枢轴（shin-local）
const CHEST_Y = 0.10;    // 胸/脊柱枢轴在 body-local 的 y（腰）
const NECK_Y = 0.34;     // head 枢轴在 chest-local 的 y（body-local 0.44）
const SHOULDER = Object.freeze({ x: 0.158, y: 0.226, z: 0.012 }); // 肩枢轴（chest-local）
const ARM_L1 = 0.260;    // 肩 → 肘
const ARM_L2 = 0.300;    // 肘 → 手（IK 的末端＝与邻居交握的那一点）
const HAND = Object.freeze({ x: 0.248, y: 0.120, z: 0.190 });    // 手的目标（chest-local；左右交叉到邻居手边）
const BUN_POS = Object.freeze({ x: 0, y: 0.198, z: -0.060 });       // bun 枢轴（head-local）

const TAU = Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 每 8 拍一个动作块（8 拍 ≈ 4.72s）。整支舞是这些块的序列：站立呼吸 → 基本小跳 →
 * 横移 → 侧/后伸腿 → 再回到基本 → 快板腿花 → 终幕收势。
 * 每个块只描述参数，动作由 update() 连续插值生成；所有幅度都在 +Z 面向观众时成立。
 */
const MOVES = {
  // hop: 每拍小跳高度；sway: 整排摆动幅度；arm: 手臂随跳起伏；head: 头侧；ext: 伸腿强度；bend: plié 屈膝强度
  hold:    { hop: 0.045, sway: 0.060, arm: 0.08, head: 0.20, ext: 0.0, bend: 0.60 },   // 入场：从第一拍就有可见的屈膝与小跳
  basic:   { hop: 0.070, sway: 0.10, arm: 0.08, head: 0.24, ext: 0.0, bend: 0.85 },
  travel:  { hop: 0.078, sway: 0.32, arm: 0.10, head: 0.28, ext: 0.0, bend: 0.95 },
  extend:  { hop: 0.050, sway: 0.09, arm: 0.06, head: 0.32, ext: 1.00, bend: 0.55 },
  legbeat: { hop: 0.085, sway: 0.14, arm: 0.10, head: 0.34, ext: 1.20, bend: 0.50 },
  finale:  { hop: 0.018, sway: 0.04, arm: 0.02, head: 0.12, ext: 0.35, bend: 1.20 },
};
const BLOCKS = [
  'hold', 'hold',                                               // 0–1   入场
  'basic', 'basic', 'basic', 'basic', 'basic',                  // 2–6   队列
  'travel', 'travel', 'extend', 'extend',                       // 7–10  横移 + 展翅
  'basic', 'basic', 'extend', 'extend',                         // 11–14
  'travel', 'travel', 'legbeat', 'legbeat',                     // 15–18 回旋
  'extend', 'extend', 'finale', 'finale',                       // 19–22 终幕
];

/** 阵型横向展开半径：index 0..3 → x = (index - 1.5) * spacing。 */
const FORMATION_CENTER = 1.5;

// ---------------------------------------------------------------------------
// 共享材质
// ---------------------------------------------------------------------------

let _porcelainMaterial = null;
let _goldMaterial = null;

/**
 * 瓷白材质：暖白、高 clearcoat、低粗糙、一层很淡的虹彩（iridescence）。
 * 整个作品共享同一个实例（四只小天鹅 + 主程序里如需参考都拿到它）。
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createPorcelainMaterial() {
  if (_porcelainMaterial) return _porcelainMaterial;
  _porcelainMaterial = new THREE.MeshPhysicalMaterial({
    name: 'swan-porcelain',
    color: new THREE.Color(0xfff6ee),        // 暖白，不是死白
    roughness: 0.16,
    metalness: 0.0,
    clearcoat: 1.0,                          // 釉面高光
    clearcoatRoughness: 0.05,
    sheen: 1.0,                              // 边缘一层柔光（像瓷的透光）
    sheenColor: new THREE.Color(0xffdfe9),
    sheenRoughness: 0.6,
    iridescence: 0.38,                       // 微虹彩
    iridescenceIOR: 1.38,
    iridescenceThicknessRange: [90, 380],
    envMapIntensity: 1.15,
    side: THREE.FrontSide,
  });
  return _porcelainMaterial;
}

/** 金饰材质（发带、冠、足尖鞋丝带）—— 少量点缀，不抢瓷白。 */
function getGoldMaterial() {
  if (_goldMaterial) return _goldMaterial;
  _goldMaterial = new THREE.MeshPhysicalMaterial({
    name: 'swan-gold',
    color: new THREE.Color(0xd8a94a),
    roughness: 0.24,
    metalness: 1.0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.15,
    envMapIntensity: 1.6,
  });
  return _goldMaterial;
}

// ---------------------------------------------------------------------------
// 几何小工具（只在构造期使用，可以随意分配）
// ---------------------------------------------------------------------------

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

function V(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

/** 椭球。 */
function ball(x, y, z, r, sx = 1, sy = 1, sz = 1, widthSeg = 14, heightSeg = 10) {
  const g = new THREE.SphereGeometry(r, widthSeg, heightSeg);
  if (sx !== 1 || sy !== 1 || sz !== 1) g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/**
 * 两段点之间的（锥形）柱体：a 端半径 r0，b 端半径 r1。
 * 关节处再补一个小球就得到圆润的“瓷关节”。
 */
function limb(a, b, r0, r1, radialSegments = 10) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, Math.max(len, 1e-4), radialSegments, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/** 一片羽：把锥形柱体压扁（沿旋转前的局部 X 轴），尖端补一个小球。 */
function pushFeather(out, a, b, r0, r1, squash = 0.45) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, Math.max(len, 1e-4), 8, 1, false);
  g.scale(squash, 1, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  out.push(g);
  out.push(ball(b.x, b.y, b.z, r1 * 1.15, 1, 1, 1, 8, 6));
}

/** 圆环（torus）。rotation 用 [rx, ry, rz] 弧度依次旋转。 */
function ring(radius, tube, position, rotation = null, arc = TAU) {
  const g = new THREE.TorusGeometry(radius, tube, 6, 24, arc);
  if (rotation) {
    if (rotation[0]) g.rotateX(rotation[0]);
    if (rotation[1]) g.rotateY(rotation[1]);
    if (rotation[2]) g.rotateZ(rotation[2]);
  }
  g.translate(position[0], position[1], position[2]);
  return g;
}

/** 非索引三角形网格的有向体积（用来判断 Lathe 的绕序是否朝外）。 */
function signedVolume(g) {
  const p = g.attributes.position.array;
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** 翻转非索引三角形的绕序（配合 computeVertexNormals 重新法线）。 */
function flipWinding(g) {
  const p = g.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const tmp = p[i + 3 + k];
      p[i + 3 + k] = p[i + 6 + k];
      p[i + 6 + k] = tmp;
    }
  }
}

/**
 * 旋转体：profile = [[r, y], ...]。自动修正绕序并重算法线，保证法线朝外。
 * 注意构造期的少量分配无妨（不在热路径）。
 */
function lathe(profile, segments = 28) {
  const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]));
  let g = new THREE.LatheGeometry(pts, segments).toNonIndexed();
  if (signedVolume(g) < 0) flipWinding(g);
  g.computeVertexNormals();
  return g;
}

/**
 * 合并一组 BufferGeometry（统一转非索引，拼 position/normal/uv）。
 * 用于：每个刚体部件最终只保留一个 Mesh（draw call 友好），
 * 以及 getPartGeometry() 给 ghost 的低模几何。
 */
function mergeGeometries(list) {
  const prepared = [];
  let vertexCount = 0;
  for (const source of list) {
    if (!source || !source.attributes || !source.attributes.position) continue;
    const g = source.index ? source.toNonIndexed() : source;
    if (!g.attributes.normal) g.computeVertexNormals();
    prepared.push(g);
    vertexCount += g.attributes.position.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  let offset = 0;
  for (const g of prepared) {
    const count = g.attributes.position.count;
    positions.set(g.attributes.position.array, offset * 3);
    normals.set(g.attributes.normal.array, offset * 3);
    if (g.attributes.uv) uvs.set(g.attributes.uv.array, offset * 2);
    offset += count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// ---------------------------------------------------------------------------
// 12 个部件的几何（都建在各自的 part-local 坐标里，枢轴已在原点）
// ---------------------------------------------------------------------------

/** 骨盆/下躯干：胯、收腰、腰关节球、背面三根小尾羽。 */
function buildBodyGeometry() {
  const g = [];
  const torso = lathe([
    [0.000, -0.105],
    [0.046, -0.100],
    [0.083, -0.085],
    [0.109, -0.055],
    [0.119, -0.020],
    [0.115, 0.020],
    [0.100, 0.075],
    [0.101, 0.100],
    [0.103, 0.118],
    [0.000, 0.120],
  ], 30);
  torso.scale(1, 1, 0.72);
  torso.computeVertexNormals();
  g.push(torso);
  // 胯部/臀部体积
  g.push(ball(0, -0.005, -0.012, 0.118, 1.02, 0.74, 0.88));
  // 腰关节：一个略扁的球，胸旋转时把接缝藏在里面
  g.push(ball(0, CHEST_Y, 0.002, 0.104, 1.0, 0.52, 0.74, 18, 12));
  // 小尾羽（从腰后向 -Z 下方展开）
  const tailBase = V(0, -0.020, -0.075);
  pushFeather(g, tailBase, V(0.000, -0.105, -0.300), 0.034, 0.008, 0.5);
  pushFeather(g, tailBase, V(-0.070, -0.070, -0.270), 0.030, 0.007, 0.5);
  pushFeather(g, tailBase, V(0.070, -0.070, -0.270), 0.030, 0.007, 0.5);
  return mergeGeometries(g);
}

/** 上躯干/胸腔：从腰到颈根，圆润的胸线、肩头、颈根；脊柱枢轴在腰（chest-local 原点）。 */
function buildChestGeometry() {
  const g = [];
  const torso = lathe([
    [0.000, 0.000],
    [0.100, 0.000],
    [0.101, 0.012],
    [0.106, 0.040],
    [0.121, 0.075],
    [0.140, 0.110],
    [0.154, 0.150],
    [0.156, 0.165],
    [0.150, 0.195],
    [0.135, 0.220],
    [0.110, 0.240],
    [0.082, 0.257],
    [0.055, 0.272],
    [0.044, 0.288],
    [0.000, 0.296],
  ], 30);
  torso.scale(1, 1, 0.72);
  torso.computeVertexNormals();
  g.push(torso);
  // 胸部（很克制的一点点起伏）
  g.push(ball(-0.050, 0.162, 0.072, 0.047, 1.05, 0.78, 0.46));
  g.push(ball(0.050, 0.162, 0.072, 0.047, 1.05, 0.78, 0.46));
  // 肩头（臂的枢轴处）
  g.push(ball(-0.150, 0.220, 0.004, 0.050, 1.0, 0.88, 0.94));
  g.push(ball(0.150, 0.220, 0.004, 0.050, 1.0, 0.88, 0.94));
  // 颈根
  g.push(limb(V(0, 0.240, 0.0), V(0, 0.296, 0.004), 0.056, 0.044, 14));
  return mergeGeometries(g);
}

/** 短纱裙：闭合剖面旋转成的薄圆盘 + 13 瓣波浪裙边 + 腰封。 */
function buildTutuGeometry() {
  // 剖面是一个闭合回路（上表面 → 外缘 → 下表面），因此是一块有厚度的实心纱裙，
  // 从上方和下方看都有正面，不依赖 DoubleSide。
  const profile = [
    [0.100, 0.036],
    [0.150, 0.043],
    [0.215, 0.037],
    [0.280, 0.021],
    [0.330, 0.000],
    [0.356, -0.020],   // 外缘（更厚的瓷片）
    [0.340, -0.042],
    [0.290, -0.050],
    [0.215, -0.038],
    [0.150, -0.022],
    [0.100, -0.007],
    [0.100, 0.036],
  ];
  const disk = lathe(profile, 48);

  // 裙边压出波浪（只在 r > 0.22 的区域生效，13 瓣 → 首尾在 seam 处连续）
  const pos = disk.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 0.22) continue;
    let t = (r - 0.22) / 0.13;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const k = t * t * (3 - 2 * t);         // smoothstep
    const ang = Math.atan2(z, x);
    const wave = Math.sin(ang * 13);
    const radial = 1 + wave * 0.027 * k;
    pos.setXYZ(i, x * radial, y + wave * 0.018 * k, z * radial);
  }
  disk.computeVertexNormals();

  const waistband = ring(0.112, 0.016, [0, 0.020, 0], [Math.PI / 2, 0, 0]);
  return mergeGeometries([disk, waistband]);
}

/** 头颈：颈根枢轴在原点，往上依次是颈、下颌、头骨、脸、鼻、耳。 */
function buildHeadGeometry() {
  const g = [];
  // 颈
  g.push(limb(V(0, -0.088, 0), V(0, 0.048, 0.006), 0.044, 0.037, 14));
  // 下颌/脸
  g.push(ball(0, 0.092, 0.034, 0.065, 1.02, 0.88, 0.92, 16, 12));
  // 头骨
  g.push(ball(0, 0.132, 0.004, 0.091, 1.0, 1.10, 0.96, 22, 16));
  // 鼻尖（很浅的起伏，保持“素白瓷偶”的留白脸）
  g.push(ball(0, 0.114, 0.099, 0.0105, 1.15, 0.75, 1.05, 8, 6));
  // 耳
  g.push(ball(-0.090, 0.112, -0.008, 0.017, 0.55, 1.0, 0.8, 8, 6));
  g.push(ball(0.090, 0.112, -0.008, 0.017, 0.55, 1.0, 0.8, 8, 6));
  return mergeGeometries(g);
}

/** 发髻：一颗扁圆丸子 + 一圈盘发沟槽。 */
function buildBunGeometry() {
  const g = [];
  g.push(ball(0, 0, 0, 0.076, 1.0, 0.94, 0.90, 20, 14));
  g.push(ring(0.045, 0.011, [0, 0.004, 0], [Math.PI / 2, 0, 0]));
  return mergeGeometries(g);
}

/**
 * 翅羽（左 = side -1，右 = side +1）：从背部肩胛处向后下方展开的 4 片羽。
 * 枢轴在翅根，动画里只做轻微颤动。
 */
function buildWingGeometry(side) {
  const g = [];
  // 收拢的翅壳：流线型的一整片，正面只从肩后露一点轮廓
  g.push(ball(side * 0.030, -0.040, -0.085, 0.150, 0.30, 0.56, 0.95, 16, 12));
  g.push(ball(side * 0.015, 0.010, -0.030, 0.075, 0.55, 0.85, 0.90, 12, 10));
  // 翅尖三片短而圆的覆羽（不做细针状，远看是羽毛的层叠边）
  const base = V(side * 0.045, -0.075, -0.135);
  pushFeather(g, base, V(side * 0.070, -0.130, -0.245), 0.038, 0.020, 0.85);
  pushFeather(g, base, V(side * 0.100, -0.170, -0.235), 0.034, 0.018, 0.85);
  pushFeather(g, base, V(side * 0.125, -0.205, -0.215), 0.030, 0.016, 0.85);
  return mergeGeometries(g);
}

/** 上臂：肩枢轴在原点；肩球 → 上臂 → 肘球。 */
function buildUpperArmGeometry() {
  const g = [];
  g.push(ball(0, 0, 0, 0.050, 1.0, 1.0, 1.0, 12, 8));
  g.push(limb(V(0, 0, 0), V(0, -ARM_L1, 0), 0.046, 0.036, 10));
  g.push(ball(0, -ARM_L1, 0, 0.036, 1.0, 1.0, 1.0, 10, 8));
  return mergeGeometries(g);
}

/** 前臂：肘枢轴在原点；前臂 → 手腕 → 手掌 + 四指 + 拇指（指尖朝 -Y，即伸向邻居的手）。 */
function buildForearmGeometry() {
  const g = [];
  const wristY = -0.245;          // 手腕
  const tipY = -ARM_L2;           // 指尖 = IK 末端（与邻居交握点）
  g.push(limb(V(0, 0, 0), V(0, wristY, 0), 0.033, 0.023, 10));
  g.push(ball(0, wristY, 0, 0.025, 1.12, 0.9, 1.0, 10, 8));
  // 手掌（略扁）
  g.push(ball(0, wristY - 0.014, 0.004, 0.028, 1.22, 0.62, 0.92, 12, 8));
  // 四根手指，微微张开
  for (let i = 0; i < 4; i++) {
    const fx = (i - 1.5) * 0.0125;
    g.push(limb(
      V(fx * 0.55, wristY - 0.027, 0.006 + i * 0.0015),
      V(fx, tipY + 0.006, 0.008 + i * 0.002),
      0.0072, 0.0040, 6,
    ));
  }
  // 拇指
  g.push(limb(V(0.020, wristY - 0.012, 0.014), V(0.034, wristY - 0.034, 0.022), 0.0078, 0.0044, 6));
  return mergeGeometries(g);
}

/** 大腿：髋枢轴在原点；髋球 → 大腿 → 膝球。 */
function buildThighGeometry() {
  const g = [];
  const knee = V(KNEE_POS.x, KNEE_POS.y, KNEE_POS.z);
  g.push(ball(0, 0, 0, 0.074, 1.0, 0.92, 1.0, 12, 10));
  g.push(limb(V(0, 0, 0), knee, 0.079, 0.054, 12));
  // 大腿前侧的肌肉体积
  g.push(ball(0, -0.135, 0.014, 0.066, 1.05, 1.55, 0.92, 12, 10));
  g.push(ball(knee.x, knee.y, knee.z, 0.051, 1.0, 1.0, 1.0, 10, 8));
  return mergeGeometries(g);
}

/** 小腿：膝枢轴在原点；小腿 → 踝球。 */
function buildShinGeometry() {
  const g = [];
  const ankle = V(ANKLE_POS.x, ANKLE_POS.y, ANKLE_POS.z);
  g.push(limb(V(0, 0, 0), ankle, 0.050, 0.028, 10));
  // 小腿肚（腓肠肌）——有起伏才不像一根管子
  g.push(ball(0, -0.135, -0.008, 0.055, 1.0, 1.35, 0.92, 12, 10));
  g.push(ball(ankle.x, ankle.y, ankle.z, 0.028, 1.0, 0.92, 1.0, 10, 8));
  return mergeGeometries(g);
}

/**
 * 足尖鞋：踝枢轴在原点，鞋尖朝 +Z 下方（立脚尖）。最低点对齐到 -0.09，
 * 这样当踝世界高为 0.09 时，鞋尖正好落在 y=0 的地面上。
 */
function buildSlipperGeometry() {
  const g = [];
  const ballFoot = V(0, -0.052, 0.082);
  const toe = V(0, -0.082, 0.148);
  // 脚背（从踝向前下方的楔形）
  g.push(limb(V(0, -0.004, 0.008), ballFoot, 0.030, 0.025, 10));
  // 鞋身
  g.push(ball(ballFoot.x, ballFoot.y, ballFoot.z, 0.026, 1.0, 0.92, 1.0, 10, 8));
  // 鞋尖
  g.push(limb(ballFoot, toe, 0.025, 0.006, 8));
  g.push(ball(toe.x, toe.y, toe.z, 0.007, 1.0, 1.0, 1.0, 8, 6));
  // 后跟
  g.push(ball(0, -0.030, -0.016, 0.026, 0.9, 0.80, 1.0, 10, 8));
  // 踝头
  g.push(ball(0, 0, 0, 0.029, 1.0, 0.95, 1.0, 10, 8));

  const merged = mergeGeometries(g);
  // 让鞋底最低点刚好在踝下方 0.09m（= 地面）
  if (merged.boundingBox === null) merged.computeBoundingBox();
  const minY = merged.boundingBox.min.y;
  merged.translate(0, -0.09 - minY, 0);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** 头部金饰：小冠（弧环 + 一颗珠子）+ 颈链。 */
function buildHeadGoldGeometry() {
  const crownArc = ring(0.056, 0.0045, [0, 0.212, 0.015], [Math.PI / 2 - 0.32, 0, 0.05 * Math.PI], Math.PI * 0.86);
  const pearl = ball(0, 0.225, 0.058, 0.008, 1, 1, 1, 8, 6);
  const choker = ring(0.047, 0.0035, [0, -0.008, 0.004], [Math.PI / 2, 0, 0]);
  return mergeGeometries([crownArc, pearl, choker]);
}

/** 发髻金饰：一圈发带。 */
function buildBunGoldGeometry() {
  return mergeGeometries([
    ring(0.060, 0.005, [0, -0.044, 0.016], [Math.PI / 2 + 0.22, 0, 0]),
  ]);
}

/** 足尖鞋金饰：踝上一圈丝带 + 一个很细的蝴蝶结。 */
function buildSlipperGoldGeometry() {
  const g = [];
  g.push(ring(0.0305, 0.0042, [0, 0.004, 0.002], [Math.PI / 2 - 0.18, 0, 0]));
  g.push(ring(0.0305, 0.0042, [0, -0.010, 0.006], [Math.PI / 2 + 0.30, 0, 0]));
  g.push(ball(-0.020, 0.008, 0.030, 0.0075, 1.4, 0.7, 1.0, 8, 6));
  g.push(ball(0.020, 0.008, 0.030, 0.0075, 1.4, 0.7, 1.0, 8, 6));
  return mergeGeometries(g);
}

// ---------------------------------------------------------------------------
// Swan
// ---------------------------------------------------------------------------

/**
 * 一只瓷白芭蕾小天鹅。
 *
 * 层级（parts）：
 *   root
 *   ├─ body ── tutu / head ─– bun / wingL / wingR / armL / armR
 *   └─ legL ── slipperL
 *      legR ── slipperR
 *
 * 说明：腿之所以挂在 root 而不是 body 下，是为了「脚踩地面」——
 * 骨盆做 plié 下沉 / 小跳起伏时腿不跟着沉，髋部的 1~2cm 落差被纱裙盖住。
 */
// ---------------------------------------------------------------------------
// 腿的正向运动学：给定大腿/小腿/足尖角度，算出踝与足尖相对髋的高度偏移。
// 用它反推髋高，让支撑脚落在湖面上，而不是让整个身体"浮"在腿长上。
// ---------------------------------------------------------------------------
const _legE = new THREE.Euler(0, 0, 0, 'XYZ');
const _legQT = new THREE.Quaternion(), _legQS = new THREE.Quaternion(), _legQSl = new THREE.Quaternion();
const _legA = new THREE.Vector3(), _legT = new THREE.Vector3();
const _KNEE_V = new THREE.Vector3(KNEE_POS.x, KNEE_POS.y, KNEE_POS.z);
const _ANKLE_V = new THREE.Vector3(ANKLE_POS.x, ANKLE_POS.y, ANKLE_POS.z);
const _TOE_V = new THREE.Vector3(0, -0.082, 0.148);
const _legRes = { ankleY: 0, toeY: 0 };

function legOffsets(tx, ty, tz, kx, slx) {
  _legQT.setFromEuler(_legE.set(tx, ty, tz, 'XYZ'));
  _legQS.setFromEuler(_legE.set(kx, 0, 0, 'XYZ'));
  _legQSl.setFromEuler(_legE.set(slx, 0, 0, 'XYZ'));
  // ankle in thigh-local
  _legA.copy(_ANKLE_V).applyQuaternion(_legQS).add(_KNEE_V);
  // toe: ankle pivot + slipper rotation, in shin-local, then knee/thigh
  _legT.copy(_TOE_V).applyQuaternion(_legQSl).add(_ANKLE_V).applyQuaternion(_legQS).add(_KNEE_V);
  _legA.applyQuaternion(_legQT);
  _legT.applyQuaternion(_legQT);
  _legRes.ankleY = _legA.y;
  _legRes.toeY = _legT.y;
  return _legRes;
}

// ---------------------------------------------------------------------------
// 手臂两段 IK：手链不能断，所以手的目标点固定在「与邻居的中线」上，
// 由肩和肘去够；肘用极向量控制朝外下方，弯肘看起来像真人在身前交手。
// ---------------------------------------------------------------------------
const _armS = new THREE.Vector3(), _armD = new THREE.Vector3(), _armE = new THREE.Vector3();
const _armPole = new THREE.Vector3(), _armV = new THREE.Vector3();
const _armQ1 = new THREE.Quaternion(), _armQ2 = new THREE.Quaternion();
const _ARM_DOWN = new THREE.Vector3(0, -1, 0);
const _handA = new THREE.Vector3(), _handB = new THREE.Vector3();

function poseArm(side, target, upperPart, forePart) {
  _armS.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z);
  _armD.copy(target).sub(_armS);
  let dist = _armD.length();
  const maxReach = ARM_L1 + ARM_L2 - 0.008;
  if (dist > maxReach) { _armD.multiplyScalar(maxReach / dist); dist = maxReach; }
  if (dist < 0.08) { _armD.set(0, -1, 0); dist = 0.08; }
  _armD.normalize();
  const a = (ARM_L1 * ARM_L1 - ARM_L2 * ARM_L2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0.0001, ARM_L1 * ARM_L1 - a * a));
  // 肘部极向量：朝身体外侧、略向下
  _armPole.set(side * 1.0, -0.75, 0.06);
  _armPole.addScaledVector(_armD, -_armPole.dot(_armD));
  if (_armPole.lengthSq() < 1e-6) _armPole.set(0, -1, 0); else _armPole.normalize();
  _armE.copy(_armS).addScaledVector(_armD, a).addScaledVector(_armPole, h);
  // 上臂：local -Y → 肩→肘
  _armV.copy(_armE).sub(_armS).normalize();
  _armQ1.setFromUnitVectors(_ARM_DOWN, _armV);
  // 前臂：父级旋转之后，local -Y 指向肘→手
  _armV.copy(target).sub(_armE).normalize();
  _armQ2.copy(_armQ1).invert();
  _armV.applyQuaternion(_armQ2);
  _armQ2.setFromUnitVectors(_ARM_DOWN, _armV);
  upperPart.quaternion.copy(_armQ1);
  forePart.quaternion.copy(_armQ2);
}

// 手链约束：胸腔会 roll/twist，如果只在 chest-local 里举手，相邻两人的手会错开。
// 所以先在 root 空间算出「两人手之间的中点」，再反变换回 chest-local 交给 IK。
const _chestQ = new THREE.Quaternion(), _chestIQ = new THREE.Quaternion();
const _chestPos = new THREE.Vector3(), _pL = new THREE.Vector3(), _pR = new THREE.Vector3();

function poseLinkedArms(swan, handY, handZ) {
  const p = swan.parts;
  const bodyQ = p.body.quaternion;
  _chestQ.copy(bodyQ).multiply(p.chest.quaternion);
  _chestPos.copy(p.chest.position).applyQuaternion(bodyQ).add(p.body.position);
  _pL.set(HAND.x, handY, handZ).applyQuaternion(_chestQ).add(_chestPos);
  _pR.set(-HAND.x, handY, handZ).applyQuaternion(_chestQ).add(_chestPos);
  _handA.copy(_pL).add(_pR).multiplyScalar(0.5);
  _handA.x += swan.spacing * 0.5;
  _handB.copy(_pL).add(_pR).multiplyScalar(0.5);
  _handB.x -= swan.spacing * 0.5;
  _chestIQ.copy(_chestQ).invert();
  _handA.sub(_chestPos).applyQuaternion(_chestIQ);
  _handB.sub(_chestPos).applyQuaternion(_chestIQ);
  poseArm(-1, _handA, p.armUpperL, p.armForeL);
  poseArm(1, _handB, p.armUpperR, p.armForeR);
}

export class Swan {
  /**
   * @param {{index?: number, spacing?: number}} [options]
   *   index：四只天鹅的序号 0..3；spacing：横向间距（米）。
   */
  constructor({ index = 0, spacing = 1.8 } = {}) {
    this.index = index;
    this.spacing = spacing;

    /** 队形位次（x = (index-1.5)*spacing，y=0，z=0）。 */
    this.formationX = (index - FORMATION_CENTER) * spacing;

    /** 根节点：放在地面上的队形位置。 */
    this.root = new THREE.Group();
    this.root.name = `swan-${index}`;
    this.root.position.set(this.formationX, 0, 0);

    // 骨盆锚点：worldline / ghost 从这里升起。
    this.anchor = new THREE.Vector3(this.formationX, PELVIS_Y, 0);

    const porcelain = createPorcelainMaterial();
    const gold = getGoldMaterial();

    /** @type {{[k: string]: THREE.Object3D}} 12 个刚体部件（含父子层级）。 */
    this.parts = {};
    /** @type {{[k: string]: THREE.Mesh}} 每个部件的 porcelain 主 mesh。 */
    this.meshes = {};
    /** 每个部件上的金饰（不属于刚体主 mesh，但会一起并入 ghost 几何）。 */
    this._details = {};
    /** 给 ghost 的低模合并几何缓存。 */
    this._ghostGeometries = new Map();

    // --- 骨盆 / 胸腔（脊柱两段）------------------------------------------
    const body = this._addPart('body', buildBodyGeometry(), porcelain);
    body.position.set(0, PELVIS_Y, 0);
    this.root.add(body);

    const chest = this._addPart('chest', buildChestGeometry(), porcelain);
    chest.position.set(0, CHEST_Y, 0.002);
    body.add(chest);

    // --- 纱裙 -------------------------------------------------------------
    const tutu = this._addPart('tutu', buildTutuGeometry(), porcelain);
    tutu.position.set(0, 0.045, 0.002);
    body.add(tutu);

    // --- 头颈 / 发髻 ------------------------------------------------------
    const head = this._addPart('head', buildHeadGeometry(), porcelain);
    head.position.set(0, NECK_Y, 0.0);
    chest.add(head);

    const bun = this._addPart('bun', buildBunGeometry(), porcelain);
    bun.position.set(BUN_POS.x, BUN_POS.y, BUN_POS.z);
    head.add(bun);

    // --- 背翅 -------------------------------------------------------------
    const wingL = this._addPart('wingL', buildWingGeometry(-1), porcelain);
    const wingR = this._addPart('wingR', buildWingGeometry(1), porcelain);
    wingL.position.set(-0.095, 0.200, -0.072);
    wingR.position.set(0.095, 0.200, -0.072);
    chest.add(wingL, wingR);

    // --- 双臂（上臂 + 前臂两段；手链由 IK 保持相连）------------------------
    const armUpperL = this._addPart('armUpperL', buildUpperArmGeometry(), porcelain);
    const armUpperR = this._addPart('armUpperR', buildUpperArmGeometry(), porcelain);
    armUpperL.position.set(-SHOULDER.x, SHOULDER.y, SHOULDER.z);
    armUpperR.position.set(SHOULDER.x, SHOULDER.y, SHOULDER.z);
    chest.add(armUpperL, armUpperR);

    const armForeL = this._addPart('armForeL', buildForearmGeometry(), porcelain);
    const armForeR = this._addPart('armForeR', buildForearmGeometry(), porcelain);
    armForeL.position.set(0, -ARM_L1, 0);
    armForeR.position.set(0, -ARM_L1, 0);
    armUpperL.add(armForeL);
    armUpperR.add(armForeR);

    // --- 双腿：髋/膝两段 ---------------------------------------------------
    const thighGeometry = buildThighGeometry();
    const shinGeometry = buildShinGeometry();
    const thighL = this._addPart('thighL', thighGeometry.clone(), porcelain);
    const thighR = this._addPart('thighR', thighGeometry.clone(), porcelain);
    thighL.position.set(-HIP_X, HIP_Y, 0);
    thighR.position.set(HIP_X, HIP_Y, 0);
    this.root.add(thighL, thighR);
    const shinL = this._addPart('shinL', shinGeometry.clone(), porcelain);
    const shinR = this._addPart('shinR', shinGeometry.clone(), porcelain);
    shinL.position.set(KNEE_POS.x, KNEE_POS.y, KNEE_POS.z);
    shinR.position.set(KNEE_POS.x, KNEE_POS.y, KNEE_POS.z);
    thighL.add(shinL);
    thighR.add(shinR);

    // --- 足尖鞋 -----------------------------------------------------------
    const slipperGeometry = buildSlipperGeometry();
    const slipperL = this._addPart('slipperL', slipperGeometry.clone(), porcelain);
    const slipperR = this._addPart('slipperR', slipperGeometry.clone(), porcelain);
    slipperL.position.set(ANKLE_POS.x, ANKLE_POS.y, ANKLE_POS.z);
    slipperR.position.set(ANKLE_POS.x, ANKLE_POS.y, ANKLE_POS.z);
    shinL.add(slipperL);
    shinR.add(slipperR);

    // --- 金饰（每个部件最多一个合并好的 gold mesh）-------------------------
    this._addDetail('head', buildHeadGoldGeometry(), gold);
    this._addDetail('bun', buildBunGoldGeometry(), gold);
    this._addDetail('slipperL', buildSlipperGoldGeometry(), gold);
    this._addDetail('slipperR', buildSlipperGoldGeometry(), gold);

    // 记录热路径要用的常量，避免 update 里查对象
    this._formX = this.formationX;
    this._lastT = NaN;
    this._partsOrdered = SWAN_PARTS.map((name) => this.parts[name]);

    // 用 t=0 初始化一次姿态（也让 anchor 立即有效）
    this.update(0);
  }

  /**
   * 建一个刚体部件（porcelain 主 mesh），登记进 parts/meshes。
   * 几何已经建在 part-local 坐标系里，枢轴在原点。
   * @private
   */
  _addPart(name, geometry, material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = true;
    this.parts[name] = mesh;
    this.meshes[name] = mesh;
    return mesh;
  }

  /** 往某个部件上挂金饰（geometry 已经是 part-local 坐标）。@private */
  _addDetail(partName, geometry, material) {
    const part = this.parts[partName];
    if (!part) return null;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${partName}-gold`;
    mesh.matrixAutoUpdate = false;   // 恒为单位矩阵，省一次矩阵更新
    part.add(mesh);
    (this._details[partName] || (this._details[partName] = [])).push(mesh);
    return mesh;
  }

  /**
   * 推进编舞到时间 t（秒），内部先对 SWAN_LOOP 取模。
   * 纯函数式：同一 t 必得同一姿态；不分配对象。
   * @param {number} t 秒
   */
  update(t) {
    const tt = Math.min(Math.max(0, t), SCORE.totalDuration);
    if (tt === this._lastT) return;
    this._lastT = tt;
    // curtain call: the last musical bars become the bow; the walk-off happens in the applause
    if (tt >= SCORE.danceEnd) { this._updateOutro(tt); return; }

    const beat = Math.max(0, tt - SCORE.beatOffset) / BEAT;
    const bi = Math.floor(beat);
    const u = beat - bi;                       // 0..1 inside the beat
    const block = Math.floor(bi / 8);
    const bp = bi % 8;
    const type = BLOCKS[Math.min(BLOCKS.length - 1, block)];
    const prevType = BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, block - 1))];
    const A = MOVES[prevType], B = MOVES[type];
    const w = smooth(clamp01(bp / 2));          // blocks dissolve into each other over two beats
    const hopAmp = lerp(A.hop, B.hop, w);
    const swayAmp = lerp(A.sway, B.sway, w);
    const armAmp = lerp(A.arm, B.arm, w);
    const headAmp = lerp(A.head, B.head, w);
    const extAmp = lerp(A.ext, B.ext, w);
    const bendAmp = lerp(A.bend, B.bend, w);

    // ---- the beat: a human jump — quick rise, slower fall, and a grounded contact around the beat ----
    const RISE = 0.34;
    const hop = u < RISE ? smooth(u / RISE) : 1 - smooth((u - RISE) / (1 - RISE));
    const contact = Math.exp(-Math.pow(Math.min(u, 1 - u) / 0.16, 2));   // 1 on the beat boundary, 0 in the air
    const breathe = 0.006 * Math.sin((tt / 4.2) * Math.PI * 2);

    // ---- phrase: the whole line sways over 8 beats; everyone moves together, so the chain holds ----
    const sway = Math.sin((beat / 8) * Math.PI * 2);
    const swayLag = Math.sin(((beat - 0.18) / 8) * Math.PI * 2);       // follow-through for head/chest/tutu/wings
    const swayLag2 = Math.sin(((beat - 0.30) / 8) * Math.PI * 2);

    // ---- leg work: a 4-beat cycle. The outside leg opens on alternate cycles, side / back alternating ----
    const cyc = (beat % 4) / 4;
    const pulse = Math.exp(-Math.pow((cyc - 0.5) / 0.19, 2));
    const cycleIdx = Math.floor(beat / 4);
    const extSide = (cycleIdx % 2 === 0) ? pulse : pulse * 0.12;
    const extSideR = (cycleIdx % 2 === 1) ? pulse : pulse * 0.12;
    const extBack = (Math.floor(beat / 8) % 2 === 1);
    const eL = extAmp * extSide;
    const eR = extAmp * extSideR;
    const bendBase = 0.05 + 0.58 * bendAmp * (0.12 + 0.88 * contact);   // plié depth (radians); legs straighten in the air
    const supportThigh = -0.42 * bendBase;                             // knee travels forward
    const slipperSupport = -0.42 * contact * bendAmp + 0.04 * hop;      // 落地时脚掌放平，跳起时绷脚
    const turnout = 0.10 + 0.05 * bendBase;
    const wantExt = Math.max(eL, eR);
    const extL = wantExt > 0.02 && eL >= eR;
    const extR = wantExt > 0.02 && eR > eL;
    const airLift = hopAmp * hop;
    const ankleTarget = ANKLE_Y - 0.02 * contact * bendAmp + airLift;

    // ---- two-link legs: solve the hip height so the SUPPORT foot stays on the floor (or lifts with the jump) ----
    let hipY;
    if (extL) {
      const off = legOffsets(supportThigh - 0.06, -0.01 * sway, turnout, bendBase, slipperSupport);
      hipY = ankleTarget - off.ankleY;
      const toe = hipY + off.toeY;
      if (toe < 0) hipY -= toe;
      else if (hop < 0.06) hipY -= toe;
    } else if (extR) {
      const off = legOffsets(supportThigh + 0.06, 0.01 * sway, -turnout, bendBase, slipperSupport);
      hipY = ankleTarget - off.ankleY;
      const toe = hipY + off.toeY;
      if (toe < 0) hipY -= toe;
      else if (hop < 0.06) hipY -= toe;
    } else {
      const offL = legOffsets(supportThigh + 0.06, 0.01 * sway, -turnout, bendBase, slipperSupport);
      const offR = legOffsets(supportThigh - 0.06, -0.01 * sway, turnout, bendBase, slipperSupport);
      hipY = ankleTarget - 0.5 * (offL.ankleY + offR.ankleY);
      const toe = hipY + Math.min(offL.toeY, offR.toeY);
      if (toe < 0) hipY -= toe;
      else if (hop < 0.06) hipY -= toe;
    }

    this.root.position.x = this._formX + swayAmp * sway;
    this.root.position.y = 0;
    this.root.position.z = 0;

    const p = this.parts;
    // ---- pelvis: rides 3 cm above the hip joints; weight shifts a beat behind the line ----
    const bodyY = hipY + (PELVIS_Y - HIP_Y) + breathe;
    const bodyPitch = 0.02 + 0.05 * hop + 0.05 * contact * bendAmp;
    const bodyRoll = -0.06 * sway - 0.10 * (eR - eL);
    const bodyTwist = 0.03 * sway + 0.05 * (eR - eL);
    p.body.position.set(0.012 * sway + 0.010 * swayLag, bodyY, 0);
    p.body.rotation.set(bodyPitch, bodyTwist, bodyRoll);

    // ---- thighs/shins: support leg bent in plié, the opening leg extends to the side or back ----
    p.thighL.position.set(-HIP_X, hipY, 0);
    p.thighR.position.set(HIP_X, hipY, 0);

    if (extL) {
      const tz = -turnout - (extBack ? 0.20 : 0.95) * eL;
      const tx = extBack ? 0.85 * eL : 0.06;
      let knee = 0.14 + 0.30 * eL;
      const slx = 0.18 + 0.25 * Math.min(1, eL);
      for (let it = 0; it < 3; it++) {
        const off = legOffsets(tx, 0.02 * sway, tz, knee, slx);
        if (hipY + off.toeY >= 0.012) break;
        knee = Math.min(1.3, knee + (0.012 - hipY - off.toeY) / 0.30);
      }
      p.thighL.rotation.set(tx, 0.02 * sway, tz);
      p.shinL.rotation.set(knee, 0, 0);
      p.slipperL.rotation.set(0.18 + 0.25 * Math.min(1, eL), 0, 0.02 * sway);
    } else {
      p.thighL.rotation.set(supportThigh + 0.06, 0.01 * sway, -turnout);
      p.shinL.rotation.set(bendBase, 0, 0);
      p.slipperL.rotation.set(slipperSupport, 0, 0.02 * sway);
    }
    if (extR) {
      const tz = turnout + (extBack ? 0.20 : 0.95) * eR;
      const tx = extBack ? 0.85 * eR : 0.06;
      let knee = 0.14 + 0.30 * eR;
      const slx = 0.18 + 0.25 * Math.min(1, eR);
      for (let it = 0; it < 3; it++) {
        const off = legOffsets(tx, -0.02 * sway, tz, knee, slx);
        if (hipY + off.toeY >= 0.012) break;
        knee = Math.min(1.3, knee + (0.012 - hipY - off.toeY) / 0.30);
      }
      p.thighR.rotation.set(tx, -0.02 * sway, tz);
      p.shinR.rotation.set(knee, 0, 0);
      p.slipperR.rotation.set(0.18 + 0.25 * Math.min(1, eR), 0, -0.02 * sway);
    } else {
      p.thighR.rotation.set(supportThigh - 0.06, -0.01 * sway, turnout);
      p.shinR.rotation.set(bendBase, 0, 0);
      p.slipperR.rotation.set(slipperSupport, 0, -0.02 * sway);
    }

    // ---- spine: the chest counter-rolls against the pelvis, breathes, and compresses on the landing ----
    const breathChest = 0.008 * Math.sin((tt / 4.2) * Math.PI * 2 + 0.5);
    p.chest.rotation.set(
      0.03 + 0.06 * hop + 0.06 * contact * bendAmp + breathChest,
      0.10 * sway + 0.10 * (eR - eL),
      -0.07 * swayLag - 0.12 * (eR - eL),
    );

    // ---- tutu: lags the pelvis; lifts a little in the jump ----
    p.tutu.rotation.set(0.10 * hop - 0.04 * swayLag, 0, -0.07 * swayLag2 - 0.04 * (eR - eL));

    // ---- head: small lead, then settles after the body; the swan tilt keeps a beat of delay ----
    const look = Math.sin((tt / 6.2) * Math.PI * 2 + this.index * 0.6);
    p.head.rotation.set(
      0.04 + 0.06 * contact * bendAmp - 0.03 * hop + 0.02 * Math.sin((tt / 3.1) * Math.PI * 2 + this.index),
      look * 0.22 - 0.35 * p.chest.rotation.y,
      -headAmp * 0.8 * swayLag + 0.03 * Math.sin(beat * Math.PI) - 0.10 * (eR - eL),
    );
    p.bun.rotation.set(-0.06 * hop - 0.03 * swayLag2, 0, 0.08 * swayLag2);

    // ---- arms: the hands stay clasped with the neighbours; IK bends the elbows as the line breathes ----
    const handLift = 0.010 * hop + armAmp * 0.02 * hop + 0.012 * Math.sin(beat * Math.PI) + 0.02 * (eL + eR);
    poseLinkedArms(this, HAND.y + handLift, HAND.z + 0.010 * sway);

    // ---- wings: driven by the jump and the delayed roll ----
    const flutter = 0.16 * hop + 0.02 * Math.sin(beat * Math.PI);
    p.wingL.rotation.set(0.16 * hop, 0.04 * swayLag, 0.10 * flutter);
    p.wingR.rotation.set(0.16 * hop, -0.04 * swayLag, -0.10 * flutter);

    // ---- anchor (pelvis world position): where the worldline begins ----
    this.anchor.set(this.root.position.x + p.body.position.x, bodyY, 0);
  }

  /**
   * 谢幕 / 退场：音乐最后一小节里脊柱一节节弯下去（骨盆先、胸再、头最后），
   * 掌声响起时深鞠躬；然后起身、保持手链走几步退场，灯光暗下。
   * @private
   */
  _updateOutro(tt) {
    const DE = SCORE.danceEnd;
    const bowIn = smooth(clamp01((tt - DE) / 1.35));
    const bowOut = smooth(clamp01((tt - (DE + 1.90)) / 0.95));
    const bow = bowIn * (1 - bowOut);
    const walkT = Math.max(0, tt - (DE + 2.45));
    const exitX = 0.80 * walkT;   // a calm walk-off; the stage light goes down as they leave
    const walking = walkT > 0.02;
    const phase = walkT * Math.PI * 2 * 1.5;
    const step = Math.sin(phase);
    const sway = 0.012 * Math.sin(tt * 0.9);

    this.root.position.set(this._formX + exitX, 0, 0);
    this.root.rotation.y = 0;

    const p = this.parts;
    const bowBend = 0.10 + 0.55 * bow;
    const turnout = 0.10 + 0.04 * bowBend;
    const stepL = walking ? Math.max(0, step) : 0;
    const stepR = walking ? Math.max(0, -step) : 0;
    const kneeL = 0.10 + 0.12 * stepL + 0.55 * bow;
    const kneeR = 0.10 + 0.12 * stepR + 0.55 * bow;
    const offL = legOffsets(0.04, 0.01 * sway, -turnout, kneeL, 0.02);
    const offR = legOffsets(-0.04, -0.01 * sway, turnout, kneeR, 0.02);
    let hipY = ANKLE_Y - Math.max(offL.ankleY, offR.ankleY);
    if (!walking) hipY = ANKLE_Y - 0.5 * (offL.ankleY + offR.ankleY);
    const bodyY = hipY + (PELVIS_Y - HIP_Y) + (walking ? 0.003 * Math.abs(step) : 0);

    // bow: the spine curls — pelvis leads, chest follows deeper, head last
    p.body.position.set(0.008 * sway, bodyY - 0.10 * bow, 0);
    p.body.rotation.set(0.30 * bow + (walking ? 0.02 : 0), 0.02 * sway, -0.03 * sway);
    p.chest.rotation.set(0.52 * bow, 0.03 * sway, -0.02 * sway);
    p.tutu.rotation.set(0.14 * bow, 0, -0.02 * sway);
    p.head.rotation.set(0.45 * bow + (walking ? 0.02 : 0.02), 0.03 * sway, -0.08 * bow);
    p.bun.rotation.set(-0.05 * bow, 0, 0.03 * sway);

    // arms stay in the little-swans hold; during the bow they come down with the chest
    poseLinkedArms(this, HAND.y - 0.045 * bow, HAND.z + 0.02 * bow);

    p.wingL.rotation.set(0.13 * bow, 0.01 * sway, 0.05 * bow);
    p.wingR.rotation.set(0.13 * bow, -0.01 * sway, -0.05 * bow);

    p.thighL.position.set(-HIP_X, hipY, 0);
    p.thighR.position.set(HIP_X, hipY, 0);
    p.thighL.rotation.set(0.04 - (walking ? 0.22 * stepL : 0), 0.01 * sway, -turnout);
    p.thighR.rotation.set(-0.04 + (walking ? 0.22 * stepR : 0), -0.01 * sway, turnout);
    p.shinL.rotation.set(kneeL, 0, 0);
    p.shinR.rotation.set(kneeR, 0, 0);
    p.slipperL.rotation.set(-0.30 * bow + (walking ? 0.05 : 0.02), 0, 0.01 * sway);
    p.slipperR.rotation.set(-0.30 * bow + (walking ? 0.05 : 0.02), 0, -0.01 * sway);

    this.anchor.set(this.root.position.x + p.body.position.x, bodyY, 0);
  }

  /**
   * 把 17 个部件的 matrixWorld（平移相对 anchor）写进 out。
   * 顺序 = SWAN_PARTS，每部件 16 个 float（列主序 Matrix4）。
   * 调用前应已 update(t) 且 root.updateMatrixWorld(true)（本方法内也会补一次）。
   * @param {Float32Array|number[]} out 预分配数组
   * @param {number} [floatOffset=0] 起始 float 下标
   */
  captureWorldPose(out, floatOffset = 0) {
    this.root.updateMatrixWorld(true);
    const ax = this.anchor.x;
    const ay = this.anchor.y;
    const az = this.anchor.z;
    const parts = this._partsOrdered;
    let o = floatOffset;
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i].matrixWorld.elements;
      out[o] = e[0];
      out[o + 1] = e[1];
      out[o + 2] = e[2];
      out[o + 3] = e[3];
      out[o + 4] = e[4];
      out[o + 5] = e[5];
      out[o + 6] = e[6];
      out[o + 7] = e[7];
      out[o + 8] = e[8];
      out[o + 9] = e[9];
      out[o + 10] = e[10];
      out[o + 11] = e[11];
      out[o + 12] = e[12] - ax;
      out[o + 13] = e[13] - ay;
      out[o + 14] = e[14] - az;
      out[o + 15] = e[15];
      o += 16;
    }
    return out;
  }

  /**
   * 返回某部件用于 ghost 的低模 BufferGeometry（part-local 坐标，已 merge）。
   * 第一次调用时把主 mesh 与金饰合并并缓存。
   * @param {string} name 必须是 SWAN_PARTS 之一
   * @returns {THREE.BufferGeometry}
   */
  getPartGeometry(name) {
    const cached = this._ghostGeometries.get(name);
    if (cached) return cached;
    const part = this.parts[name];
    if (!part) throw new Error(`[Swan] unknown part: ${name}`);
    const sources = [part.geometry.clone()];
    const details = this._details[name];
    if (details) {
      for (const d of details) sources.push(d.geometry.clone());
    }
    const merged = mergeGeometries(sources);
    this._ghostGeometries.set(name, merged);
    return merged;
  }

  /** 释放本实例独占的几何（共享材质不在这里释放）。 */
  dispose() {
    const seen = new Set();
    for (const name of SWAN_PARTS) {
      const part = this.parts[name];
      if (part && part.geometry && !seen.has(part.geometry)) {
        part.geometry.dispose();
        seen.add(part.geometry);
      }
      const details = this._details[name];
      if (details) {
        for (const d of details) {
          if (d.geometry && !seen.has(d.geometry)) {
            d.geometry.dispose();
            seen.add(d.geometry);
          }
        }
      }
    }
    for (const g of this._ghostGeometries.values()) g.dispose();
    this._ghostGeometries.clear();
  }
}

export default Swan;
