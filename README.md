<p align="center">
  <img src="src/assets/icons/tessel-logo.png" width="112" alt="Tessel logo" />
</p>

<h1 align="center">Tessel</h1>

<p align="center">
  A focused, local-first PDF reader with contextual AI conversations.<br />
  专注、本地优先的 PDF 阅读器，让 AI 对话始终贴合你的阅读位置。
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a>
</p>

---

<a id="english"></a>

## Read with context

Tessel opens directly into a PDF. Select a passage, ask a question, translate it, or turn it into a note. Conversations, citations, pins, notes, and reading progress stay connected to the document by its content hash, not its filename.

### Highlights

- **Direct PDF workflow**: open a file and start reading, with vector PDF.js rendering and persistent page state.
- **Contextual conversations**: quote a selected passage into chat without sending it, then ask in your own words.
- **Codex sidebar**: an experimental local Codex CLI integration for chat, translation, document search, local tools, images, and LaTeX output.
- **Flexible AI routing**: choose Codex or an OpenAI-compatible API for chat, translation, and generated outlines.
- **Working memory**: pin conversations, translations, notes, and images alongside the PDF; reopen recent translations at any time.
- **Your data stays yours**: document metadata is keyed by the SHA-256 hash of the PDF. Optional WebDAV sync preserves progress and conversations across devices.
- **Desktop native**: Electron builds for macOS and Windows, GitHub Release updates, and platform-specific application icons.

### Run from source

```bash
corepack enable
pnpm install
pnpm dev
```

Build and verify the desktop application:

```bash
pnpm build
pnpm test:e2e
```

If the shell has `ELECTRON_RUN_AS_NODE=1`, remove it before starting Electron.

### Data and privacy

Tessel stores its workspace in Electron's `userData` directory. It contains PDF metadata, reading state, conversations, notes, pins, and preferences. API keys use Electron `safeStorage` where the platform provides it. PDF files themselves remain in their original locations.

The experimental Codex integration requires a locally installed and authenticated `codex` CLI. When it is unavailable, the rest of the reader remains fully usable.

---

<a id="中文"></a>

## 带着上下文阅读

Tessel 打开后直接进入 PDF。选中一段文字后，可以提问、翻译或生成笔记；对话、引用、Pin、笔记和阅读进度都会按 PDF 内容哈希关联，而不是依赖文件名。

### 主要功能

- **直接阅读**：打开 PDF 后立即开始阅读，使用 PDF.js 矢量渲染并保存页码与视图状态。
- **上下文对话**：选中的段落会先作为引用放入输入框，由你决定如何提问和发送。
- **Codex 侧边栏**：实验性本地 Codex CLI 集成，支持对话、翻译、文档搜索、本地工具、图文与 LaTeX 输出。
- **统一 AI 路由**：对话、翻译和 AI 目录可在 Codex 与 OpenAI 兼容 API 之间选择。
- **阅读工作台**：将对话、翻译、笔记和图片 Pin 在 PDF 旁；最近翻译可随时重新打开。
- **数据归你所有**：每份 PDF 使用 SHA-256 内容哈希保存元数据；可选 WebDAV 同步阅读进度与对话。
- **原生桌面应用**：提供 macOS 和 Windows 构建、GitHub Release 自动更新及平台图标。

### 从源码运行

```bash
corepack enable
pnpm install
pnpm dev
```

构建并运行回归测试：

```bash
pnpm build
pnpm test:e2e
```

若终端设置了 `ELECTRON_RUN_AS_NODE=1`，请先移除该环境变量再启动 Electron。

### 数据与隐私

Tessel 将工作区保存在 Electron 的 `userData` 目录中，包含 PDF 元数据、阅读进度、对话、笔记、Pin 和偏好设置。系统支持时，API 密钥通过 Electron `safeStorage` 加密；PDF 文件始终留在原始位置。

实验性 Codex 功能要求本机已安装并登录 `codex` CLI。即使不可用，阅读器的其他功能也不受影响。
