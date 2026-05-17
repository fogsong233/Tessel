import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  AppPreferences,
  Conversation,
  GitHubUploadConfig,
  LibraryGroup,
  NoteDocument,
  PdfGeneratedOutline,
  PdfDocumentMeta,
  PdfMark,
  PdfReadingState,
  PdfUserBookmark,
  WorkspaceBlock
} from '../shared/domain';
import {
  cloudAssetPathForDocument,
  documentContentHash,
  documentHashAlgorithm,
  normalizeLibraryDocument,
  sampledContentHashAlgorithm
} from './documentIdentity';

export interface WorkspaceStoreData {
  documents: PdfDocumentMeta[];
  libraryGroups: LibraryGroup[];
  conversations: Conversation[];
  notes: NoteDocument[];
  workspaceBlocks: WorkspaceBlock[];
  generatedOutlines: PdfGeneratedOutline[];
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  readingStates: PdfReadingState[];
  githubUpload: Omit<GitHubUploadConfig, 'token'>;
  appPreferences: AppPreferences;
}

export interface WorkspaceSyncManifest {
  version: 1;
  updatedAt: string;
  hashAlgorithm: string;
  settingsPath: string;
  groups: LibraryGroup[];
  documents: Array<{
    documentId: string;
    hash: string;
    hashAlgorithm: string;
    format: string;
    title: string;
    fileName: string;
    inLibrary: boolean;
    groupIds: string[];
    cloudHeld: boolean;
    jsonPath: string;
    assetPath?: string;
    pdfPath?: string;
    updatedAt: string;
  }>;
  settings: {
    appPreferences: AppPreferences;
    githubUpload: Omit<GitHubUploadConfig, 'token'>;
  };
}

export interface WorkspaceDocumentSnapshot {
  version: 1;
  updatedAt: string;
  document: PdfDocumentMeta;
  conversations: Conversation[];
  notes: NoteDocument[];
  workspaceBlocks: WorkspaceBlock[];
  generatedOutlines: PdfGeneratedOutline[];
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  readingStates: PdfReadingState[];
}

export async function hydrateDocumentWorkspaceFromSnapshot(input: {
  store: WorkspaceStoreData;
  workspaceDir: string;
  documentId: string;
  contentHash: string;
}): Promise<void> {
  const snapshotPath = join(input.workspaceDir, 'sync', 'documents', `${input.contentHash}.json`);
  let snapshot: WorkspaceDocumentSnapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as WorkspaceDocumentSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const rekey = <T extends { documentId: string }>(items: T[] | undefined): T[] =>
    (items ?? []).map((item) => ({ ...item, documentId: input.documentId }));

  input.store.conversations = mergeById(input.store.conversations, rekey(snapshot.conversations), (item) => item.id, updatedAtOf);
  input.store.notes = mergeById(input.store.notes, rekey(snapshot.notes), (item) => item.id, updatedAtOf);
  input.store.workspaceBlocks = mergeById(input.store.workspaceBlocks, rekey(snapshot.workspaceBlocks), (item) => item.id, updatedAtOf);
  input.store.generatedOutlines = mergeById(input.store.generatedOutlines, rekey(snapshot.generatedOutlines), (item) => item.documentId, updatedAtOf);
  input.store.marks = mergeById(input.store.marks, rekey(snapshot.marks), (item) => item.id, (item) => item.createdAt);
  input.store.bookmarks = mergeById(input.store.bookmarks, rekey(snapshot.bookmarks), (item) => item.id, (item) => item.createdAt);
  input.store.readingStates = mergeById(input.store.readingStates, rekey(snapshot.readingStates), (item) => item.documentId, updatedAtOf);
}

