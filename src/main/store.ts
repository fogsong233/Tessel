import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiProviderConfig,
  AppPreferences,
  Conversation,
  TranslationEntry,
  defaultAppPreferences,
  defaultAiProvider,
  defaultGitHubUpload,
  defaultWebDavSync,
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
  SafeWebDavSyncConfig,
  MetadataSyncResult,
  WebDavSyncConfig,
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
import { normalizeWorkspaceBlock } from '../shared/workspacePins';
import { normalizeNoteRange } from '../shared/notes';
import { normalizeSelectionColors } from '../shared/selectionColors';
import { renameWithTransientRetry } from './fileWrites';
import { PdfSessionSnapshot, syncPdfSessionToWebDav } from './webdavSync';

interface PersistedAiProviderConfig extends Omit<AiProviderConfig, 'apiKey'> {
  encryptedApiKey?: string;
  encryption?: 'safeStorage' | 'plain';
}

interface PersistedGitHubUploadConfig extends Omit<GitHubUploadConfig, 'token'> {
  encryptedToken?: string;
  encryption?: 'safeStorage' | 'plain';
}

interface PersistedWebDavSyncConfig extends Omit<WebDavSyncConfig, 'password'> {
  encryptedPassword?: string;
  encryption?: 'safeStorage' | 'plain';
}

interface StoreFile {
  documents: PdfDocumentMeta[];
  libraryGroups: LibraryGroup[];
  conversations: Conversation[];
  translations: TranslationEntry[];
  notes: NoteDocument[];
  workspaceBlocks: WorkspaceBlock[];
  generatedOutlines: PdfGeneratedOutline[];
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  readingStates: PdfReadingState[];
  aiProvider: PersistedAiProviderConfig;
  githubUpload: PersistedGitHubUploadConfig;
  webDavSync: PersistedWebDavSyncConfig;
  appPreferences: AppPreferences;
}

const emptyStore = (): StoreFile => ({
  documents: [],
  libraryGroups: [],
  conversations: [],
  translations: [],
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
  webDavSync: {
    enabled: defaultWebDavSync.enabled,
    baseUrl: defaultWebDavSync.baseUrl,
    basePath: defaultWebDavSync.basePath,
    username: defaultWebDavSync.username
  },
  appPreferences: defaultAppPreferences
});

export class JsonWorkspaceStore {
  private readonly storePath: string;
  private readonly metadataSyncQueues = new Map<string, Promise<void>>();

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
    const existing = store.documents.find((document) => document.id === id);
    // A one-time migration keeps existing chats when an older build used a
    // sampled fingerprint for the same local file.
    const legacy = existing ? undefined : store.documents.find((document) => document.filePath === filePath);
    if (legacy) {
      rekeyDocumentSession(store, legacy.id, id);
    }
    const persisted = existing ?? legacy;

    const nextDocument: PdfDocumentMeta = {
      id,
      title: persisted?.title ?? titleFromFileName(identity.fileName),
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
      inLibrary: options.addToLibrary ? true : persisted?.inLibrary ?? true,
      groupIds: [],
      pageCount: persisted?.pageCount,
      tags: [],
      createdAt: persisted?.createdAt ?? now,
      updatedAt: now,
      lastOpenedAt: now
    };

