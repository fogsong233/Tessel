import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AiCompletionRequest,
  AiStreamEvent,
  AiStreamRequest,
  AiProviderConfig,
  Conversation,
  NoteDocument,
  PdfDocumentMeta,
  PdfMark,
  PdfRangeRequest,
  PdfReadingState,
  PdfSourceDescriptor,
  PdfUserBookmark,
  pdfRangeChunkSize
} from '../shared/domain';
import { AiService } from './aiService';
import { JsonWorkspaceStore } from './store';

if (process.env.SIDELIGHT_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.SIDELIGHT_REMOTE_DEBUG_PORT);
}

app.commandLine.appendSwitch('disable-http-cache');

if (process.env.SIDELIGHT_USER_DATA_DIR) {
  app.setPath('userData', process.env.SIDELIGHT_USER_DATA_DIR);
}

function createWindow(options: { documentId?: string } = {}): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    title: options.documentId ? 'Sidelight Reader' : 'Sidelight Library',
    backgroundColor: '#f3f3f3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
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
  ipcMain.handle('library:listDocuments', () => store.listDocuments());

  ipcMain.handle('pdf:open', async () => {
    const filePath = process.env.SIDELIGHT_TEST_OPEN_PDF ?? (await pickPdfFile());
    if (!filePath) {
      return null;
    }

    const document = await store.upsertDocumentFromPdf(filePath);
    createWindow({ documentId: document.id });
    return {
      document,
      source: await pdfSourceForDocument(document)
    };
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
  ipcMain.handle('pdf:getReadingState', (_event, documentId: string) => store.getReadingState(documentId));
  ipcMain.handle('pdf:saveReadingState', (_event, state: PdfReadingState) => store.saveReadingState(state));

  ipcMain.handle('conversation:list', (_event, documentId: string) => store.listConversations(documentId));
  ipcMain.handle('conversation:save', (_event, input: { conversation: Conversation }) =>
    store.saveConversation(input.conversation)
  );

  ipcMain.handle('note:get', (_event, documentId: string) => store.getNote(documentId));
  ipcMain.handle('note:save', (_event, input: { note: NoteDocument }) => store.saveNote(input.note));

  ipcMain.handle('settings:getAiProvider', () => store.getSafeAiProvider());
  ipcMain.handle('settings:saveAiProvider', (_event, config: AiProviderConfig) => store.saveAiProvider(config));
  ipcMain.handle('ai:complete', (_event, request: AiCompletionRequest) => aiService.complete(request));
  ipcMain.handle('ai:completeStream', async (event, input: AiStreamRequest) => {
    const sender = event.sender;
    const abortController = new AbortController();
    let rendererAvailable = true;

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

app.whenReady().then(async () => {
  await clearChromiumCacheDirs();

  const store = new JsonWorkspaceStore();
  const aiService = new AiService(() => store.getAiProviderWithSecret());

  registerIpc(store, aiService);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

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
