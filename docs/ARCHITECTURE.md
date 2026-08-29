# Tessel Architecture

Last updated: 2026-08-29

## Product Shape

Tessel is a local-first Electron PDF reader. The start window has two jobs:
open a PDF and launch application settings. Opening a PDF creates a dedicated
reader window whose identity is the full SHA-256 digest of the file. Settings
use a singleton window (`?view=settings`) rather than an overlay inside a home
or reader window.

There is no active library or GitHub-workspace flow. Older workspace files may
still contain fields from those removed features; the store tolerates and
preserves unknown JSON fields during normal reads and writes.

## Runtime Boundaries

1. `src/renderer/src/App.tsx`
   - Owns application and document state.
   - Coordinates persistence and AI streams.
   - Chooses the start page or reader from the `documentId` query parameter.
2. `src/renderer/src/PdfReader.tsx`
   - Owns PDF.js rendering, navigation, selection, marks, dock panels, and the
     spatial workspace canvas.
   - Emits persistence and AI intents through typed callbacks.
   - Delegates page-relative zoom geometry to `reader/pdfZoom.ts` and the
     pressure-aware whiteboard UI to `reader/WorkspaceDrawingBlock.tsx`.
3. `src/preload/index.ts`
   - Exposes the narrow `window.sidelight` IPC bridge described by `TesselApi`.
   - Must not expose channels that have no main-process handler.
4. `src/main/index.ts`
   - Creates Electron windows and registers IPC handlers.
   - Serializes every mutation of the JSON workspace.
   - Routes reader AI work to the configured provider or local Codex adapter.
   - Owns the singleton settings window and Windows window-control IPC.
5. `src/main/store.ts`
   - Reads and atomically replaces `userData/workspace/library.json`.
   - Encrypts secrets with Electron `safeStorage` when available.
   - Contains storage normalization and WebDAV snapshot application.

## Document Loading

- `documentIdentity.ts` hashes the complete file and creates `pdf_<sha256>`.
- The main process sends the first 512 KiB with the open result.
- `ElectronPdfRangeTransport` requests later byte ranges through IPC.
- PDF files remain in their original location and are never copied into the
  workspace or uploaded by Tessel.

## AI Routing

`ai:completeReaderStream` is the normal reader entry point.

- When the experimental Codex integration is enabled, `CodexAgent` uses the
  local authenticated Codex CLI and a per-document private workspace.
- Windows discovery prefers the native executable bundled by the global npm
  package, then supports npm shims, `codex.ps1`, npm directories, PATH, and the
  usual AppData fallback. Multi-line prompts are sent through stdin.
- Otherwise, `AiService` uses the configured OpenAI-compatible endpoint.
- Without an API key, `AiService` streams a local explanatory draft so the UI
  remains testable and usable.
- Both routes normalize deltas, tool activity, attachments, completion, errors,
  and cancellation into `AiStreamEvent`.

## Persistence And Synchronization

The JSON store includes documents, reading state, marks, bookmarks,
conversations, translations, notes, generated outlines, workspace blocks, AI
configuration, WebDAV configuration, and preferences.

All local mutations and WebDAV snapshot applications must run through the same
main-process serialized mutation queue. `MetadataSyncScheduler` debounces rapid
updates and then enters that queue before starting synchronization. This is a
correctness invariant: a background snapshot must never overwrite a newer local
write while waiting for the network.

Store reads are side-effect free when `library.json` does not exist. The first
real mutation creates the file; do not eagerly write an empty Store from a read,
because first-launch settings and Codex warm-up happen concurrently.

WebDAV currently synchronizes only:

- reading progress;
- conversations;
- the ten most recent translations per document.

It does not synchronize PDFs, notes, marks, bookmarks, workspace blocks,
outlines, provider settings, or application preferences.

## UI Invariants

- Windows uses a frameless window with no application menu. The renderer-owned
  title strip exposes only maximize/restore and close controls.
- Settings must remain a standalone window; do not reintroduce an in-page modal.
- `.pdf-viewport` must remain absolutely positioned for PDF.js.
- The PDF scrollbar stays at the far right of the reader window.
- `.pdfViewer` reserves the active dock lane so text is not covered.
- `.pdfViewer` keeps a minimum reading-column width at small zoom levels so the
  dock does not drift left with a narrow PDF page.
- `.workspace-canvas-spacer` must remain present because absolutely positioned
  blocks do not contribute their own horizontal scroll width.
- Image blocks keep a fixed viewport. Their zoom and scroll position live in
  `WorkspaceBlock.payload`; the image must not grow the spatial canvas card.
- Drawing blocks use page-local logical coordinates and render strokes as SVG
  paths. Their displayed width and height follow the attached PDF page, while
  pressure points, colors, sizes, and lasso-editable strokes remain persisted.
- Conversation participant display names are stored per conversation rather
  than as global application preferences.
- Loading the PDF document must not depend on workspace block state; pinning a
  block must not destroy and reload PDF.js.
- Save a note before saving a newly created note block so two full-file Store
  writes cannot race.

## Verification

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test:e2e
```

Active tests live in `tests/e2e/home.spec.ts`, `pdf-reader.spec.ts`,
`metadata-sync-scheduler.spec.ts`, and `webdav.spec.ts`.
