export type ISODate = string;
export type DocumentId = string;
export type ConversationId = string;
export type AnchorId = string;
export type NoteId = string;
export type WorkspaceBlockId = string;
export type LibraryGroupId = string;

export type AiMode = 'ask' | 'explain' | 'translate' | 'summarize' | 'lesson';
export type ConversationRole = 'user' | 'assistant' | 'system';
export type ConversationAgentKind = 'default' | 'codex';
export type PdfMarkKind = 'highlight' | 'underline';
export type SelectionColorRole = 'highlight' | 'underline' | 'chat' | 'note' | 'summary' | 'translate';
export type ConversationAttachmentKind = 'image';
export type DocumentFormat = 'pdf' | 'markdown' | 'text' | 'image' | 'html' | 'epub' | 'unknown';
export type DocumentSourceKind = 'local-file' | 'cloud-file' | 'url';
export type WorkspaceBlockKind = 'conversation' | 'note' | 'snapshot' | 'card' | 'quote' | 'image' | 'link' | 'embed';
export type WorkspaceBlockAnchor = 'page' | 'viewport' | 'document' | 'selection';
export type WorkspaceBlockContentKind = 'markdown' | 'text' | 'image' | 'html' | 'external' | 'custom';
export type UiLanguage = 'en' | 'zh-CN';
export type AiPreferredLanguage = 'English' | 'Chinese' | 'Simplified Chinese';

export const pdfRangeChunkSize = 512 * 1024;

export interface DocumentFingerprint {
  algorithm: string;
  hash: string;
  byteSize?: number;
  sampledBytes?: number;
}

export interface DocumentSourceRef {
  kind: DocumentSourceKind;
  uri: string;
  filePath?: string;
}

export interface LibraryDocumentMeta {
  id: DocumentId;
  title: string;
  fileName: string;
  filePath: string;
  format: DocumentFormat;
  source?: DocumentSourceRef;
  fingerprint?: DocumentFingerprint;
  sha256: string;
  hashAlgorithm?: string;
  inLibrary?: boolean;
  groupIds?: LibraryGroupId[];
  tags: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
  lastOpenedAt: ISODate;
}

export interface PdfDocumentMeta extends LibraryDocumentMeta {
  pageCount?: number;
  readingState?: PdfReadingState;
}

