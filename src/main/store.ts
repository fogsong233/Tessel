import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiProviderConfig,
  AppPreferences,
  Conversation,
  defaultAppPreferences,
  defaultAiProvider,
  defaultGitHubUpload,
  GitHubUploadConfig,
  LibraryGroup,
  NoteDocument,
  PdfGeneratedOutline,
  PdfMark,
  PdfDocumentMeta,
  PdfReadingState,
  PdfUserBookmark,
  SafeAiProviderConfig,
  SafeGitHubUploadConfig,
  WorkspaceSyncMode,
  WorkspaceSyncResult,
  WorkspaceBlock
} from '../shared/domain';
import {
  documentHashAlgorithm,
  documentIdForFingerprint,
  identifyLocalDocument,
  normalizeLibraryDocument,
  titleFromFileName
} from './documentIdentity';
import {
  hydrateOpenDocumentsFromSyncSnapshots,
  hydrateDocumentWorkspaceFromSnapshot,
  uploadWorkspaceSyncToGitHub,
  WorkspaceStoreData,
  writeWorkspaceSyncSnapshot
} from './workspaceSync';
import { normalizeWorkspaceBlock } from '../shared/workspacePins';
import { normalizeNoteRange } from '../shared/notes';
import { normalizeSelectionColors } from '../shared/selectionColors';

interface PersistedAiProviderConfig extends Omit<AiProviderConfig, 'apiKey'> {
  encryptedApiKey?: string;
  encryption?: 'safeStorage' | 'plain';
}

interface PersistedGitHubUploadConfig extends Omit<GitHubUploadConfig, 'token'> {
  encryptedToken?: string;
  encryption?: 'safeStorage' | 'plain';
}

interface StoreFile extends WorkspaceStoreData {
  documents: PdfDocumentMeta[];
  libraryGroups: LibraryGroup[];
  conversations: Conversation[];
  notes: NoteDocument[];
  workspaceBlocks: WorkspaceBlock[];
  generatedOutlines: PdfGeneratedOutline[];
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  readingStates: PdfReadingState[];
  aiProvider: PersistedAiProviderConfig;
  githubUpload: PersistedGitHubUploadConfig;
  appPreferences: AppPreferences;
}

const emptyStore = (): StoreFile => ({
  documents: [],
  libraryGroups: [],
  conversations: [],
  notes: [],
  workspaceBlocks: [],
  generatedOutlines: [],
  marks: [],
  bookmarks: [],
  readingStates: [],
  aiProvider: {
    displayName: defaultAiProvider.displayName,
    baseUrl: defaultAiProvider.baseUrl,
    model: defaultAiProvider.model,
    temperature: defaultAiProvider.temperature
  },
  githubUpload: {
    enabled: defaultGitHubUpload.enabled,
    owner: defaultGitHubUpload.owner,
    repo: defaultGitHubUpload.repo,
    branch: defaultGitHubUpload.branch,
    basePath: defaultGitHubUpload.basePath
  },
  appPreferences: defaultAppPreferences
});

export class JsonWorkspaceStore {
  private readonly storePath: string;

  constructor() {
    this.storePath = join(app.getPath('userData'), 'workspace', 'library.json');
  }

