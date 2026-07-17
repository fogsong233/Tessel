import { Conversation, PdfReadingState, WebDavSyncConfig } from '../shared/domain';

export interface PdfSessionSnapshot {
  version: 1;
  documentHash: string;
  updatedAt: string;
  readingState?: PdfReadingState;
  conversations: Conversation[];
}

export interface WebDavSessionSyncInput {
  config: WebDavSyncConfig;
  documentHash: string;
  local: PdfSessionSnapshot;
}

/**
 * Merge one PDF session with its WebDAV counterpart. A session is stored in a
 * standalone resource so one document never overwrites metadata for another.
 */
export async function syncPdfSessionToWebDav(input: WebDavSessionSyncInput): Promise<PdfSessionSnapshot> {
  const target = webDavSessionUrl(input.config, input.documentHash);
  const remote = await getRemoteSnapshot(target, input.config);
  const merged = mergePdfSessionSnapshots(remote, input.local);

  await ensureCollection(webDavCollectionUrl(input.config), input.config);
  const response = await fetch(target, {
    method: 'PUT',
    headers: {
      ...webDavHeaders(input.config),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: `${JSON.stringify(merged, null, 2)}\n`
  });

  if (!response.ok) {
    throw new Error(`WebDAV metadata upload failed (${response.status} ${response.statusText}).`);
  }

  return merged;
}

export function mergePdfSessionSnapshots(
  remote: PdfSessionSnapshot | undefined,
  local: PdfSessionSnapshot
): PdfSessionSnapshot {
  if (!remote || remote.documentHash !== local.documentHash) {
    return local;
  }

  const conversations = new Map<string, Conversation>();
  for (const conversation of [...remote.conversations, ...local.conversations]) {
    const existing = conversations.get(conversation.id);
    if (!existing || conversation.updatedAt >= existing.updatedAt) {
      conversations.set(conversation.id, conversation);
    }
  }

  const readingState = latestByUpdatedAt(remote.readingState, local.readingState);
  const updatedAt = [remote.updatedAt, local.updatedAt, readingState?.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? new Date().toISOString();

  return {
    version: 1,
    documentHash: local.documentHash,
    updatedAt,
    readingState,
    conversations: Array.from(conversations.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  };
}

function latestByUpdatedAt<T extends { updatedAt: string }>(first?: T, second?: T): T | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return first.updatedAt >= second.updatedAt ? first : second;
}

async function getRemoteSnapshot(url: string, config: WebDavSyncConfig): Promise<PdfSessionSnapshot | undefined> {
  const response = await fetch(url, { headers: webDavHeaders(config) });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`WebDAV metadata download failed (${response.status} ${response.statusText}).`);
  }

  try {
    const value = await response.json() as PdfSessionSnapshot;
    return value?.version === 1 && typeof value.documentHash === 'string' && Array.isArray(value.conversations)
      ? value
      : undefined;
  } catch {
    throw new Error('WebDAV returned invalid PDF session metadata.');
  }
}

async function ensureCollection(url: string, config: WebDavSyncConfig): Promise<void> {
  const response = await fetch(url, { method: 'MKCOL', headers: webDavHeaders(config) });
  // Existing collections commonly return 405; both outcomes are valid.
  if (response.ok || response.status === 405 || response.status === 301 || response.status === 302) {
    return;
  }
  // Many managed WebDAV endpoints create the final collection lazily on PUT.
  if (response.status === 409) {
    return;
  }
  throw new Error(`WebDAV session directory is unavailable (${response.status} ${response.statusText}).`);
}

function webDavCollectionUrl(config: WebDavSyncConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  const path = config.basePath.trim().replace(/^\/+|\/+$/g, '');
  return `${base}/${path ? `${path}/` : ''}pdf-sessions/`;
}

function webDavSessionUrl(config: WebDavSyncConfig, documentHash: string): string {
  return `${webDavCollectionUrl(config)}${encodeURIComponent(documentHash)}.json`;
}

function webDavHeaders(config: WebDavSyncConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.username.trim() || config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password ?? ''}`, 'utf8').toString('base64')}`;
  }
  return headers;
}
