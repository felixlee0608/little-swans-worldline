# 瓷偶小天鹅模型与编舞

> **2026-11-16 更新（Lead）**：骨架升级为 **17 个刚体部件**：骨盆 + 胸（脊柱两段）、头、大臂/小臂（肘由两段 IK 驱动、保持手链）、大腿/小腿、足尖鞋；
> 队形收紧到 0.66m 间距，手与邻鹅相握；动作加入呼吸、胸腔 counter-roll、头部延迟与落地压缩。
> （2026-10-29：腿已从单刚体升级为 **髋/膝两段（thighL/R + shinL/R）**，当时总部件 14 个；
> 编舞已按参考视频原声（103.7s，bpm≈101.7）的整曲节拍重写，采用两段腿正向运动学反推髋高（支撑脚贴地、落地 plié）。
> 下文关于 12 部件/8 秒循环的描述是升级前的设计记录，供对照。

# 瓷偶小天鹅 · 模型与编舞（src/swan.js）

> 模块：`little-swans/src/swan.js` ｜ 负责人：swan-modeler ｜ 契约：`little-swans/CONTRACT.md` §src/swan.js
> 纯 three.js 程序化建模（无外部模型/贴图），只 `import 'three'`。

---

## 1. 交付与 API 对照

| 契约项 | 实现 | 状态 |
| --- | --- | --- |
| `SWAN_PARTS` 固定 12 个、顺序不变 | `Object.freeze` 冻结数组，顺序见 §3 表 | ✅ |
| `SWAN_LOOP = 8.0` | 导出常量，`update()` 内部按它取模 | ✅ |
| `class Swan({index=0, spacing=1.8})` | 同签名；`root.position.x = (index-1.5)*spacing`，默认 index 0..3 → x=[-2.7,-0.9,0.9,2.7]，y=0，z=0 | ✅ |
| `root` | `THREE.Group`，放在地面，仅 `x` 在编舞中侧移（≤0.14m），y/z 恒为 0 | ✅ |
| `parts` | `{ [name]: THREE.Object3D }`，12 个刚体 mesh，含父子层级（见 §4） | ✅ |
| `meshes` | `{ [name]: THREE.Mesh }`，每个部件一个 porcelain 主 mesh，材质共享 | ✅ |
| `anchor` | `THREE.Vector3`，骨盆世界位置，每次 `update()` 后更新（静止 y=0.95，plie 时低 ~1.6cm，跳起时高 ~6cm） | ✅ |
| `update(t)` | 对 `SWAN_LOOP` 取模；只写 12 个部件的 local transform + `root.position.x`；确定性、不分配 | ✅ |
| `captureWorldPose(out, floatOffset=0)` | 12×16 floats（列主序 Matrix4，平移 = `matrixWorld - anchor`），顺序 = `SWAN_PARTS`；内部补一次 `root.updateMatrixWorld(true)` | ✅ |
| `getPartGeometry(name)` | 返回 part-local 的低模合并几何（porcelain 主 mesh + 金饰合并），首次调用后缓存 | ✅ |
| `createPorcelainMaterial()` | 导出；模块级单例，四只天鹅共享 | ✅ |
| 只 import `'three'`；无全局副作用 | 仅 1 行 import；几何/材质只在构造期创建 | ✅ |

**附加（不属于契约，主程序可忽略）**：`dispose()` 释放本实例几何；`export default Swan`。

---

## 2. 坐标系、比例与阵型

- 世界：y 向上，地面 y=0，1 单位 = 1 米；小天鹅面朝 **+Z**（鼻尖/交叉的指尖/鞋尖都朝 +Z）。
- 比例：静止总高 **1.6527m**（发髻顶），脚底 y≈0.0004；骨盆锚点 y=0.95。
  - 踝高 0.09 → 腿长（髋 0.92）0.83；躯干腰部约 0.99；肩线约 1.27；颈根 1.39；头骨顶约 1.63；发髻顶 1.65。
