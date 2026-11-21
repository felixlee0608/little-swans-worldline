# little-swans 模块契约（v1）

项目：**《小天鹅舞曲 · 瓷偶世界线》** —— 参考 worldline-dancer 的"历史姿态冻结成雕塑"机制，做的交互 3D 作品。
技术：three.js 0.185（importmap → jsDelivr CDN），原生 ES Modules，无构建工具。所有模块从 `'three'` 导入。

## 全局约定

- 世界坐标：**y 向上，地面 y=0**，1 单位 = 1 米。
- 四只小天鹅站在 **z=0** 一条横线上，x = `[-2.7, -0.9, 0.9, 2.7]`，面朝 **+Z**（观众/相机在 +Z）。
- 世界线从每只天鹅的骨盆锚点（anchor，y≈0.95）出发，向 **-Z / +Y** 方向升起（舞台后方上空）。
- 相机在 +Z 方向看向 -Z；画幅 16:9。
- 时间轴 `T`（秒）：= 音乐播放位置，0 → 约 120s 一遍。所有模块都读同一个 `T`。
- 快照节流：每 **0.2s**（音乐时间）拍一次四只天鹅的姿态。
- 不使用外部模型/贴图（字体与 HDRI 除外，均已放好）。
- 代码风格：ES module、具名导出、无全局变量、注释写中文或英文均可；每帧热路径避免 new 对象（用模块级 scratch）。

## src/swan.js（负责人：swan-modeler）

```js
export const SWAN_PARTS = [...];   // 固定 17 个刚体部件名（含 chest、armUpper/Fore、thigh/shin），顺序不可变
export const SWAN_LOOP = 10.213;    // 16 拍 @94bpm，与乐句对齐（可调）
export class Swan {
  constructor({ index = 0, spacing = 1.8 } = {});
  root;          // THREE.Group，放在地面；root.position = 队形位（x=index 对应，y=0，z=0）
  parts;         // { [partName]: THREE.Object3D } 刚体层级（可含父子，如 head 挂在 body 上）
  meshes;        // { [partName]: THREE.Mesh } 每个部件至少一个 mesh，共享 porcelain 材质
  anchor;        // THREE.Vector3 骨盆世界位置（每次 update 后更新）
  update(t);     // 推进编舞：t 秒，内部对 SWAN_LOOP 取模；更新 parts 的 local transform 和 root.position.x（允许小幅侧移）
  captureWorldPose(out, floatOffset = 0);  // 在 update + root.updateMatrixWorld(true) 之后调用；把每个 part 的 matrixWorld 写入 out，平移减去 anchor（锚点相对）；顺序 = SWAN_PARTS 顺序，每 part 16 floats
  getPartGeometry(name); // 返回该部件用于 ghost 的 BufferGeometry（应已 merge/低模）
}
export function createPorcelainMaterial(); // 可选，导出瓷白材质给主程序/ghost 参考
```

要求：
- 12 个部件建议：`body / tutu / head / bun / wingL / wingR / armL / armR / legL / legR / slipperL / slipperR`（可微调，但必须正好 12 个且导出）。
- 瓷偶感：白色 + 高 clearcoat + 微虹彩；纱裙 tutu 用扁圆环/锥体。
- 编舞必须**可读作四小天鹅**：双臂在身前交叉（手递向相邻天鹅）、小跳/plie 侧向移动、头微侧；循环 8s 左右，动作平滑（用 sin/缓动，不要脏跳变）。
- `update(t)` 纯函数式（同一 t 必得同一姿态），便于回放/暂停。
- 不得引用未定义的外部资源；只 import 'three'。

## src/worldline.js（负责人：ghost-engineer）

```js
export class SwanWorldline {
  constructor({ anchor = new THREE.Vector3(0, 0.95, 0), preset = 'arc' } = {});
  update(dt, anchor);              // 每帧重建 LUT（6 控制点 Catmull-Rom，弧长 LUT 128~256 点）
  matrixAtAge(a, out);             // a∈[0,1] → Matrix4（位置+朝向；a=0 在 anchor）
  uOfAge(a); ageOfU(u); tangentAtU(u, out);
}
export function createWorldlines(swans); // 为 4 只天鹅各建一条世界线：起点=各自 anchor，向 -Z/+Y 升起；四条线在空间上错开（左右间距≈1.8m）
```

要求：可参考 `worldline-dancer/ref/site/src/spline.js` 的数学（受控 Catmull-Rom、弧长重采样、并行传输朝向），**但自己写、不要复制文件**；简化即可（不需要 twist/stretch/手柄编辑）。

## src/ghosts.js（负责人：ghost-engineer）

