import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { open, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AiCompletionRequest,
  AiStreamEvent,
  AiStreamRequest,
  AiProviderConfig,
  AppPreferences,
  Conversation,
  GitHubUploadConfig,
  LibraryGroup,
  NoteDocument,
  PdfGeneratedOutline,
  PdfDocumentMeta,
  PdfMark,
  PdfRangeRequest,
  PdfReadingState,
  PdfSourceDescriptor,
  PdfUserBookmark,
  WorkspaceBlock,
  pdfRangeChunkSize
} from '../shared/domain';
import { AiService } from './aiService';
import { extractPdfPageTextRange, readPdfOutline } from './pdfTools';
import { JsonWorkspaceStore } from './store';

if (process.env.SIDELIGHT_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.SIDELIGHT_REMOTE_DEBUG_PORT);
}

app.commandLine.appendSwitch('disable-http-cache');

if (process.env.SIDELIGHT_USER_DATA_DIR) {
  app.setPath('userData', process.env.SIDELIGHT_USER_DATA_DIR);
}

const hideE2eWindows = process.env.SIDELIGHT_E2E_HIDE_WINDOWS === '1';
const pendingSystemPdfPaths: string[] = [];
let handleSystemPdfOpen: ((filePath: string) => Promise<void>) | undefined;

const shouldUseSingleInstanceLock = !hideE2eWindows;
const hasSingleInstanceLock = !shouldUseSingleInstanceLock || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueSystemPdfOpen(filePath);
});

if (shouldUseSingleInstanceLock && hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    const pdfPaths = pdfPathsFromArgv(argv);
    if (pdfPaths.length === 0) {
      focusFirstWindow();
      return;
    }

    for (const filePath of pdfPaths) {
      queueSystemPdfOpen(filePath);
    }
  });
}

