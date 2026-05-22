declare module 'pdfjs-dist/build/pdf.js' {
  export function getDocument(params: unknown): {
    promise: Promise<{
      destroy(): Promise<void>;
      getDestination(dest: string): Promise<unknown[] | null>;
      getOutline(): Promise<unknown[] | null>;
      getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
      getPageIndex(ref: { num: number; gen: number }): Promise<number>;
      numPages: number;
    }>;
  };
}
