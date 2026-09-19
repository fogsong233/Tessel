# Tessel

[English](README.md) | [简体中文](README.zh-CN.md)

Tessel is a local-first PDF reader for focused reading, contextual AI conversations, translations, notes, and page workspaces.

## Features

- **Contextual reading** — select a passage, quote it into a conversation, translate it, or turn it into a note.
- **Persistent PDF workspace** — reading progress, bookmarks, highlights, conversations, translations, notes, and pinned items stay attached to the PDF content hash.
- **Codex integration** — optionally use a locally installed Codex CLI for chat, translation, document search, local tools, images, and LaTeX output.
- **OpenAI-compatible providers** — route chat, translation, and generated outlines through an OpenAI-compatible API when preferred.
- **Page whiteboards** — place pressure-aware vector canvases beside PDF pages with pens, colors, undo, and lasso selection.
- **Tablet handwriting over LAN** — open the whiteboard link from Settings on a tablet. Write with a stylus, scroll continuously with one finger, and zoom with two fingers. Brush and finger-writing preferences carry across sheets.
- **Local-first storage** — PDF files remain in their original locations; Tessel stores metadata and derived content in Electron's `userData` directory.
- **Optional WebDAV sync** — synchronize reading progress, conversations, notes, and translations across devices.
- **Desktop releases** — installers are published for Windows and macOS through [GitHub Releases](https://github.com/fogsong233/Tessel/releases).

## Download

Download the latest installer from the [latest release](https://github.com/fogsong233/Tessel/releases/latest).

Windows releases support in-app update checks and installation. Unsigned macOS builds are updated manually: download the latest DMG or ZIP and replace the existing application.

## Run from source

Requirements: Node.js 22 and pnpm 11.

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

## AI providers

Tessel can use an OpenAI-compatible provider configured in Settings. API keys are protected with Electron `safeStorage` when the platform provides it.

The optional Codex integration requires a locally installed and authenticated `codex` CLI. If Codex is unavailable, the PDF reader and provider-based features remain usable.

Codex chat and translation reuse a background process. Translation uses a compact text-only context and a fast available model unless configured otherwise. Built-in PDF tools reuse parsed documents and page text; CLI compatibility mode receives the same tools through a temporary local MCP connection, without requiring `pdftotext`. File citations, local images, fenced code, and LaTeX render directly in messages.

## Data and privacy

Tessel stores its workspace in Electron's `userData` directory. It contains PDF metadata, reading state, conversations, translations, notes, pins, and preferences. PDF files themselves remain in their original locations. Optional WebDAV sync is disabled until configured by the user.

See [Release Notes](docs/releases/v1.5.2.md) for the current release details.
