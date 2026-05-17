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
- `docs/LEARNING_SPACE_PLAN.md`
  - Product and implementation plan for evolving the reader into a spatial
    learning canvas.

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
- Chat supports image attachments from the file picker, drag/drop, and pasted
  clipboard images. User messages persist image attachments and AI requests send
  them as OpenAI-compatible `image_url` content blocks.

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
- Chat image attachments show a composer preview, render in the transcript, and
  are included in local draft / provider requests.
- Chat LaTeX renders through KaTeX.
- Right dock panels stay inside the dock.
- PDF page does not sit under the dock.
- AI stream stops cleanly when reader window closes.
- AI stream stop from the composer persists a non-empty stopped/partial
  assistant message.

Learning space:

- The workspace store now has durable `WorkspaceBlock` records.
- A chat can be pinned from the chat header into the PDF canvas.
- Pinned conversation blocks sit beside the page and move with the continuous
  PDF canvas.
- Pinned blocks avoid the open dock by default, can be dragged/resized on the
  horizontal canvas, and persist `x`, `y`, and `width`.
- E2E checks that pinned block controls are not occluded and that block content
  does not overflow after drag/resize.
- Notes can be pinned from the notes list or note editor. Pinned note blocks use
  `kind: note`; clicking one reopens its note editor.
- E2E covers note block persistence, no-overflow rendering, and click-to-open.
- The dock `+` action is context-aware: it creates a page chat from chat mode
  and a current-page note from notes mode.
- Pinning a block horizontally reveals it in the canvas without forcing the PDF
  back to the top of the page. New blocks default near the current vertical
  reading position rather than the page start.
- Workspace blocks are absolute-positioned, so `.workspace-canvas-spacer`
  intentionally contributes horizontal scroll width. Keep it when changing the
  canvas; otherwise pinned blocks can save correctly but remain unreachable or
  invisible.
- Pin placement follows the current PDF page, not the source page of the open
  chat/note. Example: if a p.1 chat is open while the reader is on p.2, pinning
  places the card beside p.2.
- New chat/note pins now default to the left side of the PDF page. The canvas
  reserves a stable left gutter once any left-side pin exists, so dragging a
  pinned card changes its visible position instead of being cancelled out by
  shrinking padding.
- Pinned cards use a short `workspace-block-pop` mount animation and a larger
  top drag hit area. New pins are placed through an overlap-avoidance pass, and
  e2e checks multiple note cards do not stack on top of each other.
- Search results for notes and Q&A now have their own pin action, so cross-page
  items found through search can be attached to the current PDF page without
  first opening the dock editor/chat.
- Keep the PDF loader effect independent of `workspaceBlocks`. A previous
  version depended on `updateWorkspaceBlockLayouts`, which depended on
  `workspaceBlocks`, so every pin caused the PDF.js document to be destroyed and
  reloaded.
- Note pinning must save sequentially. Saving the note and the workspace block
  concurrently can race in the JSON store and drop the newly pinned block.

AI stream stop:

- Stopping a stream records the stopped stream id in the renderer so a missing
  final cancelled event still saves either the partial assistant text or
  `Response stopped.` / `已停止回答。`.

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