export interface LibraryGroup {
  id: LibraryGroupId;
  name: string;
  cloudHeld: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface PdfOpenResult {
  document: PdfDocumentMeta;
  source: PdfSourceDescriptor;
}

export interface PdfSourceDescriptor {
  documentId: DocumentId;
  fileName: string;
  fileSize: number;
  initialData?: ArrayBuffer;
}

export interface PdfRangeRequest {
  documentId: DocumentId;
  begin: number;
  end: number;
}

export interface PdfMarkArea {
  pageIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfMark {
  id: string;
  documentId: DocumentId;
  kind: PdfMarkKind;
  colorRole?: SelectionColorRole;
  quote: string;
  areas: PdfMarkArea[];
  pageNumber: number;
  createdAt: ISODate;
}

export interface PdfUserBookmark {
  id: string;
  documentId: DocumentId;
  pageNumber: number;
  label: string;
  createdAt: ISODate;
}

export interface PdfReadingState {
  documentId: DocumentId;
  lastPage: number;
  updatedAt: ISODate;
}

export interface AnchorRect {
  pageNumber: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TextAnchor {
  id: AnchorId;
  documentId: DocumentId;
  pageNumber: number;
  quote: string;
  beforeText?: string;
  afterText?: string;
  rects: AnchorRect[];
  createdAt: ISODate;
}

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  attachments?: ConversationAttachment[];
  toolCalls?: AiToolCallEvent[];
  agentActivities?: AgentActivityEvent[];
  agentTimeline?: AgentTimelineEntry[];
  createdAt: ISODate;
}

export type AgentActivityKind = 'reading' | 'tool' | 'command' | 'artifact';
export type AgentActivityStatus = 'started' | 'completed' | 'error';

/** A user-visible activity record. It intentionally never contains model reasoning. */
export interface AgentActivityEvent {
  id: string;
  kind: AgentActivityKind;
  label: string;
  status: AgentActivityStatus;
  detail?: string;
  updatedAt: ISODate;
}

export type AgentTimelineEntry = AgentTimelineOutputEntry | AgentTimelineActivityEntry;

export interface AgentTimelineOutputEntry {
  id: string;
  type: 'output';
  content: string;
  createdAt: ISODate;
}

export interface AgentTimelineActivityEntry {
  id: string;
  type: 'activity';
  activities: AgentActivityEvent[];
  createdAt: ISODate;
}

export interface ConversationAttachment {
  id: string;
  kind: ConversationAttachmentKind;
  name: string;
  mimeType: string;
  dataUrl: string;
  createdAt: ISODate;
}

export type AiToolCallStatus = 'started' | 'completed' | 'error';

export interface AiToolCallEvent {
  id: string;
  name: string;
  status: AiToolCallStatus;
  pageStart?: number;
  pageEnd?: number;
  maxItems?: number;
  maxChars?: number;
  resultSummary?: string;
  error?: string;
  updatedAt: ISODate;
}

export interface ConversationSummary {
  title: string;
  brief: string;
  keywords: string[];
}

export interface Conversation {
  id: ConversationId;
  documentId: DocumentId;
  pageNumber?: number;
  anchor?: TextAnchor;
  mode: AiMode;
  agentKind?: ConversationAgentKind;
  codexThreadId?: string;
  summary: ConversationSummary;
  messages: ConversationMessage[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface NoteDocument {
  id: NoteId;
  documentId: DocumentId;
  title: string;
  markdown: string;
  pageStart: number;
  pageEnd: number;
  anchor?: TextAnchor;
  source?: 'manual' | 'ai';
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface WorkspaceBlock {
  id: WorkspaceBlockId;
  documentId: DocumentId;
  kind: WorkspaceBlockKind;
  anchor: WorkspaceBlockAnchor;
  sourceId?: string;
  sourceKind?: WorkspaceBlockKind | DocumentSourceKind | 'manual' | 'selection';
  contentKind?: WorkspaceBlockContentKind;
  pageNumber?: number;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  height?: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface AiProviderConfig {
  baseUrl: string;
  model: string;
  displayName: string;
  apiKey?: string;
  temperature: number;
}

export interface SafeAiProviderConfig extends Omit<AiProviderConfig, 'apiKey'> {
  hasApiKey: boolean;
}

export interface GitHubUploadConfig {
  enabled: boolean;
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
  token?: string;
}

export interface SafeGitHubUploadConfig extends Omit<GitHubUploadConfig, 'token'> {
  hasToken: boolean;
}

/**
 * WebDAV stores reader metadata only. PDF files always remain in the user's
 * local filesystem and are identified by their full SHA-256 digest.
 */
export interface WebDavSyncConfig {
  enabled: boolean;
  baseUrl: string;
  basePath: string;
  username: string;
  password?: string;
}

export interface SafeWebDavSyncConfig extends Omit<WebDavSyncConfig, 'password'> {
  hasPassword: boolean;
}

export type MetadataSyncStatus = 'skipped' | 'synced';

export interface MetadataSyncResult {
  status: MetadataSyncStatus;
  documentId: DocumentId;
  syncedAt?: ISODate;
  message: string;
}

export type WorkspaceSyncMode = 'sync' | 'upload';
export type WorkspaceSyncStatus = 'skipped' | 'uploaded';

export interface WorkspaceSyncResult {
  mode: WorkspaceSyncMode;
  status: WorkspaceSyncStatus;
  documentCount: number;
  uploadedAt?: ISODate;
  message: string;
}

export interface AppPreferences {
  uiLanguage: UiLanguage;
  aiLanguage: AiPreferredLanguage;
  selectionColors: SelectionColorPreferences;
  experimentalCodexAgent: ExperimentalCodexAgentPreferences;
}

export interface ExperimentalCodexAgentPreferences {
  enabled: boolean;
  /** @deprecated Migrated to chatModel on the next settings save. */
  model?: string;
  chatModel?: string;
  translationModel?: string;
  chatReasoningEffort?: string;
  translationReasoningEffort?: string;
}

export interface SelectionColorPreferences {
  highlight: string;
  underline: string;
  chat: string;
  note: string;
  summary: string;
  translate: string;
}

export interface AiPdfOutlineItem {
  title: string;
  level: number;
  pageNumber?: number;
}

export interface PdfGeneratedOutlineItem extends AiPdfOutlineItem {
  id: string;
}

export interface PdfGeneratedOutline {
  documentId: DocumentId;
  source: 'ai';
  items: PdfGeneratedOutlineItem[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface AiPdfHighlightContext {
  kind: PdfMarkKind;
  pageNumber: number;
  quote: string;
}

export interface AiConversationContext {
  title: string;
  brief?: string;
  pageNumber?: number;
  anchorQuote?: string;
  transcript?: string;
}

export interface AiDocumentToolContext {
  documentId?: DocumentId;
  documentTitle?: string;
  fileName?: string;
  currentPage?: number;
  totalPages?: number;
  pageStart?: number;
  pageEnd?: number;
  selectedText?: string;
  selectionRects?: AnchorRect[];
  pdfText?: string;
  outline?: AiPdfOutlineItem[];
  highlights?: AiPdfHighlightContext[];
  conversations?: AiConversationContext[];
}

export interface AiCompletionRequest {
  mode: AiMode;
  prompt: string;
  documentTitle?: string;
  contextText?: string;
  messages?: ConversationMessage[];
  attachments?: ConversationAttachment[];
  conversationContext?: string;
  toolContext?: AiDocumentToolContext;
  preferredLanguage?: AiPreferredLanguage;
}

export interface AiCompletionResponse {
  content: string;
  usedProvider: string;
}

export interface AiModelInfo {
  id: string;
  ownedBy?: string;
}

export interface AiStreamRequest {
  streamId: string;
  request: AiCompletionRequest;
}

export interface AiStreamEvent {
  streamId: string;
  delta?: string;
  toolCall?: AiToolCallEvent;
  activity?: AgentActivityEvent;
  artifacts?: ConversationAttachment[];
  agentThreadId?: string;
  done?: boolean;
  cancelled?: boolean;
  error?: string;
  usedProvider?: string;
}

export interface CodexStreamRequest {
  streamId: string;
  conversationId: ConversationId;
  transient?: boolean;
  codexThreadId?: string;
  documentId: DocumentId;
  prompt: string;
  attachments?: ConversationAttachment[];
  history?: ConversationMessage[];
  context: AiDocumentToolContext;
  model?: string;
  preferredLanguage?: AiPreferredLanguage;
  effort?: string;
}

export interface CodexAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface CodexModelInfo {
  id: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
}

export interface ReaderAiStreamRequest {
  streamId: string;
  documentId?: DocumentId;
  conversationId?: ConversationId;
  codexThreadId?: string;
  transient?: boolean;
  history?: ConversationMessage[];
  request: AiCompletionRequest;
  codexContext?: AiDocumentToolContext;
}

export interface SaveConversationInput {
  conversation: Conversation;
}

export interface SaveNoteInput {
  note: NoteDocument;
}

export interface SaveWorkspaceBlockInput {
  block: WorkspaceBlock;
}

export interface SaveLibraryGroupInput {
  group: LibraryGroup;
}

export interface SavePdfMarkInput {
  mark: PdfMark;
}

export interface SavePdfBookmarkInput {
  bookmark: PdfUserBookmark;
}

export interface SavePdfGeneratedOutlineInput {
  outline: PdfGeneratedOutline;
}

export interface SidelightApi {
  listDocuments(): Promise<PdfDocumentMeta[]>;
  listLibraryGroups(): Promise<LibraryGroup[]>;
  saveLibraryGroup(input: SaveLibraryGroupInput): Promise<LibraryGroup>;
  deleteLibraryGroup(groupId: LibraryGroupId): Promise<void>;
  openPdf(): Promise<PdfOpenResult | null>;
  openDocumentWindow(documentId: DocumentId): Promise<PdfDocumentMeta | null>;
  loadPdf(documentId: DocumentId): Promise<PdfOpenResult | null>;
  addDocumentToLibrary(documentId: DocumentId): Promise<PdfDocumentMeta>;
  updateDocument(document: PdfDocumentMeta): Promise<PdfDocumentMeta>;
  syncWorkspace(): Promise<WorkspaceSyncResult>;
  uploadWorkspace(): Promise<WorkspaceSyncResult>;
  readPdfRange(request: PdfRangeRequest): Promise<ArrayBuffer>;
  listPdfMarks(documentId: DocumentId): Promise<PdfMark[]>;
  savePdfMark(input: SavePdfMarkInput): Promise<PdfMark>;
  deletePdfMark(markId: string): Promise<void>;
  listPdfBookmarks(documentId: DocumentId): Promise<PdfUserBookmark[]>;
  savePdfBookmark(input: SavePdfBookmarkInput): Promise<PdfUserBookmark>;
  deletePdfBookmark(bookmarkId: string): Promise<void>;
  getGeneratedPdfOutline(documentId: DocumentId): Promise<PdfGeneratedOutline | null>;
  saveGeneratedPdfOutline(input: SavePdfGeneratedOutlineInput): Promise<PdfGeneratedOutline>;
  deleteGeneratedPdfOutline(documentId: DocumentId): Promise<void>;
  getReadingState(documentId: DocumentId): Promise<PdfReadingState | null>;
  saveReadingState(state: PdfReadingState): Promise<PdfReadingState>;
  listConversations(documentId: DocumentId): Promise<Conversation[]>;
  saveConversation(input: SaveConversationInput): Promise<Conversation>;
  listNotes(documentId: DocumentId): Promise<NoteDocument[]>;
  getNote(documentId: DocumentId): Promise<NoteDocument>;
  saveNote(input: SaveNoteInput): Promise<NoteDocument>;
  deleteNote(noteId: NoteId): Promise<void>;
  listWorkspaceBlocks(documentId: DocumentId): Promise<WorkspaceBlock[]>;
  saveWorkspaceBlock(input: SaveWorkspaceBlockInput): Promise<WorkspaceBlock>;
  deleteWorkspaceBlock(blockId: WorkspaceBlockId): Promise<void>;
  getAiProvider(): Promise<SafeAiProviderConfig>;
  saveAiProvider(config: AiProviderConfig): Promise<SafeAiProviderConfig>;
  getGitHubUpload(): Promise<SafeGitHubUploadConfig>;
  saveGitHubUpload(config: GitHubUploadConfig): Promise<SafeGitHubUploadConfig>;
  getWebDavSync(): Promise<SafeWebDavSyncConfig>;
  saveWebDavSync(config: WebDavSyncConfig): Promise<SafeWebDavSyncConfig>;
  syncDocumentMetadata(documentId: DocumentId): Promise<MetadataSyncResult>;
  getAppPreferences(): Promise<AppPreferences>;
  saveAppPreferences(config: AppPreferences): Promise<AppPreferences>;
  listAiModels(config: AiProviderConfig): Promise<AiModelInfo[]>;
  completeAi(request: AiCompletionRequest): Promise<AiCompletionResponse>;
  completeAiStream(input: AiStreamRequest): Promise<void>;
  completeReaderAiStream(input: ReaderAiStreamRequest): Promise<void>;
  completeCodexStream(input: CodexStreamRequest): Promise<void>;
  getCodexAvailability(): Promise<CodexAvailability>;
  listCodexModels(): Promise<CodexModelInfo[]>;
  cancelAiStream(streamId: string): Promise<void>;
  onAiStreamEvent(listener: (event: AiStreamEvent) => void): () => void;
  onLibraryChanged(listener: () => void): () => void;
}

export const defaultAiProvider: SafeAiProviderConfig = {
  displayName: 'OpenAI-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  temperature: 0.2,
  hasApiKey: false
};

export const defaultGitHubUpload: SafeGitHubUploadConfig = {
  enabled: false,
  owner: '',
  repo: '',
  branch: 'main',
  basePath: 'sidelight',
  hasToken: false
};

export const defaultWebDavSync: SafeWebDavSyncConfig = {
  enabled: false,
  baseUrl: '',
  basePath: 'sidelight',
  username: '',
  hasPassword: false
};

export const defaultAppPreferences: AppPreferences = {
  uiLanguage: 'en',
  aiLanguage: 'Simplified Chinese',
  selectionColors: {
    highlight: '#d8ead4',
    underline: '#8fa4b8',
    chat: '#cfe3f5',
    note: '#f5e3a6',
    summary: '#ded7f0',
    translate: '#d7eadf'
  },
  experimentalCodexAgent: {
    enabled: false
  }
};
