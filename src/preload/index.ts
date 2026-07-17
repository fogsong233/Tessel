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
  GitHubUploadConfig,
  WebDavSyncConfig,
  PdfDocumentMeta,
  SavePdfGeneratedOutlineInput,
  SaveLibraryGroupInput,
  SaveConversationInput,
  SaveTranslationInput,
  SaveNoteInput,
  SaveWorkspaceBlockInput,
  SidelightApi
} from '../shared/domain';

const api: SidelightApi = {
  listDocuments: () => ipcRenderer.invoke('library:listDocuments'),
  listLibraryGroups: () => ipcRenderer.invoke('library:listGroups'),
  saveLibraryGroup: (input: SaveLibraryGroupInput) => ipcRenderer.invoke('library:saveGroup', input),
  deleteLibraryGroup: (groupId) => ipcRenderer.invoke('library:deleteGroup', groupId),
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  openDocumentWindow: (documentId) => ipcRenderer.invoke('window:openDocument', documentId),
  loadPdf: (documentId) => ipcRenderer.invoke('pdf:load', documentId),
  addDocumentToLibrary: (documentId) => ipcRenderer.invoke('pdf:addToLibrary', documentId),
  updateDocument: (document: PdfDocumentMeta) => ipcRenderer.invoke('pdf:updateDocument', document),
  syncWorkspace: () => ipcRenderer.invoke('sync:workspace'),
  uploadWorkspace: () => ipcRenderer.invoke('sync:uploadWorkspace'),
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
  openLocalPath: (path) => ipcRenderer.invoke('shell:openLocalPath', path),
  resolveRemoteImage: (url) => ipcRenderer.invoke('media:resolveRemoteImage', url),
  getAiProvider: () => ipcRenderer.invoke('settings:getAiProvider'),
  saveAiProvider: (config: AiProviderConfig) => ipcRenderer.invoke('settings:saveAiProvider', config),
  getGitHubUpload: () => ipcRenderer.invoke('settings:getGitHubUpload'),
  saveGitHubUpload: (config: GitHubUploadConfig) => ipcRenderer.invoke('settings:saveGitHubUpload', config),
  getWebDavSync: () => ipcRenderer.invoke('settings:getWebDavSync'),
  saveWebDavSync: (config: WebDavSyncConfig) => ipcRenderer.invoke('settings:saveWebDavSync', config),
  syncDocumentMetadata: (documentId) => ipcRenderer.invoke('sync:documentMetadata', documentId),
  getAppPreferences: () => ipcRenderer.invoke('settings:getAppPreferences'),
  saveAppPreferences: (config: AppPreferences) => ipcRenderer.invoke('settings:saveAppPreferences', config),
  getWindowChromeState: () => ipcRenderer.invoke('window:getChromeState'),
  listAiModels: (config: AiProviderConfig): Promise<AiModelInfo[]> => ipcRenderer.invoke('ai:listModels', config),
  completeAi: (request: AiCompletionRequest) => ipcRenderer.invoke('ai:complete', request),
  completeAiStream: (input: AiStreamRequest) => ipcRenderer.invoke('ai:completeStream', input),
  completeReaderAiStream: (input: ReaderAiStreamRequest) => ipcRenderer.invoke('ai:completeReaderStream', input),
  completeCodexStream: (input: CodexStreamRequest) => ipcRenderer.invoke('codex:completeStream', input),
  getCodexAvailability: () => ipcRenderer.invoke('codex:availability'),
  listCodexModels: () => ipcRenderer.invoke('codex:listModels'),
  steerAiStream: (request: AiStreamSteerRequest) => ipcRenderer.invoke('ai:steerStream', request),
  cancelAiStream: (streamId: string) => ipcRenderer.invoke('ai:cancelStream', streamId),
  getAppUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:getState'),
  checkForAppUpdates: (): Promise<AppUpdateState> => ipcRenderer.invoke('app:update:check'),
  installAppUpdate: (): Promise<void> => ipcRenderer.invoke('app:update:install'),
  onAppUpdateState: (listener: (state: AppUpdateState) => void) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: AppUpdateState): void => listener(payload);
    ipcRenderer.on('app:update:state', channelListener);
    return () => ipcRenderer.removeListener('app:update:state', channelListener);
  },
  onWindowChromeState: (listener) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: { macTrafficLightsVisible: boolean }): void => listener(payload);
    ipcRenderer.on('window:chromeState', channelListener);
    return () => ipcRenderer.removeListener('window:chromeState', channelListener);
  },
  onAiStreamEvent: (listener: (event: AiStreamEvent) => void) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: AiStreamEvent): void => listener(payload);
    ipcRenderer.on('ai:stream:event', channelListener);
    return () => ipcRenderer.removeListener('ai:stream:event', channelListener);
  },
  onLibraryChanged: (listener: () => void) => {
    const channelListener = (): void => listener();
    ipcRenderer.on('library:changed', channelListener);
    return () => ipcRenderer.removeListener('library:changed', channelListener);
  }
};

contextBridge.exposeInMainWorld('sidelight', api);
