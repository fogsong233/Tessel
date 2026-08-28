# Tessel Handoff

Last updated: 2026-08-28

## Current Product

Tessel is a local-first PDF reader built with Electron, React, TypeScript, and
PDF.js. The current product intentionally starts with a focused open/settings
window rather than a document library. Opening a file creates a reader window
identified by the PDF's full SHA-256 digest.

The intended reading loop is:

1. Open a local PDF.
2. Read with persistent page state, marks, and bookmarks.
3. Select text to chat, translate, summarize, or start a note.
4. Keep durable conversations and notes in the dock or pin them beside a page.
5. Optionally synchronize reading progress, conversations, and recent
   translations through WebDAV.

## Important Files

- `docs/ARCHITECTURE.md`: runtime boundaries and correctness invariants.
- `src/main/index.ts`: windows, IPC, serialized Store mutation queue, AI routing.
- `src/main/store.ts`: JSON persistence, secret storage, WebDAV snapshots.
- `src/main/metadataSyncScheduler.ts`: coalesced WebDAV scheduling through the
  Store mutation queue.
- `src/main/aiService.ts`: OpenAI-compatible completions and PDF tools.
- `src/main/codexAgent.ts`: experimental local Codex CLI adapter.
- `src/renderer/src/App.tsx`: application state and reader workflows.
- `src/renderer/src/PdfReader.tsx`: PDF.js viewer, dock, selection, marks, and
  spatial workspace.
- `src/shared/domain.ts`: shared domain and `TesselApi` contract.

## Current Capabilities

- Initial-buffer plus IPC range loading for large PDFs.
- Embedded or AI-generated PDF outlines.
- Persistent reading state, highlights, underlines, and bookmarks.
- Persistent contextual conversations with Markdown, math, images, tool calls,
  visible agent activity, cancellation, and active-turn guidance.
- OpenAI-compatible and local Codex routing.
- Translation history capped at ten entries per document.
- Manual and AI-generated Markdown notes with CodeMirror and optional Vim mode.
- Page-anchored conversation, note, translation, and image blocks that can be
  dragged, resized, reopened, and removed without deleting their source.
- English and Simplified Chinese UI, configurable colors and fonts.
- Explicit GitHub Release update flow for installed builds.
- Standalone singleton settings window and compact custom Windows chrome.

## Storage And Sync

The workspace file is `userData/workspace/library.json`; the name is retained
for compatibility with existing installations. Writes use a unique temporary
file followed by rename. Invalid JSON is moved to a timestamped backup before a
fresh store is created.

API keys and WebDAV passwords use Electron `safeStorage` where available. A
base64 plain fallback exists only for development environments without platform
encryption.

WebDAV is metadata-only. It does not upload PDFs, notes, marks, bookmarks,
outlines, workspace blocks, or preferences. Automatic sync must be scheduled by
`MetadataSyncScheduler`; do not start Store synchronization directly from a
Store save method because it can race with later full-file writes.

## Verification

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test:e2e
```

The active Playwright suite covers the focused home window, full-hash and range
PDF loading, selection/chat flows, pinned blocks and images, Codex transports
and guidance, translations, settings, generated outlines, synchronization
scheduling, and WebDAV folder creation.

Expected non-blocking build warnings:

- `pdfjs-dist` contains `eval`.
- PDF.js alt-text SVG assets can remain unresolved at build time.

On Windows, Codex auto-discovery should resolve the native executable inside a
global npm installation even when a packaged GUI launch does not inherit the
user's npm PATH. The settings page displays the resolved path for diagnostics.

## Editing Cautions

- Preserve the layout invariants listed in `docs/ARCHITECTURE.md`.
- Avoid broad style rewrites in `styles.css`; the reader still has historical
  override layers that should be reduced incrementally with visual checks.
- Abort AI streams when their renderer is destroyed and never send a final
  chunk into a disposed frame.
- Keep PDF loading independent from workspace block updates.
- Coordinate all `library.json` mutations through the main-process queue.

## Suggested Next Work

- Split the remaining reader and settings UI into smaller modules.
- Add screenshot-based visual regression coverage for dock states.
- Move from the monolithic JSON file toward SQLite plus FTS or a conflict-aware
  file layout before expanding sync scope.
- Add durable synchronization for notes and spatial blocks only after defining
  conflict semantics.
- Continue removing unused historical CSS selectors with visual verification.
