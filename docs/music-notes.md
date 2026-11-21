# 配乐笔记 · 《四小天鹅舞曲 · 瓷偶世界线》

> 本仓库不包含旧版合成管线的离线渲染（`preview.wav`）与 MIDI 源文件：它们是本地开发物，不参与网页运行时。

> **2026-10-29 更新：配乐已改为参考视频原声。**
> 当前运行时使用 `assets/audio/swan-lake-source.mp3`（103.03s，bpm≈104.37，已裁掉开头 0.67s 静音），由用户提供的参考演出视频（final 版）
> `~/Movies/涌现AI/craft/little-swans-worldline/天鹅湖-四小天鹅芭蕾舞-final.MP4` 抽出（ffmpeg，AAC→MP3 160k）。
> `src/music.js` 已重写为"音频缓冲播放 + 时间轴同步"（playhead = T、冻结磁带停转、回溯 seek）。
> 下文关于 MIDI 合成管线（`music-data.js` + `tools/midi_*.py`）的内容保留为**旧版实现记录**，当前不参与运行时。

旧版文件记录 `src/music-data.js` / 旧版 `src/music.js` 的音符数据来源、授权情况、编曲结构与合成实现。
最后更新：2026-10-27（music-maker / task-7）。

---

## 1. 曲目与版权状态

| 项 | 内容 |
| --- | --- |
| 曲目 | **《四小天鹅舞曲》**（Danse des petits cygnes / Dance of the Little Swans） |
| 出处 | 柴可夫斯基《天鹅湖》Op. 20，**第二幕 No. 13 "Danses des cygnes" 第 IV 首**（Allegro moderato，F# 小调，4/4） |
| 作曲 | Pyotr Ilyich Tchaikovsky（1840–1893），首演 1877 |
| 版权 | **公有领域（PD）**：作曲家逝世已逾 130 年（中国著作权法 50 年、欧美 70 年保护期均已届满） |
| 用途 | 作品内实时合成（本项目原创编配与音色设计），非商业展示 |

> 注：任务描述里写的是"第三幕"，实际乐谱出处为 **Act II, No. 13, Mvmt. IV**（1895 年伊万诺夫复排版把四小天鹅舞放在第二幕湖畔场景）。曲目本身无版权问题。

## 2. 音符数据来源（MIDI）

我们没有使用任何录音/音频素材，而是从一份**公版乐谱的钢琴缩谱 MIDI** 中提取"音高 / 时值 / 力度"事实，再用本项目自己的 Web Audio 合成器重新配器。

| 项 | 内容 |
| --- | --- |
| MIDI 文件 | `tchaikovsky_swan_lake_act-2_13d_allegro_moderato_(c)yogore.mid` |
| 派发页 | <https://www.kunstderfuge.com/-/midi.asp?file=23/tchaikovsky_swan_lake_act-2_13d_allegro_moderato_(c)yogore.mid> |
| 宿主站 | Kunst der Fuge（<https://www.kunstderfuge.com/tchaikovsky.htm>，Tchaikovsky → Swan Lake → Act II → 13d） |
| 音序者 | "yogore"（KDF 文件命名中的 `(c)yogore`；原 MIDI 内标注为钢琴缩谱，3 个声部：Grand Piano / Instrument17 / Instrument18） |
| 下载日期 | **2026-10-27**（本项目工作机，HTTP 200，`audio/mid`，7,220 bytes） |
| 本地副本 | `assets/audio/source/swan-lake-act2-13d-allegro-moderato.mid`（仅用于 build 可复现，**不会被网页加载/播放**） |
| sha256 | `0c45bad4cb5eea16118f74f26e4f781cce9f6edc9e52fe879bc019a8c42476f6` |

### 授权分析（重要）

- **曲子本身是公有领域**（见上表），《四小天鹅舞曲》的旋律、和声、曲式不属于任何人。
- 该 MIDI 是对公版管弦乐谱的**逐音钢琴缩谱**（piano reduction），不含录音、不含演奏；KDF 站内对音序者的标注是 `(c)yogore`。
- 本项目只从中提取**作品的客观事实**：每个音的起始时刻（换算为拍）、时值、音高、以及力度序号；没有拷贝原始 MIDI 文件结构、没有采样、没有使用任何音频。在此基础上由我们**重新编曲、重新配器、自行合成**（音色、混响、包络、段落增删都是本项目原创）。
- 因此：网页成品（`music-data.js` + `music.js` 实时合成）不包含任何第三方录音或采样；源 MIDI 副本仅作构建溯源，放在 `assets/audio/source/`，不参与运行时。
- **若将来要商业发行**：建议改用 IMSLP 上的公版总谱/缩谱（<https://imslp.org/wiki/Swan_Lake_(ballet),_Op.20_(Tchaikovsky,_Pyotr)>）重新提取音符数据，彻底避免音序文件版权争议。

