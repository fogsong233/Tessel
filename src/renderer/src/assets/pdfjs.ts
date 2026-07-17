// Keep third-party render assets behind one local entry point. App-owned
// bitmap/vector assets belong in this directory as well.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

export { workerUrl };