- 阵型：`root.position.x = (index - 1.5) * spacing`。`spacing=1.8` 时正好是契约要求的 `[-2.7, -0.9, 0.9, 2.7]`。
- 编舞中允许的侧移：`root.position.x ∈ formationX ± 0.14`（契约上限 ±0.15）。

---

## 3. 12 个刚体部件

三角数来自 Node 侧 `geometry.attributes.position.count / 3`（合并后）；合计 **11,532 tri / 34,596 vert**（四只 = 46k tri，不含 ghost）。

| # | 部件 | 父级 | 枢轴（world 静止） | 几何构成 | 刚体动画自由度 | tri |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `body` | root | 骨盆 (0, 0.95, 0) | 车削躯干（收腰/开肩/含胸，z 压扁 0.72）+ 胯部椭球 + 胸 + 肩头球 + 颈根 + 3 片尾羽 | position(x,y,z)、rotation(x,y,z) | 2,672 |
| 2 | `tutu` | body | 腰 (0, 0.995, 0) | 闭合剖面车削薄瓷盘（半径 0.356）+ 13 瓣波浪裙边 + 腰封圆环 | rotation 轻摆 | 1,344 |
| 3 | `head` | body | 颈根 (0, 1.39, 0) | 颈锥 + 下颌/脸椭球 + 头骨椭球 + 浅鼻 + 耳 | rotation(x,y,z)：点头/微侧/慢转头 | 1,308 |
| 4 | `bun` | head | 头后上 (0, 1.588, -0.06) | 扁圆发髻 + 盘发沟槽环（+ 金发带，金饰另 mesh） | rotation 惯性小滞后 | 808 |
| 5 | `wingL` | body | 左肩胛 (-0.095, 1.25, -0.072) | 收拢翅壳椭球 + 覆羽球 + 3 片短圆覆羽 | rotation 轻颤 | 904 |
| 6 | `wingR` | body | 右肩胛 (+0.095, 1.25, -0.072) | 同上镜像 | 镜像 | 904 |
| 7 | `armL` | body | 左肩 (-0.158, 1.276, 0.012) | 肩球 + 上臂锥 + 肘球 + 水平前臂 + 腕球 + 指尖锥 —— **几何本身即身前交叉、手递向 +x 邻居** | rotation 微起伏/递手 | 640 |
| 8 | `armR` | body | 右肩 (+0.158, 1.276, 0.012) | 同上镜像，前臂 z 前移 3.6cm 让两臂层叠不打架 | 镜像 | 640 |
| 9 | `legL` | root | 左髋 (-0.082, 0.92, 0) | 髋球 + 大腿锥 + 膝球 + 小腿锥 + 踝球 | position.y（离地）、rotation(外开/后收) | 584 |
| 10 | `legR` | root | 右髋 (+0.082, 0.92, 0) | 同上镜像 | 镜像 | 584 |
| 11 | `slipperL` | legL | 左踝 (0, 0.09, 0.004) | 脚背楔 + 鞋身 + 尖头（鞋尖最低点对齐 -0.09，静止时正好 y=0）+ 后跟 + 踝头 | rotation.x 绷脚（≤0.05rad，防插地） | 572 |
| 12 | `slipperR` | legR | 右踝 (0, 0.09, 0.004) | 同上 | 镜像 | 572 |

金饰（不占 12 部件名额，随主 mesh 一起并进 ghost 几何）：头部小冠弧环 + 珠 + 颈链；发髻发带；两只足尖鞋的踝丝带 + 小蝴蝶结。每个部件最多 1 个合并后的 gold mesh（4 个/swan）。

**为什么腿挂在 root 而不是 body**：骨盆做 plié 下沉/小跳起伏时腿不跟着沉，脚才能踩住地面；髋部 1~2cm 的落差被纱裙盖住（这是"瓷偶"比例下最省成本的做法）。

---

## 4. 层级

```
root（队形位，y=0）
├─ body（骨盆枢轴；躯干几何以骨盆为原点）
│  ├─ tutu
│  ├─ head
│  │  └─ bun
│  ├─ wingL / wingR
│  └─ armL / armR
├─ legL ── slipperL
└─ legR ── slipperR
```

