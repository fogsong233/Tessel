import { contextBridge, ipcRenderer } from 'electron';
import {
  AiCompletionRequest,
  AiStreamEvent,
  AiStreamRequest,
  AiProviderConfig,
  SaveConversationInput,
  SaveNoteInput,
  SidelightApi
} from '../shared/domain';

const api: SidelightApi = {
  listDocuments: () => ipcRenderer.invoke('library:listDocuments'),
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  openDocumentWindow: (documentId) => ipcRenderer.invoke('window:openDocument', documentId),
  loadPdf: (documentId) => ipcRenderer.invoke('pdf:load', documentId),
  readPdfRange: (request) => ipcRenderer.invoke('pdf:readRange', request),
  listPdfMarks: (documentId) => ipcRenderer.invoke('pdf:listMarks', documentId),
  savePdfMark: (input) => ipcRenderer.invoke('pdf:saveMark', input),
  deletePdfMark: (markId) => ipcRenderer.invoke('pdf:deleteMark', markId),
  listPdfBookmarks: (documentId) => ipcRenderer.invoke('pdf:listBookmarks', documentId),
  savePdfBookmark: (input) => ipcRenderer.invoke('pdf:saveBookmark', input),
  deletePdfBookmark: (bookmarkId) => ipcRenderer.invoke('pdf:deleteBookmark', bookmarkId),
  getReadingState: (documentId) => ipcRenderer.invoke('pdf:getReadingState', documentId),
  saveReadingState: (state) => ipcRenderer.invoke('pdf:saveReadingState', state),
  listConversations: (documentId) => ipcRenderer.invoke('conversation:list', documentId),
  saveConversation: (input: SaveConversationInput) => ipcRenderer.invoke('conversation:save', input),
  getNote: (documentId) => ipcRenderer.invoke('note:get', documentId),
  saveNote: (input: SaveNoteInput) => ipcRenderer.invoke('note:save', input),
  getAiProvider: () => ipcRenderer.invoke('settings:getAiProvider'),
  saveAiProvider: (config: AiProviderConfig) => ipcRenderer.invoke('settings:saveAiProvider', config),
  completeAi: (request: AiCompletionRequest) => ipcRenderer.invoke('ai:complete', request),
  completeAiStream: (input: AiStreamRequest) => ipcRenderer.invoke('ai:completeStream', input),
  onAiStreamEvent: (listener: (event: AiStreamEvent) => void) => {
    const channelListener = (_event: Electron.IpcRendererEvent, payload: AiStreamEvent): void => listener(payload);
    ipcRenderer.on('ai:stream:event', channelListener);
    return () => ipcRenderer.removeListener('ai:stream:event', channelListener);
  }
};

contextBridge.exposeInMainWorld('sidelight', api);