```js
export class Ghosts {
  constructor({ scene, swans, capacity = 72, history = 14 });
  snapshot(T);                       // 拍一次四只天鹅的姿态（内部对每只调用 captureWorldPose）
  update(dt, { T, history, camera }); // 按 age=(T-birth)/history 把实例摆到各自世界线上；越老越淡
  reset();
  get count();                       // 每只天鹅当前可见残影数
  dispose();
}
```

要求：
- 渲染：**每个部件一个 InstancedMesh**（12 个 InstancedMesh 即可画出全部残影；容量 = capacity × 4 实例/部件）。
- 残影材质：瓷白半透明 + fresnel 边缘发光 + 轻微 age 暖光（可参考 worldline-dancer 的 `ghostMaterial.js` 思路，自己实现 ShaderMaterial 或 MeshPhysicalMaterial + onBeforeCompile）。
- 位置：instanceMatrix = worldline.matrixAtAge(age) × poseRow(part 的锚点相对矩阵)。
- 不写深度、预乘近似加性混合、按相机距离排序可选（v1 可不排序，先看效果）。
- 无每帧大分配。
- `swan.captureWorldPose()` 的 out 数组由 Ghosts 预分配（TypedArray）。

## src/music.js（负责人：music-maker）

```js
export class Music {
  constructor();
  async init();                 // 在用户点击手势里调用；建 AudioContext / 合成图 / 解析音符数据
  duration;                     // 秒，目标 110~125s
  bpm;                          // 速度（用于 HUD/编舞参考）
  start(T = 0);                 // 从 T 秒开始播放
  stop();
  update(dt, { T, frozen = false, rate = 1 });  // 每帧保持播放头≈T；frozen 时磁带停转，rate 用于变速
  setMuted(m);
  dispose();
}
```

要求：
- 曲目：柴可夫斯基《天鹅湖》第三幕"四小天鹅舞"（曲目公版）。**用 MIDI/音符数据 + Web Audio 实时合成**：
  - 主旋律：钢片琴/音乐盒质感（正弦+泛音 + 短衰减），或双簧管质感；
  - 伴奏：拨弦（滤波噪声 + 衰减）+ 低音；
  - 轻混响（程序化 impulse 或 feedback delay），音量平衡到不刺耳。
- 目标总长 110–125s：前奏 4-8 小节 → 主题（可反复）→ 中段 → 再现 → 尾声收束（最后一个和弦长音）。
- 必须有 `music-data.js`（或 assets/*.json）存音符数据（t, dur, midi, vel, inst）。可从公版 MIDI 解析（允许联网找 MIDI，注明来源与授权）；解析脚本放 `tools/`。
- 必须能在 `update()` 里跟随外部 T（不做"自己往前跑"的时钟）：以 `AudioContext.currentTime` 积分位置，偏差 >0.25s 时重对齐；暂停/冻结用 tape-stop 音效可选。
- 音频必须由用户点击启动（Start 按钮），未 init 时所有方法安全 no-op。
- 不得使用外部音源文件（除自己下载的 PD MIDI/生成的 wav）。

## src/stage.js（负责人：Lead）

舞台：黑盒 + 月光 + 湖面反射 + 雾 + 星尘。导出 `createStage({renderer, scene, camera, hdri})` → `{update(dt, T, state), resize(), setQuality(q)}`。

## src/main.js / index.html / src/ui.js（负责人：Lead）

主循环、相机、后处理（可选 bloom）、时间轴、UI、交互（Orbit + 冻结 + 静音）、`?debug` 钩子（`window.__ls`：frames(n)/look()/perf()/shot?）。

## 验收（v1）

- `python3 tools/serve.py` → 打开 `http://127.0.0.1:8781/`，点击 Start（解锁音频）→ 看到黑盒湖面舞台上四只瓷白小天鹅跳小天鹅舞，身后升起四条残影世界线；音乐可听；60fps 无 console 报错；16:9 全屏。
- 提供 2–3 张截图（`qa/screenshots/`）证明效果。

## 写入范围（避免冲突）

- swan-modeler：`little-swans/src/swan.js`、`little-swans/docs/swan-model.md`
- ghost-engineer：`little-swans/src/worldline.js`、`little-swans/src/ghosts.js`、`little-swans/docs/ghost-engine.md`
- music-maker：`little-swans/src/music.js`、`little-swans/src/music-data.js`、`little-swans/tools/midi*`、`little-swans/assets/audio/`、`little-swans/docs/music-notes.md`
- Lead：其余全部文件（index.html、src/main.js、src/stage.js、src/ui.js、tools/serve.py、README 等）
