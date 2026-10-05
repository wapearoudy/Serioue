# Serious

把共享的「阅读（Legado）源」变成真正能用的桌面客户端。macOS 与 Windows 通用。

源仓库（`yck2026.fun/yuedu/rsss`）分享的是一堆 **规则**，不是一个应用：
每条源描述「去哪里取列表、列表项怎么选、正文怎么抽」，还夹着 JavaScript 和 JSON 模板。
这些规则原本只能在安卓手机上通过「阅读」App 运行。Serious 在桌面端重新实现了这套规则引擎，
把规则直接兑现成分类目录、文章列表、阅读器、视频播放器和图片画廊。

---

## 它能做什么

| 功能 | 说明 |
| --- | --- |
| 合集导入 | 从源仓库浏览 90+ 共享合集，一键导入；也支持粘贴 JSON 地址或拖入 JSON 文件 |
| 分类目录 | 自动解析源的 `sortUrl`，渲染成分类标签页（如「国产 / 欧美 / 福利」）；切换源时回到第一个分类 |
| 文章列表 | 按源规则解析列表，支持分页与无限滚动 |
| 视频播放 | HLS (`.m3u8`) 在 Windows 上也能播 —— 内置 hls.js，Safari 走原生；多码率可切画质、可调倍速、播放器下方常驻**选集**栏 |
| 阅读器 | 视频源 → 播放器；图集 → 可缩放画廊；音乐 → 队列式播放器；其他 → 原文或纯文本 |
| 阅读设置 | 字号、行距、字体、背景（夜间/白日/羊皮/护眼）、版心宽度，改完立即生效并记住 |
| 播放偏好 | 音乐和视频的音量、视频倍速跨启动保留；视频有独立音量条；音乐有可跟随、可点击跳转的歌词 |
| 阅读进度 | 记住每篇文章读到哪儿，重开自动回到原处 |
| 继续阅读 | 侧栏顶部列出读到一半的文章，带进度条，点一下接着读 |
| 书架 | 在任意分类列表点标题下的 ☆ 把**整个分类**收进书架，之后从侧栏「书架」直接回去接着读；读到一半会显示进度 |
| 划线与笔记 | 选中文字即出现「高亮 / 笔记」；划线随文章保存，下次打开还在原处；侧栏「划线」汇总全部 |
| 目录与章节 | 标题栏「目录」列出当前列表，当前章高亮；底部上一章/下一章；读到本章末尾自动提示下一章；快捷键 `[` `]` `T` |
| 阅读统计 | 侧栏「统计」显示今日 / 本周 / 全部读了多少篇、多少分钟，并按源分组；时长由阅读记录推断，单篇封顶 30 分钟 |
| 音乐睡眠定时 | 🌙 定时 15/30/45/60 分钟或「本曲结束」；到点后最后 20 秒**音频本身**线性淡出到 0 再暂停，剩余时间常驻可见 |
| 视频手感 | 全屏播放 3 秒无操作自动隐藏控件、移动鼠标立刻淡回、暂停时常显；双击画面切换全屏；缓冲时显示「缓冲中…」与已缓冲百分比 |
| 画质记忆 | 手动选过的画质**按条目记住**，重开仍是那一档；画质菜单里可「清除本条画质记忆」 |
| 源校验 | 分阶段体检每个源：规则 / 首页 / 列表 / 详情 / 搜索，逐项给出可执行的结论 |
| 收藏 / 历史 / 搜索 | 常用源收藏、阅读历史回溯、单源内搜索 |
| 跨平台 | macOS（Apple Silicon + Intel）与 Windows |

## 源校验

共享的源会慢慢失效：有的站点直接打不开，有的改版后选择器失配。校验功能按阅读器真实的取数路径，
把每个源走一遍，并逐项说明结果：

| 阶段 | 验证什么 |
| --- | --- |
| 规则 | 规则里是否声明了必需的 `ruleArticles` / `ruleContent` |
| 首页 | 站点是否可达，响应码、内容类型、页面大小 |
| 列表 | 列表选择器是否还能匹配到条目、条目是否带链接 |
| 详情 | 打开一条真实条目，正文规则能否提取到内容 |
| 搜索 | `searchUrl` 是否还能返回结果 |

结论会直接写成可执行的诊断，例如「能打开(2.3 KB)，但规则没有匹配到任何条目——通常是站点改版
导致选择器失效」，而不是笼统的「不可用」。

用法：

- 左侧「校验」标签页进入面板，可选 **全部 / 仅异常 / 未检测 / 过期** 四种范围
- 结果按「失效 → 警告 → 未检测 → 正常」排序，问题排在最前
- 点开任意一行看分阶段报告；「只校验这个」单独重检一个源
- 「复制报告」导出 Markdown，方便反馈问题或提 issue
- 校验进行中可随时「停止」

工程上的两个关键点：

- **每阶段 12 秒看门狗**。单阶段跑在独立线程上，超时就记为失败并放弃该线程，一个不响应的站点
  拖不垮整轮校验。
- **并发校验**。受设置里的「并发检测」开关控制（最多 6 个 worker）；结果每 8 个批量落盘一次，
  避免 71 个源各自全量重写一次 `sources.json`。

## 阅读设置

点标题栏右侧的 `Aa` 打开：

| 项 | 范围 | 说明 |
| --- | --- | --- |
| 字号 | 13–30 px | 每次 ±1px |
| 行距 | 1.20–2.40 | 每次 ±0.10 |
| 背景 | 夜间 / 白日 / 羊皮 / 护眼 | 切换整个阅读面，不只是正文列 |
| 字体 | 系统 / 宋体 | |
| 版心 | 全宽 / 640 / 760 px | 控制一行字数 |

设置立即生效并持久化。**服务端会做范围校验**（`validate_settings`），越界或非法值一律夹回合法区间，
所以手改 `settings.json` 也不会把界面改成不可读的样子。

