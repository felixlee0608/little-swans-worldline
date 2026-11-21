# 残影引擎（世界线 · 瓷偶残影）技术笔记

> 文件：`little-swans/src/worldline.js`（世界线数学）、`little-swans/src/ghosts.js`（残影渲染）
> 机制来源：`worldline-dancer`（参考其「姿态快照 → 沿世界线冻结成雕塑」的思路；代码全部重写，未复制参考实现）
> 坐标系：y 向上、地面 y=0、1 单位 = 1 米；四只天鹅 x = [-2.7, -0.9, 0.9, 2.7]，面朝 +Z；世界线向 -Z / +Y 升起。

---

## 0. TL;DR

- 每条世界线 = 6 控制点向心 Catmull-Rom → **每帧**重采样成 160 点等弧长 LUT（位置 / 切线 / 平行传输朝向 / age 映射）；
- 残影位置公式只有一行：`instanceMatrix = worldline.matrixAtAge(age) × pose（锚点相对部件矩阵）`，`age = (T − birth) / history`；
- 12 个部件 = 12 个 `InstancedMesh`，共享 1 个 ShaderMaterial：**总 draw call 增量 = 12**（预算 ≤15）；
- 材质 = 瓷白半透明 + fresnel 边缘 + 稀疏虹彩 + 新生暖光 + 老尾端微光；预乘近似加性、不写深度、按相机距离从远到近排序；
- 所有缓冲预分配（位姿 / 实例矩阵 / 排序表），实测 CPU ≈ **0.15–0.17 ms/帧**（60 个残影 ×4 只 = 2880 实例）。

---

## 1. 数据流

```
main.js step(dt)
 ├─ 每 0.2s（音乐时间，UI 密度滑杆可调）:  ghosts.snapshot(T)
 │     └─ swans[i].captureWorldPose(pose, off)
 │           └─ 12 个部件的 matrixWorld，平移减去 swan.anchor（锚点相对），按 SWAN_PARTS 顺序 × 16 floats
 │        写入环形槽位 slot：pose[slot][swan][part]，birth[slot] = T
 │
 ├─ poseSwans(T)  （保证 root.updateMatrixWorld(true)；快照必须发生在姿态更新之后）
 │
 └─ 每帧:  ghosts.update(dt, { T, history, camera })
       ├─ 1. worldlines[i].update(dt, swans[i].anchor)      // 每帧重建 LUT；anchor 未变则跳过
       ├─ 2. 遍历环形槽位：age = (T − birth)/history ∈ [0,1)
       │      每个可见快照 × 每只天鹅：
       │        Frame = worldline.matrixAtAge(age)           // 位置 + 朝向
       │        age、density、到相机距离写进按实例 id 索引的 Float32Array
       ├─ 3. 按相机距离从远到近排序（复用上一帧次序做插入排序，近似 O(n)）
       ├─ 4. 写共享 aData 属性：vec2(age, density)（12 个几何体引用同一份，只上传一次）
       ├─ 5. 12 个 InstancedMesh：instanceMatrix[j] = Frame × pose[part]  （手写 4×4 标量乘，不 new 对象）
       └─ 6. uniform：uTime += dt（老尾端闪烁用）、uHistory = history
```

> **主循环顺序的 1 帧代价**：`main.js` 里 `snapshot(T)` 发生在当帧 `poseSwans(T)` 之前，所以最新残影用的是
> 上一帧姿态（≤16ms 的相位差），视觉不可见。`captureWorldPose` 内部也会补一次 `updateMatrixWorld(true)`，
> 所以即使主循环漏了也不会读到过期矩阵。

---

## 2. 世界线数学（`worldline.js`）

### 2.1 6 控制点向心 Catmull-Rom

控制点 `P0..P5` = `home + presetOffset_j + (anchor − home) × FOLLOW[j]`：