export async function writeWorkspaceSyncSnapshot(input: {
  store: WorkspaceStoreData;
  workspaceDir: string;
}): Promise<WorkspaceSyncManifest> {
  const syncDir = join(input.workspaceDir, 'sync');
  const documentsDir = join(syncDir, 'documents');
  await mkdir(documentsDir, { recursive: true });

  const now = new Date().toISOString();
  const groups = input.store.libraryGroups ?? [];
  const heldGroupIds = new Set(groups.filter((group) => group.cloudHeld).map((group) => group.id));
  const documents = (input.store.documents ?? []).map((document) => normalizeLibraryDocument(document));
  const safeGithubUpload = safeUploadSettings(input.store.githubUpload);
  const manifestDocuments = documents.map((document) => {
    const isCloudHeld = (document.groupIds ?? []).some((groupId) => heldGroupIds.has(groupId));
    const assetPath = isCloudHeld ? cloudAssetPathForDocument(document) : undefined;
    return {
      documentId: document.id,
      hash: documentContentHash(document),
      hashAlgorithm: documentHashAlgorithm(document),
      format: document.format,
      title: document.title,
      fileName: document.fileName,
      inLibrary: document.inLibrary !== false,
      groupIds: document.groupIds ?? [],
      cloudHeld: isCloudHeld,
      jsonPath: `documents/${documentContentHash(document)}.json`,
      assetPath,
      pdfPath: document.format === 'pdf' ? assetPath : undefined,
      updatedAt: document.updatedAt
    };
  });

  const manifest: WorkspaceSyncManifest = {
    version: 1,
    updatedAt: now,
    hashAlgorithm: sampledContentHashAlgorithm,
    settingsPath: 'settings.json',
    groups,
    documents: manifestDocuments,
    settings: {
      appPreferences: input.store.appPreferences,
      githubUpload: safeGithubUpload
    }
  };
  const settingsSnapshot = {
    version: 1,
    updatedAt: now,
    appPreferences: input.store.appPreferences,
    githubUpload: safeGithubUpload
  };

  for (const document of documents) {
    const manifestDocument = manifestDocuments.find((candidate) => candidate.documentId === document.id);
    const snapshot: WorkspaceDocumentSnapshot = {
      version: 1,
      updatedAt: now,
      document: {
        ...document,
        filePath: '',
        source: document.source ? { ...document.source, filePath: undefined } : undefined
      },
      conversations: input.store.conversations.filter((item) => item.documentId === document.id),
      notes: input.store.notes.filter((item) => item.documentId === document.id),
      workspaceBlocks: input.store.workspaceBlocks.filter((item) => item.documentId === document.id),
      generatedOutlines: input.store.generatedOutlines.filter((item) => item.documentId === document.id),
      marks: input.store.marks.filter((item) => item.documentId === document.id),
      bookmarks: input.store.bookmarks.filter((item) => item.documentId === document.id),
      readingStates: input.store.readingStates.filter((item) => item.documentId === document.id)
    };
    await writeJsonFile(join(documentsDir, `${documentContentHash(document)}.json`), snapshot);
    if (manifestDocument?.assetPath && document.filePath) {
      await copyFileIfChanged(document.filePath, join(syncDir, manifestDocument.assetPath)).catch(() => undefined);
    }
  }

  await writeJsonFile(join(syncDir, 'settings.json'), settingsSnapshot);
  await writeJsonFile(join(syncDir, 'manifest.json'), manifest);
  return manifest;
}

