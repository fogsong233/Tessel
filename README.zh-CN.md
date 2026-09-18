# Tessel

[English](README.md) | 简体中文

Tessel 是一款本地优先的 PDF 阅读器，支持专注阅读、上下文 AI 对话、翻译、笔记和页面工作区。

## 功能

- **上下文阅读**：选中一段文字后，可以引用到对话、翻译，或生成笔记。
- **持久化 PDF 工作区**：阅读进度、书签、高亮、对话、翻译、笔记和固定内容会根据 PDF 内容哈希与文档关联。
- **Codex 集成**：可选使用本机 Codex CLI，支持对话、翻译、文档搜索、本地工具、图片和 LaTeX 输出。
- **OpenAI 兼容服务商**：可以使用 OpenAI 兼容 API 处理对话、翻译和 AI 目录生成。
- **页面白板**：在 PDF 页面两侧放置矢量画布，支持压力感应笔刷、颜色、撤销和套索选择。
- **本地优先存储**：PDF 文件保留在原始位置，Tessel 将元数据和衍生内容保存到 Electron 的 `userData` 目录。
- **可选 WebDAV 同步**：在多台设备之间同步阅读进度、对话、笔记和翻译。
- **桌面版发布**：通过 [GitHub Releases](https://github.com/fogsong233/Tessel/releases) 提供 Windows 和 macOS 安装包。

## 下载

请从[最新 Release](https://github.com/fogsong233/Tessel/releases/latest) 下载安装包。

Windows 版本支持应用内检查并安装更新。未签名的 macOS 版本需要手动更新：下载最新 DMG 或 ZIP，替换原有应用即可。

## 从源码运行

环境要求：Node.js 22 和 pnpm 11。

```bash
corepack enable
pnpm install
pnpm dev
```

构建并验证桌面应用：

```bash
pnpm build
pnpm test:e2e
```

如果终端设置了 `ELECTRON_RUN_AS_NODE=1`，请先移除该环境变量再启动 Electron。

## AI 服务

Tessel 可以在设置中配置 OpenAI 兼容服务商。平台支持时，API 密钥会通过 Electron `safeStorage` 保护。

可选的 Codex 集成要求本机已安装并完成认证的 `codex` CLI。即使 Codex 不可用，PDF 阅读器和基于服务商的功能仍可正常使用。

## 数据与隐私

Tessel 将工作区保存在 Electron 的 `userData` 目录中，其中包含 PDF 元数据、阅读状态、对话、翻译、笔记、固定内容和偏好设置。PDF 文件本身始终保留在原始位置。WebDAV 同步只有在用户配置后才会启用。

当前版本详情请查看[发布日志](docs/releases/v1.5.1.md)。