| 项 | 含义 |
| --- | --- |
| `home` | 第一次 `update()` 观察到的 anchor（舞台上的「家」） |
| `presetOffset_j` | `arc` 预设的 anchor 相对偏移，x 由 `side × fan` 左右张开 |
| `FOLLOW` | `[1, 0.72, 0.45, 0.25, 0.12, 0.05]`：近端完全跟随天鹅，远端几乎钉在舞台上 |

- `FOLLOW[0]=1` 且 `presetOffset_0 = 0` ⇒ **`a=0` 严格位于当前 anchor**；
- 天鹅小跳/侧移（≤0.15m）只带动近端，尾端几乎不动（实测 anchor 横移 20cm 时尖端只动 1.1cm），构图稳定。

把 5 段曲线各按局部参数 `u∈[0,1]` 采样 48 点（末段 +1，共 241 个原始点）。每段用 **Barry–Goldman** 形式的
向心参数化（α=0.5）：

```
节点：t0=0, t1=t0+|P1−P0|^0.5, t2=t1+|P2−P1|^0.5, t3=t2+|P3−P2|^0.5
A1 = lerp(P0, P1, (t−t0)/(t1−t0))
A2 = lerp(P1, P2, (t−t1)/(t2−t1))
A3 = lerp(P2, P3, (t−t2)/(t3−t2))
B1 = lerp(A1, A2, (t−t0)/(t2−t0))
B2 = lerp(A2, A3, (t−t1)/(t3−t1))
C(t) = lerp(B1, B2, (t−t1)/(t2−t1))
```

端点没有邻居时用**镜像延拓** `P0' = 2·P1 − P2`、`P3' = 2·P2 − P1`，避免向心参数化出现重合节点（除零/打结）。
向心参数化相对均匀参数化的好处：控制点密集或靠近时不过冲。

### 2.2 等弧长 LUT（160 点）

1. 累加 241 个原始点的弦长得到 `rawLen[]`，总长 `length`（当前预设约 **5.68 m**）；
2. 按 `s = k/(N−1)·length` 在 `rawLen` 上线性插值，得到 160 个**等弧长**位置点（契约要求 128–256，取 160）；
3. 中心差分求单位切线 `tan[k]`；
4. **平行传输**朝向：`quat[0] = 单位四元数`，之后逐点 `q ← normalize(setFromUnitVectors(t[k−1], t[k]) · q)`。
   选择平行传输而不是 `lookAt`：`lookAt` 在曲线拐点会翻转，平行传输是「旋转最小」标架，沿曲线摆放刚体不会扭。
   起点为单位四元数 ⇒ `matrixAtAge(0)` 的旋转是 identity ⇒ 最新残影与本体**姿态完全一致**，不会跳变。

### 2.3 age ↔ u 映射（时间密度）

`ageLUT[k] = (k/(N−1))^(1/density)`，`density` 默认 **0.75**（`1.0` = 纯等弧长均布）：

- `uOfAge(a)`：在单调的 `ageLUT` 上二分 + 线性插值；
- `ageOfU(u)`：反向插值；
- `density < 1` ⇒ 近端（新残影）在等年龄间隔下占据更多弧长、远端（老残影）更密：
  实测新残影间距 ≈18.0cm、老残影 ≈7.1cm（12s history、5 帧/秒）。
  这是「雕塑要稀、尾焰要密」的美学选择，也让近处一尊尊姿态读得清；`density=1` 即恢复均匀。

### 2.4 公共 API

```js
new SwanWorldline({ anchor, preset='arc', side, fan, density })   // 额外可选参数有默认值
wl.update(dt, anchor)          // 每帧；锚点未动时跳过重建
wl.matrixAtAge(a, out)         // a∈[0,1] → Matrix4；a=0 在 anchor，a=1 在尖端
wl.uOfAge(a) / wl.ageOfU(u)    // 年龄 ↔ 弧长双向映射
wl.tangentAtU(u, out)          // 单位切线
createWorldlines(swans)        // 四条：side = 左半 -1 / 右半 +1，fan=2.4
```