export async function uploadWorkspaceSyncToGitHub(input: {
  store: WorkspaceStoreData;
  workspaceDir: string;
  manifest: WorkspaceSyncManifest;
  token?: string;
}): Promise<void> {
  const upload = input.store.githubUpload;
  if (!upload.enabled || !input.token || !upload.owner || !upload.repo) {
    return;
  }

  const syncDir = join(input.workspaceDir, 'sync');
  const branch = upload.branch || 'main';
  const message = `Sync Sidelight workspace ${input.manifest.updatedAt}`;
  const putFile = (relativePath: string, content: Buffer | string): Promise<void> =>
    githubPutFile({
      owner: upload.owner,
      repo: upload.repo,
      branch,
      basePath: upload.basePath,
      token: input.token!,
      relativePath,
      message,
      content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    });

  await putFile('manifest.json', `${JSON.stringify(input.manifest, null, 2)}\n`);
  await putFile('settings.json', await readFile(join(syncDir, 'settings.json')));

  for (const document of input.manifest.documents) {
    const localJsonPath = join(syncDir, document.jsonPath);
    let snapshot = JSON.parse(await readFile(localJsonPath, 'utf8')) as WorkspaceDocumentSnapshot;
    const remote = await githubGetFile({
      owner: upload.owner,
      repo: upload.repo,
      branch,
      basePath: upload.basePath,
      token: input.token,
      relativePath: document.jsonPath
    });
    if (remote?.content) {
      const remoteSnapshot = tryParseJson<WorkspaceDocumentSnapshot>(remote.content);
      if (remoteSnapshot) {
        snapshot = mergeDocumentSnapshots(remoteSnapshot, snapshot);
        await writeJsonFile(localJsonPath, snapshot);
      }
    }
    await putFile(document.jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    if (document.assetPath) {
      const asset = await readFile(join(syncDir, document.assetPath)).catch(() => undefined);
      if (asset) {
        await putFile(document.assetPath, asset);
      }
    }
  }
}

function safeUploadSettings(upload: Omit<GitHubUploadConfig, 'token'>): Omit<GitHubUploadConfig, 'token'> {
  return {
    enabled: upload.enabled,
    owner: upload.owner,
    repo: upload.repo,
    branch: upload.branch,
    basePath: upload.basePath
  };
}

async function copyFileIfChanged(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const sourceStat = await stat(sourcePath);
  const targetStat = await stat(targetPath).catch(() => undefined);
  if (!targetStat || targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs) {
    await copyFile(sourcePath, targetPath);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}-${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

interface GitHubFileTarget {
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
  token: string;
  relativePath: string;
}

interface GitHubPutFileRequest extends GitHubFileTarget {
  message: string;
  content: Buffer;
}

async function githubGetFile(
  request: GitHubFileTarget,
  options: { includeContent?: boolean } = {}
): Promise<{ sha: string; content?: string } | undefined> {
  const response = await fetch(githubContentsUrl(request), {
    headers: githubHeaders(request.token)
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(await githubErrorMessage(response, request.relativePath));
  }

  const payload = await response.json() as { sha?: string; content?: string; encoding?: string };
  const content = options.includeContent === false || payload.encoding !== 'base64' || !payload.content
    ? undefined
    : Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
  return payload.sha ? { sha: payload.sha, content } : undefined;
}

async function githubPutFile(request: GitHubPutFileRequest): Promise<void> {
  const existing = await githubGetFile(request, { includeContent: false });
  const response = await fetch(githubContentsUrl(request), {
    method: 'PUT',
    headers: {
      ...githubHeaders(request.token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: request.message,
      branch: request.branch,
      content: request.content.toString('base64'),
      ...(existing?.sha ? { sha: existing.sha } : {})
    })
  });

  if (!response.ok) {
    throw new Error(await githubErrorMessage(response, request.relativePath));
  }
}

function githubContentsUrl(request: GitHubFileTarget): string {
  const uploadPath = [normalizeUploadPath(request.basePath), request.relativePath.replace(/^\/+/, '')]
    .filter(Boolean)
    .join('/');
  const encodedPath = uploadPath.split('/').map((part) => encodeURIComponent(part)).join('/');
  const owner = encodeURIComponent(request.owner);
  const repo = encodeURIComponent(request.repo);
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(request.branch)}`;
}

function normalizeUploadPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, '');
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Sidelight',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function githubErrorMessage(response: Response, relativePath: string): Promise<string> {
  const body = await response.text().catch(() => '');
  const detail = body.trim().slice(0, 320);
  return `GitHub sync failed for ${relativePath}: ${response.status} ${response.statusText}${detail ? ` ${detail}` : ''}`;
}

function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function mergeDocumentSnapshots(
  remote: WorkspaceDocumentSnapshot,
  local: WorkspaceDocumentSnapshot
): WorkspaceDocumentSnapshot {
  const remoteDocument = normalizeLibraryDocument(remote.document);
  const localDocument = normalizeLibraryDocument(local.document);
  const document = (remoteDocument.updatedAt ?? '') > (localDocument.updatedAt ?? '')
    ? { ...remoteDocument, filePath: localDocument.filePath, source: localDocument.source }
    : localDocument;

  return {
    ...local,
    updatedAt: new Date().toISOString(),
    document: {
      ...document,
      filePath: ''
    },
    conversations: mergeById(remote.conversations ?? [], local.conversations ?? [], (item) => item.id, updatedAtOf),
    notes: mergeById(remote.notes ?? [], local.notes ?? [], (item) => item.id, updatedAtOf),
    workspaceBlocks: mergeById(remote.workspaceBlocks ?? [], local.workspaceBlocks ?? [], (item) => item.id, updatedAtOf),
    generatedOutlines: mergeById(remote.generatedOutlines ?? [], local.generatedOutlines ?? [], (item) => item.documentId, updatedAtOf),
    marks: mergeById(remote.marks ?? [], local.marks ?? [], (item) => item.id, (item) => item.createdAt),
    bookmarks: mergeById(remote.bookmarks ?? [], local.bookmarks ?? [], (item) => item.id, (item) => item.createdAt),
    readingStates: mergeById(remote.readingStates ?? [], local.readingStates ?? [], (item) => item.documentId, updatedAtOf)
  };
}

function mergeById<T>(
  current: T[],
  incoming: T[],
  idOf: (item: T) => string,
  timestampOf: (item: T) => string | undefined
): T[] {
  const byId = new Map<string, T>();
  for (const item of current) {
    byId.set(idOf(item), item);
  }
  for (const item of incoming) {
    const existing = byId.get(idOf(item));
    if (!existing || (timestampOf(item) ?? '') >= (timestampOf(existing) ?? '')) {
      byId.set(idOf(item), item);
    }
  }
  return Array.from(byId.values());
}

function updatedAtOf(item: { updatedAt?: string; createdAt?: string }): string | undefined {
  return item.updatedAt ?? item.createdAt;
}
