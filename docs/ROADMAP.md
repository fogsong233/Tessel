# Tessel Roadmap

Last updated: 2026-08-28

## Current Baseline: 1.3.x

- Focused open/settings start window and direct PDF launch.
- Full-content SHA-256 document identity.
- Range-backed PDF.js rendering, outline, search, navigation, marks, bookmarks,
  and reading progress.
- Persistent contextual chats, translation history, Markdown notes, generated
  outlines, and spatial workspace blocks.
- OpenAI-compatible provider and experimental local Codex CLI integration.
- Metadata-only WebDAV synchronization for reading state, chats, and recent
  translations.
- GitHub Release packaging and update support for Windows and macOS.

## Reliability And Maintainability

- Continue decomposing `App.tsx`, `PdfReader.tsx`, and `styles.css`.
- Add visual regression tests for reader dock, selection controls, and pinned
  workspace blocks.
- Add recovery and concurrency tests around the JSON Store and WebDAV merge.
- Remove remaining historical CSS and `SIDELIGHT_*` naming where compatibility
  permits.
- Improve diagnostics for missing/moved PDF files and expired WebDAV sessions.

## Search And Storage

- Replace the monolithic JSON workspace with SQLite and FTS5, or introduce a
  migration layer that keeps the current JSON format recoverable.
- Add real search across PDF text, conversations, translations, and notes.
- Use stable quote selectors and page rectangles for stronger anchor recovery.
- Define per-entity revisions before synchronizing additional artifact types.

## Learning Workspace

- Add selected-region snapshots and comparison blocks.
- Allow pinned chats and notes to expand inline.
- Add block filtering, minimization, and spatial navigation.
- Add study-card and definition extraction flows that preserve source links.
- Explore non-page canvas areas and multi-document workspaces.

## Later

- OCR for scanned PDFs.
- Browser/webpage ingestion.
- EPUB and richer non-PDF document support.
- Conflict-aware note synchronization.
- Export notes and learning artifacts as Markdown, PDF, or DOCX.