`captureWorldPose()` 直接取这 12 个部件的 `matrixWorld`，与层级无关；因此"哪些部件是父子"只影响动画书写，不影响 ghost 数据格式。`body` 的快照平移恒为 (0,0,0)（body 枢轴 = 锚点），这是 ghost 世界线"从骨盆长出来"的落点。

---

## 5. 瓷白材质

`createPorcelainMaterial()` 返回共享的 `MeshPhysicalMaterial`：

- 暖白 `#fff6ee`（不是死白），`roughness 0.16`、`metalness 0`；
- **clearcoat 1.0 / clearcoatRoughness 0.05**：釉面高光；
- **sheen 1.0**（粉色 sheen）：瓷器边缘的一层柔光；
- **iridescence 0.38 / IOR 1.38 / thickness 90–380nm**：微虹彩，随角度变化；
- `envMapIntensity 1.15`，依赖场景 `environment`（舞台 HDRI）出效果。

金饰用独立 `MeshPhysicalMaterial`（metalness 1、roughness 0.24）。

---

## 6. 编舞设计（8s 循环，四小天鹅可读性）

`update(t)` 里 `ph = 2π · (t mod 8)/8`，所有信号都是 `ph` 的整数倍频率正弦 → **天然无缝循环**、完全确定性（无积分、无随机、无状态）。核心公式：

| 信号 | 公式 | 作用 |
| --- | --- | --- |
| 侧摆 | `sway = sin(2φ)` | 8s 内左右各一次（周期 4s） |
| 小跳 | `hopRaw = (1-cos(4φ))/2`；`hop = hopRaw²·(0.6+0.4·hopRaw)` | 每 2s 一小跳，共 4 跳；指数让"离地利落、落地稳" |
| 根侧移 | `root.x = formationX + 0.14·sway` | 侧向小跳位移（≤0.15 契约上限） |
| 身体高低 | `bodyY = 0.95 + 0.06·hop − 0.016·(1−hop)` | 跳起 6cm；落地 plié 下沉 1.6cm |
| 腿 | `leg.y = 0.92 + 0.06·hop`；`legSwing = 0.10·hop`；`turnout = 0.045+0.03·(1-hop)` | 起跳双脚离地（鞋底最高 4.2cm）、plié 外开、空中腿后收 |
| 躯干 | `roll=-0.075·sway`；`twist=0.055·sway`；`pitch=0.025+0.045·hop` | 向行进侧倾、肩线微扭、跳跃前倾 |
| 头 | `tilt=-0.13·sway`（另加躯干侧倾 → 世界侧倾 ~12°）；`look=0.10·sin(φ)`；`pitch=0.02+0.055·hop` | **头微侧**；8s 慢速左右看（像找同伴）；跳时点头 |
| 手臂 | 局部小转：`-armLift`（抬肩）、左右交替 `offer=0.02·sin(φ)` | 交叉造型由几何固定，动画只做"呼吸/递手"的微起伏，交叉永不走形 |
| 翅/纱裙/发髻 | ±0.05~0.16rad 的反向小摆 | 惯性/颤动，瓷偶的"轻" |

**四小天鹅读感**：

1. **双臂在身前交叉、手递向相邻天鹅**：`armL` 的指尖在 body-local `x=+0.262`（越过身体中线，实测世界 x 越过中线 +0.14m），指尖朝 +x / −x 指向左右邻居；两前臂在胸前 z≈0.16–0.22 层叠。
2. **侧向小跳 + plié**：每 2s 一次侧向小跳（4 跳/循环），起跳时脚离地、落地身体下沉，侧移与跳跃同相位。
3. **头微侧**：世界系头部侧倾峰值 **12.2°**，与侧移反相，像小天鹅歪头。
4. **动作平滑**：逐 1/240s 采样，头部位移最大 **1.21mm/帧**，无跳变；循环首尾矩阵差 < 0.007。

