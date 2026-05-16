import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  pageCount: number;
}

export interface PdfMetadataPatch {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
}

/**
 * Heavy PDF mutations live behind this service and should only run from explicit
 * user actions. Opening a large document must stay range-based and cheap.
 */
export class PdfOperationsService {
  async readMetadata(filePath: string): Promise<PdfMetadata> {
    const bytes = await readFile(filePath);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });

    return {
      title: document.getTitle(),
      author: document.getAuthor(),
      subject: document.getSubject(),
      keywords: document.getKeywords()?.split(/\s*,\s*/).filter(Boolean),
      pageCount: document.getPageCount()
    };
  }

  async writeMetadata(filePath: string, patch: PdfMetadataPatch): Promise<void> {
    const bytes = await readFile(filePath);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });

    if (patch.title !== undefined) {
      document.setTitle(patch.title);
    }

    if (patch.author !== undefined) {
      document.setAuthor(patch.author);
    }

    if (patch.subject !== undefined) {
      document.setSubject(patch.subject);
    }

    if (patch.keywords !== undefined) {
      document.setKeywords(patch.keywords);
    }

    const nextBytes = await document.save();
    await writeFile(filePath, nextBytes);
  }
}