function createWindow(options: { documentId?: string } = {}): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: options.documentId ? 'Sidelight Reader' : 'Sidelight Library',
    backgroundColor: '#f3f3f3',
    paintWhenInitiallyHidden: true,
    show: !hideE2eWindows,
    skipTaskbar: hideE2eWindows,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      backgroundThrottling: !hideE2eWindows,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[renderer:load-failed] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer:gone] ${details.reason} exitCode=${details.exitCode}`);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (options.documentId) {
      rendererUrl.searchParams.set('documentId', options.documentId);
    }
    void mainWindow.loadURL(rendererUrl.toString());
  } else {
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      options.documentId ? { query: { documentId: options.documentId } } : undefined
    );
  }

  return mainWindow;
}

function registerIpc(store: JsonWorkspaceStore, aiService: AiService): void {
  const activeAiStreams = new Map<string, AbortController>();
  const broadcastLibraryChanged = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send('library:changed');
      }
    }
  };
  const openPdfPath = async (filePath: string) => {
    const result = await openPdfDocumentPath(store, filePath);
    broadcastLibraryChanged();
    return result;
  };

  handleSystemPdfOpen = async (filePath: string): Promise<void> => {
    try {
      await openPdfPath(filePath);
    } catch (error) {
      console.error(`Could not open PDF from system request: ${filePath}`, error);
      focusFirstWindow();
    }
  };

  ipcMain.handle('library:listDocuments', () => store.listDocuments());
  ipcMain.handle('library:listGroups', () => store.listLibraryGroups());
  ipcMain.handle('library:saveGroup', async (_event, input: { group: LibraryGroup }) => {
    const saved = await store.saveLibraryGroup(input.group);
    broadcastLibraryChanged();
    return saved;
  });
  ipcMain.handle('library:deleteGroup', async (_event, groupId: string) => {
    await store.deleteLibraryGroup(groupId);
    broadcastLibraryChanged();
  });

  ipcMain.handle('pdf:open', async () => {
    const filePath = process.env.SIDELIGHT_TEST_OPEN_PDF ?? (await pickPdfFile());
    if (!filePath) {
      return null;
    }

    return openPdfPath(filePath);
  });

  ipcMain.handle('window:openDocument', async (_event, documentId: string) => {
    const document = await store.getDocument(documentId);
    if (!document) {
      return null;
    }

    createWindow({ documentId });
    return document;
  });

  ipcMain.handle('pdf:load', async (_event, documentId: string) => {
    const document = await store.getDocument(documentId);
    if (!document) {
      return null;
    }

    const now = new Date().toISOString();
    const updatedDocument = await store.updateDocument({
      ...document,
      updatedAt: now,
      lastOpenedAt: now
    });

    return {
      document: updatedDocument,
      source: await pdfSourceForDocument(updatedDocument)
    };
  });
  ipcMain.handle('pdf:addToLibrary', async (_event, documentId: string) => {
    const saved = await store.addDocumentToLibrary(documentId);
    broadcastLibraryChanged();
    return saved;
  });
  ipcMain.handle('pdf:updateDocument', async (_event, document: PdfDocumentMeta) => {
    const saved = await store.updateDocument(document);
    broadcastLibraryChanged();
    return saved;
  });

  ipcMain.handle('pdf:readRange', async (_event, request: PdfRangeRequest) => {
    const document = await store.getDocument(request.documentId);
    if (!document) {
      throw new Error('PDF not found');
    }

    const fileStat = await stat(document.filePath);
    const begin = Math.max(0, Math.min(request.begin, fileStat.size));
    const end = Math.max(begin, Math.min(request.end, fileStat.size));
    return readFileRange(document.filePath, begin, end);
  });

  ipcMain.handle('pdf:listMarks', (_event, documentId: string) => store.listPdfMarks(documentId));
  ipcMain.handle('pdf:saveMark', (_event, input: { mark: PdfMark }) => store.savePdfMark(input.mark));
  ipcMain.handle('pdf:deleteMark', (_event, markId: string) => store.deletePdfMark(markId));
  ipcMain.handle('pdf:listBookmarks', (_event, documentId: string) => store.listPdfBookmarks(documentId));
  ipcMain.handle('pdf:saveBookmark', (_event, input: { bookmark: PdfUserBookmark }) =>
    store.savePdfBookmark(input.bookmark)
  );
  ipcMain.handle('pdf:deleteBookmark', (_event, bookmarkId: string) => store.deletePdfBookmark(bookmarkId));
  ipcMain.handle('pdf:getGeneratedOutline', (_event, documentId: string) => store.getGeneratedPdfOutline(documentId));
  ipcMain.handle('pdf:saveGeneratedOutline', async (_event, input: { outline: PdfGeneratedOutline }) => {
    const saved = await store.saveGeneratedPdfOutline(input.outline);
    broadcastLibraryChanged();
    return saved;
  });
  ipcMain.handle('pdf:deleteGeneratedOutline', async (_event, documentId: string) => {
    await store.deleteGeneratedPdfOutline(documentId);
    broadcastLibraryChanged();
  });
  ipcMain.handle('pdf:getReadingState', (_event, documentId: string) => store.getReadingState(documentId));
  ipcMain.handle('pdf:saveReadingState', async (_event, state: PdfReadingState) => {
    const saved = await store.saveReadingState(state);
    broadcastLibraryChanged();
    return saved;
  });

  ipcMain.handle('conversation:list', (_event, documentId: string) => store.listConversations(documentId));
  ipcMain.handle('conversation:save', (_event, input: { conversation: Conversation }) =>
    store.saveConversation(input.conversation)
  );

  ipcMain.handle('note:get', (_event, documentId: string) => store.getNote(documentId));
  ipcMain.handle('note:list', (_event, documentId: string) => store.listNotes(documentId));
  ipcMain.handle('note:save', (_event, input: { note: NoteDocument }) => store.saveNote(input.note));
  ipcMain.handle('note:delete', async (_event, noteId: string) => {
    await store.deleteNote(noteId);
    broadcastLibraryChanged();
  });
  ipcMain.handle('workspaceBlock:list', (_event, documentId: string) => store.listWorkspaceBlocks(documentId));
  ipcMain.handle('workspaceBlock:save', async (_event, input: { block: WorkspaceBlock }) => {
    const saved = await store.saveWorkspaceBlock(input.block);
    broadcastLibraryChanged();
    return saved;
  });
  ipcMain.handle('workspaceBlock:delete', async (_event, blockId: string) => {
    await store.deleteWorkspaceBlock(blockId);
    broadcastLibraryChanged();
  });

  ipcMain.handle('settings:getAiProvider', () => store.getSafeAiProvider());
  ipcMain.handle('settings:saveAiProvider', (_event, config: AiProviderConfig) => store.saveAiProvider(config));
  ipcMain.handle('settings:getGitHubUpload', () => store.getSafeGitHubUpload());
  ipcMain.handle('settings:saveGitHubUpload', (_event, config: GitHubUploadConfig) => store.saveGitHubUpload(config));
  ipcMain.handle('settings:getAppPreferences', () => store.getAppPreferences());
  ipcMain.handle('settings:saveAppPreferences', (_event, config: AppPreferences) => store.saveAppPreferences(config));
  ipcMain.handle('sync:workspace', () => store.syncWorkspace());
  ipcMain.handle('sync:uploadWorkspace', () => store.uploadWorkspace());
  ipcMain.handle('ai:listModels', async (_event, config: AiProviderConfig) => {
    const stored = await store.getAiProviderWithSecret();
    return aiService.listModels({
      displayName: config.displayName || stored.displayName,
      baseUrl: config.baseUrl || stored.baseUrl,
      model: config.model || stored.model,
      temperature: config.temperature ?? stored.temperature,
      apiKey: config.apiKey?.trim() || stored.apiKey
    });
  });
  ipcMain.handle('ai:complete', (_event, request: AiCompletionRequest) => aiService.complete(request));
  ipcMain.handle('ai:cancelStream', (_event, streamId: string) => {
    activeAiStreams.get(streamId)?.abort();
  });
  ipcMain.handle('ai:completeStream', async (event, input: AiStreamRequest) => {
    const sender = event.sender;
    const abortController = new AbortController();
    let rendererAvailable = true;
    activeAiStreams.set(input.streamId, abortController);

    const abortStream = (): void => {
      rendererAvailable = false;
      abortController.abort();
    };

    const sendStreamEvent = (chunk: Omit<AiStreamEvent, 'streamId'>): boolean => {
      if (!rendererAvailable || sender.isDestroyed()) {
        abortStream();
        return false;
      }

      try {
        sender.send('ai:stream:event', {
          streamId: input.streamId,
          ...chunk
        });
        return true;
      } catch (error) {
        abortStream();
        if (!(error instanceof Error && error.message.includes('Render frame was disposed'))) {
          console.warn('AI stream event could not be delivered', error);
        }
        return false;
      }
    };

    sender.once('destroyed', abortStream);
    sender.once('render-process-gone', abortStream);

    try {
      await aiService.stream(input.request, (chunk) => {
        sendStreamEvent(chunk);
      }, abortController.signal);
    } catch (error) {
      if (!abortController.signal.aborted) {
        sendStreamEvent({
          error: error instanceof Error ? error.message : String(error),
          done: true
        });
      }
    } finally {
      if (abortController.signal.aborted && rendererAvailable && !sender.isDestroyed()) {
        sendStreamEvent({ done: true, cancelled: true });
      }
      activeAiStreams.delete(input.streamId);
      sender.removeListener('destroyed', abortStream);
      sender.removeListener('render-process-gone', abortStream);
    }
  });
}

async function pickPdfFile(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF files', extensions: ['pdf'] }]
  });

  if (result.canceled || !result.filePaths[0]) {
    return undefined;
  }

  return result.filePaths[0];
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    await clearChromiumCacheDirs();

    const store = new JsonWorkspaceStore();
    const aiService = new AiService(
      () => store.getAiProviderWithSecret(),
      {
        readOutline: async (documentId, maxItems) => {
          const document = await store.getDocument(documentId);
          if (!document) {
            throw new Error('PDF not found');
          }
          return readPdfOutline(document.filePath, maxItems);
        },
        readPages: async (documentId, pageStart, pageEnd, maxChars) => {
          const document = await store.getDocument(documentId);
          if (!document) {
            throw new Error('PDF not found');
          }
          return extractPdfPageTextRange(document.filePath, pageStart, pageEnd, 8, maxChars);
        }
      }
    );

    registerIpc(store, aiService);
    createWindow();
    void store.syncWorkspace().catch((error: unknown) => {
      console.warn('Startup GitHub sync failed', error);
    });

    const startupPdfPaths = [
      ...pdfPathsFromArgv(process.argv),
      ...(process.env.SIDELIGHT_OPEN_PDF_ON_START === '1' && process.env.SIDELIGHT_TEST_OPEN_PDF
        ? [process.env.SIDELIGHT_TEST_OPEN_PDF]
        : [])
    ];
    const queuedPdfPaths = [...pendingSystemPdfPaths, ...startupPdfPaths];
    pendingSystemPdfPaths.length = 0;
    for (const filePath of queuedPdfPaths) {
      await handleSystemPdfOpen?.(filePath);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

async function openPdfDocumentPath(store: JsonWorkspaceStore, filePath: string): Promise<{
  document: PdfDocumentMeta;
  source: PdfSourceDescriptor;
}> {
  const document = await store.upsertDocumentFromPdf(filePath);
  const readerWindow = createWindow({ documentId: document.id });
  focusWindow(readerWindow);
  return {
    document,
    source: await pdfSourceForDocument(document)
  };
}

function queueSystemPdfOpen(filePath: string): void {
  const pdfPath = normalizePdfOpenPath(filePath);
  if (!pdfPath) {
    return;
  }

  if (handleSystemPdfOpen) {
    void handleSystemPdfOpen(pdfPath);
    return;
  }

  if (!pendingSystemPdfPaths.includes(pdfPath)) {
    pendingSystemPdfPaths.push(pdfPath);
  }
}

function pdfPathsFromArgv(argv: string[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const arg of argv) {
    const pdfPath = normalizePdfOpenPath(arg);
    if (pdfPath && !seen.has(pdfPath)) {
      seen.add(pdfPath);
      paths.push(pdfPath);
    }
  }

  return paths;
}

function normalizePdfOpenPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-')) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }

  if (extname(candidate).toLowerCase() !== '.pdf') {
    return undefined;
  }

  return resolve(candidate);
}

function focusFirstWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    focusWindow(window);
  }
}

function focusWindow(window: BrowserWindow): void {
  if (hideE2eWindows || window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

async function pdfSourceForDocument(document: PdfDocumentMeta): Promise<PdfSourceDescriptor> {
  const fileStat = await stat(document.filePath);
  const initialEnd = Math.min(fileStat.size, pdfRangeChunkSize);

  return {
    documentId: document.id,
    fileName: document.fileName,
    fileSize: fileStat.size,
    initialData: await readFileRange(document.filePath, 0, initialEnd)
  };
}

async function readFileRange(filePath: string, begin: number, end: number): Promise<ArrayBuffer> {
  const length = end - begin;
  const buffer = Buffer.allocUnsafe(length);
  const file = await open(filePath, 'r');

  try {
    const result = await file.read(buffer, 0, length, begin);
    const bytes = buffer.subarray(0, result.bytesRead);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } finally {
    await file.close();
  }
}

async function clearChromiumCacheDirs(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const cacheDirs = [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'blob_storage',
    'Shared Dictionary'
  ];

  await Promise.all(
    cacheDirs.map((dirName) =>
      rm(join(userDataPath, dirName), { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(`Could not clear Chromium cache directory "${dirName}"`, error);
      })
    )
  );
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
