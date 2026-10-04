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
| 分类目录 | 自动解析源的 `sortUrl`，渲染成分类标签页（如「国产 / 欧美 / 福利」） |
| 文章列表 | 按源规则解析列表，支持分页与无限滚动 |
| 视频播放 | HLS (`.m3u8`) 在 Windows 上也能播 —— 内置 hls.js，Safari 走原生；多码率可切画质、可调倍速 |
| 阅读器 | 视频源 → 播放器；图集 → 可缩放画廊；音乐 → 队列式播放器；其他 → 原文或纯文本 |
| 阅读设置 | 字号、行距、字体、背景（夜间/白日/羊皮/护眼）、版心宽度，改完立即生效并记住 |
| 阅读进度 | 记住每篇文章读到哪儿，重开自动回到原处 |
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

### 验证

```bash
pnpm dev            # 另开一个终端
pnpm test:reader    # Playwright 驱动真实浏览器
```

断言：字号确实变大变小且不低于 13px、行距确实变、羊皮主题背景确实换了、点外面能关掉浮层、
滚动后阅读进度确实被测量到。

## 视频播放

`.m3u8` 是这类源最常见的视频格式,而 Chromium/WebView2 **原生不支持** —— 之前的播放器只能显示一句
「请在系统播放器或 VLC 中打开」,等于功能不存在。现在：

- Safari / iOS 走浏览器原生 HLS；其余平台由 [hls.js](https://github.com/video-dev/hls.js) 经
  Media Source Extensions 喂给同一个 `<video>` 元素

  > **为什么不问浏览器「你支持 HLS 吗」**：Edge 对 `canPlayType("application/vnd.apple.mpegurl")`
  > 返回 `"maybe"`，但实际解不了流。信这个返回值会让所有 Windows 用户点开就是黑屏。
  > 所以只要 hls.js 能用就走 hls.js，只在缺少 Media Source Extensions 时才把地址交给元素本身
  > （那条路恰好就是 Safari 的原生路径）。
- 从主播放列表解析出每个码率，**可手动切换 / 自动选择**
- 倍速 0.75× – 2×
- 快捷键：`空格` / `k` 播放暂停、`←/→` ±10 秒、`f` 全屏
- **续播**：记住看到的位置，重开时提示「上次看到 6:24」，可选继续播放或从头开始
- 失败分级处理：网络错误自动重试、解码错误自动恢复、其余给出明确原因 —— 不再一律甩锅给 VLC

播放控制条用浏览器原生的（无障碍、可访问性更好），画质/倍速/全屏放在覆盖层。

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
position stored as 50% of the runtime
after reload the player offers: 上次看到 0:06
"继续播放" jumped from 0s to 6s
"从头开始" cleared the stored position
```

`readyState 4` 表示分片已完整解码，**是真的在播**。

> 未能验证的：真实直播流的解码 —— 需要能访问外网的机器。这里验证的是清单解析、画质切换、
> 倍速写入和分片播放本身。

## 音乐播放

包含 `.mp3` / `.flac` / `.m4a` / `.aac` / `.wav` / `.ogg` / `.opus` 的条目会被识别为音乐，
直接进入播放器而不是当成文章。播放器是队列式的：

- 一页里所有 `<audio>` 会被收集成播放列表，标题取自对应链接文字
- 上一首 / 下一首 / 队列点选 / 进度拖动 / 音量 / 静音
- 随机播放、单曲循环、列表循环
- 快捷键：`空格` 播放暂停、`Ctrl + ←/→` 切歌、`←/→` 快退快进 5 秒、`↑/↓` 音量
- 播完自动进入下一首；不循环的列表播到末尾会停下而不是悄悄回绕

判定只看**链接路径和标题**，不看域名 —— 否则托管在 `music.x.com` 的源会把它的视频全判成音乐。

### 验证

播放器不靠肉眼验收，用真实音频文件在真实浏览器里驱动：

```bash
pnpm demo:audio     # 生成 public/demo/*.wav 测试音频
pnpm dev            # 另开一个终端
pnpm test:music     # Playwright 跑真实播放行为
```

断言覆盖：播放位置真的在走、进度条跟着动、上一首/下一首切换、点队列跳转、空格暂停、
音量确实写到了 `<audio>` 元素上。

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
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设的密码（本项目为空，留空即可） |

   > ⚠️ **私钥绝对不要提交到 Git。** `.gitignore` 已经排除了 `*.key`，但请确认没有手动添加过。
   > 私钥一旦丢失，就再也无法为后续版本签名，更新会永久失效。

3. **发布** — 推送一个 tag：

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

   GitHub Actions 会自动为 macOS（ARM + Intel）和 Windows 构建、签名并创建 Release 草稿。
   检查无误后在 Releases 页面点 **Publish** 即可对外发布。

   > Release 默认建为草稿（`releaseDraft: true`），确认产物完整再发布。

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
cargo test --lib      # 62 个单元测试，不联网
cargo clippy --all-targets
```

### 原生窗口冒烟测试

用 Playwright 通过 WebView2 的 CDP 端口驱动**真实窗口**，截图并断言界面与 IPC：

```bash
pnpm build && cargo build --release --features custom-protocol   # src-tauri/
pnpm test:native           # 渲染检查 + 后端命令
SERIOUS_SMOKE_NETWORK=1 pnpm test:native   # 额外导入真实合集并浏览
```

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
  commands.rs      Tauri 命令层
src/               React 前端
tests/             联网集成测试（默认跳过）
```

## 已知限制

- HLS (`.m3u8`) 由内置 hls.js 播放，不再需要外部播放器；直播流未做鉴权与 DRM 支持
- 规则里用到的 `@js` 若依赖 Legado 独有的 Java API，只覆盖了常见的一小部分
- 部分站点依赖 JS 渲染页面，服务端拿不到内容；这类源无法解析（见下）

### 源可用率实测

`cargo test --test source_audit -- --ignored --nocapture` 会拉取一个合集并逐个体检，把失败分成
**网络不可达**和**规则失配**两类。后者才是能靠代码改善的部分。

对最大的合集（2524 个源）抽 60 个的结果：

| 分类 | 数量 | 说明 |
| --- | --- | --- |
| 网络不可达 | 31 (52%) | 取决于运行机器的网络，不代表源已失效 |
| 站点可达但取不到内容 | 14 (23%) | **几乎全部是 JS 渲染页面** |
| 站点返回 4xx/5xx | 7 (12%) | 需要登录或已限流 |
| 可用 | 8 (13%) | 可达源中约 28% |

抽样中 **39/60 个源声明了 `enableJs`**。真正的瓶颈不是选择器写错，而是这些站点用脚本生成内容，
纯服务端解析原理上就拿不到 —— 这是架构限制，不是规则 bug。校验报告会明确区分这两者。

## 内容说明

源仓库中的合集包含大量成人内容，应用按你的要求**不做任何过滤**，原样呈现。
所有内容来自第三方站点，仅供学习交流使用，请遵守当地法律法规。
