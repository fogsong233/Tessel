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
  WorkspaceBlock,
  WorkspaceSyncMode,
  WorkspaceSyncResult
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

  hydrateDocumentMetadataFromSnapshot(input.store, snapshot, input.documentId, input.contentHash);
  input.store.conversations = mergeById(input.store.conversations, rekey(snapshot.conversations), (item) => item.id, updatedAtOf);
  input.store.notes = mergeById(input.store.notes, rekey(snapshot.notes), (item) => item.id, updatedAtOf);
  input.store.workspaceBlocks = mergeById(input.store.workspaceBlocks, rekey(snapshot.workspaceBlocks), (item) => item.id, updatedAtOf);
  input.store.generatedOutlines = mergeById(input.store.generatedOutlines, rekey(snapshot.generatedOutlines), (item) => item.documentId, updatedAtOf);
  input.store.marks = mergeById(input.store.marks, rekey(snapshot.marks), (item) => item.id, (item) => item.createdAt);
  input.store.bookmarks = mergeById(input.store.bookmarks, rekey(snapshot.bookmarks), (item) => item.id, (item) => item.createdAt);
  input.store.readingStates = mergeById(input.store.readingStates, rekey(snapshot.readingStates), (item) => item.documentId, updatedAtOf);
}

export async function hydrateOpenDocumentsFromSyncSnapshots(input: {
  store: WorkspaceStoreData;
  workspaceDir: string;
}): Promise<void> {
  const documents = [...(input.store.documents ?? [])];
  for (const document of documents) {
    await hydrateDocumentWorkspaceFromSnapshot({
      store: input.store,
      workspaceDir: input.workspaceDir,
      documentId: document.id,
      contentHash: documentContentHash(document)
    });
  }
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
  mergeRemote?: boolean;
  mode: WorkspaceSyncMode;
  token?: string;
}): Promise<WorkspaceSyncResult> {
  const upload = input.store.githubUpload;
  const documentCount = input.manifest.documents.length;
  if (!upload.enabled || !input.token || !upload.owner || !upload.repo) {
    return {
      mode: input.mode,
      status: 'skipped',
      documentCount,
      message: 'GitHub upload is disabled or missing owner, repo, or token.'
    };
  }

  const syncDir = join(input.workspaceDir, 'sync');
  const branch = upload.branch || 'main';
  const message = `Sync Sidelight workspace ${input.manifest.updatedAt}`;
  let manifest = input.manifest;
  const remoteDocuments = new Map<string, WorkspaceDocumentSnapshot>();

  if (input.mergeRemote !== false) {
    const remoteManifestFile = await githubGetFile({
      owner: upload.owner,
      repo: upload.repo,
      branch,
      basePath: upload.basePath,
      token: input.token,
      relativePath: 'manifest.json'
    });
    const remoteManifest = remoteManifestFile?.content
      ? tryParseJson<WorkspaceSyncManifest>(remoteManifestFile.content)
      : undefined;

    if (remoteManifest) {
      manifest = mergeWorkspaceManifests(remoteManifest, input.manifest);
      for (const document of remoteManifest.documents) {
        const remoteFile = await githubGetFile({
          owner: upload.owner,
          repo: upload.repo,
          branch,
          basePath: upload.basePath,
          token: input.token,
          relativePath: document.jsonPath
        });
        if (!remoteFile?.content) {
          continue;
        }

        const remoteSnapshot = tryParseJson<WorkspaceDocumentSnapshot>(remoteFile.content);
        if (remoteSnapshot) {
          remoteDocuments.set(document.jsonPath, remoteSnapshot);
          await writeJsonFile(join(syncDir, document.jsonPath), remoteSnapshot);
        }
      }
    }
  }
  if (manifest !== input.manifest) {
    await writeJsonFile(join(syncDir, 'manifest.json'), manifest);
  }

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

  await putFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  await putFile('settings.json', await readFile(join(syncDir, 'settings.json')));

  for (const document of input.manifest.documents) {
    const localJsonPath = join(syncDir, document.jsonPath);
    let snapshot = JSON.parse(await readFile(localJsonPath, 'utf8')) as WorkspaceDocumentSnapshot;
    const remoteSnapshot = remoteDocuments.get(document.jsonPath);
    if (remoteSnapshot) {
      snapshot = mergeDocumentSnapshots(remoteSnapshot, snapshot);
      await writeJsonFile(localJsonPath, snapshot);
    }
    await putFile(document.jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    if (document.assetPath) {
      const asset = await readFile(join(syncDir, document.assetPath)).catch(() => undefined);
      if (asset) {
        await putFile(document.assetPath, asset);
      }
    }
  }

  return {
    mode: input.mode,
    status: 'uploaded',
    documentCount: manifest.documents.length,
    uploadedAt: input.manifest.updatedAt,
    message: `${input.mode === 'sync' ? 'Synced' : 'Uploaded'} ${manifest.documents.length} document${manifest.documents.length === 1 ? '' : 's'} to GitHub.`
  };
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

function mergeWorkspaceManifests(
  remote: WorkspaceSyncManifest,
  local: WorkspaceSyncManifest
): WorkspaceSyncManifest {
  const documentsByPath = new Map(remote.documents.map((document) => [document.jsonPath, document]));
  for (const document of local.documents) {
    documentsByPath.set(document.jsonPath, document);
  }

  return {
    ...local,
    documents: Array.from(documentsByPath.values()).sort((a, b) => a.title.localeCompare(b.title))
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
  const response = await fetch(githubContentsUrl(request, { ref: true }), {
    headers: githubHeaders(request.token)
  });
  if (response.status === 404) {
    return undefined;
  }
  if (response.status === 409) {
    const body = await response.text().catch(() => '');
    if (isEmptyRepositoryMessage(body)) {
      return undefined;
    }
    throw new Error(githubErrorMessageFromBody(response, request.relativePath, body));
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
  const write = (includeBranch: boolean): Promise<Response> => fetch(githubContentsUrl(request), {
    method: 'PUT',
    headers: {
      ...githubHeaders(request.token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: request.message,
      content: request.content.toString('base64'),
      ...(includeBranch ? { branch: request.branch } : {}),
      ...(existing?.sha ? { sha: existing.sha } : {})
    })
  });

  let response = await write(true);
  if (!response.ok && response.status === 409 && !existing?.sha) {
    const body = await response.text().catch(() => '');
    if (isEmptyRepositoryMessage(body)) {
      response = await write(false);
    } else {
      throw new Error(githubErrorMessageFromBody(response, request.relativePath, body));
    }
  }

  if (!response.ok) {
    throw new Error(await githubErrorMessage(response, request.relativePath));
  }
}

function githubContentsUrl(request: GitHubFileTarget, options: { ref?: boolean } = {}): string {
  const uploadPath = [normalizeUploadPath(request.basePath), request.relativePath.replace(/^\/+/, '')]
    .filter(Boolean)
    .join('/');
  const encodedPath = uploadPath.split('/').map((part) => encodeURIComponent(part)).join('/');
  const owner = encodeURIComponent(request.owner);
  const repo = encodeURIComponent(request.repo);
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  return options.ref ? `${baseUrl}?ref=${encodeURIComponent(request.branch)}` : baseUrl;
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
  return githubErrorMessageFromBody(response, relativePath, body);
}

function githubErrorMessageFromBody(response: Response, relativePath: string, body: string): string {
  const detail = body.trim().slice(0, 320);
  return `GitHub sync failed for ${relativePath}: ${response.status} ${response.statusText}${detail ? ` ${detail}` : ''}`;
}

function isEmptyRepositoryMessage(body: string): boolean {
  return /empty/i.test(body) && /repo|repository|git/i.test(body);
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
  const documentId = localDocument.id;
  const document = (remoteDocument.updatedAt ?? '') > (localDocument.updatedAt ?? '')
    ? { ...remoteDocument, id: documentId, filePath: localDocument.filePath, source: localDocument.source }
    : localDocument;
  const rekey = <T extends { documentId: string }>(items: T[] | undefined): T[] =>
    (items ?? []).map((item) => ({ ...item, documentId }));

  return {
    ...local,
    updatedAt: new Date().toISOString(),
    document: {
      ...document,
      id: documentId,
      filePath: ''
    },
    conversations: mergeById(rekey(remote.conversations), rekey(local.conversations), (item) => item.id, updatedAtOf),
    notes: mergeById(rekey(remote.notes), rekey(local.notes), (item) => item.id, updatedAtOf),
    workspaceBlocks: mergeById(rekey(remote.workspaceBlocks), rekey(local.workspaceBlocks), (item) => item.id, updatedAtOf),
    generatedOutlines: mergeById(rekey(remote.generatedOutlines), rekey(local.generatedOutlines), (item) => item.documentId, updatedAtOf),
    marks: mergeById(rekey(remote.marks), rekey(local.marks), (item) => item.id, (item) => item.createdAt),
    bookmarks: mergeById(rekey(remote.bookmarks), rekey(local.bookmarks), (item) => item.id, (item) => item.createdAt),
    readingStates: mergeById(rekey(remote.readingStates), rekey(local.readingStates), (item) => item.documentId, updatedAtOf)
  };
}

function hydrateDocumentMetadataFromSnapshot(
  store: WorkspaceStoreData,
  snapshot: WorkspaceDocumentSnapshot,
  documentId: string,
  contentHash: string
): void {
  const snapshotDocument = normalizeLibraryDocument({
    ...snapshot.document,
    id: documentId,
    sha256: contentHash,
    fingerprint: {
      ...snapshot.document.fingerprint,
      algorithm: documentHashAlgorithm(snapshot.document),
      hash: contentHash
    }
  });
  const existing = store.documents.find((document) => document.id === documentId);
  const baseDocument = existing && (existing.updatedAt ?? '') >= (snapshotDocument.updatedAt ?? '')
    ? existing
    : snapshotDocument;
  const document = existing
    ? {
        ...baseDocument,
        fileName: existing.fileName || snapshotDocument.fileName,
        filePath: existing.filePath,
        source: existing.source,
        lastOpenedAt: existing.lastOpenedAt
      }
    : {
        ...snapshotDocument,
        filePath: '',
        source: snapshotDocument.source ? { ...snapshotDocument.source, filePath: undefined } : undefined
      };

  store.documents = [
    document,
    ...store.documents.filter((candidate) => candidate.id !== documentId)
  ];
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