四条线左右张开：同侧两条线的 x 间隔保持 1.8m（与队形一致），内圈两条向上逐渐分开；
尖端世界坐标（arc 预设）：`anchor + (±2.4, +3.15, −3.85)`，即外圈 (±5.10, 4.08, −3.85)、内圈 (±3.30, 4.08, −3.85)。
用主程序相机（fov 34 / 16:9 / pos(0,2.45,8.8) / target(0,1.12,−1.35)）投影，四条线全部 LUT 点都在画面内（tip ndc y≈0.87、|x|≤0.76）。

---

## 3. 残影 = 年龄 → 世界线上的位置

### 3.1 age 公式

```
age = clamp((T − birth) / history, 0, 1)        // 0 = 刚出生（在 anchor），1 = 老到消失
u   = worldline.uOfAge(age)                     // 年龄 → 弧长（含时间密度）
M   = worldline.matrixAtAge(age)                // 位置 + 平行传输朝向
ghostWorld = M × poseWorld（锚点相对）           // 单只天鹅的某个部件
```

`pose` 的平移已经减去快照时刻的 anchor，所以 **`M(a=0)` = 平移(当前 anchor) × I ⇒ 残影恰好从骨盆处与本体重叠**。
自测覆盖：12 个部件在 `age=0` 时与本体部件的世界坐标误差 < 1e−7 m。

### 3.2 时间回跳（循环 / 重开 / scrub）

`update` 检测到 `T < lastT`（时间往回跳）时，把所有已写快照的 `birth` 整体平移 `Δ = T − lastT`：

- 年龄保持连续 → 残影不会「瞬间全部消失」或「全部堆回 anchor」；
- 主程序 `restart()` 会调用 `ghosts.reset()`，则从空轨迹重新开始；
- 单帧数值抖动（<1e−3s）不触发平移。

### 3.3 history 动态变化

`update(dt, { history })` 每帧接受外部 history（UI 滑杆 6–20s）：

- **不重新分配任何缓冲**，不改快照数据；只是每帧用新 history 重算 age → 整个雕塑会像「时间密度」变化一样重新分布
  （越短越压缩，符合参考作品手感）；
- 无越界：`age` 在 [0,1) 之外直接跳过；`uOfAge/ageOfU` 内部 clamp；
- **唯一硬约束**：可见快照数 ≈ `history / snapshotInterval`，不能超过 `capacity`。
  `capacity=64`、interval=0.12s、history=20s 时需要 167 个 > 64 ⇒ 环形缓冲会覆盖还没老到 age=1 的快照，
  表现为尾端被截断（轨迹只覆盖到 `age ≈ capacity×interval/history`）且尾端有轻微「换血」pop。
  建议主程序二选一（本次交付不改主程序）：
  - `capacity ≥ history / interval + 2`；或
  - 快照间隔下限 `interval ≥ history / (capacity − 4)`（capacity 64、history 20 → interval ≥ 0.333s；history 12 → ≥ 0.2s）。
  默认组合（interval 0.2s / history 12s / capacity 64）需要 60 个，留 4 槽余量，稳定 60 尊/只。

---

## 4. 渲染实现（`ghosts.js`）

### 4.1 12 个 InstancedMesh

- 每个部件一个 `InstancedMesh`，实例容量 = `capacity × swanCount`（默认 72×4=288；主程序 64×4=256）；
- 每帧只设置 `mesh.count = 可见实例数`；`frustumCulled = false`（实例位置每帧变化，包围球无意义，**必须关**，
  已确认没有留默认 true，镜头贴近不会消失）；
- `renderOrder = 10`（不透明之后、其他透明之前）；`instanceMatrix` 用 `DynamicDrawUsage`；
- 12 个几何体共享**同一个** `aData` InstancedBufferAttribute（vec2：age、density），每帧只写一次、只上传一次。

### 4.2 残影材质（共享 1 个 ShaderMaterial）

片元里没有光照/贴图采样（过绘制是主要成本），只有解析式：

