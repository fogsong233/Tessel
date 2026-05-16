# Sidelight Roadmap

## Version 0.1

- Electron + React shell
- PDF open and render with PDF.js
- Selectable PDF text layer
- Floating selection actions: chat, temporary translate, temporary summary
- Persistent anchored conversations
- Markdown notes with math rendering
- Local search across conversations and notes
- OpenAI-compatible provider settings
- Library window plus one reader window per open PDF

Product rule: Chat is the only persisted AI interaction. Translate and summary are temporary reading aids; closing the panel discards them.

## Version 0.2

- Replace JSON store with SQLite + FTS5
- Better PDF text anchoring with stable quote selectors and page rectangles
- Replace the custom page renderer with more of PDF.js' open-source viewer layer where it gives us better search, annotation layers, and page queue behavior
- Conversation auto-title and auto-summary through the configured AI provider
- Real PDF text search
- Streaming AI responses
- Per-document prompt presets

## Version 0.3

- Lesson/note generation from selected PDF ranges plus conversation trees
- Git-backed sync target for private GitHub repositories
- Optional PDF file backup
- Conflict-aware Markdown note merging
- Document tags, collections, and reading projects

## Later

- Browser extension ingestion
- Multi-PDF workspaces
- OCR for scanned PDFs
- WYSIWYG Markdown editor replacement
- Export notes as Markdown, PDF, or DOCX
