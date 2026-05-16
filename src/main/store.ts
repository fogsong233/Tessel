import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  AiProviderConfig,
  Conversation,
  defaultAiProvider,
  NoteDocument,
  PdfMark,
  PdfDocumentMeta,
  PdfReadingState,
  PdfUserBookmark,
  SafeAiProviderConfig
} from '../shared/domain';

interface PersistedAiProviderConfig extends Omit<AiProviderConfig, 'apiKey'> {
  encryptedApiKey?: string;
  encryption?: 'safeStorage' | 'plain';
}

interface StoreFile {
  documents: PdfDocumentMeta[];
  conversations: Conversation[];
  notes: NoteDocument[];
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  readingStates: PdfReadingState[];
  aiProvider: PersistedAiProviderConfig;
}

const emptyStore = (): StoreFile => ({
  documents: [],
  conversations: [],
  notes: [],
  marks: [],
  bookmarks: [],
  readingStates: [],
  aiProvider: {
    displayName: defaultAiProvider.displayName,
    baseUrl: defaultAiProvider.baseUrl,
    model: defaultAiProvider.model,
    temperature: defaultAiProvider.temperature
  }
});

export class JsonWorkspaceStore {
  private readonly storePath: string;

  constructor() {
    this.storePath = join(app.getPath('userData'), 'workspace', 'library.json');
  }

  async listDocuments(): Promise<PdfDocumentMeta[]> {
    const store = await this.read();
    return [...store.documents].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async upsertDocumentFromPdf(filePath: string): Promise<PdfDocumentMeta> {
    const store = await this.read();
    const now = new Date().toISOString();
    const fileStat = await stat(filePath);
    const sha256 = createHash('sha256')
      .update(`${filePath}:${fileStat.size}:${fileStat.mtimeMs}`)
      .digest('hex');
    const id = `doc_${sha256.slice(0, 16)}`;
    const existing = store.documents.find((document) => document.id === id);
    const fileName = basename(filePath);

    const nextDocument: PdfDocumentMeta = {
      id,
      title: existing?.title ?? fileName.replace(/\.pdf$/i, ''),
      fileName,
      filePath,
      sha256,
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
    return nextDocument;
  }

  async updateDocument(document: PdfDocumentMeta): Promise<PdfDocumentMeta> {
    const store = await this.read();
    store.documents = store.documents.map((candidate) =>
      candidate.id === document.id ? document : candidate
    );
    await this.write(store);
    return document;
  }

  async getDocument(documentId: string): Promise<PdfDocumentMeta | undefined> {
    const store = await this.read();
    return store.documents.find((document) => document.id === documentId);
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

  async getNote(documentId: string): Promise<NoteDocument> {
    const store = await this.read();
    const existing = store.notes.find((note) => note.documentId === documentId && note.id.endsWith(':main'));
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const note: NoteDocument = {
      id: `${documentId}:main`,
      documentId,
      title: 'Reading notes',
      markdown: '# Reading notes\n\nCapture your own thoughts here. AI-generated drafts can land here later.\n',
      createdAt: now,
      updatedAt: now
    };

    store.notes.push(note);
    await this.write(store);
    return note;
  }

  async saveNote(note: NoteDocument): Promise<NoteDocument> {
    const store = await this.read();
    store.notes = [note, ...store.notes.filter((candidate) => candidate.id !== note.id)];
    await this.write(store);
    return note;
  }

  async getAiProviderWithSecret(): Promise<AiProviderConfig> {
    const store = await this.read();
    return {
      displayName: store.aiProvider.displayName,
      baseUrl: store.aiProvider.baseUrl,
      model: store.aiProvider.model,
      temperature: store.aiProvider.temperature,
      apiKey: this.decryptApiKey(store.aiProvider)
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
      ? this.encryptApiKey(config.apiKey)
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

  private async read(): Promise<StoreFile> {
    await mkdir(join(app.getPath('userData'), 'workspace'), { recursive: true });

    try {
      const raw = await readFile(this.storePath, 'utf8');
      return { ...emptyStore(), ...JSON.parse(raw) } as StoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const fresh = emptyStore();
        await this.write(fresh);
        return fresh;
      }

      throw error;
    }
  }

  private async write(store: StoreFile): Promise<void> {
    await mkdir(join(app.getPath('userData'), 'workspace'), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  }

  private encryptApiKey(apiKey: string | undefined): { value?: string; encryption?: 'safeStorage' | 'plain' } {
    if (!apiKey?.trim()) {
      return {};
    }

    if (safeStorage.isEncryptionAvailable()) {
      return {
        value: safeStorage.encryptString(apiKey.trim()).toString('base64'),
        encryption: 'safeStorage'
      };
    }

    // This fallback keeps dev builds usable on machines where OS encryption is disabled.
    return {
      value: Buffer.from(apiKey.trim(), 'utf8').toString('base64'),
      encryption: 'plain'
    };
  }

  private decryptApiKey(config: PersistedAiProviderConfig): string | undefined {
    if (!config.encryptedApiKey) {
      return undefined;
    }

    if (config.encryption === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(config.encryptedApiKey, 'base64'));
    }

    return Buffer.from(config.encryptedApiKey, 'base64').toString('utf8');
  }
}