```
fres  = pow(1 − |N·V|, uRimPow)                                   // fresnel 边缘
ageSec= age × history
fade  = exp(−1.9·age) · (1 − smoothstep(0.86,1,age)) · smoothstep(0, 0.28s, ageSec)
a     = (uAlphaBase + uAlphaRim·fres) · fade · uOcclude
col   = 瓷白顶光 · a                                 // 顶部受光更亮，center 通透
      + uPorcelain · fres · uRimGlow                 // 边缘发光
      + 虹彩 · fres · uIridescence                   // 极淡的瓷釉虹彩
      + uWarm · fresh · (0.10 + 0.9·fres)            // 新生暖光，fresh = exp(−ageSec/0.55)
      + uWarm · fresh² · fres^1.5 · 4                // 最新边缘越过 bloom 阈值
col/a ×= uLight × vDensity                            // 全局亮度 × 视线密度补偿
gl_FragColor = vec4(min(col, 6), a)
```

- **出生淡入 0.28s**：最新残影从 anchor 长出来时不会和本体硬叠；
- **老尾端微光**：`age>0.55` 后用世界坐标 hash + `uTime` 做轻微闪烁（`uTime` 是墙钟累积，冻结时也会呼吸）；
- **密度补偿** `vDensity = 1 − (1−DENSITY_MIN)·|dot(tangent, view)|^DENSITY_POW`（默认 0.45 / 2.2）：
  顺着世界线看时把亮度压下来，几百层叠加不会烧成一片白；侧看时接近 1；
- 混合 = **预乘近似加性**：`blendSrc=One, blendDst=OneMinusSrcAlpha`、`depthWrite=false`、`depthTest=true`
  ⇒ 不平淡地互相遮挡、但仍被舞台/本体正确遮挡（黑盒剧场里只有该发光的东西发光）。

### 4.3 排序

预乘「over」混合近似交换律，但近处残影仍应最后画，所以每帧按到相机距离**从远到近**写实例：

- 用实例 id（`slot×4 + swan`）索引距离表，**复用上一帧次序**做插入排序：成员每帧只增删一个，
  几乎已经有序，代价接近 O(n)（n≤288）；
- `camera` 缺省时跳过排序（`update` 的 camera 参数可选）。

### 4.4 部件顺序自动校准

`captureWorldPose` 按 `SWAN_PARTS` 顺序写矩阵，而 `Object.keys(swan.meshes)` 的顺序不一定相同
（例：swan.js 先建腿再建纱裙）。`Ghosts` 构造时会在第一只天鹅上拍一张参考姿态，用每个部件 mesh 的
world 平移（减 anchor）去匹配快照行号，得到真实 `partNames` 顺序；匹配失败时退回契约建议顺序。
这样 `worldline/ghosts` 不依赖 `swan.js` 的内部建树顺序，也不需要 import `SWAN_PARTS`。

---

## 5. 性能预算

| 项目 | 数值 |
| --- | --- |
| draw call 增量 | **12**（每部件 1 个 InstancedMesh；无额外 pass） |
| 桌面默认实例量 | 60 残影/只 × 4 只 = 240 ghost × 12 部件 = **2880 instances** |
| 每帧世界矩阵 | 240 次 `matrixAtAge` + 2880 次 4×4 矩阵乘（手写标量乘，无对象分配） |
| CPU（Node 实测，M 系列） | **0.15–0.17 ms/帧**（含每 12 帧一次 snapshot + 每帧 update + 排序） |
| instanceMatrix 上传 | 12 × 240 × 64B ≈ 184 KB/帧 |
| 内存 | pose 缓冲 `capacity×4×12×16` floats ≈ 221KB（cap=72）；实例矩阵 12×288×16 floats ≈ 221KB |
| 每帧分配 | **零**（位姿、矩阵、排序表、aData 全预分配；`Matrix4.toArray` 不 new） |
| 过绘制 | 主要成本；`FrontSide` + 密度补偿 + 低代价 shader（无光照/贴图）控制；移动端降 `capacity` 即可 |