  async listDocuments(): Promise<PdfDocumentMeta[]> {
    const store = await this.read();
    return store.documents
      .filter((document) => document.inLibrary !== false)
      .map((document) => withReadingState(document, store.readingStates))
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async listLibraryGroups(): Promise<LibraryGroup[]> {
    const store = await this.read();
    return store.libraryGroups.sort((a, b) => a.name.localeCompare(b.name));
  }

  async saveLibraryGroup(group: LibraryGroup): Promise<LibraryGroup> {
    const store = await this.read();
    const now = new Date().toISOString();
    const normalized: LibraryGroup = {
      ...group,
      name: group.name.trim() || 'Untitled group',
      cloudHeld: Boolean(group.cloudHeld),
      createdAt: group.createdAt || now,
      updatedAt: now
    };
    store.libraryGroups = [
      normalized,
      ...store.libraryGroups.filter((candidate) => candidate.id !== normalized.id)
    ];
    await this.write(store);
    return normalized;
  }

  async deleteLibraryGroup(groupId: string): Promise<void> {
    const store = await this.read();
    store.libraryGroups = store.libraryGroups.filter((group) => group.id !== groupId);
    store.documents = store.documents.map((document) => ({
      ...document,
      groupIds: (document.groupIds ?? []).filter((candidate) => candidate !== groupId)
    }));
    await this.write(store);
  }

  async upsertDocumentFromPdf(filePath: string, options: { addToLibrary?: boolean } = {}): Promise<PdfDocumentMeta> {
    const store = await this.read();
    const now = new Date().toISOString();
    const identity = await identifyLocalDocument(filePath, 'pdf');
    const sha256 = identity.fingerprint.hash;
    const id = documentIdForFingerprint(identity.fingerprint);
    await hydrateDocumentWorkspaceFromSnapshot({
      store,
      workspaceDir: dirname(this.storePath),
      documentId: id,
      contentHash: sha256
    });
    const existing = store.documents.find((document) => document.id === id);

    const nextDocument: PdfDocumentMeta = {
      id,
      title: existing?.title ?? titleFromFileName(identity.fileName),
      fileName: identity.fileName,
      filePath,
      format: identity.format,
      source: {
        kind: 'local-file',
        uri: filePath,
        filePath
      },
      fingerprint: identity.fingerprint,
      sha256,
      hashAlgorithm: identity.fingerprint.algorithm,
      inLibrary: options.addToLibrary ? true : existing?.inLibrary ?? false,
      groupIds: existing?.groupIds ?? [],
      pageCount: existing?.pageCount,
      tags: existing?.tags ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastOpenedAt: now
    };

    store.documents = [
      nextDocument,
      ...store.documents.filter((document) => document.id !== id)
    ];
    await this.write(store);
    return withReadingState(nextDocument, store.readingStates);
  }

  async addDocumentToLibrary(documentId: string): Promise<PdfDocumentMeta> {
    const store = await this.read();
    const document = store.documents.find((candidate) => candidate.id === documentId);
    if (!document) {
      throw new Error('PDF not found');
    }

    const now = new Date().toISOString();
    const nextDocument: PdfDocumentMeta = {
      ...document,
      inLibrary: true,
      groupIds: document.groupIds ?? [],
      updatedAt: now,
      lastOpenedAt: now
    };
    store.documents = [
      nextDocument,
      ...store.documents.filter((candidate) => candidate.id !== documentId)
    ];
    await this.write(store);
    return withReadingState(nextDocument, store.readingStates);
  }

  async updateDocument(document: PdfDocumentMeta): Promise<PdfDocumentMeta> {
    const store = await this.read();
    const { readingState: _readingState, ...documentToPersist } = document;
    const existing = store.documents.find((candidate) => candidate.id === document.id);
    const normalized = normalizeLibraryDocument({
      ...documentToPersist,
      format: documentToPersist.format ?? existing?.format ?? 'pdf',
      source: documentToPersist.source ?? existing?.source,
      fingerprint: documentToPersist.fingerprint ?? existing?.fingerprint,
      sha256: documentToPersist.sha256 || existing?.sha256 || documentToPersist.fingerprint?.hash || document.id.replace(/^doc_/, ''),
      hashAlgorithm: documentToPersist.hashAlgorithm ?? existing?.hashAlgorithm ?? documentHashAlgorithm(documentToPersist),
      inLibrary: documentToPersist.inLibrary ?? existing?.inLibrary ?? true,
      groupIds: documentToPersist.groupIds ?? existing?.groupIds ?? [],
      tags: documentToPersist.tags ?? existing?.tags ?? []
    });
    store.documents = store.documents.map((candidate) =>
      candidate.id === document.id ? normalized : candidate
    );
    await this.write(store);
    return withReadingState(normalized, store.readingStates);
  }

  async getDocument(documentId: string): Promise<PdfDocumentMeta | undefined> {
    const store = await this.read();
    const document = store.documents.find((candidate) => candidate.id === documentId);
    return document ? withReadingState(document, store.readingStates) : undefined;
  }

  async listConversations(documentId: string): Promise<Conversation[]> {
    const store = await this.read();
    return store.conversations
      .filter((conversation) => conversation.documentId === documentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPdfMarks(documentId: string): Promise<PdfMark[]> {
    const store = await this.read();
    return store.marks
      .filter((mark) => mark.documentId === documentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async savePdfMark(mark: PdfMark): Promise<PdfMark> {
    const store = await this.read();
    store.marks = [mark, ...store.marks.filter((candidate) => candidate.id !== mark.id)];
    await this.write(store);
    return mark;
  }

  async deletePdfMark(markId: string): Promise<void> {
    const store = await this.read();
    store.marks = store.marks.filter((mark) => mark.id !== markId);
    await this.write(store);
  }

  async listPdfBookmarks(documentId: string): Promise<PdfUserBookmark[]> {
    const store = await this.read();
    return store.bookmarks
      .filter((bookmark) => bookmark.documentId === documentId)
      .sort((a, b) => a.pageNumber - b.pageNumber || a.createdAt.localeCompare(b.createdAt));
  }

  async savePdfBookmark(bookmark: PdfUserBookmark): Promise<PdfUserBookmark> {
    const store = await this.read();
    store.bookmarks = [bookmark, ...store.bookmarks.filter((candidate) => candidate.id !== bookmark.id)];
    await this.write(store);
    return bookmark;
  }

  async deletePdfBookmark(bookmarkId: string): Promise<void> {
    const store = await this.read();
    store.bookmarks = store.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
    await this.write(store);
  }

  async getGeneratedPdfOutline(documentId: string): Promise<PdfGeneratedOutline | null> {
    const store = await this.read();
    return store.generatedOutlines.find((outline) => outline.documentId === documentId) ?? null;
  }

  async saveGeneratedPdfOutline(outline: PdfGeneratedOutline): Promise<PdfGeneratedOutline> {
    const store = await this.read();
    const now = new Date().toISOString();
    const normalized: PdfGeneratedOutline = {
      ...outline,
      source: 'ai',
      items: normalizeGeneratedOutlineItems(outline.items),
      createdAt: outline.createdAt || now,
      updatedAt: now
    };
    store.generatedOutlines = [
      normalized,
      ...store.generatedOutlines.filter((candidate) => candidate.documentId !== normalized.documentId)
    ];
    await this.write(store);
    return normalized;
  }

  async deleteGeneratedPdfOutline(documentId: string): Promise<void> {
    const store = await this.read();
    store.generatedOutlines = store.generatedOutlines.filter((outline) => outline.documentId !== documentId);
    await this.write(store);
  }

  async getReadingState(documentId: string): Promise<PdfReadingState | null> {
    const store = await this.read();
    return store.readingStates.find((state) => state.documentId === documentId) ?? null;
  }

  async saveReadingState(state: PdfReadingState): Promise<PdfReadingState> {
    const store = await this.read();
    store.readingStates = [
      state,
      ...store.readingStates.filter((candidate) => candidate.documentId !== state.documentId)
    ];
    await this.write(store);
    return state;
  }

  async saveConversation(conversation: Conversation): Promise<Conversation> {
    const store = await this.read();
    store.conversations = [
      conversation,
      ...store.conversations.filter((candidate) => candidate.id !== conversation.id)
    ];
    await this.write(store);
    return conversation;
  }

  async listNotes(documentId: string): Promise<NoteDocument[]> {
    const store = await this.read();
    const document = store.documents.find((candidate) => candidate.id === documentId);
    return store.notes
      .filter((note) => note.documentId === documentId)
      .map((note) => normalizeNoteRange(note, document?.pageCount))
      .sort((a, b) => a.pageStart - b.pageStart || a.pageEnd - b.pageEnd || b.updatedAt.localeCompare(a.updatedAt));
  }

  async getNote(documentId: string): Promise<NoteDocument> {
    const store = await this.read();
    const existing = store.notes.find((note) => note.documentId === documentId && note.id.endsWith(':main'));
    if (existing) {
      const document = store.documents.find((candidate) => candidate.id === documentId);
      return normalizeNoteRange(existing, document?.pageCount);
    }

    const now = new Date().toISOString();
    const document = store.documents.find((candidate) => candidate.id === documentId);
    const note: NoteDocument = {
      id: `${documentId}:main`,
      documentId,
      title: 'Reading notes',
      markdown: '# Reading notes\n\nCapture your own thoughts here. AI-generated drafts can land here later.\n',
      pageStart: 1,
      pageEnd: Math.max(1, document?.pageCount ?? 9999),
      source: 'manual',
      createdAt: now,
      updatedAt: now
    };

    store.notes.push(note);
    await this.write(store);
    return note;
  }

  async saveNote(note: NoteDocument): Promise<NoteDocument> {
    const store = await this.read();
    const document = store.documents.find((candidate) => candidate.id === note.documentId);
    const normalized = normalizeNoteRange(note, document?.pageCount);
    store.notes = [normalized, ...store.notes.filter((candidate) => candidate.id !== normalized.id)];
    await this.write(store);
    return normalized;
  }

  async deleteNote(noteId: string): Promise<void> {
    const store = await this.read();
    store.notes = store.notes.filter((note) => note.id !== noteId);
    store.workspaceBlocks = store.workspaceBlocks.filter(
      (block) => !(block.kind === 'note' && block.sourceId === noteId)
    );
    await this.write(store);
  }

  async listWorkspaceBlocks(documentId: string): Promise<WorkspaceBlock[]> {
    const store = await this.read();
    return store.workspaceBlocks
      .filter((block) => block.documentId === documentId)
      .sort((a, b) => {
        const pageDelta = (a.pageNumber ?? 0) - (b.pageNumber ?? 0);
        return pageDelta || a.y - b.y || a.x - b.x || a.createdAt.localeCompare(b.createdAt);
      });
  }

  async saveWorkspaceBlock(block: WorkspaceBlock): Promise<WorkspaceBlock> {
    const store = await this.read();
    const normalized = normalizeWorkspaceBlock(block);
    store.workspaceBlocks = [
      normalized,
      ...store.workspaceBlocks.filter((candidate) => candidate.id !== normalized.id)
    ];
    await this.write(store);
    return normalized;
  }

  async deleteWorkspaceBlock(blockId: string): Promise<void> {
    const store = await this.read();
    store.workspaceBlocks = store.workspaceBlocks.filter((block) => block.id !== blockId);
    await this.write(store);
  }

  async getAiProviderWithSecret(): Promise<AiProviderConfig> {
    const store = await this.read();
    return {
      displayName: store.aiProvider.displayName,
      baseUrl: store.aiProvider.baseUrl,
      model: store.aiProvider.model,
      temperature: store.aiProvider.temperature,
      apiKey: this.decryptSecret(store.aiProvider.encryptedApiKey, store.aiProvider.encryption)
    };
  }

  async getSafeAiProvider(): Promise<SafeAiProviderConfig> {
    const store = await this.read();
    return {
      displayName: store.aiProvider.displayName,
      baseUrl: store.aiProvider.baseUrl,
      model: store.aiProvider.model,
      temperature: store.aiProvider.temperature,
      hasApiKey: Boolean(store.aiProvider.encryptedApiKey)
    };
  }

  async saveAiProvider(config: AiProviderConfig): Promise<SafeAiProviderConfig> {
    const store = await this.read();
    const encrypted = config.apiKey?.trim()
      ? this.encryptSecret(config.apiKey)
      : {
          value: store.aiProvider.encryptedApiKey,
          encryption: store.aiProvider.encryption
        };
    store.aiProvider = {
      displayName: config.displayName,
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: config.temperature,
      encryptedApiKey: encrypted.value,
      encryption: encrypted.encryption
    };
    await this.write(store);
    return this.getSafeAiProvider();
  }

  async getSafeGitHubUpload(): Promise<SafeGitHubUploadConfig> {
    const store = await this.read();
    return {
      enabled: store.githubUpload.enabled,
      owner: store.githubUpload.owner,
      repo: store.githubUpload.repo,
      branch: store.githubUpload.branch,
      basePath: store.githubUpload.basePath,
      hasToken: Boolean(store.githubUpload.encryptedToken)
    };
  }

  async saveGitHubUpload(config: GitHubUploadConfig): Promise<SafeGitHubUploadConfig> {
    const store = await this.read();
    const encrypted = config.token?.trim()
      ? this.encryptSecret(config.token)
      : {
          value: store.githubUpload.encryptedToken,
          encryption: store.githubUpload.encryption
        };
    store.githubUpload = {
      enabled: config.enabled,
      owner: config.owner.trim(),
      repo: config.repo.trim(),
      branch: config.branch.trim() || defaultGitHubUpload.branch,
      basePath: normalizeUploadPath(config.basePath),
      encryptedToken: encrypted.value,
      encryption: encrypted.encryption
    };
    await this.write(store);
    return this.getSafeGitHubUpload();
  }

  async getAppPreferences(): Promise<AppPreferences> {
    const store = await this.read();
    return store.appPreferences;
  }

  async saveAppPreferences(config: AppPreferences): Promise<AppPreferences> {
    const store = await this.read();
    store.appPreferences = normalizeAppPreferences(config);
    await this.write(store);
    return store.appPreferences;
  }

  async syncWorkspace(): Promise<WorkspaceSyncResult> {
    return this.syncWorkspaceToGitHub('sync');
  }

  async uploadWorkspace(): Promise<WorkspaceSyncResult> {
    return this.syncWorkspaceToGitHub('upload');
  }

  private async syncWorkspaceToGitHub(mode: WorkspaceSyncMode): Promise<WorkspaceSyncResult> {
    const store = await this.read();
    const workspaceDir = dirname(this.storePath);
    const manifest = await writeWorkspaceSyncSnapshot({ store, workspaceDir });
    const result = await uploadWorkspaceSyncToGitHub({
      store,
      workspaceDir,
      manifest,
      mergeRemote: mode === 'sync',
      mode,
      token: this.decryptSecret(store.githubUpload.encryptedToken, store.githubUpload.encryption)
    });
    await hydrateOpenDocumentsFromSyncSnapshots({ store, workspaceDir });
    await this.write(store);
    return result;
  }

  private async read(): Promise<StoreFile> {
    await mkdir(dirname(this.storePath), { recursive: true });

    try {
      const raw = await readFile(this.storePath, 'utf8');
      const fallback = emptyStore();
      const parsed = { ...fallback, ...JSON.parse(raw) } as StoreFile;
      return {
        ...parsed,
        documents: (parsed.documents ?? fallback.documents).map((document) => normalizeLibraryDocument(document)),
        libraryGroups: parsed.libraryGroups ?? fallback.libraryGroups,
        aiProvider: { ...fallback.aiProvider, ...parsed.aiProvider },
        githubUpload: { ...fallback.githubUpload, ...parsed.githubUpload },
        appPreferences: normalizeAppPreferences({ ...fallback.appPreferences, ...parsed.appPreferences }),
        workspaceBlocks: parsed.workspaceBlocks ?? fallback.workspaceBlocks,
        generatedOutlines: parsed.generatedOutlines ?? fallback.generatedOutlines
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const fresh = emptyStore();
        await this.write(fresh);
        return fresh;
      }

      if (error instanceof SyntaxError) {
        const fresh = emptyStore();
        const backupPath = join(
          dirname(this.storePath),
          `library.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        );
        await rename(this.storePath, backupPath).catch(() => undefined);
        await this.write(fresh);
        console.warn(`Workspace store was invalid JSON. Backed up to ${backupPath}`);
        return fresh;
      }

      throw error;
    }
  }

  private async write(store: StoreFile): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    const tmpPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await rename(tmpPath, this.storePath);
    await writeWorkspaceSyncSnapshot({ store, workspaceDir: dirname(this.storePath) });
  }

  private encryptSecret(secret: string | undefined): { value?: string; encryption?: 'safeStorage' | 'plain' } {
    if (!secret?.trim()) {
      return {};
    }

    if (safeStorage.isEncryptionAvailable()) {
      return {
        value: safeStorage.encryptString(secret.trim()).toString('base64'),
        encryption: 'safeStorage'
      };
    }

    // This fallback keeps dev builds usable on machines where OS encryption is disabled.
    return {
      value: Buffer.from(secret.trim(), 'utf8').toString('base64'),
      encryption: 'plain'
    };
  }

  private decryptSecret(value: string | undefined, encryption: 'safeStorage' | 'plain' | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    if (encryption === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    }

    return Buffer.from(value, 'base64').toString('utf8');
  }
}

function normalizeUploadPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
  return trimmed || defaultGitHubUpload.basePath;
}

function normalizeAiLanguage(language: string): AppPreferences['aiLanguage'] {
  if (language === 'English') {
    return 'English';
  }

  if (language === 'Chinese') {
    return 'Chinese';
  }

  return 'Simplified Chinese';
}

function normalizeAppPreferences(config: AppPreferences): AppPreferences {
  return {
    uiLanguage: config.uiLanguage === 'zh-CN' ? 'zh-CN' : 'en',
    aiLanguage: normalizeAiLanguage(config.aiLanguage),
    selectionColors: normalizeSelectionColors(config.selectionColors)
  };
}

function normalizeGeneratedOutlineItems(items: PdfGeneratedOutline['items']): PdfGeneratedOutline['items'] {
  return (items ?? [])
    .map((item, index) => {
      const title = String(item.title ?? '').replace(/\s+/g, ' ').trim();
      const pageNumber = Number(item.pageNumber);
      return {
        id: item.id || `outline_${index + 1}`,
        title,
        level: Math.max(0, Math.min(6, Math.floor(Number(item.level) || 0))),
        ...(Number.isFinite(pageNumber) && pageNumber > 0 ? { pageNumber: Math.floor(pageNumber) } : {})
      };
    })
    .filter((item) => item.title)
    .slice(0, 240);
}

function withReadingState(document: PdfDocumentMeta, readingStates: PdfReadingState[]): PdfDocumentMeta {
  return {
    ...document,
    readingState: readingStates.find((state) => state.documentId === document.id)
  };
}