### 交叉验证（不是素材来源）

- 旋律"**A A A A | G# A B A G# | B B B B | A B C# B A | …**"（F# 小调）与独立来源的乐谱视图和另一份管弦乐版 MIDI（BitMidi 的 *Swan Lake Act 2 No. 13*，仅用于核对旋律，未采用其数据）一致；
- 曲长（约 152 个四分音符的完整舞曲）与 FluteTunes 的《Danse des petits cygnes》独立编配版（约 151 拍）吻合。
- 结论：提取出的主题旋律正确，完整主题 + 低音 + B 段 + 尾声都来自公版乐谱事实。

## 3. 编曲结构（本项目原创段落设计）

速度 **♩ = 94**，4/4，**总时长 117.447 s**（在契约要求的 110–125 s 内）。
数据里所有 `t`/`dur` 以秒计；`sections` 给主程序对齐段落 / HUD / 编舞重音用。

| 段落 | 起点 T(s) | 时长(s) | 内容 |
| --- | --- | --- | --- |
| `intro` 前奏 | 0.000 | 10.213 | 4 小节原创音乐盒引子：F#m 低音踏板 + 铃 + 竖琴式琶音 → D → C#7 属和弦导入 |
| `theme` 主题 | 10.213 | 20.426 | 完整主题 A（低八度）+ A（高八度），公版旋律 |
| `middle` 中段 | 30.638 | 40.851 | 原曲 B 段（8+8 小节，转调/对答），织体加厚 |
| `reprise` 再现 | 71.489 | 20.426 | 主题 A 低+高八度再现，力度最强（加八度铃） |
| `coda` 尾声 | 91.915 | 25.532 | 原曲尾句 4 小节 + **F# 小调和弦长音 24 拍**（音乐盒滚奏后长鸣，配合世界线冻结/瓷偶定格的结尾） |

细粒度段落：`sectionsDetail`（theme_a1 / theme_a2 / middle_b1 / middle_b2 / reprise / coda / coda_ring），供需要精确节拍对齐的模块使用。

编曲/配器原则：

- 原曲的**双簧管三度双声部** → `lead`（上声部）+ `harm`（三度内声部），钢片琴/音乐盒音色；
- 原曲的**弦乐拨弦低音（F#/C# 交替）** → `bass`（拨弦低音）；
- 钢琴缩谱中的内声部和弦音 → `pluck`（拨弦点缀）；
- 前奏与尾声长和弦 → `pad`（慢起长音）+ `bell`（高音铃/星光）；
- 力度随段落递增（前奏 0.68 → 中段 0.84/0.92 → 再现 0.98 → 尾声衰减），高潮段给旋律加 +12 半音的弱铃八度。

## 4. 实时合成（src/music.js）

无任何外部音源；全部由 Web Audio 节点实时生成：

| inst | 合成方式 |
| --- | --- |
| `lead` | 钢片琴/音乐盒：正弦 1× + 2× + 3× + 4.16× 泛音，3 ms 快起、指数慢落，长音叠加 5.1 Hz / ±3.5 cent 的轻微 vibrato |
| `harm` | 同音色，力度更低、声像略偏左，构成三度双声部 |
| `pluck` | 拨弦：噪声瞬态（band-pass，Q≈1.1）+ 三角波音体，≈0.22 s 指数衰减，声像随机散开 |
| `bass` | 拨弦低音：正弦 + 三角波，低通 240–900 Hz，中等衰减 |
| `pad` | 长音铺底：三角+正弦，0.5 s 慢起、长保持、1.5 s 慢收，低通 1.2 kHz |
| `bell` | 高音铃：1× / 2× / 3.01× / 5.4× 泛音，2–4.5 s 长衰减，宽声像 + 大混响 |

