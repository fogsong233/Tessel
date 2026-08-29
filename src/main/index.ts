import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type WebContents } from 'electron';
import { open, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AiCompletionRequest,
  AiStreamEvent,
  AiStreamSteerRequest,
  AiStreamRequest,
  CodexStreamRequest,
  ReaderAiStreamRequest,
  AiProviderConfig,
  AppPreferences,
  Conversation,
  TranslationEntry,
  NoteDocument,
  PdfGeneratedOutline,
  PdfDocumentMeta,
  PdfMark,
  PdfRangeRequest,
  PdfReadingState,
  PdfSourceDescriptor,
  PdfUserBookmark,
  WindowChromeState,
  WorkspaceBlock,
  pdfRangeChunkSize
} from '../shared/domain';
import { AiService } from './aiService';
import { extractPdfPageTextRange, readPdfOutline } from './pdfTools';
import { JsonWorkspaceStore } from './store';
import { CodexAgent } from './codexAgent';
import { AppUpdateService } from './appUpdater';
import { MetadataSyncScheduler } from './metadataSyncScheduler';

if (process.env.SIDELIGHT_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.SIDELIGHT_REMOTE_DEBUG_PORT);
}

app.commandLine.appendSwitch('disable-http-cache');

// Electron enables Chromium GPU acceleration by default. Keep it enabled on
// Windows for PDF canvas rendering, with an explicit escape hatch for machines
// whose graphics driver cannot run the accelerated compositor reliably.
if (process.env.TESSEL_DISABLE_HARDWARE_ACCELERATION === '1') {
  app.disableHardwareAcceleration();
}

if (process.env.SIDELIGHT_USER_DATA_DIR) {
  app.setPath('userData', process.env.SIDELIGHT_USER_DATA_DIR);
}

const hideE2eWindows = process.env.SIDELIGHT_E2E_HIDE_WINDOWS === '1';
const pendingSystemPdfPaths: string[] = [];
let handleSystemPdfOpen: ((filePath: string) => Promise<void>) | undefined;
let storeMutationQueue = Promise.resolve();
let settingsWindow: BrowserWindow | undefined;

function windowChromeState(window?: BrowserWindow | null): WindowChromeState {
  return {
    macTrafficLightsVisible: process.platform === 'darwin' && window != null && !window.isFullScreen(),
    customControls: process.platform === 'win32',
    maximized: Boolean(window?.isMaximized())
  };
}

function sendWindowChromeState(window: BrowserWindow): void {
  if (!window.isDestroyed()) {
    window.webContents.send('window:chromeState', windowChromeState(window));
  }
}

function runStoreMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = storeMutationQueue.then(operation, operation);
  storeMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

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

function createWindow(options: { documentId?: string; view?: 'settings' } = {}): BrowserWindow {
  const isReaderWindow = Boolean(options.documentId);
  const isSettingsWindow = options.view === 'settings';
  const mainWindow = new BrowserWindow({
    width: isReaderWindow ? 1440 : isSettingsWindow ? 1040 : 720,
    height: isReaderWindow ? 920 : isSettingsWindow ? 760 : 520,
    minWidth: isReaderWindow ? 1080 : isSettingsWindow ? 820 : 620,
    minHeight: isReaderWindow ? 720 : isSettingsWindow ? 600 : 460,
    title: isReaderWindow ? 'Tessel Reader' : isSettingsWindow ? 'Tessel Settings' : 'Tessel',
    backgroundColor: isSettingsWindow ? '#ffffff' : '#f3f3f3',
    icon: join(app.getAppPath(), 'src/assets/icons/icon_256x256.png'),
    paintWhenInitiallyHidden: true,
    show: !hideE2eWindows,
    skipTaskbar: hideE2eWindows,
    autoHideMenuBar: true,
    frame: process.platform !== 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      backgroundThrottling: !hideE2eWindows,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on('enter-full-screen', () => sendWindowChromeState(mainWindow));
  mainWindow.on('leave-full-screen', () => sendWindowChromeState(mainWindow));
  mainWindow.on('maximize', () => sendWindowChromeState(mainWindow));
  mainWindow.on('unmaximize', () => sendWindowChromeState(mainWindow));
  if (process.platform === 'win32') {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
  }

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
    if (options.view) {
      rendererUrl.searchParams.set('view', options.view);
    }
    void mainWindow.loadURL(rendererUrl.toString());
  } else {
    const query = {
      ...(options.documentId ? { documentId: options.documentId } : {}),
      ...(options.view ? { view: options.view } : {})
    };
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      Object.keys(query).length > 0 ? { query } : undefined
    );
  }

  return mainWindow;
}

