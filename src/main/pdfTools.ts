import { readFile } from 'node:fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import type { AiPdfOutlineItem } from '../shared/domain';

interface PdfJsOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: PdfJsOutlineNode[];
}

export interface PdfPageText {
  pageNumber: number;
  text: string;
}

export interface PdfPageTextResult {
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  pages: PdfPageText[];
}

export async function extractPdfPageTextRange(
  filePath: string,
  requestedStart: number,
  requestedEnd: number,
  maxPages = 8,
  maxChars = 24000
): Promise<PdfPageTextResult> {
  const pdfDocument = await loadPdf(filePath);
  try {
    const pageCount = pdfDocument.numPages;
    const pageStart = clampPage(requestedStart, pageCount);
    const pageEnd = Math.min(clampPage(Math.max(requestedStart, requestedEnd), pageCount), pageStart + maxPages - 1);
    let remainingChars = maxChars;
    const pages: PdfPageText[] = [];

    for (let pageNumber = pageStart; pageNumber <= pageEnd && remainingChars > 0; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = normalizeTextItems(textContent.items).slice(0, remainingChars);
      remainingChars -= text.length;
      pages.push({ pageNumber, text });
    }

    return {
      pageCount,
      pageStart,
      pageEnd,
      pages
    };
  } finally {
    await pdfDocument.destroy();
  }
}

export async function readPdfOutline(filePath: string, maxItems = 160): Promise<{
  pageCount: number;
  outline: AiPdfOutlineItem[];
}> {
  const pdfDocument = await loadPdf(filePath);
  try {
    const rawOutline = (await pdfDocument.getOutline()) as PdfJsOutlineNode[] | null;
    const outline = rawOutline?.length
      ? (await flattenOutline(pdfDocument, rawOutline, 0, [])).slice(0, maxItems)
      : [];
    return {
      pageCount: pdfDocument.numPages,
      outline
    };
  } finally {
    await pdfDocument.destroy();
  }
}

async function loadPdf(filePath: string): Promise<{
  destroy(): Promise<void>;
  getDestination(dest: string): Promise<unknown[] | null>;
  getOutline(): Promise<unknown[] | null>;
  getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
  numPages: number;
}> {
  const data = new Uint8Array(await readFile(filePath));
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true
  });
  return task.promise;
}

function normalizeTextItems(items: unknown[]): string {
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const textItem = item as { str?: unknown; hasEOL?: unknown };
      const value = typeof textItem.str === 'string' ? textItem.str : '';
      return textItem.hasEOL ? `${value}\n` : value;
    })
    .join(' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function flattenOutline(
  pdfDocument: Awaited<ReturnType<typeof loadPdf>>,
  items: PdfJsOutlineNode[],
  level: number,
  parents: number[]
): Promise<AiPdfOutlineItem[]> {
  const flattened: AiPdfOutlineItem[] = [];

  for (const [index, item] of items.entries()) {
    const path = [...parents, index];
    flattened.push({
      title: item.title || `Untitled ${path.join('.')}`,
      level,
      pageNumber: await pageNumberForDestination(pdfDocument, item.dest)
    });

    if (item.items?.length) {
      flattened.push(...(await flattenOutline(pdfDocument, item.items, level + 1, path)));
    }
  }

  return flattened;
}

async function pageNumberForDestination(
  pdfDocument: Awaited<ReturnType<typeof loadPdf>>,
  dest: string | unknown[] | null
): Promise<number | undefined> {
  if (!dest) {
    return undefined;
  }

  try {
    const explicitDest = typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest;
    const pageRef = explicitDest?.[0];
    if (typeof pageRef === 'object' && pageRef && 'num' in pageRef && 'gen' in pageRef) {
      return (await pdfDocument.getPageIndex(pageRef as { num: number; gen: number })) + 1;
    }

    if (typeof pageRef === 'number') {
      return pageRef + 1;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function clampPage(value: number, pageCount: number): number {
  const page = Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.max(1, Math.min(pageCount, page));
}
