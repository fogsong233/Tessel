import { contextBridge, ipcRenderer } from 'electron';
import {
  AiCompletionRequest,
  AiModelInfo,
  AiStreamEvent,
  AiStreamRequest,
  AiStreamSteerRequest,
  CodexStreamRequest,
  ReaderAiStreamRequest,
  AiProviderConfig,
  AppPreferences,
  AppUpdateState,
  WebDavSyncConfig,
  SavePdfGeneratedOutlineInput,
  SaveConversationInput,
  SaveTranslationInput,
  SaveNoteInput,
  SaveWorkspaceBlockInput,
  TesselApi,
  WindowChromeState
} from '../shared/domain';
import type { LanWhiteboardRendererEvent } from '../shared/lanWhiteboard';

const api: TesselApi = {
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  openSettings: () => ipcRenderer.invoke('window:openSettings'),
  listRecentDocuments: (limit) => ipcRenderer.invoke('library:listRecentDocuments', limit),
  openStoredDocument: (documentId) => ipcRenderer.invoke('library:openDocument', documentId),
  getStorageOverview: () => ipcRenderer.invoke('library:getStorageOverview'),
  loadPdf: (documentId) => ipcRenderer.invoke('pdf:load', documentId),
  readPdfRange: (request) => ipcRenderer.invoke('pdf:readRange', request),
  listPdfMarks: (documentId) => ipcRenderer.invoke('pdf:listMarks', documentId),
  savePdfMark: (input) => ipcRenderer.invoke('pdf:saveMark', input),
  deletePdfMark: (markId) => ipcRenderer.invoke('pdf:deleteMark', markId),
  listPdfBookmarks: (documentId) => ipcRenderer.invoke('pdf:listBookmarks', documentId),
  savePdfBookmark: (input) => ipcRenderer.invoke('pdf:saveBookmark', input),
  deletePdfBookmark: (bookmarkId) => ipcRenderer.invoke('pdf:deleteBookmark', bookmarkId),
  getGeneratedPdfOutline: (documentId) => ipcRenderer.invoke('pdf:getGeneratedOutline', documentId),
  saveGeneratedPdfOutline: (input: SavePdfGeneratedOutlineInput) => ipcRenderer.invoke('pdf:saveGeneratedOutline', input),
  deleteGeneratedPdfOutline: (documentId) => ipcRenderer.invoke('pdf:deleteGeneratedOutline', documentId),
  getReadingState: (documentId) => ipcRenderer.invoke('pdf:getReadingState', documentId),
  saveReadingState: (state) => ipcRenderer.invoke('pdf:saveReadingState', state),
  listConversations: (documentId) => ipcRenderer.invoke('conversation:list', documentId),
  saveConversation: (input: SaveConversationInput) => ipcRenderer.invoke('conversation:save', input),
  listTranslations: (documentId) => ipcRenderer.invoke('translation:list', documentId),
  saveTranslation: (input: SaveTranslationInput) => ipcRenderer.invoke('translation:save', input),
  deleteTranslation: (translationId) => ipcRenderer.invoke('translation:delete', translationId),
  listNotes: (documentId) => ipcRenderer.invoke('note:list', documentId),
  getNote: (documentId) => ipcRenderer.invoke('note:get', documentId),
  saveNote: (input: SaveNoteInput) => ipcRenderer.invoke('note:save', input),
  deleteNote: (noteId) => ipcRenderer.invoke('note:delete', noteId),
  listWorkspaceBlocks: (documentId) => ipcRenderer.invoke('workspaceBlock:list', documentId),
  saveWorkspaceBlock: (input: SaveWorkspaceBlockInput) => ipcRenderer.invoke('workspaceBlock:save', input),
  deleteWorkspaceBlock: (blockId) => ipcRenderer.invoke('workspaceBlock:delete', blockId),
  getLanWhiteboardInfo: () => ipcRenderer.invoke('lanWhiteboard:getInfo'),
  getLanWhiteboardSnapshot: () => ipcRenderer.invoke('lanWhiteboard:getSnapshot'),
  openLocalPath: (path) => ipcRenderer.invoke('shell:openLocalPath', path),
  resolveRemoteImage: (url) => ipcRenderer.invoke('media:resolveRemoteImage', url),
  getAiProvider: () => ipcRenderer.invoke('settings:getAiProvider'),
  saveAiProvider: (config: AiProviderConfig) => ipcRenderer.invoke('settings:saveAiProvider', config),
  getWebDavSync: () => ipcRenderer.invoke('settings:getWebDavSync'),
  saveWebDavSync: (config: WebDavSyncConfig) => ipcRenderer.invoke('settings:saveWebDavSync', config),
  syncDocumentMetadata: (documentId) => ipcRenderer.invoke('sync:documentMetadata', documentId),
  getAppPreferences: () => ipcRenderer.invoke('settings:getAppPreferences'),
  saveAppPreferences: (config: AppPreferences) => ipcRenderer.invoke('settings:saveAppPreferences', config),
  getWindowChromeState: () => ipcRenderer.invoke('window:getChromeState'),
  toggleWindowMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  listAiModels: (config: AiProviderConfig): Promise<AiModelInfo[]> => ipcRenderer.invoke('ai:listModels', config),
  completeAi: (request: AiCompletionRequest) => ipcRenderer.invoke('ai:complete', request),
  completeAiStream: (input: AiStreamRequest) => ipcRenderer.invoke('ai:completeStream', input),
  completeReaderAiStream: (input: ReaderAiStreamRequest) => ipcRenderer.invoke('ai:completeReaderStream', input),
  completeCodexStream: (input: CodexStreamRequest) => ipcRenderer.invoke('codex:completeStream', input),
  getCodexAvailability: (executablePath?: string) => ipcRenderer.invoke('codex:availability', executablePath),
  listCodexModels: () => ipcRenderer.invoke('codex:listModels'),
  steerAiStream: (request: AiStreamSteerRequest) => ipcRenderer.invoke('ai:steerStream', request),
  cancelAiStream: (streamId: string) => ipcRenderer.invoke('ai:cancelStream', streamId),
  getAppUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:getState'),
  checkForAppUpdates: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:check'),
  downloadAppUpdate: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:download'),
  dismissAppUpdate: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:dismiss'),
  installAppUpdate: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:install'),
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: AppUpdateState): void => listener(payload);
    ipcRenderer.on('app:update:state', channelListener);
    return () => ipcRenderer.removeListener('app:update:state', channelListener);
  },
  onWindowChromeState: (listener) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: WindowChromeState): void => listener(payload);
    ipcRenderer.on('window:chromeState', channelListener);
    return () => ipcRenderer.removeListener('window:chromeState', channelListener);
  },
  onSettingsChanged: (listener) => {
    const channelListener = (): void => listener();
    ipcRenderer.on('settings:changed', channelListener);
    return () => ipcRenderer.removeListener('settings:changed', channelListener);
  },
  onAiStreamEvent: (listener: (event: AiStreamEvent) => void) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: AiStreamEvent): void => listener(payload);
    ipcRenderer.on('ai:stream:event', channelListener);
    return () => ipcRenderer.removeListener('ai:stream:event', channelListener);
  },
  onLanWhiteboardEvent: (listener: (event: LanWhiteboardRendererEvent) => void) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: LanWhiteboardRendererEvent): void => listener(payload);
    ipcRenderer.on('lanWhiteboard:event', channelListener);
    return () => ipcRenderer.removeListener('lanWhiteboard:event', channelListener);
  }
};

contextBridge.exposeInMainWorld('sidelight', api);