阅读进度按文章 URL 记录的是**滚动比例**而不是像素位置 —— 换字号或改窗口高度后页面会重排，
只有比例能活下来。滚动时每 1.2 秒存一次，离开时再存一次。

### 目录与章节跳转

打开的条目来自哪个列表，那个列表就成为目录：

- 标题栏「目录」（或按 `T`）展开章节列表，**当前章高亮**，**读完的章打勾、读到一半的标黄点**，点任意一章直接跳转
- 文章底部「上一章 / 下一章」，到首尾自动禁用
- 快捷键：`[` 上一章、`]` 下一章

列表内容被提升到应用层保存 —— 否则列表组件在打开阅读器时会卸载，目录就没有数据来源了。

滚到本章末尾会出现「本章已读完 · 下一章：xxx」，可选继续或「暂不」。**「暂不」是按章记录的** ——
往回翻不会又冒出来，翻到再下一章则重新提示。

目录里的「已读」标记来自阅读进度表(≥98% 视为读完),整本列表一次性取回,不会一章一次 IPC。

### 继续阅读

侧栏顶部会列出**读到一半**的文章：标题、来源、上次阅读时间、进度条，点一下直接接上。

只收进度在 2%–98% 之间的：刚打开没滚动的、和已经看完的，都不该出现在这里。离开阅读器或切换源时
侧栏会重新拉取，所以读了一半退出来，下次打开就在那儿。

### 阅读统计

侧栏「统计」显示读了多久。**不联网、不需要任何外部服务** —— 全部由本地已有的
`history.json` + `progress.json` 算出来。

今日 / 本周 / 全部各显示篇数与时长，并按源分组列出篇数。没有记录时给一句空状态（`还没有可统计的阅读`），
而不是三个 0。

时长只能用阅读位置推断，**并且单篇封顶 30 分钟**：

> 进度记录只有 `updated_at`，没有「读了多久」。所以时长是用相邻两次更新的时间差推出来的 ——
> 晚上挂着一篇不关，次日再看就会算出「读了八小时」。封顶是为此存在的，
> 理由写在 `src-tauri/src/reading_stats.rs` 里。

实测（`pnpm test:reader-stats`）覆盖了这几个容易算错的点：

```
today: 今日 3 篇 45 分钟      week: 本周 3 篇 45 分钟      all: 全部 5 篇 1 小时 35 分钟
by source: 源 A 3 篇 | 源 B 2 篇
only yesterday: today "今日 0 篇 不到 1 分钟" · week "本周 0 篇 不到 1 分钟"
across midnight: today 10 分钟 · 全部 20 分钟
eight hours of wall clock counted as: 全部 1 篇 30 分钟     ← 封顶生效
opened but never scrolled: 全部 1 篇 不到 1 分钟
failure state: progress.json 读取失败 ✕ 统计没读出来 …      ← 不是白屏也不是永远转圈
```

最后一条同样是验收项：统计读不出来时必须显示错误和出路，**不能永远转圈**。

### 书架

「继续阅读」记的是**单篇文章**，书架记的是**一整个分类列表** —— 也就是读者真正会反复回去的那本书。

在任意源的分类列表里，搜索框上方有 `☆ 收进书架`，收的是当前分类：按钮旁会写清楚收的是哪一个
（「收的是「玄幻」这一整个列表」），避免以为收的是某一篇。点一次保存，再点一次移除。

书架里每行显示来源、分类、加入时间，以及**整本书的进度**：`已读 3 / 12 章 · 25%`，另外还在读一半的
章节会单独数出来。点开就会切到对应的源并直接进入第一篇。

> 进度是把这个分类的列表重新抓一遍、逐条对阅读位置算出来的，不是估的。分页列表只统计第一页，
> 界面上会写明「只统计了第一页」—— 说一个假的总数比不说更糟。
> 一次最多并发 4 个源；某个源挂了只影响它自己那一行，不会清空整个书架。

> **一个「书」= 一个分类**。在 1000 本书的源里收一整个分类比收某一章有用得多；章节级的东西交给
> 「目录」和「继续阅读」。

### 验证

```bash
pnpm dev            # 另开一个终端
pnpm test:shelf     # Playwright 驱动真实的 ArticleList 与 ShelfPanel
```

```
star starts as "☆ 收进书架" · 收的是「全部」这一整个列表
after saving: ★ 已在书架
header tab reads: 书架 1
switching category clears the saved state
re-saving kept the count at 书架 2
after a reload the shelf still holds 书架 2
panel lists: 演示小说源 · 玄幻 | 演示小说源 · 全部
opening a row returns the entry: 打开了：演示小说源 · 玄幻
removing one row left: 演示小说源 · 全部
```

（现已改为断言**被删掉的是哪一行**：`removed "演示小说源 · 全部"; "演示小说源 · 玄幻" is still there`。
断言「另一行还在」在点错按钮时同样会通过。）

`added_at` 由后端打，不接受前端传值，并且会跨过已有的最大时间戳 —— 否则一秒内保存的两本书
回来顺序是随机的。

### 划线与笔记

在文章里选中一段文字，选区上方立刻出现「高亮 / 笔记 / 取消」。侧栏的「划线」列出全部，
每条显示引用、笔记、来源和时间，点一下回到原文。

两条设计约束：

- **存的是引文，不是 DOM 偏移。** 文章每次打开都是重新抓取的，昨天 DOM 里的偏移今天早就指到
  别的句子上去了。匹配时忽略空白，并且跨节点匹配 —— 源站 HTML 里一句话常常被 `<strong>`、
  `<a>` 切成好几段（`src/components/highlight.ts`）。画的时候用 `Range.extractContents()`，
  和鼠标拖选的行为一致。