    store.documents = [
      nextDocument,
      ...store.documents.filter((document) => document.id !== id && document.id !== legacy?.id)
    ];
    await this.write(store);
    await this.syncDocumentMetadata(id).catch((error: unknown) => {
      console.warn('WebDAV metadata sync failed while opening PDF', error);
    });
    const refreshed = await this.getDocument(id);
    return refreshed ?? withReadingState(nextDocument, store.readingStates);
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
    const existing = store.readingStates.find((candidate) => candidate.documentId === state.documentId);
    if (existing && existing.updatedAt > state.updatedAt) {
      return existing;
    }
    store.readingStates = [
      state,
      ...store.readingStates.filter((candidate) => candidate.documentId !== state.documentId)
    ];
    await this.write(store);
    this.queueDocumentMetadataSync(state.documentId);
    return state;
  }

  async saveConversation(conversation: Conversation): Promise<Conversation> {
    const store = await this.read();
    store.conversations = [
      conversation,
      ...store.conversations.filter((candidate) => candidate.id !== conversation.id)
    ];
    await this.write(store);
    this.queueDocumentMetadataSync(conversation.documentId);
    return conversation;
  }

  async listTranslations(documentId: string): Promise<TranslationEntry[]> {
    const store = await this.read();
    return store.translations
      .filter((translation) => translation.documentId === documentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveTranslation(translation: TranslationEntry): Promise<TranslationEntry> {
    const store = await this.read();
    const others = store.translations.filter((candidate) => candidate.id !== translation.id);
    const documentTranslations = [translation, ...others.filter((candidate) => candidate.documentId === translation.documentId)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);
    store.translations = [
      ...documentTranslations,
      ...others.filter((candidate) => candidate.documentId !== translation.documentId)
    ];
    await this.write(store);
    this.queueDocumentMetadataSync(translation.documentId);
    return translation;
  }

  async deleteTranslation(translationId: string): Promise<void> {
    const store = await this.read();
    const translation = store.translations.find((candidate) => candidate.id === translationId);
    store.translations = store.translations.filter((candidate) => candidate.id !== translationId);
    await this.write(store);
    if (translation) {
      this.queueDocumentMetadataSync(translation.documentId);
    }
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

  async getSafeWebDavSync(): Promise<SafeWebDavSyncConfig> {
    const store = await this.read();
    return {
      enabled: store.webDavSync.enabled,
      baseUrl: store.webDavSync.baseUrl,
      basePath: store.webDavSync.basePath,
      username: store.webDavSync.username,
      hasPassword: Boolean(store.webDavSync.encryptedPassword)
    };
  }

  async saveWebDavSync(config: WebDavSyncConfig): Promise<SafeWebDavSyncConfig> {
    const store = await this.read();
    const encrypted = config.password?.trim()
      ? this.encryptSecret(config.password)
      : {
          value: store.webDavSync.encryptedPassword,
          encryption: store.webDavSync.encryption
        };
    store.webDavSync = {
      enabled: Boolean(config.enabled),
      baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
      basePath: normalizeWebDavPath(config.basePath),
      username: config.username.trim(),
      encryptedPassword: encrypted.value,
      encryption: encrypted.encryption
    };
    await this.write(store);
    return this.getSafeWebDavSync();
  }

  async syncDocumentMetadata(documentId: string): Promise<MetadataSyncResult> {
    const store = await this.read();
    const document = store.documents.find((candidate) => candidate.id === documentId);
    if (!document) {
      throw new Error('PDF not found');
    }

    const config = store.webDavSync;
    const password = this.decryptSecret(config.encryptedPassword, config.encryption);
    if (!config.enabled || !config.baseUrl || !password) {
      return {
        status: 'skipped',
        documentId,
        message: 'WebDAV metadata sync is disabled or incomplete.'
      };
    }

    const documentHash = document.fingerprint?.hash ?? document.sha256;
    const local = this.snapshotForDocument(store, documentId, documentHash);
    const merged = await syncPdfSessionToWebDav({
      config: {
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        basePath: config.basePath,
        username: config.username,
        password
      },
      documentHash,
      local
    });
    this.applySessionSnapshot(store, documentId, merged);
    await this.write(store);
    return {
      status: 'synced',
      documentId,
      syncedAt: merged.updatedAt,
      message: 'PDF reading progress and chats synced through WebDAV.'
    };
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
    return {
      mode: 'sync',
      status: 'skipped',
      documentCount: 0,
      message: 'GitHub workspace sync has been removed. Configure WebDAV metadata sync instead.'
    };
  }

  async uploadWorkspace(): Promise<WorkspaceSyncResult> {
    return {
      mode: 'upload',
      status: 'skipped',
      documentCount: 0,
      message: 'PDF files are not uploaded by the reader.'
    };
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
        webDavSync: { ...fallback.webDavSync, ...parsed.webDavSync },
        appPreferences: normalizeAppPreferences({ ...fallback.appPreferences, ...parsed.appPreferences }),
        translations: parsed.translations ?? fallback.translations,
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
    await renameWithTransientRetry(tmpPath, this.storePath);
  }

  private queueDocumentMetadataSync(documentId: string): void {
    const previous = this.metadataSyncQueues.get(documentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.syncDocumentMetadata(documentId))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.warn(`WebDAV metadata sync failed for ${documentId}`, error);
      });
    this.metadataSyncQueues.set(documentId, next);
    void next.finally(() => {
      if (this.metadataSyncQueues.get(documentId) === next) {
        this.metadataSyncQueues.delete(documentId);
      }
    });
  }

  private snapshotForDocument(store: StoreFile, documentId: string, documentHash: string): PdfSessionSnapshot {
    const readingState = store.readingStates.find((state) => state.documentId === documentId);
    const conversations = store.conversations.filter((conversation) => conversation.documentId === documentId);
    const translations = store.translations
      .filter((translation) => translation.documentId === documentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10);
    const latestConversationUpdate = conversations.map((conversation) => conversation.updatedAt).sort().at(-1);
    const latestTranslationUpdate = translations.map((translation) => translation.updatedAt).sort().at(-1);
    return {
      version: 1,
      documentHash,
      updatedAt: [readingState?.updatedAt, latestConversationUpdate, latestTranslationUpdate, new Date().toISOString()]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1)!,
      readingState,
      conversations,
      translations
    };
  }

  private applySessionSnapshot(store: StoreFile, documentId: string, snapshot: PdfSessionSnapshot): void {
    if (snapshot.readingState) {
      store.readingStates = [
        { ...snapshot.readingState, documentId },
        ...store.readingStates.filter((state) => state.documentId !== documentId)
      ];
    }

    const remoteConversationIds = new Set(snapshot.conversations.map((conversation) => conversation.id));
    store.conversations = [
      ...snapshot.conversations.map((conversation) => ({ ...conversation, documentId })),
      ...store.conversations.filter((conversation) => conversation.documentId !== documentId || !remoteConversationIds.has(conversation.id))
    ];

    const remoteTranslationIds = new Set(snapshot.translations.map((translation) => translation.id));
    store.translations = [
      ...snapshot.translations.map((translation) => ({ ...translation, documentId })).slice(0, 10),
      ...store.translations.filter((translation) => translation.documentId !== documentId || !remoteTranslationIds.has(translation.id))
    ];
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

function normalizeWebDavPath(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  return normalized || defaultWebDavSync.basePath;
}

function rekeyDocumentSession(store: StoreFile, previousId: string, nextId: string): void {
  const rekey = <T extends { documentId: string }>(items: T[]): T[] =>
    items.map((item) => item.documentId === previousId ? { ...item, documentId: nextId } : item);

  store.conversations = rekey(store.conversations);
  store.translations = rekey(store.translations);
  store.notes = rekey(store.notes);
  store.workspaceBlocks = rekey(store.workspaceBlocks);
  store.generatedOutlines = rekey(store.generatedOutlines);
  store.marks = rekey(store.marks);
  store.bookmarks = rekey(store.bookmarks);
  store.readingStates = rekey(store.readingStates);
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
    translationBackend: config.translationBackend === 'codex' ? 'codex' : 'provider',
    sidebarColor: normalizeSidebarColor(config.sidebarColor),
    selectionColors: normalizeSelectionColors(config.selectionColors),
    appearance: normalizeAppearancePreferences(config.appearance),
    experimentalCodexAgent: {
      enabled: Boolean(config.experimentalCodexAgent?.enabled),
      ...(config.experimentalCodexAgent?.executablePath?.trim()
        ? { executablePath: config.experimentalCodexAgent.executablePath.trim() }
        : {}),
      ...(config.experimentalCodexAgent?.chatModel?.trim()
        ? { chatModel: config.experimentalCodexAgent.chatModel.trim() }
        : config.experimentalCodexAgent?.model?.trim()
          ? { chatModel: config.experimentalCodexAgent.model.trim() }
          : {}),
      ...(config.experimentalCodexAgent?.translationModel?.trim()
        ? { translationModel: config.experimentalCodexAgent.translationModel.trim() }
        : {}),
      ...(config.experimentalCodexAgent?.chatReasoningEffort?.trim()
        ? { chatReasoningEffort: config.experimentalCodexAgent.chatReasoningEffort.trim() }
        : {}),
      ...(config.experimentalCodexAgent?.translationReasoningEffort?.trim()
        ? { translationReasoningEffort: config.experimentalCodexAgent.translationReasoningEffort.trim() }
        : {})
    }
  };
}

function normalizeAppearancePreferences(config: AppPreferences['appearance'] | undefined): AppPreferences['appearance'] {
  const defaults = defaultAppPreferences.appearance;
  const normalizeFont = (value: unknown): AppPreferences['appearance']['uiFont'] =>
    value === 'serif' || value === 'rounded' || value === 'mono' || value === 'system' ? value : defaults.uiFont;
  const normalizeSize = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(11, Math.min(20, Math.round(parsed))) : fallback;
  };

  return {
    uiFont: normalizeFont(config?.uiFont),
    agentFont: normalizeFont(config?.agentFont),
    codeFont: normalizeFont(config?.codeFont),
    uiFontSize: normalizeSize(config?.uiFontSize, defaults.uiFontSize),
    agentFontSize: normalizeSize(config?.agentFontSize, defaults.agentFontSize),
    codeFontSize: normalizeSize(config?.codeFontSize, defaults.codeFontSize)
  };
}

function normalizeSidebarColor(value: unknown): string {
  const color = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : defaultAppPreferences.sidebarColor;
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
