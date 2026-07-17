# Renderer assets

- `icons/` is reserved for product icons used outside the Lucide UI icon set.
- `images/` is for imported bitmap artwork and document-independent textures.
- `pdfjs.ts` is the single renderer entry point for the PDF.js worker asset.

Use Vite imports for renderer assets. Do not place generated assets in source
folders; packaged output is emitted to `out/renderer/assets/`.