- **同一篇里的同一句话只有一条划线。** 同一段文字很容易被选中两次；重复的行比缺一行更糟。
  身份是 (文章, 引文)，`id` 由后端用 FNV-1a 从这两者派生 —— 不用 `DefaultHasher`，
  因为它的值要落盘、跨重启必须一致。

划线画不出来是正常情况：源站改了措辞。找不到的划线仍然出现在列表里，只是正文里没有高亮。

### 验证

```bash
pnpm test:highlight
```

夹具文章的每一句都被 `<strong>` / `<em>` / `<a>` 切开，所以要匹配的引文**一定跨节点** ——
按单个文本节点搜索的写法在这里必然失败，而这正是要测的情况。

```
no toolbar until something is selected
toolbar after selecting a passage: 高亮 笔记 取消
the passage is marked in the page: 让人愿意一直读下去
surrounding text intact across 141 chars
stored once
a second passage highlights independently
re-highlighting the same sentence did not duplicate it
after a reload the page shows 3 marks: 让人愿意一直读下去 | 成组调整 | 换一台设备
panel lists 3 highlights, and the note reads "这一段值得回头再看"
deleting a highlight removed it from the panel and the store
```

其中 `after a reload … 3 marks` 同时断言了**没有 `<mark>` 套 `<mark>`** —— 每次重绘前先清掉旧的。

### 验证

```bash
pnpm dev            # 另开一个终端
pnpm test:reader    # Playwright 驱动真实浏览器
```

断言：字号确实变大变小且不低于 13px、行距确实变、羊皮主题背景确实换了、点外面能关掉浮层、
滚动后阅读进度确实被测量到、目录列出 6 章并高亮当前章、点章节能跳转且关闭目录、
章节按钮走到首尾会禁用、读到章末提示下一章、「暂不」之后不再打扰、下一章重新提示、
目录给读完的章打勾、给读到一半的标点。

## 视频播放

`.m3u8` 是这类源最常见的视频格式,而 Chromium/WebView2 **原生不支持** —— 之前的播放器只能显示一句
「请在系统播放器或 VLC 中打开」,等于功能不存在。现在：