效果链：`mix → tapeFilter(lowpass) → drive(×2.2) → compressor → masterGain(1.35) → destination`（drive 让压缩器在 -12 dB 阈值上工作，整体约 -20 dBFS RMS、峰值 < 0.6，不削波）；
**程序化卷积混响**（用低通噪声 × 指数衰减生成 2.8 s 双声道 impulse，含早期反射）+ **feedback delay**（八分音符 ≈ 0.319 s，反馈 0.26，低通 3.2 kHz）；各音色独立发送量，总电平经压缩器处理，不刺耳。

### 跟随外部时间轴（严格按 CONTRACT）

- `update(dt, {T, frozen, rate})`：以 `AudioContext.currentTime` 的积分作为播放头；每帧与外部 `T` 对齐，**偏差 > 0.25 s 时硬重对齐**（取消当前发声 + 二分查找重排程），小于阈值时以 0.12/帧柔性收敛，避免可闻跳变；
- 排程采用 0.22 s lookahead，按 `rate` 换算音频时间；`rate` 同时用于播放头积分；
- `frozen = true`：**tape-stop**——播放头冻结、停止排程，主低通 18 kHz→240 Hz + 混音渐隐；解冻后恢复频响并重新对齐；
- `start(T)`：从 T 秒开始；`stop()`：停止并清零；`setMuted(m)`：主增益平滑淡入/淡出；
- **未 `init()` 前所有方法安全 no-op**（`init()` 需在用户点击手势里调用，内部 `resume()` AudioContext）；
- `dispose()`：停止所有声音、关闭 AudioContext。

## 5. 构建工具（tools/）

| 文件 | 作用 |
| --- | --- |
| `tools/midi_parse.py` | 零依赖 Standard MIDI File 解析器（format 0/1、tempo map、track 名、开关音符），可 CLI 查看任意 .mid |
| `tools/midi_fetch.py` | 重新下载源 MIDI（带 URL / Referer / sha256 记录） |
| `tools/midi_build.py` | **主构建脚本**：解析源 MIDI → 声部分类 → 编曲（前奏/主题/中段/再现/尾声）→ 生成 `src/music-data.js`，并做自检（有序、非空、时长 110–125 s） |
| `tools/midi_render_preview.py` | 离线渲染 `assets/audio/preview.wav`（用与网页相同的音符数据验证旋律/时长，不需要浏览器） |

重新生成数据：

```bash
python3 tools/midi_build.py          # -> src/music-data.js
python3 tools/midi_render_preview.py # -> assets/audio/preview.wav（可选）
```

## 6. 自测记录

- `node --check src/music-data.js` / `node --check src/music.js`：通过（ES module）。
- 数据自检：1,049 个音符，按 `t` 有序，非空；`duration = 117.447 s ∈ [110, 125]`；音高范围 F#1–B6；最后一个音符起点 109.95 s（长和弦延音到 ~116 s）。
- 旋律核对：主题头 `A4 A4 A4 A4 G#4 A4 B4 A4 G#4 B4 B4 B4 B4 A4 B4 C#5 B4 A4 C#5 F#5 F5 C#5`（F# 小调）与公版主题一致。
- `src/music.js` 用 Node 里手写的 Web Audio mock 做了无头功能测试：no-init no-op / init / 20 s 帧循环跟随 T / 跳转硬重对齐 / frozen tape-stop / rate / mute / mid-piece start / dispose，全部通过。
- **真实 Chromium 端到端测试**（Playwright 无头，`?debug`）：点击 Enter 后 `AudioContext.state = running`（48 kHz），`music.pos` 与外部 `T` 漂移仅 0.002 s；`F` 冻结时 `tapeFilter` 扫到 240 Hz、位置冻结，解冻后恢复 18 kHz；静音生效；全过程 **console 无 error / warning**；并在 master 后接 AnalyserNode 实测各段有真实音频输出（intro RMS≈0.21 / theme≈0.15 / middle≈0.20 / reprise≈0.23 / coda≈0.17，峰值 <0.57，无削波）。
- `assets/audio/preview.wav`：离线渲染（32 kHz / 单声道 / 16-bit，含 3.5 s 尾音，约 7.7 MB，120.9 s；网页播放不依赖它）。对渲染结果做了 FFT 音高抽检：主题段 42 个 `lead` 音符中 39 个主频与期望音高误差 < 1 个半音（其余 3 个是内声部/泛音叠加导致的峰值误判），旋律正确。