function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    focusWindow(settingsWindow);
    return settingsWindow;
  }
  settingsWindow = createWindow({ view: 'settings' });
  settingsWindow.once('closed', () => {
    settingsWindow = undefined;
  });
  focusWindow(settingsWindow);
  return settingsWindow;
}

function registerIpc(store: JsonWorkspaceStore, aiService: AiService, codexAgent: CodexAgent, appUpdater: AppUpdateService): void {
  const activeAiStreams = new Map<string, AbortController>();
  const metadataSyncScheduler = new MetadataSyncScheduler(
    runStoreMutation,
    (documentId) => store.syncDocumentMetadata(documentId),
    {
      onError: (documentId, error) => {
        console.warn(`WebDAV metadata sync failed for ${documentId}`, error);
      }
    }
  );
  app.once('before-quit', () => metadataSyncScheduler.dispose());
  const openPdfPath = async (filePath: string) => {
    const result = await runStoreMutation(() => openPdfDocumentPath(store, filePath));
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

  ipcMain.handle('pdf:open', async () => {
    const filePath = process.env.SIDELIGHT_TEST_OPEN_PDF ?? (await pickPdfFile());
    if (!filePath) {
      return null;
    }

    return openPdfPath(filePath);
  });

  ipcMain.handle('library:listRecentDocuments', (_event, limit?: number) => store.listRecentDocuments(limit));
  ipcMain.handle('library:getStorageOverview', () => store.getStorageOverview());
  ipcMain.handle('library:openDocument', async (_event, documentId: string) => {
    const document = await store.getDocument(documentId);
    if (!document) {
      return false;
    }
    try {
      await stat(document.filePath);
    } catch {
      return false;
    }
    const readerWindow = createWindow({ documentId });
    focusWindow(readerWindow);
    return true;
  });

  ipcMain.handle('pdf:load', async (_event, documentId: string) => {
    const testLoadDelay = Number(process.env.SIDELIGHT_E2E_PDF_LOAD_DELAY_MS ?? 0);
    if (Number.isFinite(testLoadDelay) && testLoadDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(testLoadDelay, 5_000)));
    }
    const document = await store.getDocument(documentId);
    if (!document) {
      return null;
    }

    const now = new Date().toISOString();
    const openedDocument: PdfDocumentMeta = {
      ...document,
      updatedAt: now,
      lastOpenedAt: now
    };

    const source = await pdfSourceForDocument(document);
    void runStoreMutation(() => store.updateDocument(openedDocument))
      .catch((error: unknown) => {
        console.warn(`Could not update last-opened state for PDF ${documentId}`, error);
      });

    return {
      document: openedDocument,
      source
    };
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
  ipcMain.handle('pdf:saveMark', (_event, input: { mark: PdfMark }) => runStoreMutation(() => store.savePdfMark(input.mark)));
  ipcMain.handle('pdf:deleteMark', (_event, markId: string) => runStoreMutation(() => store.deletePdfMark(markId)));
  ipcMain.handle('pdf:listBookmarks', (_event, documentId: string) => store.listPdfBookmarks(documentId));
  ipcMain.handle('pdf:saveBookmark', (_event, input: { bookmark: PdfUserBookmark }) =>
    runStoreMutation(() => store.savePdfBookmark(input.bookmark))
  );
  ipcMain.handle('pdf:deleteBookmark', (_event, bookmarkId: string) => runStoreMutation(() => store.deletePdfBookmark(bookmarkId)));
  ipcMain.handle('pdf:getGeneratedOutline', (_event, documentId: string) => store.getGeneratedPdfOutline(documentId));
  ipcMain.handle('pdf:saveGeneratedOutline', async (_event, input: { outline: PdfGeneratedOutline }) => {
    return runStoreMutation(() => store.saveGeneratedPdfOutline(input.outline));
  });
  ipcMain.handle('pdf:deleteGeneratedOutline', async (_event, documentId: string) => {
    await runStoreMutation(() => store.deleteGeneratedPdfOutline(documentId));
  });
  ipcMain.handle('pdf:getReadingState', (_event, documentId: string) => store.getReadingState(documentId));
  ipcMain.handle('pdf:saveReadingState', async (_event, state: PdfReadingState) => {
    const saved = await runStoreMutation(() => store.saveReadingState(state));
    metadataSyncScheduler.schedule(saved.documentId);
    return saved;
  });

  ipcMain.handle('conversation:list', (_event, documentId: string) => store.listConversations(documentId));
  ipcMain.handle('conversation:save', async (_event, input: { conversation: Conversation }) => {
    const saved = await runStoreMutation(() => store.saveConversation(input.conversation));
    metadataSyncScheduler.schedule(saved.documentId);
    return saved;
  });
  ipcMain.handle('translation:list', (_event, documentId: string) => store.listTranslations(documentId));
  ipcMain.handle('translation:save', async (_event, input: { translation: TranslationEntry }) => {
    const saved = await runStoreMutation(() => store.saveTranslation(input.translation));
    metadataSyncScheduler.schedule(saved.documentId);
    return saved;
  });
  ipcMain.handle('translation:delete', async (_event, translationId: string) => {
    const documentId = await runStoreMutation(() => store.deleteTranslation(translationId));
    if (documentId) {
      metadataSyncScheduler.schedule(documentId);
    }
  });

  ipcMain.handle('note:get', (_event, documentId: string) => store.getNote(documentId));
  ipcMain.handle('note:list', (_event, documentId: string) => store.listNotes(documentId));
  ipcMain.handle('note:save', (_event, input: { note: NoteDocument }) => runStoreMutation(() => store.saveNote(input.note)));
  ipcMain.handle('note:delete', async (_event, noteId: string) => {
    await runStoreMutation(() => store.deleteNote(noteId));
  });
  ipcMain.handle('workspaceBlock:list', (_event, documentId: string) => store.listWorkspaceBlocks(documentId));
  ipcMain.handle('workspaceBlock:save', async (_event, input: { block: WorkspaceBlock }) => {
    return runStoreMutation(() => store.saveWorkspaceBlock(input.block));
  });
  ipcMain.handle('workspaceBlock:delete', async (_event, blockId: string) => {
    await runStoreMutation(() => store.deleteWorkspaceBlock(blockId));
  });
  ipcMain.handle('shell:openLocalPath', async (_event, path: string) => {
    const localPath = normalizeLocalResourcePath(path);
    if (!localPath) {
      throw new Error('Only absolute local file paths can be opened.');
    }
    const error = await shell.openPath(localPath);
    if (error) {
      throw new Error(error);
    }
  });
  ipcMain.handle('media:resolveRemoteImage', (_event, url: string) => resolveRemoteImageDataUrl(url));
  ipcMain.handle('app:update:getState', () => appUpdater.getState());
  ipcMain.handle('app:update:check', () => appUpdater.check());
  ipcMain.handle('app:update:download', () => appUpdater.download());
  ipcMain.handle('app:update:dismiss', () => appUpdater.dismiss());
  ipcMain.handle('app:update:install', () => appUpdater.install());

  ipcMain.handle('settings:getAiProvider', () => store.getSafeAiProvider());
  ipcMain.handle('settings:saveAiProvider', (_event, config: AiProviderConfig) => runStoreMutation(() => store.saveAiProvider(config)));
  ipcMain.handle('settings:getWebDavSync', () => store.getSafeWebDavSync());
  ipcMain.handle('settings:saveWebDavSync', (_event, config) => runStoreMutation(() => store.saveWebDavSync(config)));
  ipcMain.handle('settings:getAppPreferences', () => store.getAppPreferences());
  ipcMain.handle('settings:saveAppPreferences', async (_event, config: AppPreferences) => {
    const preferences = await runStoreMutation(() => store.saveAppPreferences(config));
    codexAgent.resetConfiguration();
    for (const window of BrowserWindow.getAllWindows()) {
      sendToRenderer(window.webContents, 'settings:changed');
    }
    return preferences;
  });
  ipcMain.handle('window:getChromeState', (event) => windowChromeState(BrowserWindow.fromWebContents(event.sender)));
  ipcMain.handle('window:openSettings', () => {
    openSettingsWindow();
  });
  ipcMain.handle('window:toggleMaximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return windowChromeState();
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return windowChromeState(window);
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('sync:documentMetadata', (_event, documentId: string) => runStoreMutation(() => store.syncDocumentMetadata(documentId)));
  ipcMain.handle('codex:availability', async (_event, executablePath?: string) => {
    const preferences = await store.getAppPreferences();
    return CodexAgent.availability(executablePath ?? preferences.experimentalCodexAgent.executablePath);
  });
  ipcMain.handle('codex:listModels', () => codexAgent.listModels());
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
    void codexAgent.cancel(streamId);
  });
  ipcMain.handle('ai:steerStream', async (_event, request: AiStreamSteerRequest) => {
    if (!activeAiStreams.has(request.streamId)) {
      throw new Error('This Codex turn is no longer active.');
    }
    await codexAgent.steer(request.streamId, request.prompt);
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

      const sent = sendToRenderer(sender, 'ai:stream:event', {
        streamId: input.streamId,
        ...chunk
      });
      if (!sent) {
        abortStream();
      }
      return sent;
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

  ipcMain.handle('ai:completeReaderStream', async (event, input: ReaderAiStreamRequest) => {
    const sender = event.sender;
    const abortController = new AbortController();
    let rendererAvailable = true;
    activeAiStreams.set(input.streamId, abortController);

    const abortStream = (): void => {
      rendererAvailable = false;
      abortController.abort();
      void codexAgent.cancel(input.streamId);
    };
    const sendStreamEvent = (chunk: Omit<AiStreamEvent, 'streamId'>): boolean => {
      if (!rendererAvailable || sender.isDestroyed()) {
        abortStream();
        return false;
      }
      const sent = sendToRenderer(sender, 'ai:stream:event', { streamId: input.streamId, ...chunk });
      if (!sent) {
        abortStream();
      }
      return sent;
    };

    sender.once('destroyed', abortStream);
    sender.once('render-process-gone', abortStream);
    try {
      const preferences = await store.getAppPreferences();
      const isTranslation = (input.task ?? input.request.mode) === 'translate';
      const useCodex = preferences.experimentalCodexAgent.enabled
        && Boolean(input.documentId && input.codexContext)
        && (!isTranslation || preferences.translationBackend === 'codex');
      if (useCodex) {
        const task = input.task ?? (input.request.mode === 'translate' ? 'translate' : 'chat');
        const useTranslationConfig = task === 'translate';
        const translationModel = preferences.experimentalCodexAgent.translationModel
          ?? await codexAgent.preferredFastModel();
        await codexAgent.stream({
          streamId: input.streamId,
          conversationId: input.conversationId ?? input.streamId,
          task,
          codexThreadId: input.codexThreadId,
          transient: input.transient,
          documentId: input.documentId!,
          prompt: input.request.prompt,
          attachments: input.request.attachments,
          history: input.history,
          context: input.codexContext!,
          model: useTranslationConfig
            ? translationModel
            : input.codexOptions?.model ?? preferences.experimentalCodexAgent.chatModel,
          effort: useTranslationConfig
            ? preferences.experimentalCodexAgent.translationReasoningEffort ?? 'low'
            : input.codexOptions?.effort ?? preferences.experimentalCodexAgent.chatReasoningEffort ?? 'low',
          permissionMode: input.codexOptions?.permissionMode ?? 'workspace-write',
          preferredLanguage: input.request.preferredLanguage
        }, sendStreamEvent);
      } else {
        await aiService.stream(input.request, (chunk) => {
          sendStreamEvent(chunk);
        }, abortController.signal);
      }
    } catch (error) {
      if (!abortController.signal.aborted && rendererAvailable && !sender.isDestroyed()) {
        sendStreamEvent({ error: error instanceof Error ? error.message : String(error), done: true });
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

  ipcMain.handle('codex:completeStream', async (event, input: CodexStreamRequest) => {
    const sender = event.sender;
    let rendererAvailable = true;

    const abortStream = (): void => {
      rendererAvailable = false;
      void codexAgent.cancel(input.streamId);
    };
    const sendStreamEvent = (chunk: Omit<AiStreamEvent, 'streamId'>): boolean => {
      if (!rendererAvailable || sender.isDestroyed()) {
        abortStream();
        return false;
      }
      const sent = sendToRenderer(sender, 'ai:stream:event', { streamId: input.streamId, ...chunk });
      if (!sent) {
        abortStream();
      }
      return sent;
    };

    sender.once('destroyed', abortStream);
    sender.once('render-process-gone', abortStream);
    try {
      await codexAgent.stream(input, sendStreamEvent);
    } catch (error) {
      if (rendererAvailable && !sender.isDestroyed()) {
        sendStreamEvent({ error: error instanceof Error ? error.message : String(error), done: true });
      }
    } finally {
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
    if (process.platform === 'win32') {
      Menu.setApplicationMenu(null);
    }
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

    const codexAgent = new CodexAgent(
      async (documentId) => {
        const document = await store.getDocument(documentId);
        if (!document) {
          throw new Error('PDF not found');
        }
        return {
          document,
          readOutline: (maxItems) => readPdfOutline(document.filePath, maxItems),
          readPages: (pageStart, pageEnd, maxChars) => extractPdfPageTextRange(document.filePath, pageStart, pageEnd, 8, maxChars)
        };
      },
      join(app.getPath('userData'), 'codex-inputs'),
      join(app.getPath('userData'), 'codex-workspaces'),
      async () => (await store.getAppPreferences()).experimentalCodexAgent.executablePath
    );
    codexAgent.warmup();

    const appUpdater = new AppUpdateService((state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        sendToRenderer(window.webContents, 'app:update:state', state);
      }
    });
    registerIpc(store, aiService, codexAgent, appUpdater);
    appUpdater.start();
    app.once('before-quit', () => {
      void codexAgent.shutdown();
    });
    const startupPdfPaths = pdfPathsFromArgv(process.argv);
    const queuedPdfPaths = [...pendingSystemPdfPaths, ...startupPdfPaths];
    pendingSystemPdfPaths.length = 0;
    const initialPdfPaths = queuedPdfPaths.length > 0
      ? queuedPdfPaths
      : [process.env.SIDELIGHT_TEST_OPEN_PDF].filter((filePath): filePath is string => Boolean(filePath));
    for (const filePath of initialPdfPaths) {
      await handleSystemPdfOpen?.(filePath);
    }

    if (initialPdfPaths.length === 0) {
      createWindow();
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

function normalizeLocalResourcePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^sandbox:/i.test(candidate)) {
    candidate = sandboxLocalPath(candidate);
  }
  if (/^file:/i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }

  return isAbsolute(candidate) ? resolve(candidate) : undefined;
}

function sandboxLocalPath(value: string): string {
  const path = value.replace(/^sandbox:/i, '');
  return /^\/{1,2}[A-Za-z]:[\\/]/.test(path) ? path.replace(/^\/+/, '') : path;
}

const remoteImageCache = new Map<string, Promise<string | undefined>>();

function resolveRemoteImageDataUrl(url: string): Promise<string | undefined> {
  const cached = remoteImageCache.get(url);
  if (cached) {
    return cached;
  }

  const pending = loadRemoteImageDataUrl(url).catch(() => undefined);
  remoteImageCache.set(url, pending);
  return pending;
}

async function loadRemoteImageDataUrl(value: string, depth = 0): Promise<string | undefined> {
  if (depth > 1) {
    return undefined;
  }

  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || isLoopbackHost(url.hostname)) {
    return undefined;
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.9,text/html;q=0.6',
      'User-Agent': remoteMediaUserAgent
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Remote media request failed (${response.status} ${response.statusText}).`);
  }
  const effectiveUrl = new URL(response.url);
  if (!/^https?:$/.test(effectiveUrl.protocol) || isLoopbackHost(effectiveUrl.hostname)) {
    return undefined;
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  const maxBytes = contentType.startsWith('image/') ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
  const bytes = await readRemoteBody(response, maxBytes);
  if (contentType.startsWith('image/')) {
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  }
  if (!contentType.includes('html')) {
    return undefined;
  }
  const imageUrl = imageCandidateFromHtml(bytes.toString('utf8'), effectiveUrl.toString());
  return imageUrl ? loadRemoteImageDataUrl(imageUrl, depth + 1) : undefined;
}

const remoteMediaUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

async function readRemoteBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error('Remote media exceeds the size limit.');
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error('Remote media exceeds the size limit.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

function imageCandidateFromHtml(html: string, baseUrl: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const property = htmlAttribute(tag, 'property') ?? htmlAttribute(tag, 'name');
    if (!/^(?:og|twitter):image(?::url)?$/i.test(property ?? '')) {
      continue;
    }
    const content = htmlAttribute(tag, 'content');
    if (content) {
      return new URL(content, baseUrl).toString();
    }
  }

  const imageTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imageTags) {
    const candidate = htmlAttribute(tag, 'data-imgsrc') ?? htmlAttribute(tag, 'src');
    if (!candidate || /(?:logo|banner|template|_visitcount)/i.test(candidate)) {
      continue;
    }
    return new URL(candidate, baseUrl).toString();
  }
  return undefined;
}

function htmlAttribute(tag: string, attribute: string): string | undefined {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isLoopbackHost(host: string): boolean {
  if (process.env.SIDELIGHT_E2E_ALLOW_LOOPBACK_MEDIA === '1') {
    return false;
  }
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function focusFirstWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    focusWindow(window);
    return;
  }

  // A macOS app can remain alive after all windows close. Recreate the home
  // window when a second launch reaches that orphaned single-instance process.
  createWindow();
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

function sendToRenderer(webContents: WebContents, channel: string, ...args: unknown[]): boolean {
  if (webContents.isDestroyed()) {
    return false;
  }

  try {
    webContents.send(channel, ...args);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Render frame was disposed')) {
      console.warn(`Could not send renderer IPC "${channel}"`, error);
    }
    return false;
  }
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