- Safari / iOS 走浏览器原生 HLS；其余平台由 [hls.js](https://github.com/video-dev/hls.js) 经
  Media Source Extensions 喂给同一个 `<video>` 元素

  > **为什么不问浏览器「你支持 HLS 吗」**：Edge 对 `canPlayType("application/vnd.apple.mpegurl")`
  > 返回 `"maybe"`，但实际解不了流。信这个返回值会让所有 Windows 用户点开就是黑屏。
  > 所以只要 hls.js 能用就走 hls.js，只在缺少 Media Source Extensions 时才把地址交给元素本身
  > （那条路恰好就是 Safari 的原生路径）。

  hls.js 有 500 KB，**按需动态加载**：主包 gzip 88 KB，只有真的打开 HLS 视频时才拉那一份。
- 从主播放列表解析出每个码率，**可手动切换 / 自动选择**
- 倍速 0.75× – 2×
- 快捷键：`空格` / `k` 播放暂停、`←/→` ±10 秒、`f` 全屏、`↑`/`↓` 音量
- 独立的音量条；**音量与倍速跨启动保留**（存在设置里，后端会夹到合法区间）
- **续播**：记住看到的位置，重开时提示「上次看到 6:24」，可选继续播放或从头开始
- **字幕**：自动读取页面里的 `<track kind="subtitles">` 并挂到播放器上
- **连播**：一个视频源往往就是剧集列表，放完后提示「6 秒后播放：第 2 集」，可立即播放或取消
- **选集**：播放器正下方常驻一栏 —— `‹` 上一集、剧集下拉、`›` 下一集，右边显示「第 3 / 12 集」。
  不用翻到页面底部找上下章按钮，也不用开目录；到头时对应箭头置灰而不是绕回第一集
- 失败分级处理：网络错误自动重试、解码错误自动恢复、其余给出明确原因 —— 不再一律甩锅给 VLC

播放控制条现在**不再用浏览器原生的 `<video controls>`**，改用播放器自带的控制条。

> **为什么换掉原生的**：Chromium 的原生控制条会**抢走手势** —— 画面单击被它拿去切播放/暂停，
> 双击被它拿去给 `<video>` 元素自己全屏，而应用层根本不需要后者。
> 实测 `preventDefault()` **拦不住**。两条控制条在功能上互斥，只能留一个，
> 所以这里选了能自己管手势的那条。原生条的其他优点（无障碍）由自绘条补回来：
> 按钮都有可读标签与 `aria-label`。

自绘条上：播放/暂停、后退 10 秒、进度条、时间、画中画、画质、倍速、全屏、静音、音量。

### 控制条自动隐藏、双击全屏、画质记忆

- **自动隐藏**：全屏**且正在播放**时，3 秒无操作就淡出控件；移动鼠标、触摸或按键立刻淡回；
  **暂停时永远显示**。判据是控件元素的 `computed opacity`，不是截图。
- **双击切换全屏**：双击画面进出全屏；**单击不打断播放**。
- **画质记忆**：手动选过的档位**按条目记住**，重开仍是那一档；画质菜单里有
  「清除本条画质记忆」可以逐条清除。

> **没有全局的「清除所有画质记忆」入口。** 记忆是按条目存的，数量等于「曾经手动选过画质的不同剧集」，
> 不会膨胀到需要一键清空；逐条清除已经够用。

- **缓冲反馈**：不再是转圈，而是「缓冲中… NN%」，用 `progress` 事件算已缓冲百分比，能继续播放时消失。

实测（`pnpm test:video-controls`）：

```
buffering badge reads "缓冲中… 100%" and disappears once playback can continue
outside fullscreen the controls stay visible (opacity 1)
paused in fullscreen keeps them visible (opacity 1)
after ~3s idle while playing, controls opacity 0.0154944
a mouse move restored them (opacity 0.98036)
a key press restored them without interrupting playback
pausing while hidden brings the controls straight back
a single click on the picture left playback running (t 0.0 → 0.3)
double click put the player itself into fullscreen (player-wrap)
after a reload the player opened at 画质 360p
「清除本条画质记忆」 removed it from storage and went back to 自动
```

> **跨域限制**：hls.js 通过 XHR 拉取播放列表和分片，因此**视频服务器必须带
> `Access-Control-Allow-Origin`** 才会被放行。绝大多数正规 CDN 都有；个别自建源没有，
> 表现是播放器能打开但一直转圈。这种源可以用「在浏览器中打开」到系统播放器里看。

### 验证

用 ffmpeg 生成一个**真实的三码率 HLS 流**（`testsrc` 合成画面，不需要素材），再在真实浏览器里驱动：

```bash
pnpm demo:video     # ffmpeg -> public/demo/hls/master.m3u8
pnpm dev            # 另开一个终端
pnpm test:video
```

实测输出：

```
manifest parsed, quality control reads "画质 自动"
quality menu offers: 自动, 1080p, 720p, 360p
switched to 画质 360p
restored to 画质 自动
speed set the element to 1.5x
HLS playback advanced to t=1.68s (readyState 4, duration 12.1s)
dead stream reports: 网络中断，正在重试…
subtitles: 1 <track>, 1 text track, 4 cues, mode=showing
next-episode prompt: 6 秒后播放：第 2 集 · 示例
cancelling the prompt dismissed it
position stored as 50% of the runtime
after reload the player offers: 上次看到 0:06
"继续播放" jumped from 0s to 6s
"从头开始" cleared the stored position
```

`readyState 4` 表示分片已完整解码，**是真的在播**。

选集那一栏挂在真正的 `Reader` 组件上验证 —— 旧的 `reader-preview.html` 是**手抄**的阅读器标记，
改坏了也不会报错，所以另开了一个 `video-reader-preview.html` 直接挂载真组件：

```bash
pnpm test:episodes
```

```
episode picker rendered under the player
counter reads 第 3 / 5 集
dropdown opened on 第 3 集 · 示例剧集
choosing the dropdown moved the reader to 第 5 集 · 示例剧集
both ends disable their arrow instead of wrapping around
‹ › step one episode at a time
a standalone video gets neither a picker nor chapter buttons
```

> 未能验证的：真实直播流的解码 —— 需要能访问外网的机器。这里验证的是清单解析、画质切换、
> 倍速写入和分片播放本身。

## 音乐播放

包含 `.mp3` / `.flac` / `.m4a` / `.aac` / `.wav` / `.ogg` / `.opus` 的条目会被识别为音乐，
直接进入播放器而不是当成文章。播放器是队列式的：

- 一页里所有 `<audio>` 会被收集成播放列表，标题取自对应链接文字
- 上一首 / 下一首 / 队列点选 / 进度拖动 / 音量 / 静音
- 随机播放、单曲循环、列表循环
- 快捷键：`空格` 播放暂停、`Ctrl + ←/→` 切歌、`←/→` 快退快进 5 秒、`↑/↓` 音量
- **音量跨启动保留**
- 播完自动进入下一首；不循环的列表播到末尾会停下而不是悄悄回绕
- **歌词**：页面里以 `.lrc` 结尾的链接按文件名配到对应的曲目（`<a href>`、`data-lrc`、
  `<link rel="lyrics">` 都认）。解析器接受真实文件里那些不规范写法 —— 一行两个时间戳、
  用 `:` 当小数点、`[ti:]`/`[offset:]` 这类元数据、正文里的方括号；当前句高亮并**自动滚动**到
  视野中央，点任意一句直接跳到那里。没有歌词的曲目不显示面板

  > 歌词文件放在音乐源自己的域名下，通常不发 `Access-Control-Allow-Origin`，所以 webview 直接
  > `fetch` 会被拦。走的是后端的 `fetch_text`（复用引擎那套 User-Agent 和 cookie jar）。

判定只看**链接路径和标题**，不看域名 —— 否则托管在 `music.x.com` 的源会把它的视频全判成音乐。

### 睡眠定时与淡出

控件区有 🌙 入口，可选 15 / 30 / 45 / 60 分钟或「本曲结束」。

- **淡出改的是音频本身**，不是 CSS：到点后最后 20 秒线性把 `audio.volume` 降到 0 再 `pause()`。
  用 CSS 做淡出只会让音量条和实际音量对不上。
- **定时状态必须看得见**：按钮上直接显示 `🌙 剩余 14:59` / `本曲结束` / `淡出中`，
  另有一行 `aria-live` 状态。悄悄生效的定时等于没有。
- **淡出途中可以取消**：立即停止斜坡并恢复淡出前的音量，且不打断播放。
  实现上用 generation 计数，取消时 bump 一次，在途的那一帧下一帧就退出，不会把音量再拖下去。
- 「本曲结束」在**切歌时自然失效**并清空状态；定时停下不会误跳到下一首。

> 淡出期间音量滑块会置灰并注明「睡眠定时淡出中」，避免用户的拖动和斜坡互相覆盖。

实测（`pnpm test:sleep`，逐帧采样 `audio.volume`，不是看界面文字）：

```
options offered: 15 分钟 / 30 分钟 / 45 分钟 / 60 分钟 / 本曲结束
15-minute timer armed and visible: "🌙 剩余 15:00" / "睡眠定时已开启 · 剩余 15:00"
track-end fade: 296 frames, volume 0.800 → 0.000, paused on 第二首 · 测试音, timer cleared
cancel mid-fade: volume restored to 0.800, still playing, ramp flat for the following 146 frames
timed fade: 23.0s from arming to silence (19.9s of it the ramp), volume fell monotonically to 0
```

`19.9s of it the ramp` 是实测到的斜坡长度，接近文档承诺的 20 秒。

### 验证

播放器不靠肉眼验收，用真实音频文件在真实浏览器里驱动：

```bash
pnpm demo:audio     # 生成 public/demo/*.wav 测试音频
pnpm dev            # 另开一个终端
pnpm test:music     # Playwright 跑真实播放行为
```

断言覆盖：播放位置真的在走、进度条跟着动、上一首/下一首切换、点队列跳转、空格暂停、
音量确实写到了 `<audio>` 元素上。

歌词单独一条腿，因为它要穿过网络和解析两层：

```bash
pnpm test:lyrics
```

```
lyric panel rendered with 19 lines
at rest the panel shows: 第一行歌词,用来检查高亮是否落在正确的时间点上
current line follows playback: 第 12 行 · 用来把歌词面板撑到需要滚动
panel followed the song to 215px of 318px, current line in view
clicking line 5 seeked to 0.32s
messy file parsed to 5 lines: ["同一行带两个时间戳","冒号也可以当小数点","同一行带两个时间戳","♪","方括号 [在这里] 不该被当成时间戳"]
a track with no lyric file shows no panel
```

`♪` 那一行是刻意的：真实歌词文件用「有时间戳但没有文字」表示间奏。

## 自动更新

应用支持从 GitHub Releases 自动更新（启动时自动检查，发现新版会弹窗提示）。

### 一次性设置

1. **改仓库地址** — 把 `src-tauri/tauri.conf.json` 里的占位符换成你的仓库：

   ```json
   "endpoints": [
     "https://github.com/<你的用户名>/<仓库名>/releases/latest/download/latest.json"
   ]
   ```

   公钥（`pubkey`）已经填好，不用动。

2. **设置签名密钥** — 仓库 → Settings → Secrets and variables → Actions → New repository secret：

   | Secret | 值 |
   | --- | --- |
   | `TAURI_SIGNING_PRIVATE_KEY` | `src-tauri/serious-updater.key` 的**全部内容** |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **不要创建这个 secret** |

   私钥是加过密的，解密口令为空时最省事的做法是**根本不建口令 secret** —— 变量不存在就是空串。
   如果建了却填了别的内容（GitHub 不接受空值），CI 会解密失败，三个平台一起失败。

   粘贴私钥时别用记事本手动打开复制，用命令行更稳妥：

   ```powershell
   Get-Content -Raw src-tauri\serious-updater.key | Set-Clipboard
   ```

   > ⚠️ **私钥绝对不要提交到 Git。** `.gitignore` 已经排除了 `*.key`，但请确认没有手动添加过。
   > 私钥一旦丢失，就再也无法为后续版本签名，更新会永久失效。

3. **发布** — 推送一个 tag：

   ```bash
   git tag v0.1.3
   git push origin v0.1.3
   ```

   GitHub Actions 会自动为 macOS（ARM + Intel）和 Windows 构建、签名，并**直接发布** Release。
   推 tag 就是全部步骤，不需要再去 Releases 页面点任何按钮。

   > `releaseDraft: false`，不再做草稿。v0.1.2 恰恰是因为留了「手工点 Publish」这一步，
   > 结果对外发布的 Release 里只有源码压缩包、没有安装包，`releases/latest/download/latest.json`
   > 取不到 —— 用户既下载不了也更新不了，而 CI 那次还显示绿色。现在改成推 tag 即发布，
   > 并且 CI 会回头检查产物：`latest.json` 和至少一个 `.sig` 没挂上，这次运行直接标红。

### 工作方式

- CI 用 `tauri-action` 生成各平台安装包，并用上面的私钥签名；
- 每个平台额外产出更新清单（`latest.json`）和 `.sig` 签名文件；
- 客户端启动后约 1.5 秒查询一次，发现新版本弹窗，点击「立即更新」下载并安装；
- 设置页有「检查更新」按钮，可随时手动查询；
- 下载过程显示进度条，进度通过 `update-progress` 事件推送。

> 注意：自动更新功能依赖 `ring`（C 库）编译。Windows 需要可用的 Visual Studio Build Tools
> 或 MinGW；macOS 需要 Xcode Command Line Tools。这只影响打包，普通使用不受影响。
>

## 技术选型

**Tauri v2 + Rust**，而不是 Electron：安装包只有几 MB，内存占用低，更接近原生应用。

代价是规则引擎要用 Rust 重写——这正是本项目的主要工作量。好在整条依赖链是**纯 Rust**的：

- **Boa** 作为 JS 引擎（不是 QuickJS），因此**不需要 C 编译器**，在任何只装了 Rust 的机器上都能构建
- **scraper / html5ever** 解析 HTML，**jsonpath_lib** 解析 JSON 接口
- **reqwest + native-tls**（Windows 用 SChannel，macOS 用 Security.framework），同样零 C 依赖
- 本地存储用 JSON 文件而非 SQLite，避免 `cc-rs` 编译 bundled SQLite

## 支持的规则语法

引擎按 Legado 的语义实现，兼容以下写法：

```
class.video-player@all          类名选择 + 遍历
id.content@text                 取文本
class.item@all@img@alt          @all 之后重新进入规则解析，逐项取属性
tag.a@href  .main@li            标签/类名选择器
child.0  children  next  prev  parent   节点遍历
$.model.data                   JSON 接口 + JSONPath
$.model.data@all@title          数组展开后取字段
{{$.model.title}}              模板渲染
{{$.model.time##T|.000.*## }}  `##` 正则替换运算符
@js: / <js>…</js> / enableJs    JavaScript 规则（java.ajax、cache、Base64 等）
//div.list-com/a   //text()     XPath 风格规则
{{page}}  {{page<3>}}          分页占位符
名称::URL   多行 / $$$         sortUrl 分类定义
```

JS 沙箱提供 Legado 常用的 `java.ajax`、`cache.put/get`、`Base64`，并设有循环次数上限，
避免坏规则卡死界面。

对于**没有规则、只有网址**的源（合集里很常见），会自动把该页面的内容链接提取成可浏览的列表，
而不是把整页文字塞成一条巨大的「文章」。

## 开发

需要 [Rust](https://rustup.rs)、[Node.js](https://nodejs.org) 和 [pnpm](https://pnpm.io)。
**不需要** Visual Studio Build Tools 或 Xcode 命令行工具（Linux 打包 CI 除外）。

```bash
pnpm install
pnpm tauri dev        # 开发模式
pnpm tauri build      # 打包当前平台的安装包
```

> **release 构建必须走 `pnpm tauri build`，或 `cargo build --release --features custom-protocol`。**
> 直接 `cargo build --release` 不会启用 Tauri 的 `custom-protocol`，产物会回退到
> `devUrl` 并显示空白窗口。

### 单独运行各部分

```bash
pnpm dev              # 只启动前端（需要后端命令，无法单独使用）
cd src-tauri
cargo test --release --lib   # 165 个单元测试，不联网
cargo clippy --release --all-targets   # 0 warning
```

### 原生窗口冒烟测试

用 Playwright 通过 WebView2 的 CDP 端口驱动**真实窗口**，截图并断言界面与 IPC：

```bash
pnpm build && cargo build --release --features custom-protocol   # src-tauri/
pnpm test:native           # 渲染检查 + 后端命令

# 更深的三层，按需叠加：
SERIOUS_SMOKE_NETWORK=1 pnpm test:native   # 导入真实合集、浏览、校验、更新检查
SERIOUS_SMOKE_READ=1    pnpm test:native   # 阅读流：字号改动、持久化、目录
SERIOUS_SMOKE_MEDIA=1   pnpm test:native   # 分类、搜索、音乐、视频：真实播放、画质、续播
```

`SERIOUS_SMOKE_MEDIA=1` 会起一个本地夹具站点（`scripts/fixture-server.mjs`），提供带
`<audio>` / `<video>` / 字幕轨道的页面、多分类源和搜索结果页，让**打包后的程序**能真正跑起来 ——
浏览器里的测试证明不了 Tauri IPC 和打包后的 CSS。

> 这一层不是冗余。上一轮就是靠它抓到两个躲过全部浏览器测试的缺陷：旧格式的
> `ruleArticles: "body"` 把 101 条链接压成 1 条「文章」，以及切换源时界面停留在上一个源。
> 本轮又抓到睡眠菜单在深色下是白底 —— 根因是 `var(--panel, #fff)` 的回退值生效，
> 而这个缺陷在浏览器里看不出来（打包应用有自己的 CSS 加载顺序）。

另有 `node scripts/gate-verify.mjs`，专门在**打包后的 exe** 里核对主题变量解析结果与空状态
（断言 `--panel` 解析成深色而非 `#fff`、空闲时没有残留 spinner），同样是量 computed 值、不看截图。

产物写在 `test-results/`（已 gitignore）。

> **低完整性会话的注意事项**
>
> 如果构建产物位于低完整性（Low integrity）级别，WebView2 无法写入默认的用户数据目录，
> 窗口创建会失败并报 `拒绝访问 (os error 5)`。两种处理方式：
>
> ```powershell
> icacls .\src-tauri\target\release\serious.exe /setintegritylevel Medium
> ```
>
> 冒烟测试脚本已经通过 `WEBVIEW2_USER_DATA_FOLDER` 指向临时目录来规避这一点。

### 联网集成测试

单元测试只证明引擎能处理我们自己写下的规则形态；这些测试用真实站点验证它们确实能用：

```bash
cd src-tauri
cargo test --test live -- --ignored --nocapture        # 合集导入、列表解析
cargo test --test live_rules -- --ignored --nocapture   # 真实规则、模板、JS、XPath、源校验
```

> 部分源在特定网络下不可达（DNS 被污染或站点已关闭），测试只断言「至少一个源能产出内容」。

## 项目结构

```
src-tauri/src/
  engine/          规则引擎（核心）
    selector.rs    规则编译 + HTML/JSON 选择器求值
    template.rs    {{}} 模板与 ## 正则替换
    js.rs          Boa 沙箱与 Legado JS 桥接
    fetch.rs       HTTP、请求头、按源隔离的 Cookie
    browse.rs      列表分页、正文抽取、媒体识别、音频识别
    verify.rs      分阶段源校验、看门狗、并发校验池
  model.rs         源结构、两种 JSON 格式的归一化
  repo.rs          源仓库合集抓取
  store.rs         本地持久化（源、历史、阅读进度、设置）
  reading_stats.rs 阅读统计（今日/本周/全部，单篇时长封顶 30 分钟）
  commands.rs      Tauri 命令层（含 continue_reading 的筛选阈值）
src/               React 前端
tests/             联网集成测试（默认跳过）
```

## 已知限制

- HLS (`.m3u8`) 由内置 hls.js 播放，不再需要外部播放器；直播流未做鉴权与 DRM 支持
- 规则里用到的 `@js` 若依赖 Legado 独有的 Java API，只覆盖了常见的一小部分
- **部分依赖 JS 渲染的源仍需改规则** —— 打开渲染兜底能在 16 个这类源里救回 2 个（见下），
  但「有条目、点进去是空页面」的那类救不了，那是规则与渲染后的 DOM 对不上
- **阅读统计的时长是推断值**，不是精确计时：来源是进度更新时间差，单篇封顶 30 分钟

### 源可用率实测

`cargo test --test source_audit -- --ignored --nocapture` 会分两步跑：先并发探测每个源**这台机器能不能打开**，再只对能打开的源做完整体检。

这样做的原因：任意一批源里都有一半左右是域名失效、DNS 被污染或地区限制的，而**这个比例每次跑都在变**。把它混进分母，真实改进会被噪声淹没 —— 上一轮就因为这个差点把一次零效果改动说成「大幅提升」。

所以「可用率」只统计**本机能打开的源**，那才是引擎能力的体现。

对合集 160 抽 150 个（一批跑完、期间工作树未变动的完整结果）：

```
collection …/id/160.json carries 176 source(s)
phase 1: 113 of 150 reachable from this machine in 58.5s (6 threads)
verified 113 reachable source(s) in 18.1s with 6 worker(s)
  degraded       1  (1%)
  rule-broken   13  (12%)
  working       99  (88%)
  (113 verified, 113 bucketed — every source has a verdict)
  ENGINE PASS RATE: 99/113 reachable = 88%  (14 not handled)
    work without a browser      1
    declare enableJs            111
    single-page (rule=body)     74
```

**「113 可达 / 99 可用 = 88%」。** 四个桶之和正好等于可达数（1+13+99=113），没有「算了分母却没进任何桶」的源 ——
审计工具现在会自己核对并打印 `every source has a verdict`，对不上时直接打出 `NO-VERDICT WARNING` 并声明下面所有比率都是临时的。

> **合集会漂移，旧的对比数字已经作废。** 上一版文档写的是「最大的合集（2524 个源）」，
> 而**合集 163 现在只返回 9 个源**（当时是 2524）。拿 163 的旧数字和今天任何一批比较都是错的，
> 所以这里不再引用它。可达数本身也会随网络在几十的量级上浮动，因此**只有同批受控对照的数字才有可比性**。

这批源的样子很说明问题：

| | 数量 |
| --- | --- |
| 本机能打开的源 | 113 |
| 其中声明 `enableJs` | **111** |
| 其中**不需要浏览器**就能用 | **1** |
| 单页源（`ruleArticles=body`） | **74** |

**88% 不等于「引擎解决了 88%」。** 这一批里 **74/113 是单页源**（`ruleArticles=body`），
高分主要来自「单页源处理」和「链接回退」两条兜底，而不是把规则写对了。
另一批（合集 77）单页源只有 12 个，通过率就低得多 —— **通过率跟着源的构成走，不跟着引擎能力走。**

### 渲染引擎这条路走不走得通?——已经实测过了

结论:**走得通。**

`cargo test` 里那个尖刺([render_probe.rs](src-tauri/src/render_probe.rs),只由原生冒烟测试调用)
会建一个离屏窗口、加载一个 URL、把渲染后的 DOM 取回来:

```
render_probe: loaded=true html=974 links=6 title="脚本渲染页"
```

夹具页 `/rendered.html` 的列表**完全由 JavaScript 生成** —— 服务出去的 HTML 里 `<ul id="list">` 是空的。
取回来却有 974 字符、6 个链接,说明脚本确实跑过了。

关键在于用哪个 API:

| API | 能否拿回结果 |
| --- | --- |
| `WebviewWindow::eval(js)` | **不能** —— 返回 `Result<(), Error>`,结果被丢掉 |
| `WebviewWindow::eval_with_callback(js, cb)` | **能** —— 通过 Rust 闭包把字符串送回来 |

所以这条路的技术障碍不存在。代价是:每次渲染要开一个离屏窗口(约 2.5 秒),需要串行化、超时清理,
并且要为拒绝加载的站点准备降级。

要不要做仍然是个取舍 —— 它会让整个后端多出一条「取页面」的路径。

**现在这条路径已经接上了,作为兜底,而且默认关闭。**

触发条件全部满足才渲染:源声明了 `enableJs`、用户打开了开关、抓到的页面不是空的,而且**只有在解析不出
任何可打开的条目时**才触发 —— 包括「整页源」那种只产出一个没有地址的条目的情况,因为脚本构建的页面
在渲染前正是这个样子。渲染结果优先采用;渲染失败或仍然打不开就退回原结果,不会让用户看到空屏。

离屏窗口是**串行**的(互斥锁),同一次渲染的结果**缓存 2 分钟**。

> `eval_with_callback` 返回的是 **JSON 编码后的值**:字符串带引号、`<` 写成 `<`。
> 直接当 HTML 喂给解析器会得到一个「什么都没有」的页面,而且不报任何错 —— 这个坑踩过一次。

### 「实测零收益」这个结论是错的 —— 它测在了一条不会调用渲染器的路径上

早前这里写过:「拿到 14 个真实源做开关对照,结果完全一样」。

**这个对比在结构上不可能测出任何东西。** 那一遍是用 `check_all` 跑的,而 `verify::probe_list`
(`engine/verify.rs`) 直接 `fetch_ok` + `parse_list`,**从不查 `should_render`**;全仓唯一的渲染调用点在
`browse.rs:666` 的 `load_page` —— 读者真正打开列表的那条路径。
所以在审计路径上,`render_js` 是个**恒为 0 的常量**,开与不开必然一样。

**这不是「渲染没用」的证据,是无效测量。该结论撤回。**

### 重新量:读者路径上到底有没有收益

`node scripts/render-ab.mjs` 对 **16 个脚本构建、且不开渲染就取不到条目的真实源**做受控对照:
同一个应用实例、同一批导入、每遍之前清空缓存、顺序固定 **off → on → off**(两遍 off 用来暴露站点漂移)。

两个独立跑批的结果:

```
engine 那遍:  off 0 working · on 2 working · off 0 working     → 净 +2
我这遍:       off 1 working · on 2 working · off 0 working     → 净 +1
```

两遍的 on 都是 2,而且**是同样两个**:`box+apk 蓝奏直链√`、`黑料社区`。

把每一遍的 working 名单摊开对比,结论就闭合了:

| | pass 1 (off) | pass 2 (on) | pass 3 (off) |
| --- | --- | --- | --- |
| `box+apk 蓝奏直链√` | — | **working** | — |
| `黑料社区` | — | **working** | — |
| `影视森林` | **working** | — | — |

- `box+apk` 和 `黑料社区` **在两遍 off 里从未出现、在 on 遍出现** → **渲染稳定救回了它们**。
- `影视森林` 在 **pass 1(渲染是关的)** 就是 working → **它那次成功与渲染无关**。
  单独再跑它五遍 off(`SERIOUS_AB_NAMES=影视森林`),**五遍全是 0 working**,进一步证明它是个
  间歇性源,不是渲染的功劳。

所以诚实的说法是:**稳定增益 = 2 / 16(12.5%),外加 1 个与渲染无关的间歇源。**
单遍净增益会在 **1–2 之间浮动**,取决于 `影视森林` 那天有没有恰巧成功 ——
engine 那遍两遍 off 都是 0(净 +2),我这遍 off 是 1 和 0(净 +1)。
两个数字都真实,合起来才是完整的噪声画像。**所以这里不写「12.5%」这个干净数**,
免得把噪声藏起来。

### 所以仍然默认关闭 —— 但理由换了

不是「测出没用」,而是**收益确实存在、但只覆盖 16 个源里的 2 个,不值得让所有用户为每个解析失败的页面付费**。

| | |
| --- | --- |
| 触发条件 | 一次列表抓取里,**普通解析拿不到任何可打开条目** **且** 源声明 `enableJs` |
| 代价 | 离屏窗口 + 固定 2.5 秒 settle,读 DOM 最多 8 秒 |
| 缓存 | 同 URL 缓存 120 秒,最多 8 条 |
| 开关 | 默认**关**,在设置里 |

只有「解析不出条目」才渲染,正常解析的源一秒都不多花。

> **渲染解决不了什么**:它只救「拿不到条目」。有条目、点进去却是空页面的源,渲染救不了 ——
> 那属于规则与渲染后的 DOM 对不上,是另一类问题。

剩下 14 个仍然失败的,原因分类:脚本没生成链接 5 个、规则与渲染后 DOM 对不上 8 个、传输层/限流 1 个。
**有收益不等于够用。**

### 默认值曾经不一致 —— 用户没同意就花掉他 2 秒

`RENDER_ENABLED` 的代码默认值原本是 `true`,而 `Settings::render_js` 是 `false`,**两者相反**。
后果:用户偏好生效之前走到验证的那条路径,会在**用户没有同意**的情况下走昂贵分支。
已改为 `false`,并补了测试 `the_engine_default_matches_the_stored_preference`,
断言的是**两个默认值必须相等** —— 以后改一边忘了另一边,测试立刻失败。

### 测量时踩过的坑:别用 `Select-Object -First` 读测试输出

用 `cargo test … | Select-String … | Select-Object -First 12` 读审计结果时,
**`-First N` 会掐断上游管道,测试进程在汇总打印之后、断言执行之前被杀**。
汇总是在断言之前打印的,所以被掐断的那一遍照样给你一份**看起来完整的漂亮报告**。

> 本轮就中过两次招:一次让合集 77 出现「37 可达但只有 36 个有结论」的假象,
> 一次让合集 160 出现分母对不上的数字。**正确做法:输出落文件,再看尾部有没有 `test result: ok`。**
> 审计工具现在也会自己核对「四桶之和 == 可达数」,对不上就打出 `NO-VERDICT WARNING` 并声明所有比率都是临时的。

### 规则失效时的链接回退

列表规则匹配不到任何条目(**或者条目根本没有地址**)时,应用会再试一次:把页面自己的链接当列表展示。
很多站点只是用脚本做交互和懒加载,**内容链接本身仍在 HTML 里**。

加入这条回退之前,可达源可用率是 28%;之后是 48%。

只有页面里能提取出 3 条以上链接时才回退,否则保持「无内容」,避免把导航栏当成内容。

### 没有正文规则时的降级

源没有 `ruleContent`、页面也没有常见内容容器时,最后一步是「整页当正文」。这时会先去掉
`script` `style` `nav` `header` `footer` `aside` `form` 等页面框架元素再转纯文本 —— 否则读者要滚过
菜单、页脚和一堆内联脚本。实测一个页面从 7689 字降到 4786 字。

若去掉框架后几乎不剩内容(本身就是纯导航页),会退回未去框架的原文,而不是显示空白。

### `ruleArticles: "body"` 的陷阱

旧格式合集里,**只要源没有 `articleUrl`,就会被填上 `ruleArticles: "body"`** —— 这是 Legado 的
「整页源」约定。但如果页面其实是一堆链接(导航页、发布页、书签站),这会把 100 条链接压成
**一条**「文章」,正文还是整页 HTML,连 `<script>` 都在里面。

### 规则引擎支持的 Legado 语法

`text.<内容>` —— 按可见文字定位元素。用在「一键导入」这类按钮上：

```
text.一键导入@onclick
```

优先精确匹配，找不到才退回「包含」，并且只保留**最深的**匹配 —— 否则会返回包着按钮的整个
列表项，而不是按钮本身。

取到的链接还会过一道合理性检查：`importApp(1)`、`javascript:void(0)`、带空格或括号的片段
不会被当成地址。校验报告会直接说「链接规则「text.一键导入@onclick」没有取到地址」，而不是笼统
地怪罪网站。

## 内容说明

源仓库中的合集包含大量成人内容，应用按你的要求**不做任何过滤**，原样呈现。
所有内容来自第三方站点，仅供学习交流使用，请遵守当地法律法规。
