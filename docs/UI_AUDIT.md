# UI screenshot audit

The visual audit uses an isolated Electron profile, a generated PDF and a local
fake Codex process. It never opens or changes the installed application's library.

Run after building:

```powershell
$env:TESSEL_UI_AUDIT_PHASE = 'current'
node node_modules/@playwright/test/cli.js test -g 'visually audits'
```

Screenshots and measured overflow are retained in `tmp/ui-audit/current/`, outside
Playwright's disposable result directory. Change the phase to preserve a comparison.
Open `index.html` in that directory for the screenshot gallery.
`TESSEL_UI_AUDIT_SURFACES=1` refreshes the reader/tablet portion of an existing audit
without discarding its settings screenshots.

## Coverage

- All eight settings sections: provider, Codex, sync, LAN, storage, appearance,
  language and updates. Long sections are captured in overlapping scroll positions.
- Settings at 1040 × 760 and 820 × 600; Chinese at the maximum interface font size.
- Expanded book details, network addresses, QR code and Markdown update notes.
- Chat: empty/multiline input, model/reasoning, permissions, slash commands,
  participant names and a completed transcript; normal and large fonts.
- PDF loading, search, bookmarks, selection actions, translation history/result,
  Markdown note editor at wide and narrow widths, notebook placement, collapsed
  and expanded drawing tools.
- Tablet landscape/portrait, compact/hidden sidebar, brush preferences, delete
  confirmation and the smaller 600-pixel layout.
- Recent-history home screen at 720 × 520 and 620 × 460.
- Image-card controls and a dock dragged to the bottom before resizing the window.

The audit records horizontal overflow and asserts that open panels stay in the
window and empty composer buttons align with the text field. The handwriting
regression also checks that zoom settling never scrolls the canvas during a stroke.
PDF/canvas panning and code editor scrolling are intentional scroll areas,
not layout failures. Visual review of the PNGs is still required: DOM measurements
alone do not detect misleading icons or awkward wrapping.

## Issues covered by the fixes

- Settings row selectors no longer leak into nested font/color controls; range
  and color inputs have their own geometry instead of text-input styling.
- Dock width/height follow the actual reader column, with bounded dragging and
  synchronous alignment when the host resizes. Narrow notes stack their panes.
- Empty chat content adapts to a short dock; composer height tracks both width
  and font changes. Bookmark tabs make room for their count before wrapping.
- Notebook paper accounts for its padding and thin scrollbar. Starting input
  cancels delayed post-zoom canvas reveals, preventing jumps during handwriting.
- Tablet brush settings are outside the clipped toolbar, with bounded height,
  a real close button, and compact footer actions for narrower workspaces.
- Search navigation, lasso, attachment, send-to-AI, full-access permissions, and
  notebook controls use action-specific icons. Clearing search clears its highlights.

## Layout ownership

- `appearance.css`: independent font controls and settings content sizing.
- `reader/chat-composer.css`: composer sizing and per-conversation controls.
- `reader/dock-layout.css`: responsive dock panel headers and note editor layout.
- `reader/reader-overrides.css`: notebook paper/toolbar and sidebar layout.
- `remote/remote.css`: tablet shell, toolbar, brush panel and compact footer.
- The shared size observer measures the actual host column. PDF zoom does not
  change the dock size; window/splitter resizing does.

Avoid descendant-wide form rules such as `.reader-settings__fields label`: they
also match nested swatches/sliders and silently give them a full settings-row grid.
Use direct-child selectors and size-specific controls instead. Use content
containers rather than window media queries when the sidebar reduces usable width.
