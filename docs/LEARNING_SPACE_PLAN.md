# Learning Space Plan

Last updated: 2026-05-16

## Product Thesis

Sidelight should evolve from a PDF reader with a right dock into a spatial
learning workspace. The PDF remains the spine: a continuous vertical book that
sets context, page anchors, and reading flow. Around that spine, users can place
durable blocks: conversations, notes, screenshots, comparisons, extracted
definitions, and AI-generated study cards.

The right dock stays valuable, but its role narrows: it is the production and
navigation instrument. The workspace canvas is where durable thinking lives.

## Spatial Model

There are two block anchoring modes:

- Page-anchored blocks move with a PDF page vertically and horizontally. Examples:
  a conversation pinned beside a theorem, a note attached to a paragraph, a
  screenshot comparison beside page 12.
- Viewport-anchored blocks stay visible while reading. Examples: a task list,
  active AI generation dock, or temporary translation aid.

The current dock is effectively a viewport-pinned producer. New study artifacts
should be page-pinned by default.

## UI Direction

Keep the existing dock visual language:

- White translucent panels on the gray reading background.
- Tight borders, restrained shadows, 8-10px radius.
- Small lucide icons for actions.
- Compact metadata, strong title, short body preview.
- Avoid large decorative hero surfaces; this is a study tool.

The PDF should still feel like the main object. Blocks sit near it, not over it
unless explicitly placed there.

## Implementation Phases

1. Foundation
   - Add a persisted `WorkspaceBlock` model.
   - Render page-anchored blocks in the same horizontal canvas as the PDF.
   - Allow pinning an existing chat to the learning space.

2. Manipulation
   - Drag blocks within the page canvas.
   - Resize blocks with the same subtle handle language as the dock.
   - Persist `x`, `y`, `width`, and optional `height`.

3. Rich Blocks
   - Add note cards, screenshots, selected-region snapshots, and comparison
     cards.
   - Support expanding a pinned chat inline beside its page.
   - Add block type filters and minimization.

4. Infinite Workspace
   - Add non-page areas before/after the PDF.
   - Support freeform clusters for exam review, outlines, and concept maps.
   - Add mini-map / spatial search.

5. AI Orchestration
   - The dock can generate blocks directly: "make cards", "compare with page",
     "turn this chat into note", "extract definitions".
   - Generated blocks inherit page range and source links.

## First Slice Implemented

The first slice adds the durable model and page-attached conversation cards:

- Chat header has a pin action.
- Clicking it creates or updates a `conversation` workspace block.
- The block appears beside the PDF page on the continuous canvas.
- Clicking the block reopens the conversation.
- Removing the block does not delete the underlying conversation.

## Second Slice Implemented

The second slice makes pinned cards feel like real canvas objects:

- Pinned conversation blocks default to the canvas area beyond the active dock,
  so they do not hide under the assistant panel.
- Blocks have a subtle top drag handle and lower-right resize handle.
- Dragging persists `x` and `y`; resizing persists `width`.
- E2E reveals the block on the horizontal canvas, verifies the handle is not
  occluded, checks movement/resize persistence, and asserts no card content
  overflow.

## Third Slice Implemented

Notes can now become learning-space blocks too:

- The notes list exposes a compact pin action for each visible note.
- The note editor header exposes the same pin action.
- Pinned note blocks use the same canvas card language as conversation blocks.
- Clicking a pinned note block reopens the note editor.
- E2E covers note block persistence, no-overflow rendering, and click-to-open.

## Interaction Corrections

- The dock `+` action follows the active creation context: chat creates a page
  chat, notes creates a current-page note.
- Newly pinned blocks are horizontally revealed without vertical `scrollIntoView`.
- Default block `y` is based on the current viewport position inside the page,
  so pinning near the middle of a page does not jump the reader to the page top.
- The canvas includes an invisible spacer because pinned blocks are absolutely
  positioned and do not otherwise expand horizontal scroll width.
- Chat and note pins now default to the left side of the PDF, leaving the dock
  side cleaner for active production work.
- Left-side pins reserve a stable canvas gutter, animate in with a small pop,
  can be dragged/resized, and new pins avoid overlapping existing blocks on the
  same page/side.
- Pin placement follows the current PDF page rather than the source page of the
  chat/note. Search can find a cross-page item, but pinning places it beside the
  page the user is currently reading.
- Re-pinning an existing block on a different current page recomputes its
  position through overlap avoidance instead of reusing stale coordinates from
  the old page.

## Remaining Block Types

- Snapshot/image blocks are still the next rich block type. The current
  implementation covers sticky conversation/note cards only.