`update(t)` 只做标量数学 + 写 transform，实测 **≈0.5µs/次**（四只天鹅一帧 < 3µs）；`captureWorldPose` ≈0.8µs/次（0.2s 拍一次，完全可忽略）。热路径零分配。

---

## 7. 与 ghost / worldline 的接口注意

- 快照前主循环需 `swan.update(T)` 再 `swan.root.updateMatrixWorld(true)`（`captureWorldPose` 内也会补一次，容错）。
- `captureWorldPose(out, off)` 写 `out[off .. off+192)`：每部件 16 floats，**平移已减 anchor**；`body` 的 16 floats 平移应为 0。
- `getPartGeometry(name)` 返回的是 **part-local** 坐标几何（不做世界变换），ghost 端用 `worldline.matrixAtAge(age) × poseRow` 摆放即可。
- 四只天鹅使用同一套几何/材质；`getPartGeometry` 每个实例各自缓存（共约 13,948 tri，含金饰）。
- 材质为模块级共享单例；舞台 `scene.environment` 就位后釉面才会亮，没有环境贴图时瓷白会偏暗（建议舞台给一点环境光/HDRI）。

---

## 8. 自测与验证

Node 端（`three@0.185`，无 WebGL，仅验证数据/数学）自测覆盖 60+ 项，全部通过：

- 12 部件名/顺序/数量；`meshes` 共享材质；父子层级；
- 静止总高 1.6527m（1.6–1.7 ✓）、脚贴地（minY=0.4mm）、全程不穿地（最低 -1.3mm 容差内）、跳起最高 1.74m、侧移 ≤0.14m；
- `update` 确定性（穿插其它 t 后同 t 同姿态）、负 t/取模正确、循环首尾连续；
- `captureWorldPose` 与 `matrixWorld-anchor` 逐元素一致、`floatOffset` 生效、矩阵正交（无缩放）、`body` 平移为 0；
- `getPartGeometry` 12 个都有几何且缓存；
- 双臂交叉越过中线、指尖朝外；小跳鞋底最高 4.2cm；头部侧倾 12.2°；动作平滑；
- 四实例阵型 x=[-2.7,-0.9,0.9,2.7]、互不干扰；
- 性能：update 0.51µs/次、capture 0.8µs/次。

复现：

```bash
# 语法（three 的 import 不会被求值）
node --input-type=module --check < little-swans/src/swan.js

# 若本地有 three（如 worldline-dancer/ref/run 里没有，可 npm i three@0.185.0）：
#   把 swan.js 复制到含 node_modules/three 的目录后跑 Node 场景自检，
#   或直接跑主程序：python3 little-swans/tools/serve.py → http://127.0.0.1:8781/
```

QA 渲染：本次在无头 Chromium（Metal/ANGLE WebGL2）里用 16:9 1280×720 拍了 15 张多角度图（正面/侧面/背面/顶视/近景/头部/三视角），确认：站立脚贴地、交叉手臂清晰、跳起离地、纱裙波浪与瓷面高光可见；单只 16 draw calls、四只 65 draw calls、55.9k tri。

---

## 9. 已知取舍（后续可迭代）

- **翅**：为了在 ghost 里不出现"细针"，翅膀做成收拢的流线翅壳 + 3 片短覆羽；从正后方看偏圆润，若舞台相机主要从 +Z 前方看效果最好（当前主视觉）。
- **手臂是单刚体**：肘部弯折烘进几何（满足"手臂分段带肘关节"的视觉要求），动画只在肩部微转。这样 ghost 的每部件单矩阵永远与本体一致——这是契约 ghost 数据格式下的正确取舍；若未来要做真肘关节，需要把 arm 拆成两个部件（会破坏 12 部件数）。
- **双腿不真弯膝**：plié 靠骨盆下沉 + 腿外开表达，脚保持贴地；瓷偶风格下可读。
- 头部是"留白脸"（不画眼睛）+ 浅鼻，符合素白瓷偶；金冠/颈链/发带/鞋带提供少量金色焦点。
