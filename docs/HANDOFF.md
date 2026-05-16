# Sidelight Handoff

Last updated: 2026-05-16

This document captures the working context for continuing Sidelight on another
machine.

## Product Goal

Sidelight is a local-first, LLM-assisted PDF reader built with Electron, React,
TypeScript, and PDF.js.

The intended experience:

- A Zotero-like library home for managing PDFs and, later, webpages.
- Opening a PDF creates a separate reader window. One reader window per PDF.
- Basic PDF reading must feel smooth, clean, and reliable.
- The user can select text in a PDF and open an AI chat grounded in that
  selection.
- Chat conversations are permanently saved and attached to the PDF page and
  selected context.
- Summary and Translate are temporary reading aids. They are not persisted.
- Explain is not a separate tool. Explanation should happen through Chat.
- The right side of the reader shows page conversations and reading aids on top
  of the PDF reading background, not as a hard separated app sidebar.
- The PDF scrollbar should remain at the far right of the window.
- The left outline/library sidebar can be hidden and restored.
- Zoom is driven by mouse wheel with Ctrl/Cmd, not by a visible zoom widget.

## UX Preferences

The user is sensitive to UI quality. Avoid rough custom controls when a polished
PrimeReact or lucide-based component is available.

Design direction:

- Minimal, calm, document-reader feel.
- Chat should feel closer to ChatGPT: a transcript, scoped Markdown prose,
  readable assistant content, compact user bubbles, and a bottom composer.
- Avoid card-on-card layouts and oversized decorative elements.
- Right dock controls should be grouped. Do not use an invisible spacer that
  pushes the `+` button far away from the rest of the toolbar.
- Text must not overlap PDF content or adjacent panels.
- Summary and Translate belong in the right dock area, not centered over the PDF.

## Current Implementation

Important files:

- `src/main/index.ts`
  - Electron window creation.
  - IPC registration.
  - One reader window per PDF through `documentId`.
  - AI stream handling with safe abort when the renderer frame closes.
  - Chromium HTTP disk cache disabled and cache directories cleared on startup.
- `src/main/aiService.ts`
  - OpenAI-compatible chat completion and streaming.
  - Local draft mode when no API key is configured.
  - Stream cancellation via `AbortSignal`.
- `src/main/store.ts`
  - JSON workspace repository.
  - Stores PDFs, marks, bookmarks, conversations, notes, reading state, and AI
    provider settings.
- `src/renderer/src/App.tsx`
  - App state orchestration.
  - Persistent Chat flow.
  - Temporary Summary/Translate flow.
- `src/renderer/src/PdfReader.tsx`
  - PDF.js viewer.
  - Left sidebar, PDF viewport, selection toolbar, marks, right dock, chat panel.
  - Right dock can show chat, temporary reading aid, chat list, notes, bookmarks,
    or marks.
  - PDF auto-shrinks when the dock takes reading space so text does not sit under
    panels.
- `src/renderer/src/MarkdownView.tsx`
  - Markdown rendering with GFM, math, and KaTeX.
  - Normalizes LLM-style `\(...\)` and `\[...\]` delimiters to Markdown math.
  - Skips code spans and fenced code when normalizing LaTeX delimiters.
- `src/renderer/src/styles.css`
  - Main styling. There are late overrides near the end of the file for the final
    reader/dock/chat polish.
- `tests/e2e/sidelight.spec.ts`
  - Playwright Electron integration tests.

## Recent Fixes

PDF rendering:

- Fixed blank PDF rendering. PDF.js `PDFViewer` needs `.pdf-viewport` to remain
  absolutely positioned.
- Added e2e checks that PDF text and canvas render.

Reader layout:

- PDF scrollbar remains at the far right.
- Right dock lives in the gray reading background area.
- Chat/Summary/Translate no longer appear in the middle of the PDF page.
- PDF content auto-shrinks when the right dock is active, preventing overlap.
- Left sidebar can be hidden/restored.

Zoom:

- Ctrl/Cmd + wheel zooms the PDF.
- Tests verify first page width changes after Ctrl-wheel.

AI modes:

- Chat is persisted.
- Summary and Translate stream into temporary panels and are not saved.
- Explain was removed as a separate selection action.

Chat:

- Chat panel was restyled toward a ChatGPT-like transcript.
- Markdown prose, blockquotes, headings, lists, code, and KaTeX have scoped
  styles inside the dock.
- Composer uses lucide/PrimeReact controls.

LaTeX:

- `remark-math`, `rehype-katex`, and `katex/dist/katex.min.css` are wired.
- `MarkdownView` now supports `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`.
- E2E asserts that chat output creates `.katex` nodes.

Stream crash:

- Fixed crash/log spam when a reader window closed during AI streaming.
- Main process now aborts the stream if `webContents` is destroyed or renderer
  process is gone.
- Catch paths no longer try to send error chunks into a disposed frame.

Chromium cache logs:

- Disabled Electron HTTP cache with `app.commandLine.appendSwitch('disable-http-cache')`.
- Startup clears only Chromium cache directories:
  - `Cache`
  - `Code Cache`
  - `GPUCache`
  - `DawnCache`
  - `blob_storage`
  - `Shared Dictionary`
- Workspace data is not cleared.

## Tests

Run:

```powershell
pnpm install
pnpm typecheck
pnpm test:e2e
```

Current e2e coverage:

- Opens a PDF from library into a reader window.
- Verifies PDF text layer and canvas render.
- Hides/restores the left sidebar.
- Ctrl-wheel zoom increases page width.
- Summary and Translation are temporary and not persisted.
- Chat is persisted.
- Chat LaTeX renders through KaTeX.
- Right dock panels stay inside the dock.
- PDF page does not sit under the dock.
- AI stream stops cleanly when reader window closes.

Expected build warnings:

- `pdfjs-dist` uses `eval`; Vite warns about it.
- `images/altText_add.svg` and `images/altText_done.svg` from PDF.js may remain
  unresolved at build time.

These warnings are currently non-blocking.

## Running The App

Development:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm dev
```

Production build/test:

```powershell
pnpm build
pnpm test:e2e
```

If old logs keep appearing, stop all old Electron/Sidelight processes first.
Old `out/main/index.js` processes will not pick up source changes until rebuilt
and restarted.

## Storage And Sync Direction

Current storage is JSON in Electron `userData`:

- `workspace/library.json`

The eventual user plan is that all important data lives in one folder that can be
synced with a private GitHub repository. PDFs may be optionally synced later, but
notes, conversations, metadata, and provider configuration should be syncable.

Keep storage boundaries clean so the JSON store can later move to SQLite + FTS
or a Git-friendly file layout.

## Important Caveats

- The worktree may appear fully untracked if this project was initialized outside
  Git tracking. Do not assume `git diff` is meaningful until files are added.
- Do not delete or reset user changes.
- Avoid large unrelated style rewrites in `styles.css`; it already has many late
  overrides.
- When touching PDF layout, preserve:
  - `.pdf-viewport { position: absolute; }`
  - PDF scrollbar at the far right
  - `.pdfViewer { width: calc(100% - var(--dock-lane-width)); }`
- When touching AI streaming, preserve safe abort behavior for closed renderer
  frames.

## Suggested Next Work

- Add a focused visual regression screenshot test for right dock states.
- Continue UI polish for:
  - chat list item density
  - bookmark/mark panels
  - composer focus/disabled states
  - long Chinese/English mixed Markdown content
- Add real search over saved conversations and notes later, but the current
  per-page chat list intentionally has no search box.
- Add better conversation auto-summary after chat close.
- Consider a more structured storage format before Git sync becomes central.
