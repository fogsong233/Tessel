export type ISODate = string;
export type DocumentId = string;
export type ConversationId = string;
export type AnchorId = string;
export type NoteId = string;

export type AiMode = 'ask' | 'explain' | 'translate' | 'summarize' | 'lesson';
export type ConversationRole = 'user' | 'assistant' | 'system';
export type PdfMarkKind = 'highlight' | 'underline';
export type ConversationAttachmentKind = 'image';

export const pdfRangeChunkSize = 512 * 1024;

export interface PdfDocumentMeta {
  id: DocumentId;
  title: string;
  fileName: string;
  filePath: string;
  sha256: string;
  pageCount?: number;
  tags: string[];
  createdAt: ISODate;
  updatedAt: ISODate;
  lastOpenedAt: ISODate;
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

export interface AiCompletionRequest {
  mode: AiMode;
  prompt: string;
  documentTitle?: string;
  contextText?: string;
  messages?: ConversationMessage[];
  attachments?: ConversationAttachment[];
}

export interface AiCompletionResponse {
  content: string;
  usedProvider: string;
}

export interface AiStreamRequest {
  streamId: string;
  request: AiCompletionRequest;
}

export interface AiStreamEvent {
  streamId: string;
  delta?: string;
  done?: boolean;
  error?: string;
  usedProvider?: string;
}

export interface SaveConversationInput {
  conversation: Conversation;
}

export interface SaveNoteInput {
  note: NoteDocument;
}

export interface SavePdfMarkInput {
  mark: PdfMark;
}

export interface SavePdfBookmarkInput {
  bookmark: PdfUserBookmark;
}

export interface SidelightApi {
  listDocuments(): Promise<PdfDocumentMeta[]>;
  openPdf(): Promise<PdfOpenResult | null>;
  openDocumentWindow(documentId: DocumentId): Promise<PdfDocumentMeta | null>;
  loadPdf(documentId: DocumentId): Promise<PdfOpenResult | null>;
  readPdfRange(request: PdfRangeRequest): Promise<ArrayBuffer>;
  listPdfMarks(documentId: DocumentId): Promise<PdfMark[]>;
  savePdfMark(input: SavePdfMarkInput): Promise<PdfMark>;
  deletePdfMark(markId: string): Promise<void>;
  listPdfBookmarks(documentId: DocumentId): Promise<PdfUserBookmark[]>;
  savePdfBookmark(input: SavePdfBookmarkInput): Promise<PdfUserBookmark>;
  deletePdfBookmark(bookmarkId: string): Promise<void>;
  getReadingState(documentId: DocumentId): Promise<PdfReadingState | null>;
  saveReadingState(state: PdfReadingState): Promise<PdfReadingState>;
  listConversations(documentId: DocumentId): Promise<Conversation[]>;
  saveConversation(input: SaveConversationInput): Promise<Conversation>;
  getNote(documentId: DocumentId): Promise<NoteDocument>;
  saveNote(input: SaveNoteInput): Promise<NoteDocument>;
  getAiProvider(): Promise<SafeAiProviderConfig>;
  saveAiProvider(config: AiProviderConfig): Promise<SafeAiProviderConfig>;
  completeAi(request: AiCompletionRequest): Promise<AiCompletionResponse>;
  completeAiStream(input: AiStreamRequest): Promise<void>;
  onAiStreamEvent(listener: (event: AiStreamEvent) => void): () => void;
}

export const defaultAiProvider: SafeAiProviderConfig = {
  displayName: 'OpenAI-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  temperature: 0.2,
  hasApiKey: false
};
