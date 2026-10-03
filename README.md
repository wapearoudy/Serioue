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
| 阅读器 | 视频源 → HTML5 播放器；图集 → 可缩放画廊；其他 → 原文或纯文本 |
| 源健康检测 | 批量检测哪些源还能用，避免一个个点开试错 |
| 收藏 / 历史 / 搜索 | 常用源收藏、阅读历史回溯、单源内搜索 |
| 跨平台 | macOS（Apple Silicon + Intel）与 Windows |

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
cargo test --test live_rules -- --ignored --nocapture   # 真实规则、模板、JS、XPath
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
    browse.rs      列表分页、正文抽取、媒体识别
  model.rs         源结构、两种 JSON 格式的归一化
  repo.rs          源仓库合集抓取
  store.rs         本地持久化
  commands.rs      Tauri 命令层
src/               React 前端
tests/             联网集成测试（默认跳过）
```

## 已知限制

- HLS (`.m3u8`) 只有 Safari 原生支持，Windows/Linux 上会提示改用外部播放器
- 内置播放器不支持需要鉴权或特殊加密的流
- 规则里用到的 `@js` 若依赖 Legado 独有的 Java API，只覆盖了常见的一小部分
- 部分站点依赖 JS 渲染页面，服务端拿不到内容；这类源无法解析

## 内容说明

源仓库中的合集包含大量成人内容，应用按你的要求**不做任何过滤**，原样呈现。
所有内容来自第三方站点，仅供学习交流使用，请遵守当地法律法规。
