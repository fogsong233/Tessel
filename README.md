# Tessel

Tessel is a focused PDF reader with anchored AI conversations and persistent reading progress.

The first version focuses on one reading loop:

1. Open a PDF.
2. Select text in the PDF.
3. Ask Tessel to explain, translate, or summarize the selection.
4. Keep the conversation attached to the page and selection.
5. Edit Markdown notes beside the PDF.

## Stack

- Node.js + pnpm
- Electron
- TypeScript
- React + Vite
- PDF.js
- pdf-lib for explicit PDF metadata/export operations
- KaTeX-enabled Markdown rendering

## Scripts

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
pnpm test:e2e
```

If your shell has `ELECTRON_RUN_AS_NODE=1`, unset it before running the app:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm dev
```

## Tests

The Electron integration suite launches the built app with an isolated test
workspace, clicks through the library, opens a generated PDF in a reader window,
checks that PDF text and canvas rendering are visible, and verifies that
temporary summary/translation panels are not persisted while chat is persisted.

```bash
pnpm test:e2e
```

## Storage

The current workspace is a JSON repository stored in Electron's `userData` directory. It keeps:

- PDF metadata and recent documents
- Anchored conversations
- Markdown notes
- AI provider settings, with the API key encrypted through Electron `safeStorage` when available

The repository boundary lives in `src/main/store.ts`, so it can later be replaced by SQLite + FTS and GitHub sync without rewriting the renderer.

## PDF Engine

Rendering uses PDF.js in the renderer, while the Electron main process exposes range reads over IPC. Large PDFs are not copied through IPC as one giant `ArrayBuffer`; PDF.js asks for byte ranges and Node reads only those slices from disk.

Explicit PDF mutations live in `src/main/pdfOperations.ts` and use `pdf-lib`. Keep that path out of the document-open flow so large files stay responsive.
