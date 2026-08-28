import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DocumentFingerprint, DocumentFormat, PdfDocumentMeta } from '../shared/domain';

export const fullContentHashAlgorithm = 'sha256-full-v1';
// Kept for reading legacy workspace snapshots during the migration. New PDFs
// are always keyed by fullContentHashAlgorithm.
export const sampledContentHashAlgorithm = 'sha256-size-head-tail-1m-v1';
const hashChunkBytes = 1024 * 1024;

export interface LocalDocumentIdentity {
  fileName: string;
  format: DocumentFormat;
  fingerprint: DocumentFingerprint;
}

export async function identifyLocalDocument(filePath: string, assumedFormat?: DocumentFormat): Promise<LocalDocumentIdentity> {
  const fileStat = await stat(filePath);
  const hash = await fullFileHash(filePath);
  return {
    fileName: basename(filePath),
    format: assumedFormat ?? inferDocumentFormat(filePath),
    fingerprint: {
      algorithm: fullContentHashAlgorithm,
      hash,
      byteSize: fileStat.size
    }
  };
}

export function documentIdForFingerprint(fingerprint: DocumentFingerprint): string {
  return `pdf_${fingerprint.hash}`;
}

export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/i, '') || fileName;
}

export function inferDocumentFormat(filePath: string): DocumentFormat {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.pdf') {
    return 'pdf';
  }
  if (extension === '.md' || extension === '.markdown') {
    return 'markdown';
  }
  if (extension === '.txt' || extension === '.text') {
    return 'text';
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(extension)) {
    return 'image';
  }
  if (extension === '.html' || extension === '.htm') {
    return 'html';
  }
  if (extension === '.epub') {
    return 'epub';
  }
  return 'unknown';
}

export function normalizeDocumentMeta(document: PdfDocumentMeta): PdfDocumentMeta {
  const hash = document.fingerprint?.hash ?? document.sha256;
  const algorithm = document.fingerprint?.algorithm ?? document.hashAlgorithm ?? fullContentHashAlgorithm;
  return {
    ...document,
    format: document.format ?? inferDocumentFormat(document.fileName),
    source: document.source ?? {
      kind: 'local-file',
      uri: document.filePath,
      filePath: document.filePath
    },
    fingerprint: {
      ...document.fingerprint,
      algorithm,
      hash
    },
    sha256: hash,
    hashAlgorithm: algorithm,
    inLibrary: document.inLibrary ?? true,
    groupIds: document.groupIds ?? [],
    tags: document.tags ?? []
  };
}

export function documentHashAlgorithm(document: PdfDocumentMeta): string {
  return document.fingerprint?.algorithm ?? document.hashAlgorithm ?? fullContentHashAlgorithm;
}

async function fullFileHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const file = await open(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(hashChunkBytes);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }

  return hash.digest('hex');
}