可调质量入口：`capacity`（残影数量）与 `history`（轨迹长度）都在构造/`update` 参数里，
主程序可在移动端用 `new Ghosts({ capacity: 36, history: 8 })`。

---

## 6. 可调参数

| 位置 | 参数 | 默认 | 作用 |
| --- | --- | --- | --- |
| `worldline.js` | `preset` | `'arc'` | 曲线造型（另有 `'sweep'` 更低更宽） |
| | `side` / `fan` | 右/2.4 | 左右张开方向与尖端横向张开量（米） |
| | `density` | 0.75 | 年龄映射 `u=a^density`：1=等弧长均匀，越小近端越疏 |
| | `FOLLOW` | `[1,.72,.45,.25,.12,.05]` | 控制点跟随天鹅的比例（尾端固定程度） |
| | `RAW_PER_SEG` / `LUT_SIZE` | 48 / 160 | 采样精度（LUT 须在 128–256） |
| `ghosts.js` | `capacity` | 72 | 快照环形缓冲容量（每快照含 4 只 × 12 部件） |
| | `history` | 14（主程序传 12） | 历史秒数 |
| | `DENSITY_MIN` / `DENSITY_POW` | 0.45 / 2.2 | 视线方向亮度补偿强度 |
| 材质 uniform | `uAlphaBase` | 0.012 | 中心通透度 |
| | `uAlphaRim` / `uRimPow` | 0.22 / 2.6 | fresnel 边缘强度 / 锐度 |
| | `uRimGlow` | 0.34 | 边缘自发光 |
| | `uIridescence` | 0.12 | 瓷釉虹彩 |
| | `uOcclude` | 0.42 | alpha 遮挡量（越小越「纯加性」） |
| | `uWarm` | (1.0,0.60,0.34) | 新生暖光颜色 |
| | `uPorcelain` / `uCool` | 冷白 / 蓝灰 | 瓷白基色 / 暗部色 |
| 代码入口 | `ghosts.setOpacity(k)` | 1 | 视觉总量（颜色+alpha 一起缩放） |
| | `ghosts.material.uniforms` | — | 直接微调任意 uniform |
| | `ghosts.count` | — | 每只天鹅当前可见残影数（QA/调试） |
| | `ghosts.reset()` / `.dispose()` | — | 清空 / 释放 |

---

## 7. 自测与验收记录

Node（本地 three 0.169，无 WebGL）+ 真实 `swan.js` 集成测试：

- **世界线**：`a=0` 在 anchor（误差 5e−8 m，float32 LUT 精度）、`a=0` 旋转为单位四元数、`a=1` 在预设尖端、
  `ageOfU(uOfAge(a))` 双向误差 <2e−3、切线均为单位向量、`matrixAtAge` 全范围有限；
  `createWorldlines` 四条线同侧间距 1.8m、不交叉、全部落在 fov34 画面内；
- **残影**：12 个 InstancedMesh / 场景中正好 12 个；age=0 时 12 个部件全部与本体重合（误差 ~1e−7）；
  实例按距离远→近写出；840 帧全部矩阵有限；`reset`/`dispose` 幂等；缓冲对象跨帧复用（零分配）；
- **集成**：真实 `Swan`（12 部件 + 父子层级 + 金饰合并几何）下自动校准出 `SWAN_PARTS` 顺序；
  主循环节奏（snapshot 先于 pose、0.2s 节拍）稳态 60 尊/只；
- **语法**：`node --check src/worldline.js src/ghosts.js` 通过。

已知边界：

1. `capacity×interval ≥ history` 是硬约束（见 §3.3），否则尾端截断；
2. 世界线尖端取景依赖主程序相机（arc 预设按 fov34 / target y=1.12 设计；改机位可调 `preset` 或 `fan`）；
3. `swans` 的部件几何需保持每个部件独立（ghost 按部件建 InstancedMesh，共享同一套 12 部件几何）；
4. 主循环每帧调用 `update` 时才会重建 LUT；长时间不调用不会自转（世界线本身不绘制，属预期）。
