import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Check,
  Clock3,
  Cloud,
  FileText,
  FolderOpen,
  Github,
  Languages as LanguagesIcon,
  LayoutGrid,
  LayoutList,
  Library,
  MessageCircle,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Tags,
  UploadCloud,
  X
} from 'lucide-react';
import {
  AiProviderConfig,
  AiModelInfo,
  AiMode,
  AiDocumentToolContext,
  AiPreferredLanguage,
  AiToolCallEvent,
  AgentActivityEvent,
  AgentTimelineEntry,
  AppPreferences,
  CodexAvailability,
  CodexModelInfo,
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
  defaultAppPreferences,
  NoteDocument,
  PdfGeneratedOutline,
  PdfGeneratedOutlineItem,
  PdfMark,
  PdfMarkKind,
  PdfDocumentMeta,
  PdfReadingState,
  PdfSourceDescriptor,
  PdfUserBookmark,
  SelectionColorRole,
  GitHubUploadConfig,
  LibraryGroup,
  SafeAiProviderConfig,
  SafeGitHubUploadConfig,
  SafeWebDavSyncConfig,
  WebDavSyncConfig,
  TextAnchor,
  ReaderAiStreamRequest,
  UiLanguage,
  WorkspaceBlock,
  WorkspaceSyncResult
} from '../../shared/domain';
import { createId } from '../../shared/ids';
import { mergeNoteDocuments as mergeNotes } from '../../shared/notes';
import { normalizeSelectionColors } from '../../shared/selectionColors';
import { PdfReader, type PdfSelectionPayload } from './PdfReader';
import { MarkdownView } from './MarkdownView';

type TransientAidMode = Extract<AiMode, 'summarize' | 'translate'>;

interface TransientAidState {
  id: string;
  mode: TransientAidMode;
  pageNumber: number;
  quote: string;
  content: string;
  busy: boolean;
  error?: string;
}

export function App(): ReactElement {
  const readerDocumentId = useMemo(() => new URLSearchParams(window.location.search).get('documentId') ?? undefined, []);
  const [documents, setDocuments] = useState<PdfDocumentMeta[]>([]);
  const [libraryGroups, setLibraryGroups] = useState<LibraryGroup[]>([]);
  const [activeDocument, setActiveDocument] = useState<PdfDocumentMeta>();
  const [pdfSource, setPdfSource] = useState<PdfSourceDescriptor>();
  const [currentPage, setCurrentPage] = useState(1);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [marks, setMarks] = useState<PdfMark[]>([]);
  const [bookmarks, setBookmarks] = useState<PdfUserBookmark[]>([]);
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [workspaceBlocks, setWorkspaceBlocks] = useState<WorkspaceBlock[]>([]);
  const [generatedOutline, setGeneratedOutline] = useState<PdfGeneratedOutline | null>(null);
  const [aiProvider, setAiProvider] = useState<SafeAiProviderConfig>();
  const [githubUpload, setGitHubUpload] = useState<SafeGitHubUploadConfig>();
  const [webDavSync, setWebDavSync] = useState<SafeWebDavSyncConfig>();
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(defaultAppPreferences);
  const [transientAid, setTransientAid] = useState<TransientAidState>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [outlineGenerationBusy, setOutlineGenerationBusy] = useState(false);
  const [outlineGenerationError, setOutlineGenerationError] = useState<string>();
  const [readerLoadPending, setReaderLoadPending] = useState(false);
  const [readerLoadError, setReaderLoadError] = useState<string>();
  const [activeStream, setActiveStream] = useState<{ streamId: string; conversationId?: string }>();
  const [quotedDraft, setQuotedDraft] = useState<{ conversationId: string; text: string; nonce: string }>();
  const loadedReaderDocumentRef = useRef<string | undefined>(undefined);
  const readerLoadRequestRef = useRef<string | undefined>(undefined);
  const stoppedStreamIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void refreshSettings();
  }, []);

  useEffect(() => {
    if (!readerDocumentId || loadedReaderDocumentRef.current === readerDocumentId) {
      return;
    }

    loadedReaderDocumentRef.current = readerDocumentId;
    setActiveDocument(undefined);
    setPdfSource(undefined);
    void loadDocumentIntoCurrentWindow(readerDocumentId);
  }, [readerDocumentId]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [activeConversationId, conversations]
  );

  async function refreshLibrary(): Promise<void> {
    const [loadedDocuments, loadedGroups] = await Promise.all([
      window.sidelight.listDocuments(),
      window.sidelight.listLibraryGroups()
    ]);
    setDocuments(loadedDocuments);
    setLibraryGroups(loadedGroups);
  }

  async function refreshSettings(): Promise<void> {
    const [provider, sync, preferences] = await Promise.all([
      window.sidelight.getAiProvider(),
      window.sidelight.getWebDavSync(),
      window.sidelight.getAppPreferences()
    ]);
    setAiProvider(provider);
    setWebDavSync(sync);
    setAppPreferences(preferences);
  }

  async function openPdf(): Promise<void> {
    const result = await window.sidelight.openPdf();
    if (!result) {
      return;
    }
    if (!readerDocumentId) {
      window.close();
    }
  }

  async function openDocumentWindow(documentId: string): Promise<void> {
    await window.sidelight.openDocumentWindow(documentId);
    await refreshLibrary();
  }

  async function addActiveDocumentToLibrary(): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const saved = await window.sidelight.addDocumentToLibrary(activeDocument.id);
    setActiveDocument(saved);
    setDocuments((current) => [
      saved,
      ...current.filter((document) => document.id !== saved.id)
    ]);
    await window.sidelight.syncWorkspace();
  }

  async function saveLibraryGroup(group: LibraryGroup): Promise<void> {
    const saved = await window.sidelight.saveLibraryGroup({ group });
    setLibraryGroups((current) => [
      saved,
      ...current.filter((candidate) => candidate.id !== saved.id)
    ].sort((a, b) => a.name.localeCompare(b.name)));
    await window.sidelight.syncWorkspace();
  }

  async function saveDocumentMeta(document: PdfDocumentMeta): Promise<void> {
    const saved = await window.sidelight.updateDocument(document);
    setDocuments((current) => [
      saved,
      ...current.filter((candidate) => candidate.id !== saved.id)
    ]);
    setActiveDocument((current) => current?.id === saved.id ? saved : current);
    await window.sidelight.syncWorkspace();
  }

  async function loadDocumentIntoCurrentWindow(documentId: string): Promise<void> {
    readerLoadRequestRef.current = documentId;
    setReaderLoadPending(true);
    setReaderLoadError(undefined);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await window.sidelight.loadPdf(documentId);
      if (result) {
        if (readerLoadRequestRef.current !== documentId) {
          return;
        }
        await activateDocument(result.document, result.source);
        setReaderLoadPending(false);
        setReaderLoadError(undefined);
        return;
      }

      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }

    if (readerLoadRequestRef.current !== documentId) {
      return;
    }
    setReaderLoadPending(false);
    setReaderLoadError('The requested PDF could not be found in the workspace.');
  }

  async function activateDocument(document: PdfDocumentMeta, source: PdfSourceDescriptor): Promise<void> {
    const documentId = document.id;
    const [loadedConversations, loadedMarks, loadedBookmarks, readingState, loadedMainNote, loadedWorkspaceBlocks, loadedGeneratedOutline] = await Promise.all([
      window.sidelight.listConversations(documentId),
      window.sidelight.listPdfMarks(documentId),
      window.sidelight.listPdfBookmarks(documentId),
      window.sidelight.getReadingState(documentId),
      window.sidelight.getNote(documentId),
      window.sidelight.listWorkspaceBlocks(documentId),
      window.sidelight.getGeneratedPdfOutline(documentId)
    ]);
    const loadedNotes = await window.sidelight.listNotes(documentId);

    setActiveDocument(document);
    setCurrentPage(readingState?.lastPage ?? 1);
    setPdfSource(source);
    setConversations(loadedConversations);
    setActiveConversationId(loadedConversations[0]?.id);
    setMarks(loadedMarks);
    setBookmarks(loadedBookmarks);
    setNotes(mergeNotes([loadedMainNote, ...loadedNotes]));
    setWorkspaceBlocks(loadedWorkspaceBlocks);
    setGeneratedOutline(loadedGeneratedOutline);
    setOutlineGenerationError(undefined);
    setPanelOpen(Boolean(loadedConversations[0]));
  }

  async function createFreeChat(selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    clearTransientForeground();
    const anchor = anchorFromSelection(activeDocument.id, selection);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createId('chat'),
      documentId: activeDocument.id,
      pageNumber: anchor.pageNumber,
      anchor,
      mode: 'ask',
      agentKind: appPreferences.experimentalCodexAgent.enabled ? 'codex' : 'default',
      summary: {
        title: compactTitle(anchor.quote, 'ask'),
        brief: compactSentence(anchor.quote, 128),
        keywords: []
      },
      messages: [],
      createdAt: now,
      updatedAt: now
    };

    const saved = await saveConversationLocally(conversation);
    focusConversation(saved.id);
  }

  async function createPageChat(pageNumber: number): Promise<void> {
    if (!activeDocument) {
      return;
    }

    clearTransientForeground();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createId('chat'),
      documentId: activeDocument.id,
      pageNumber,
      mode: 'ask',
      agentKind: appPreferences.experimentalCodexAgent.enabled ? 'codex' : 'default',
      summary: {
        title: `Question: Page ${pageNumber}`,
        brief: `Free chat attached to page ${pageNumber}.`,
        keywords: []
      },
      messages: [],
      createdAt: now,
      updatedAt: now
    };

    const saved = await saveConversationLocally(conversation);
    focusConversation(saved.id);
  }

  async function startAnchoredAction(mode: AiMode, selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    if (mode === 'ask') {
      await ensureSelectionMark('highlight', selection, 'chat');
      await createFreeChat(selection);
      return;
    }

    if (mode === 'summarize' || mode === 'translate') {
      await runTransientAid(mode, selection);
    }
  }

  async function quoteSelectionInActiveConversation(selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument || !activeConversation || busy) {
      return;
    }

    await ensureSelectionMark('highlight', selection, 'chat');
    focusConversation(activeConversation.id);
    setQuotedDraft({
      conversationId: activeConversation.id,
      text: `> ${selection.quote}\n\n`,
      nonce: createId('quote')
    });
  }

  async function runTransientAid(mode: TransientAidMode, selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const aidId = createId('aid');
    const streamId = createId('stream');
    let streamedContent = '';
    let finished = false;
    focusTransientAid({
      id: aidId,
      mode,
      pageNumber: selection.pageNumber,
      quote: selection.quote,
      content: '',
      busy: true
    });

    const finish = (patch: Partial<TransientAidState> = {}): void => {
      if (finished) {
        return;
      }

      finished = true;
      unsubscribe();
      setTransientAid((current) =>
        current?.id === aidId
          ? {
              ...current,
              ...patch,
              busy: false
            }
          : current
      );
    };

    const unsubscribe = window.sidelight.onAiStreamEvent((event) => {
      if (event.streamId !== streamId) {
        return;
      }

      if (event.delta) {
        streamedContent += event.delta;
      }

      if (event.error) {
        finish({
          content: streamedContent,
          error: presentableAiError(event.error)
        });
        return;
      }

      setTransientAid((current) =>
        current?.id === aidId
          ? {
              ...current,
              content: streamedContent
            }
          : current
      );

      if (event.done) {
        finish({ content: streamedContent });
      }
    });

    try {
      const selectionContext = buildAiDocumentToolContext({
        document: activeDocument,
        context: {
          currentPage: currentPage,
          selectedText: selection.quote,
          selectionRects: selectionAreasToAnchorRects(selection)
        },
        marks,
        conversations,
        pageStart: selection.pageNumber,
        pageEnd: selection.pageNumber,
        selectedText: selection.quote,
        selectionRects: selectionAreasToAnchorRects(selection)
      });
      await window.sidelight.completeReaderAiStream({
        streamId,
        conversationId: aidId,
        transient: true,
        documentId: activeDocument.id,
        codexContext: selectionContext,
        request: {
          mode,
          prompt: promptForMode(mode, appPreferences.aiLanguage),
          documentTitle: activeDocument.title,
          contextText: selection.quote,
          conversationContext: buildSelectionConversationContext(selection.pageNumber, selection.quote),
          toolContext: selectionContext,
          preferredLanguage: appPreferences.aiLanguage
        }
      });
    } catch (error) {
      finish({
        content: streamedContent,
        error: presentableAiError(error)
      });
    }
  }

  async function sendMessage(
    conversationId: string,
    prompt: string,
    attachments: ConversationAttachment[] = [],
    toolContext?: AiDocumentToolContext
  ): Promise<void> {
    const conversation = conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation) {
      return;
    }

    const userMessage: ConversationMessage = {
      id: createId('msg'),
      role: 'user',
      content: prompt,
      attachments: attachments.length ? attachments : undefined,
      createdAt: new Date().toISOString()
    };

    const nextConversation: Conversation = {
      ...conversation,
      messages: [...conversation.messages, userMessage],
      updatedAt: new Date().toISOString()
    };

    await saveConversationLocally({
      ...nextConversation,
      summary: summarizeConversation(nextConversation.mode, nextConversation.messages, nextConversation.anchor)
    });
    await completeConversation(nextConversation, prompt, attachments, toolContext);
  }

  async function completeConversation(
    conversation: Conversation,
    prompt: string,
    attachments: ConversationAttachment[] = [],
    toolContext?: AiDocumentToolContext
  ): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const lastMessage = conversation.messages.at(-1);
    const history =
      lastMessage?.role === 'user' && lastMessage.content === prompt
        ? conversation.messages.slice(0, -1)
        : conversation.messages;
    const anchorPage = conversation.anchor?.pageNumber ?? conversation.pageNumber ?? currentPage;
    const enrichedToolContext = buildAiDocumentToolContext({
      document: activeDocument,
      context: toolContext,
      marks,
      conversations,
      pageStart: toolContext?.pageStart ?? anchorPage,
      pageEnd: toolContext?.pageEnd ?? toolContext?.pageStart ?? anchorPage,
      pdfText: toolContext?.pdfText,
      selectedText: toolContext?.selectedText ?? conversation.anchor?.quote,
      selectionRects: toolContext?.selectionRects ?? conversation.anchor?.rects
    });

    setBusy(true);
    const assistantMessage: ConversationMessage = {
      id: createId('msg'),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    };
    let streamedContent = '';
    let draftConversation: Conversation = {
      ...conversation,
      messages: [...conversation.messages, assistantMessage],
      updatedAt: new Date().toISOString()
    };
    putConversationInState(draftConversation);

    const streamId = createId('stream');
    setActiveStream({ streamId, conversationId: conversation.id });
    let finished = false;
    const finishWithConversation = async (conversationToSave: Conversation): Promise<void> => {
      if (finished) {
        return;
      }

      finished = true;
      unsubscribe();
      const saved = await saveConversationLocally({
        ...conversationToSave,
        summary: summarizeConversation(conversationToSave.mode, conversationToSave.messages, conversationToSave.anchor)
      });
      void refreshConversationSummary(saved);
      setBusy(false);
      setActiveStream((current) => current?.streamId === streamId ? undefined : current);
      stoppedStreamIdsRef.current.delete(streamId);
    };

    const unsubscribe = window.sidelight.onAiStreamEvent((event) => {
      if (event.streamId !== streamId) {
        return;
      }

      if (event.toolCall) {
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, toolCalls: mergeToolCallEvents(message.toolCalls, event.toolCall!) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        putConversationInState(draftConversation);
      }

      if (event.activity) {
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  agentActivities: mergeAgentActivityEvents(message.agentActivities, event.activity!),
                  agentTimeline: mergeAgentTimelineActivity(message.agentTimeline, event.activity!)
                }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        putConversationInState(draftConversation);
      }

      if (event.artifacts?.length) {
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, attachments: mergeConversationAttachments(message.attachments, event.artifacts!) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        putConversationInState(draftConversation);
      }

      if (event.agentThreadId) {
        draftConversation = {
          ...draftConversation,
          agentKind: 'codex',
          codexThreadId: event.agentThreadId,
          updatedAt: new Date().toISOString()
        };
        putConversationInState(draftConversation);
      }

      if (event.delta) {
        streamedContent += event.delta;
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, agentTimeline: appendAgentTimelineOutput(message.agentTimeline, event.delta!) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
      }

      if (event.error) {
        streamedContent = `AI request failed: ${presentableAiError(event.error)}`;
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, agentTimeline: appendAgentTimelineOutput(message.agentTimeline, streamedContent) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
      }

      if (event.cancelled && !streamedContent.trim()) {
        streamedContent = stoppedGenerationText(appPreferences.aiLanguage);
      }

      if (event.delta || event.error || event.done) {
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id ? { ...message, content: streamedContent } : message
          ),
          updatedAt: new Date().toISOString()
        };
        putConversationInState(draftConversation);
      }

      if (event.done) {
        void finishWithConversation(draftConversation);
      }
    });

    try {
      await window.sidelight.completeReaderAiStream({
        streamId,
        conversationId: conversation.id,
        codexThreadId: conversation.codexThreadId,
        documentId: activeDocument.id,
        history,
        codexContext: enrichedToolContext,
        request: {
          mode: conversation.mode,
          prompt,
          documentTitle: activeDocument.title,
          contextText: conversation.anchor?.quote,
          messages: history,
          attachments,
          conversationContext: buildChatConversationContext(conversation, activeDocument.title, attachments),
          toolContext: enrichedToolContext,
          preferredLanguage: appPreferences.aiLanguage
        }
      });
      if (!finished && stoppedStreamIdsRef.current.has(streamId)) {
        const stoppedConversation: Conversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, content: streamedContent.trim() ? streamedContent : stoppedGenerationText(appPreferences.aiLanguage) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        await finishWithConversation(stoppedConversation);
      }
    } catch (error) {
      const wasStopped = stoppedStreamIdsRef.current.has(streamId);
      const failedConversation: Conversation = {
        ...draftConversation,
        messages: draftConversation.messages.map((message) =>
          message.id === assistantMessage.id
            ? {
                ...message,
                content: wasStopped
                  ? streamedContent.trim() ? streamedContent : stoppedGenerationText(appPreferences.aiLanguage)
                  : `AI request failed: ${presentableAiError(error)}`
              }
            : message
        ),
        updatedAt: new Date().toISOString()
      };
      await finishWithConversation(failedConversation);
    }
  }

  function stopActiveGeneration(): void {
    if (!activeStream) {
      return;
    }

    stoppedStreamIdsRef.current.add(activeStream.streamId);
    void window.sidelight.cancelAiStream(activeStream.streamId);
  }

  function putConversationInState(conversation: Conversation): void {
    setConversations((current) => [
      conversation,
      ...current.filter((candidate) => candidate.id !== conversation.id)
    ]);
  }

  async function saveConversationLocally(conversation: Conversation): Promise<Conversation> {
    const saved = await window.sidelight.saveConversation({ conversation });
    setConversations((current) => [
      saved,
      ...current.filter((candidate) => candidate.id !== saved.id)
    ]);
    return saved;
  }

  async function refreshConversationSummary(conversation: Conversation): Promise<void> {
    if (!activeDocument || conversation.messages.length === 0 || conversation.agentKind === 'codex') {
      return;
    }

    const aiSummary = await requestConversationSummary(conversation, activeDocument.title, appPreferences.aiLanguage);
    if (!aiSummary) {
      return;
    }

    await saveConversationLocally({
      ...conversation,
      summary: aiSummary
    });
  }

  async function saveMark(
    kind: PdfMarkKind,
    selection: PdfSelectionPayload,
    colorRole: SelectionColorRole = kind
  ): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const existing = marks.find((mark) => mark.kind === kind && sameSelection(mark, selection));
    const saved = await window.sidelight.savePdfMark({
      mark: {
        id: existing?.id ?? createId('mark'),
        documentId: activeDocument.id,
        kind,
        colorRole,
        quote: selection.quote,
        areas: selection.areas,
        pageNumber: selection.pageNumber,
        createdAt: existing?.createdAt ?? new Date().toISOString()
      }
    });
    setMarks((current) => [saved, ...current.filter((mark) => mark.id !== saved.id)]);
  }

  async function ensureSelectionMark(
    kind: PdfMarkKind,
    selection: PdfSelectionPayload,
    colorRole: SelectionColorRole = kind
  ): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const existing = marks.find((mark) => mark.kind === kind && sameSelection(mark, selection));
    if (existing) {
      if ((existing.colorRole ?? existing.kind) !== colorRole) {
        const saved = await window.sidelight.savePdfMark({
          mark: {
            ...existing,
            colorRole
          }
        });
        setMarks((current) => [saved, ...current.filter((mark) => mark.id !== saved.id)]);
      }
      return;
    }

    await saveMark(kind, selection, colorRole);
  }

  async function addBookmark(pageNumber: number): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const existing = bookmarks.find((bookmark) => bookmark.pageNumber === pageNumber);
    if (existing) {
      return;
    }

    const saved = await window.sidelight.savePdfBookmark({
      bookmark: {
        id: createId('bookmark'),
        documentId: activeDocument.id,
        pageNumber,
        label: `${activeDocument.title} p.${pageNumber}`,
        createdAt: new Date().toISOString()
      }
    });
    setBookmarks((current) => [...current, saved].sort((a, b) => a.pageNumber - b.pageNumber));
  }

  async function deleteBookmark(bookmarkId: string): Promise<void> {
    await window.sidelight.deletePdfBookmark(bookmarkId);
    setBookmarks((current) => current.filter((bookmark) => bookmark.id !== bookmarkId));
  }

  async function deleteMark(markId: string): Promise<void> {
    await window.sidelight.deletePdfMark(markId);
    setMarks((current) => current.filter((mark) => mark.id !== markId));
  }

  async function saveSettings(
    aiConfig: AiProviderConfig,
    uploadConfig: GitHubUploadConfig,
    preferencesConfig: AppPreferences,
    options: { close?: boolean } = {}
  ): Promise<void> {
    const savedProvider = await window.sidelight.saveAiProvider(aiConfig);
    const savedUpload = await window.sidelight.saveGitHubUpload(uploadConfig);
    const savedPreferences = await window.sidelight.saveAppPreferences(preferencesConfig);
    setAiProvider(savedProvider);
    setGitHubUpload(savedUpload);
    setAppPreferences(savedPreferences);
    if (options.close !== false) {
      setSettingsOpen(false);
    }
  }

  async function runGitHubWorkspaceAction(
    mode: WorkspaceSyncResult['mode'],
    aiConfig: AiProviderConfig,
    uploadConfig: GitHubUploadConfig,
    preferencesConfig: AppPreferences
  ): Promise<WorkspaceSyncResult> {
    await saveSettings(aiConfig, uploadConfig, preferencesConfig, { close: false });
    const result = mode === 'sync'
      ? await window.sidelight.syncWorkspace()
      : await window.sidelight.uploadWorkspace();
    await refreshSettings();
    return result;
  }

  async function saveReaderSettings(
    aiConfig: AiProviderConfig,
    syncConfig: WebDavSyncConfig,
    preferencesConfig: AppPreferences
  ): Promise<void> {
    const [provider, sync, preferences] = await Promise.all([
      window.sidelight.saveAiProvider(aiConfig),
      window.sidelight.saveWebDavSync(syncConfig),
      window.sidelight.saveAppPreferences(preferencesConfig)
    ]);
    setAiProvider(provider);
    setWebDavSync(sync);
    setAppPreferences(preferences);
    setSettingsOpen(false);
    if (activeDocument && sync.enabled) {
      await window.sidelight.syncDocumentMetadata(activeDocument.id).catch(() => undefined);
      await loadDocumentIntoCurrentWindow(activeDocument.id);
    }
  }

  async function saveNote(noteToSave: NoteDocument): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const saved = await window.sidelight.saveNote({
      note: {
        ...noteToSave,
        documentId: activeDocument.id,
        updatedAt: new Date().toISOString()
      }
    });
    setNotes((current) => mergeNotes([saved, ...current]));
  }

  async function deleteNote(noteId: string): Promise<void> {
    await window.sidelight.deleteNote(noteId);
    setNotes((current) => current.filter((note) => note.id !== noteId));
    setWorkspaceBlocks((current) =>
      current.filter((block) => !(block.kind === 'note' && block.sourceId === noteId))
    );
  }

  async function saveWorkspaceBlock(block: WorkspaceBlock): Promise<void> {
    setWorkspaceBlocks((current) => [
      block,
      ...current.filter((candidate) => candidate.id !== block.id)
    ]);
    const saved = await window.sidelight.saveWorkspaceBlock({ block });
    setWorkspaceBlocks((current) => [
      saved,
      ...current.filter((candidate) => candidate.id !== saved.id)
    ]);
  }

  async function deleteWorkspaceBlock(blockId: string): Promise<void> {
    await window.sidelight.deleteWorkspaceBlock(blockId);
    setWorkspaceBlocks((current) => current.filter((block) => block.id !== blockId));
  }

  async function completeReaderAi(input: Omit<ReaderAiStreamRequest, 'streamId'>): Promise<string> {
    const streamId = createId('stream');
    return new Promise((resolve, reject) => {
      let content = '';
      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) {
          return;
        }
        finished = true;
        unsubscribe();
        if (error) {
          reject(error);
        } else {
          resolve(content);
        }
      };
      const unsubscribe = window.sidelight.onAiStreamEvent((event) => {
        if (event.streamId !== streamId) {
          return;
        }
        if (event.delta) {
          content += event.delta;
        }
        if (event.error) {
          finish(new Error(event.error));
          return;
        }
        if (event.done) {
          finish();
        }
      });
      void window.sidelight.completeReaderAiStream({ streamId, ...input }).catch((error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async function generateAiNote(
    pageStart: number,
    pageEnd: number,
    pageText: string,
    toolContext?: AiDocumentToolContext
  ): Promise<void> {
    if (!activeDocument || noteBusy) {
      return;
    }

    const rangeStart = Math.max(1, Math.floor(Math.min(pageStart, pageEnd)));
    const rangeEnd = Math.max(rangeStart, Math.floor(Math.max(pageStart, pageEnd)));
    const rangeMarks = marks.filter((mark) => mark.pageNumber >= rangeStart && mark.pageNumber <= rangeEnd);
    const rangeConversations = conversations.filter((conversation) => {
      const pageNumber = conversation.pageNumber ?? conversation.anchor?.pageNumber;
      return pageNumber !== undefined && pageNumber >= rangeStart && pageNumber <= rangeEnd;
    });
    const enrichedToolContext = buildAiDocumentToolContext({
      document: activeDocument,
      context: toolContext,
      marks,
      conversations,
      pageStart: rangeStart,
      pageEnd: rangeEnd,
      pdfText: pageText
    });
    const now = new Date().toISOString();
    const noteToSave: NoteDocument = {
      id: createId('note'),
      documentId: activeDocument.id,
      title: `AI notes p.${rangeStart}-${rangeEnd}`,
      markdown: `# AI notes p.${rangeStart}-${rangeEnd}\n\nGenerating notes...`,
      pageStart: rangeStart,
      pageEnd: rangeEnd,
      source: 'ai',
      createdAt: now,
      updatedAt: now
    };

    setNoteBusy(true);
    const draft = await window.sidelight.saveNote({ note: noteToSave });
    setNotes((current) => mergeNotes([draft, ...current]));

    try {
      const content = await completeReaderAi({
        documentId: activeDocument.id,
        conversationId: noteToSave.id,
        transient: true,
        codexContext: enrichedToolContext,
        request: {
          mode: 'summarize',
          documentTitle: activeDocument.title,
          prompt: notePromptForLanguage(rangeStart, rangeEnd, appPreferences.aiLanguage),
          contextText: buildNoteContext(rangeStart, rangeEnd, pageText, rangeMarks, rangeConversations),
          conversationContext: buildNoteConversationContext(rangeStart, rangeEnd, rangeConversations),
          toolContext: enrichedToolContext,
          preferredLanguage: appPreferences.aiLanguage
        }
      });
      const saved = await window.sidelight.saveNote({
        note: {
          ...draft,
          markdown: normalizeGeneratedNote(content, rangeStart, rangeEnd),
          updatedAt: new Date().toISOString()
        }
      });
      setNotes((current) => mergeNotes([saved, ...current]));
    } catch (error) {
      const failed = await window.sidelight.saveNote({
        note: {
          ...draft,
          markdown: `# AI notes p.${rangeStart}-${rangeEnd}\n\nAI request failed: ${presentableAiError(error)}`,
          updatedAt: new Date().toISOString()
        }
      });
      setNotes((current) => mergeNotes([failed, ...current]));
    } finally {
      setNoteBusy(false);
    }
  }

  async function generatePdfOutline(toolContext?: AiDocumentToolContext): Promise<void> {
    if (!activeDocument || outlineGenerationBusy) {
      return;
    }

    const totalPages = toolContext?.totalPages ?? activeDocument.pageCount ?? currentPage;
    const enrichedToolContext = buildAiDocumentToolContext({
      document: activeDocument,
      context: toolContext,
      marks,
      conversations,
      pageStart: 1,
      pageEnd: Math.max(1, totalPages)
    });

    setOutlineGenerationBusy(true);
    setOutlineGenerationError(undefined);

    try {
      const content = await completeReaderAi({
        documentId: activeDocument.id,
        conversationId: `outline_${activeDocument.id}`,
        transient: true,
        codexContext: enrichedToolContext,
        request: {
          mode: 'summarize',
          documentTitle: activeDocument.title,
          prompt: outlinePromptForLanguage(Math.max(1, totalPages), appPreferences.aiLanguage),
          conversationContext: [
            'Task: create an external table of contents for a PDF that has no embedded outline.',
            `Document: ${activeDocument.title}.`,
            `Total pages: ${Math.max(1, totalPages)}.`,
            'The resulting outline will be saved with the document workspace metadata and reused by PDF hash.'
          ].join('\n'),
          toolContext: enrichedToolContext,
          preferredLanguage: appPreferences.aiLanguage
        }
      });
      const items = parseGeneratedOutlineItems(content, Math.max(1, totalPages));
      if (items.length === 0) {
        throw new Error('The AI response did not contain a usable outline JSON array.');
      }

      const now = new Date().toISOString();
      const saved = await window.sidelight.saveGeneratedPdfOutline({
        outline: {
          documentId: activeDocument.id,
          source: 'ai',
          items,
          createdAt: generatedOutline?.createdAt ?? now,
          updatedAt: now
        }
      });
      setGeneratedOutline(saved);
    } catch (error) {
      setOutlineGenerationError(presentableAiError(error));
    } finally {
      setOutlineGenerationBusy(false);
    }
  }

  function openConversation(conversationId: string): void {
    focusConversation(conversationId);
  }

  function focusConversation(conversationId: string): void {
    clearTransientForeground();
    setActiveConversationId(conversationId);
    setPanelOpen(true);
  }

  function focusTransientAid(aid: TransientAidState): void {
    setPanelOpen(false);
    setTransientAid(aid);
  }

  function clearTransientForeground(): void {
    setTransientAid(undefined);
  }

  function updateCurrentPage(pageNumber: number): void {
    setCurrentPage(pageNumber);

    const documentId = activeDocument?.id;
    if (!documentId) {
      return;
    }

    const nextState: PdfReadingState = {
      documentId,
      lastPage: pageNumber,
      updatedAt: new Date().toISOString()
    };
    setActiveDocument((current) => current?.id === documentId ? { ...current, readingState: nextState } : current);
    setDocuments((current) =>
      current.map((document) =>
        document.id === documentId ? { ...document, readingState: nextState, lastOpenedAt: nextState.updatedAt } : document
      )
    );
    void window.sidelight.saveReadingState(nextState);
  }

  if (!readerDocumentId) {
    return (
      <main className="app-shell">
        <section className="reader-home" aria-label="PDF reader start">
          <div className="reader-home__brand"><FileText size={22} /><span>Sidelight</span></div>
          <div className="reader-home__content">
            <FileText className="reader-home__mark" size={34} strokeWidth={1.45} />
            <div>
              <h1>PDF Reader</h1>
              <p>Open a local PDF to continue reading, chat, and translation.</p>
            </div>
            <div className="reader-home__actions">
              <button className="primary-button reader-home__open" type="button" onClick={() => void openPdf()}><FolderOpen size={17} />Open PDF</button>
              <button className="quiet-button reader-home__settings" type="button" onClick={() => setSettingsOpen(true)}><Settings size={17} />Settings</button>
            </div>
          </div>
        </section>
        {settingsOpen && aiProvider && webDavSync && (
          <ReaderSettingsPanel
            provider={aiProvider}
            webDavSync={webDavSync}
            preferences={appPreferences}
            onClose={() => setSettingsOpen(false)}
            onSave={(aiConfig, syncConfig, preferencesConfig) =>
              void saveReaderSettings(aiConfig, syncConfig, preferencesConfig)}
          />
        )}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <PdfReader
        documents={[]}
        libraryGroups={[]}
        source={pdfSource}
        meta={activeDocument}
        documentLoadPending={readerLoadPending}
        documentLoadError={readerLoadError}
        uiLanguage={appPreferences.uiLanguage}
        selectionColors={appPreferences.selectionColors}
        activePage={currentPage}
        marks={marks}
        bookmarks={bookmarks}
        conversations={conversations}
        workspaceBlocks={[]}
        generatedOutline={generatedOutline}
        activeConversationId={activeConversationId}
        activeConversation={activeConversation}
        notes={[]}
        chatOpen={panelOpen}
        busy={busy}
        canStopGeneration={busy && activeStream?.conversationId === activeConversation?.id}
        transientAid={transientAid}
        composerPrefill={quotedDraft}
        onOpenPdf={openPdf}
        onOpenSettings={() => setSettingsOpen(true)}
        onLoadDocument={() => undefined}
        onAddToLibrary={() => undefined}
        onPageChange={updateCurrentPage}
        onCreateMark={(kind, selection, colorRole) => void saveMark(kind, selection, colorRole)}
        onSelectionAction={(mode, selection) => void startAnchoredAction(mode, selection)}
        onQuoteSelection={(selection) => void quoteSelectionInActiveConversation(selection)}
        onAddBookmark={(pageNumber) => void addBookmark(pageNumber)}
        onDeleteBookmark={(bookmarkId) => void deleteBookmark(bookmarkId)}
        onDeleteMark={(markId) => void deleteMark(markId)}
        onCreatePageChat={(pageNumber) => void createPageChat(pageNumber)}
        onOpenConversation={openConversation}
        onCloseConversation={() => setPanelOpen(false)}
        onCloseTransientAid={() => setTransientAid(undefined)}
        onSendMessage={(conversationId, prompt, attachments, toolContext) =>
          void sendMessage(conversationId, prompt, attachments, toolContext)}
        onStopGeneration={stopActiveGeneration}
        noteBusy={noteBusy}
        outlineGenerationBusy={outlineGenerationBusy}
        outlineGenerationError={outlineGenerationError}
        onSaveWorkspaceBlock={saveWorkspaceBlock}
        onDeleteWorkspaceBlock={(blockId) => void deleteWorkspaceBlock(blockId)}
        onSaveNote={saveNote}
        onDeleteNote={(noteId) => void deleteNote(noteId)}
        onGenerateNote={(pageStart, pageEnd, pageText, toolContext) =>
          void generateAiNote(pageStart, pageEnd, pageText, toolContext)}
        onGenerateOutline={(toolContext) => void generatePdfOutline(toolContext)}
      />

      {settingsOpen && aiProvider && webDavSync && (
        <ReaderSettingsPanel
          provider={aiProvider}
          webDavSync={webDavSync}
          preferences={appPreferences}
          onClose={() => setSettingsOpen(false)}
          onSave={(aiConfig, syncConfig, preferencesConfig) =>
            void saveReaderSettings(aiConfig, syncConfig, preferencesConfig)}
        />
      )}
    </main>
  );
}

function ReaderSettingsPanel({
  provider,
  webDavSync,
  preferences,
  onClose,
  onSave
}: {
  provider: SafeAiProviderConfig;
  webDavSync: SafeWebDavSyncConfig;
  preferences: AppPreferences;
  onClose(): void;
  onSave(aiConfig: AiProviderConfig, syncConfig: WebDavSyncConfig, preferencesConfig: AppPreferences): void;
}): ReactElement {
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [apiKey, setApiKey] = useState('');
  const [temperature, setTemperature] = useState(provider.temperature);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelError, setModelError] = useState<string>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(webDavSync.enabled);
  const [webDavUrl, setWebDavUrl] = useState(webDavSync.baseUrl);
  const [webDavPath, setWebDavPath] = useState(webDavSync.basePath);
  const [webDavUsername, setWebDavUsername] = useState(webDavSync.username);
  const [webDavPassword, setWebDavPassword] = useState('');
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(preferences.uiLanguage);
  const [aiLanguage, setAiLanguage] = useState<AiPreferredLanguage>(preferences.aiLanguage);
  const [codexAvailability, setCodexAvailability] = useState<CodexAvailability>();
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>([]);
  const [codexEnabled, setCodexEnabled] = useState(preferences.experimentalCodexAgent.enabled);
  const [codexChatModel, setCodexChatModel] = useState(preferences.experimentalCodexAgent.chatModel ?? '');
  const [codexTranslationModel, setCodexTranslationModel] = useState(preferences.experimentalCodexAgent.translationModel ?? '');
  const [codexChatEffort, setCodexChatEffort] = useState(preferences.experimentalCodexAgent.chatReasoningEffort ?? '');
  const [codexTranslationEffort, setCodexTranslationEffort] = useState(preferences.experimentalCodexAgent.translationReasoningEffort ?? '');

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const availability = await window.sidelight.getCodexAvailability();
        if (disposed) {
          return;
        }
        setCodexAvailability(availability);
        if (!availability.available) {
          setCodexEnabled(false);
          return;
        }
        const models = await window.sidelight.listCodexModels();
        if (!disposed) {
          setCodexModels(models);
        }
      } catch {
        if (!disposed) {
          setCodexAvailability({ available: false, reason: 'Codex CLI is unavailable.' });
          setCodexEnabled(false);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const reasoningEffortsFor = (modelId: string): string[] => {
    const selected = codexModels.find((modelInfo) => modelInfo.id === modelId);
    if (selected?.supportedReasoningEfforts.length) {
      return selected.supportedReasoningEfforts;
    }
    return Array.from(new Set(codexModels.flatMap((modelInfo) => modelInfo.supportedReasoningEfforts)));
  };
  const chatEfforts = reasoningEffortsFor(codexChatModel);
  const translationEfforts = reasoningEffortsFor(codexTranslationModel);

  const fetchModels = async (): Promise<void> => {
    setLoadingModels(true);
    setModelError(undefined);
    try {
      const loaded = await window.sidelight.listAiModels({
        displayName,
        baseUrl,
        model,
        temperature,
        apiKey: apiKey.trim() || undefined
      });
      setModels(loaded);
    } catch (error) {
      setModelError(presentableAiError(error));
    } finally {
      setLoadingModels(false);
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(
      { displayName, baseUrl, model, temperature, apiKey: apiKey.trim() || undefined },
      {
        enabled: syncEnabled,
        baseUrl: webDavUrl,
        basePath: webDavPath,
        username: webDavUsername,
        password: webDavPassword.trim() || undefined
      },
      {
        uiLanguage,
        aiLanguage,
        selectionColors: normalizeSelectionColors(preferences.selectionColors),
        experimentalCodexAgent: {
          enabled: codexEnabled && Boolean(codexAvailability?.available),
          ...(codexChatModel.trim() ? { chatModel: codexChatModel.trim() } : {}),
          ...(codexTranslationModel.trim() ? { translationModel: codexTranslationModel.trim() } : {}),
          ...(codexChatEffort.trim() ? { chatReasoningEffort: codexChatEffort.trim() } : {}),
          ...(codexTranslationEffort.trim() ? { translationReasoningEffort: codexTranslationEffort.trim() } : {})
        }
      }
    );
  };

  return (
    <div className="settings-overlay reader-settings-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="reader-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="reader-settings__header">
          <div>
            <span>Reader preferences</span>
            <strong id="settings-title">Settings</strong>
          </div>
          <button type="button" className="icon-button" title="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <form className="reader-settings__form" onSubmit={submit}>
          <div className="reader-settings__body">
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Bot size={17} /><div><strong>AI provider</strong><span>OpenAI-compatible reader tools</span></div></div>
              <div className="reader-settings__fields">
                <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
                <label>Temperature<input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label>
                <label className="reader-settings__wide">Base URL<input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
                <label className="reader-settings__wide">API key<input type="password" value={apiKey} placeholder={provider.hasApiKey ? 'Stored. Enter a new key to replace it.' : ''} onChange={(event) => setApiKey(event.target.value)} /></label>
                <label className="reader-settings__wide">Model
                  <span className="reader-settings__model"><input required list="reader-model-options" value={model} onChange={(event) => setModel(event.target.value)} /><button className="quiet-button" type="button" onClick={() => void fetchModels()} disabled={loadingModels}>{loadingModels ? 'Loading...' : 'Fetch models'}</button></span>
                  <datalist id="reader-model-options">{models.map((item) => <option key={item.id} value={item.id}>{item.ownedBy}</option>)}</datalist>
                  {modelError && <small className="reader-settings__status is-error">{modelError}</small>}
                </label>
              </div>
            </section>
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Cloud size={17} /><div><strong>WebDAV metadata sync</strong><span>Reading progress and chats are keyed by the PDF SHA-256 hash.</span></div><label className="reader-settings__switch"><input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} />Enabled</label></div>
              <div className="reader-settings__fields">
                <label className="reader-settings__wide">Server URL<input value={webDavUrl} placeholder="https://dav.example.com/remote.php/dav/files/name" onChange={(event) => setWebDavUrl(event.target.value)} /></label>
                <label>Folder<input value={webDavPath} placeholder="sidelight" onChange={(event) => setWebDavPath(event.target.value)} /></label>
                <label>Username<input value={webDavUsername} onChange={(event) => setWebDavUsername(event.target.value)} /></label>
                <label className="reader-settings__wide">Password<input type="password" value={webDavPassword} placeholder={webDavSync.hasPassword ? 'Stored. Enter a new password to replace it.' : ''} onChange={(event) => setWebDavPassword(event.target.value)} /></label>
              </div>
            </section>
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><LanguagesIcon size={17} /><div><strong>Language</strong><span>Interface and generated response preference.</span></div></div>
              <div className="reader-settings__fields">
                <label>UI language<select value={uiLanguage} onChange={(event) => setUiLanguage(event.target.value as UiLanguage)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
                <label>AI preferred language<select value={aiLanguage} onChange={(event) => setAiLanguage(event.target.value as AiPreferredLanguage)}><option value="Simplified Chinese">Simplified Chinese</option><option value="Chinese">Chinese</option><option value="English">English</option></select></label>
              </div>
            </section>
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Bot size={17} /><div><strong>Experimental Codex reader</strong><span>Local Codex handles PDF chat and translation in a private per-PDF workspace.</span></div><label className="reader-settings__switch"><input type="checkbox" checked={codexEnabled} disabled={!codexAvailability?.available} onChange={(event) => setCodexEnabled(event.target.checked)} />Enabled</label></div>
              <div className="reader-settings__fields">
                <label>Chat model<select value={codexChatModel} disabled={!codexEnabled || !codexAvailability?.available} onChange={(event) => { setCodexChatModel(event.target.value); setCodexChatEffort(''); }}><option value="">Codex default</option>{codexModels.map((modelInfo) => <option key={modelInfo.id} value={modelInfo.id}>{modelInfo.displayName}</option>)}</select></label>
                <label>Chat reasoning<select value={codexChatEffort} disabled={!codexEnabled || !codexAvailability?.available || chatEfforts.length === 0} onChange={(event) => setCodexChatEffort(event.target.value)}><option value="">Model default</option>{chatEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort)}</option>)}</select></label>
                <label>Translation model<select value={codexTranslationModel} disabled={!codexEnabled || !codexAvailability?.available} onChange={(event) => { setCodexTranslationModel(event.target.value); setCodexTranslationEffort(''); }}><option value="">Codex default</option>{codexModels.map((modelInfo) => <option key={modelInfo.id} value={modelInfo.id}>{modelInfo.displayName}</option>)}</select></label>
                <label>Translation reasoning<select value={codexTranslationEffort} disabled={!codexEnabled || !codexAvailability?.available || translationEfforts.length === 0} onChange={(event) => setCodexTranslationEffort(event.target.value)}><option value="">Model default</option>{translationEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort)}</option>)}</select></label>
                <small className={codexAvailability?.available ? 'reader-settings__status' : 'reader-settings__status is-error'}>{codexAvailability?.available ? `Available locally: ${codexAvailability.version ?? 'Codex CLI'}` : codexAvailability?.reason ?? 'Checking local Codex CLI...'}</small>
              </div>
            </section>
          </div>
          <footer className="reader-settings__actions"><button className="quiet-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Save</button></footer>
        </form>
      </section>
    </div>
  );
}

function appText(language: UiLanguage) {
  if (language === 'zh-CN') {
    return {
      aiPreferredLanguage: 'AI 首选语言',
      aiProvider: 'AI Provider',
      aiReady: 'AI 已就绪',
      annotationColorsHelp: '为高亮、下划线、对话和笔记选区设置低饱和颜色。',
      appearance: '外观',
      apiKey: 'API key',
      baseUrl: 'Base URL',
      branch: 'Branch',
      cancel: '取消',
      chatColor: '对话选区',
      availableModels: '可选模型',
      chooseModel: '选择模型',
      close: '关闭',
      enabled: '启用',
      fetchModels: '获取 models',
      githubUpload: 'GitHub 上传',
      githubManualHelp: '启动时会自动同步；这里也可以手动同步或直接上传当前本地快照。',
      githubSyncNow: '同步',
      githubSyncing: '同步中...',
      githubUploadNow: '上传',
      githubUploading: '上传中...',
      group: '分组',
      groups: '分组',
      cloudHeld: '云端持有',
      createGroup: '创建分组',
      groupFilters: '分组筛选',
      holdInCloud: '持有这个组',
      newGroup: '新分组',
      noGroup: '未分组',
      noGroupsYet: '还没有分组',
      quickOpen: '临时打开',
      keyStored: 'Key 已保存',
      language: '语言',
      languageHelp: '分别控制界面文案和 AI 输出语言',
      languageMuted: 'UI 语言只影响按钮和界面文案；AI 首选语言会影响提示词、翻译目标和生成内容。',
      allDocuments: '全部文档',
      clearFilter: '清除筛选',
      latestFile: '最近文件',
      lastOpened: '上次打开',
      library: '资料库',
      libraryEmptyCopy: '每个 PDF 会在独立阅读窗口中打开，并保留对话、笔记和标注。',
      librarySections: '资料库分区',
      listView: '列表',
      loadingModels: '获取中...',
      localDraftMode: '本地草稿模式',
      localFirstLibraryData: '本地优先的资料库数据',
      highlightColor: '高亮',
      model: 'Model',
      name: '名称',
      noteColor: '笔记选区',
      noModelsFound: '没有获取到模型。',
      noMatchingCopy: '换一个标题、文件名或标签试试。',
      noMatchingPdfs: '没有匹配的 PDF',
      noRecentFiles: '还没有最近打开的 PDF',
      noTagsYet: '还没有标签',
      noProviderLoaded: 'Provider 未加载',
      openAiCompatible: 'OpenAI-compatible chat completions',
      openFirstPdf: '打开第一个 PDF',
      openPdf: '打开 PDF',
      owner: 'Owner',
      pageProgress: '阅读进度',
      path: 'Path',
      pdfLibrary: 'PDF 资料库',
      pdfReadingWorkspace: 'PDF 阅读工作台',
      recent: '最近',
      recentDocuments: '最近文档',
      repo: 'Repo',
      repositoryTarget: '仓库目标',
      save: '保存',
      searchPdfsOrTags: '搜索 PDF 或标签',
      showing: '当前显示',
      settings: '设置',
      settingsSections: '设置分区',
      storedKeyPlaceholder: '已保存。输入新 key 可替换。',
      storedTokenPlaceholder: '已保存。输入新 token 可替换。',
      tags: '标签',
      tagFilters: '标签筛选',
      taggedDocuments: '已打标签',
      temperature: 'Temperature',
      title: '标题',
      token: 'Token',
      tokenStored: 'Token 已保存',
      summaryColor: '总结选区',
      translateColor: '翻译选区',
      uiLanguage: 'UI 语言',
      underlineColor: '下划线',
      untagged: '无标签',
      coverView: '封面',
      viewMode: '显示方式',
      workspace: '工作区',
      workspaceMuted: 'PDF 元数据、笔记、标注和对话会留在本地工作区，直到你开启上传。'
    };
  }

  return {
    aiPreferredLanguage: 'AI preferred language',
    aiProvider: 'AI Provider',
    aiReady: 'AI ready',
    annotationColorsHelp: 'Use muted colors for highlights, underlines, chats, and note selections.',
    appearance: 'Appearance',
    apiKey: 'API key',
    baseUrl: 'Base URL',
    branch: 'Branch',
    cancel: 'Cancel',
    chatColor: 'Chat selection',
    availableModels: 'Available models',
    chooseModel: 'Choose a model',
    close: 'Close',
    enabled: 'Enabled',
    fetchModels: 'Fetch models',
    githubUpload: 'GitHub Upload',
    githubManualHelp: 'Sidelight syncs on launch; you can also sync now or upload the current local snapshot.',
    githubSyncNow: 'Sync now',
    githubSyncing: 'Syncing...',
    githubUploadNow: 'Upload now',
    githubUploading: 'Uploading...',
    group: 'Group',
    groups: 'Groups',
    cloudHeld: 'Cloud held',
    createGroup: 'Create group',
    groupFilters: 'Group filters',
    holdInCloud: 'Hold this group',
    newGroup: 'New group',
    noGroup: 'No group',
    noGroupsYet: 'No groups yet',
    quickOpen: 'Temporary open',
    keyStored: 'Key stored',
    language: 'Language',
    languageHelp: 'Control interface text and AI output separately',
    languageMuted: 'UI language changes buttons and interface text. AI preferred language changes prompts, translation targets, and generated content.',
    allDocuments: 'All documents',
    clearFilter: 'Clear filter',
    latestFile: 'Latest file',
    lastOpened: 'Last opened',
    library: 'Library',
    libraryEmptyCopy: 'Each PDF opens in its own reading window with persistent chats and notes.',
    librarySections: 'Library sections',
    listView: 'List view',
    loadingModels: 'Loading...',
    localDraftMode: 'Local draft mode',
    localFirstLibraryData: 'Local-first library data',
    highlightColor: 'Highlight',
    model: 'Model',
    name: 'Name',
    noteColor: 'Note selection',
    noModelsFound: 'No models were returned.',
    noMatchingCopy: 'Try a different title, file name, or tag.',
    noMatchingPdfs: 'No matching PDFs',
    noRecentFiles: 'No recently opened PDFs yet',
    noTagsYet: 'No tags yet',
    noProviderLoaded: 'No provider loaded',
    openAiCompatible: 'OpenAI-compatible chat completions',
    openFirstPdf: 'Open your first PDF',
      openPdf: 'Open PDF',
    owner: 'Owner',
    pageProgress: 'Reading progress',
    path: 'Path',
    pdfLibrary: 'PDF library',
    pdfReadingWorkspace: 'PDF reading workspace',
    recent: 'Recent',
    recentDocuments: 'Recent documents',
    repo: 'Repo',
    repositoryTarget: 'Repository target',
    save: 'Save',
    searchPdfsOrTags: 'Search PDFs or tags',
    showing: 'Showing',
    settings: 'Settings',
    settingsSections: 'Settings sections',
    storedKeyPlaceholder: 'Stored. Enter a new key to replace it.',
    storedTokenPlaceholder: 'Stored. Enter a new token to replace it.',
    tags: 'Tags',
    tagFilters: 'Tag filters',
    taggedDocuments: 'Tagged',
    temperature: 'Temperature',
    title: 'Title',
    token: 'Token',
    tokenStored: 'Token stored',
    summaryColor: 'Summary selection',
    translateColor: 'Translate selection',
    uiLanguage: 'UI language',
    underlineColor: 'Underline',
    untagged: 'untagged',
    coverView: 'Cover grid',
    viewMode: 'View mode',
    workspace: 'Workspace',
    workspaceMuted: 'PDF metadata, notes, highlights, and chats stay in the local workspace until upload is enabled.'
  };
}

function LibraryHome({
  documents,
  groups,
  provider,
  uiLanguage,
  onOpenPdf,
  onOpenDocument,
  onSaveGroup,
  onSaveDocument,
  onOpenSettings
}: {
  documents: PdfDocumentMeta[];
  groups: LibraryGroup[];
  provider?: SafeAiProviderConfig;
  uiLanguage: UiLanguage;
  onOpenPdf(): void;
  onOpenDocument(documentId: string): void;
  onSaveGroup(group: LibraryGroup): void;
  onSaveDocument(document: PdfDocumentMeta): void;
  onOpenSettings(): void;
}): ReactElement {
  const ungroupedGroupId = '__ungrouped__';
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'library' | 'recent' | 'tags' | 'groups'>('library');
  const [activeTag, setActiveTag] = useState<string>();
  const [activeGroupId, setActiveGroupId] = useState<string>();
  const [newGroupName, setNewGroupName] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'covers'>(() =>
    window.localStorage.getItem('sidelight.libraryViewMode') === 'covers' ? 'covers' : 'list'
  );
  const t = appText(uiLanguage);
  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()),
    [documents]
  );
  const visibleDocuments = useMemo(() => {
    const scopedDocuments = activeGroupId === ungroupedGroupId
      ? sortedDocuments.filter((document) => (document.groupIds ?? []).length === 0)
      : activeGroupId
      ? sortedDocuments.filter((document) => (document.groupIds ?? []).includes(activeGroupId))
      : activeTag
      ? sortedDocuments.filter((document) => document.tags.includes(activeTag))
      : scope === 'recent'
        ? sortedDocuments.slice(0, 12)
        : sortedDocuments;
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return scopedDocuments;
    }

    return scopedDocuments.filter((document) =>
      [document.title, document.fileName, ...document.tags]
        .join('\n')
        .toLowerCase()
        .includes(needle)
    );
  }, [activeGroupId, activeTag, query, scope, sortedDocuments]);
  const allTags = useMemo(
    () => Array.from(new Set(documents.flatMap((document) => document.tags))).sort((a, b) => a.localeCompare(b)),
    [documents]
  );
  const taggedCount = useMemo(() => documents.filter((document) => document.tags.length > 0).length, [documents]);
  const latestDocument = sortedDocuments[0];

  const ungroupedCount = useMemo(() => documents.filter((document) => (document.groupIds ?? []).length === 0).length, [documents]);
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const heldGroupCount = useMemo(() => groups.filter((group) => group.cloudHeld).length, [groups]);
  const toolbarEyebrow =
    scope === 'groups' ? t.groupFilters : activeTag ? t.tagFilters : scope === 'recent' ? t.recentDocuments : t.workspace;
  const toolbarTitle =
    activeGroup?.name ?? (activeGroupId === ungroupedGroupId ? t.noGroup : activeTag ?? (scope === 'recent' ? t.recentDocuments : scope === 'groups' ? t.groups : t.library));
  const overviewButtonClass = (isActive: boolean): string => isActive ? 'library-stat is-active' : 'library-stat';

  useEffect(() => {
    window.localStorage.setItem('sidelight.libraryViewMode', viewMode);
  }, [viewMode]);

  const selectScope = (nextScope: 'library' | 'recent' | 'tags' | 'groups'): void => {
    setScope(nextScope);
    if (nextScope !== 'groups') {
      setActiveGroupId(undefined);
    } else if (!activeGroupId && groups[0]) {
      setActiveGroupId(groups[0].id);
    }
    if (nextScope !== 'tags') {
      setActiveTag(undefined);
    } else if (!activeTag && allTags[0]) {
      setActiveTag(allTags[0]);
    }
  };

  const createGroup = (): void => {
    const name = newGroupName.trim();
    if (!name) {
      return;
    }

    const now = new Date().toISOString();
    const group: LibraryGroup = {
      id: createId('group'),
      name,
      cloudHeld: false,
      createdAt: now,
      updatedAt: now
    };
    setNewGroupName('');
    setScope('groups');
    setActiveGroupId(group.id);
    onSaveGroup(group);
  };

  const assignDocumentToGroup = (document: PdfDocumentMeta, groupId: string): void => {
    onSaveDocument({
      ...document,
      inLibrary: true,
      groupIds: groupId ? [groupId] : [],
      updatedAt: new Date().toISOString()
    });
  };

  return (
    <section className="library-home">
      <aside className="library-home__sidebar">
        <header>
          <div className="library-home__brand">
            <Library size={22} />
            <div>
              <strong>Sidelight</strong>
              <span>{t.pdfReadingWorkspace}</span>
            </div>
          </div>
          <button className="icon-button" type="button" title={t.settings} onClick={onOpenSettings}>
            <Settings size={16} />
          </button>
        </header>

        <nav className="library-home__nav" aria-label={t.librarySections}>
          <button
            type="button"
            className={scope === 'library' && !activeTag ? 'is-active' : ''}
            aria-pressed={scope === 'library' && !activeTag}
            onClick={() => selectScope('library')}
          >
            <BookOpen size={16} />
            <span>{t.library}</span>
            <strong>{documents.length}</strong>
          </button>
          <button
            type="button"
            className={scope === 'recent' ? 'is-active' : ''}
            aria-pressed={scope === 'recent'}
            onClick={() => selectScope('recent')}
          >
            <Clock3 size={16} />
            <span>{t.recent}</span>
            <strong>{Math.min(documents.length, 12)}</strong>
          </button>
          <button
            type="button"
            className={scope === 'tags' || activeTag ? 'is-active' : ''}
            aria-pressed={scope === 'tags' || Boolean(activeTag)}
            onClick={() => selectScope('tags')}
          >
            <Tags size={16} />
            <span>{t.tags}</span>
            <strong>{allTags.length}</strong>
          </button>
          <button
            type="button"
            className={scope === 'groups' ? 'is-active' : ''}
            aria-pressed={scope === 'groups'}
            onClick={() => selectScope('groups')}
          >
            <Cloud size={16} />
            <span>{t.groups}</span>
            <strong>{groups.length}</strong>
          </button>
        </nav>

        <form className="library-home__new-group" onSubmit={(event) => {
          event.preventDefault();
          createGroup();
        }}>
          <label htmlFor="library-new-group">{t.newGroup}</label>
          <span>
            <input
              id="library-new-group"
              value={newGroupName}
              placeholder={t.newGroup}
              onChange={(event) => setNewGroupName(event.target.value)}
            />
            <button type="submit" title={t.createGroup} disabled={!newGroupName.trim()}>
              <Plus size={15} />
            </button>
          </span>
        </form>

        <div className="library-home__provider">
          <Bot size={17} />
          <div>
            <span>{provider?.hasApiKey ? t.aiReady : t.localDraftMode}</span>
            <strong>{provider?.model ?? t.noProviderLoaded}</strong>
          </div>
        </div>
      </aside>

      <section className="library-home__main">
        <header className="library-toolbar">
          <div>
            <span>{toolbarEyebrow}</span>
            <h1>{toolbarTitle}</h1>
          </div>
          <div className="library-toolbar__actions">
            <div className="library-view-toggle" role="group" aria-label={t.viewMode}>
              <button
                type="button"
                className={viewMode === 'list' ? 'is-active' : ''}
                aria-pressed={viewMode === 'list'}
                title={t.listView}
                onClick={() => setViewMode('list')}
              >
                <LayoutList size={15} />
                {t.listView}
              </button>
              <button
                type="button"
                className={viewMode === 'covers' ? 'is-active' : ''}
                aria-pressed={viewMode === 'covers'}
                title={t.coverView}
                onClick={() => setViewMode('covers')}
              >
                <LayoutGrid size={15} />
                {t.coverView}
              </button>
            </div>
            <label className="library-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t.searchPdfsOrTags}
              />
            </label>
            <button className="primary-button" type="button" onClick={onOpenPdf}>
              <FolderOpen size={16} />
              {t.openPdf}
            </button>
          </div>
        </header>

        <section className="library-overview" aria-label={t.showing}>
          <button
            className={overviewButtonClass(scope === 'library' && !activeTag && !activeGroupId)}
            type="button"
            onClick={() => selectScope('library')}
          >
            <span>{t.allDocuments}</span>
            <strong>{documents.length}</strong>
            <small>{t.pdfLibrary}</small>
          </button>
          <button
            className={overviewButtonClass(scope === 'recent')}
            type="button"
            onClick={() => selectScope('recent')}
          >
            <span>{t.recentDocuments}</span>
            <strong>{Math.min(documents.length, 12)}</strong>
            <small>{latestDocument?.title ?? t.noRecentFiles}</small>
          </button>
          <button
            className={overviewButtonClass(scope === 'tags' || Boolean(activeTag))}
            type="button"
            onClick={() => selectScope('tags')}
          >
            <span>{t.taggedDocuments}</span>
            <strong>{taggedCount}</strong>
            <small>{allTags.length ? `${allTags.length} ${t.tags}` : t.noTagsYet}</small>
          </button>
          <button
            className={overviewButtonClass(scope === 'groups' || Boolean(activeGroupId))}
            type="button"
            onClick={() => selectScope('groups')}
          >
            <span>{t.groups}</span>
            <strong>{groups.length}</strong>
            <small>{heldGroupCount ? `${heldGroupCount} ${t.cloudHeld}` : t.noGroupsYet}</small>
          </button>
        </section>

        <div className="library-filterbar" aria-label={scope === 'groups' ? t.groupFilters : t.tagFilters}>
          {scope === 'groups' ? (
            <>
              <span>{t.groupFilters}</span>
              <button
                type="button"
                className={!activeGroupId ? 'is-active' : ''}
                onClick={() => {
                  setActiveGroupId(undefined);
                  setActiveTag(undefined);
                }}
              >
                {t.allDocuments}
              </button>
              <button
                type="button"
                className={activeGroupId === ungroupedGroupId ? 'is-active' : ''}
                onClick={() => {
                  setActiveGroupId(ungroupedGroupId);
                  setActiveTag(undefined);
                }}
              >
                {t.noGroup}
                <small>{ungroupedCount}</small>
              </button>
              {groups.length === 0 && <em>{t.noGroupsYet}</em>}
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={activeGroupId === group.id ? 'is-active' : ''}
                  onClick={() => {
                    setActiveGroupId(group.id);
                    setActiveTag(undefined);
                  }}
                >
                  {group.cloudHeld && <Cloud size={13} />}
                  {group.name}
                </button>
              ))}
              {activeGroup && (
                <button
                  type="button"
                  className={activeGroup.cloudHeld ? 'library-filterbar__hold is-active' : 'library-filterbar__hold'}
                  aria-pressed={activeGroup.cloudHeld}
                  onClick={() => onSaveGroup({ ...activeGroup, cloudHeld: !activeGroup.cloudHeld })}
                >
                  <Cloud size={13} />
                  {activeGroup.cloudHeld ? t.cloudHeld : t.holdInCloud}
                </button>
              )}
            </>
          ) : (
            <>
              <span>{t.tagFilters}</span>
              <button
                type="button"
                className={!activeTag ? 'is-active' : ''}
                onClick={() => {
                  setActiveTag(undefined);
                  setScope('library');
                }}
              >
                {t.allDocuments}
              </button>
              {allTags.length === 0 && <em>{t.noTagsYet}</em>}
              {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={activeTag === tag ? 'is-active' : ''}
              onClick={() => {
                setActiveTag(tag);
                setScope('tags');
              }}
            >
              {tag}
            </button>
              ))}
            </>
          )}
        </div>

        <div
          className={viewMode === 'list' ? 'library-table' : 'library-table library-table--covers'}
          role={viewMode === 'list' ? 'table' : 'list'}
          aria-label={t.pdfLibrary}
        >
          {viewMode === 'list' && (
            <div className="library-table__head" role="row">
              <span>{t.title}</span>
              <span>{t.group}</span>
              <span>{t.pageProgress}</span>
            </div>
          )}

          {visibleDocuments.length === 0 ? (
            <section className="library-empty">
              <FileText size={38} strokeWidth={1.5} />
              <h2>{documents.length === 0 ? t.openFirstPdf : t.noMatchingPdfs}</h2>
              <p>
                {documents.length === 0
                  ? t.libraryEmptyCopy
                  : t.noMatchingCopy}
              </p>
              {documents.length === 0 && (
                <button className="primary-button" type="button" onClick={onOpenPdf}>
                  <FolderOpen size={16} />
                  {t.openPdf}
                </button>
              )}
            </section>
          ) : viewMode === 'list' ? (
            <div className="library-table__body">
              {visibleDocuments.map((document) => {
                const selectedGroupId = (document.groupIds ?? [])[0] ?? '';
                return (
                  <div key={document.id} className="library-row" role="row">
                    <button
                      className="library-row__open"
                      type="button"
                      onClick={() => onOpenDocument(document.id)}
                    >
                      <span className="library-row__title">
                        <BookOpen size={17} />
                        <span>
                          <strong>{document.title}</strong>
                          <small>{document.fileName}</small>
                          <small className="library-row__progress-label">{readingProgressText(document, uiLanguage)}</small>
                        </span>
                      </span>
                    </button>
                    <span className="library-row__groups">
                      <select
                        aria-label={`${t.group}: ${document.title}`}
                        value={selectedGroupId}
                        onChange={(event) => assignDocumentToGroup(document, event.target.value)}
                      >
                        <option value="">{t.noGroup}</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                      <span className="library-row__tags">
                        {document.tags.length
                          ? document.tags.map((tag) => <small key={tag}>{tag}</small>)
                          : <small>{t.untagged}</small>}
                      </span>
                    </span>
                    <span className="library-row__status">
                      <span>{readingProgressText(document, uiLanguage)}</span>
                      <small>{formatLibraryDate(document.readingState?.updatedAt ?? document.lastOpenedAt)}</small>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="library-cover-grid">
              {visibleDocuments.map((document) => {
                const selectedGroupId = (document.groupIds ?? [])[0] ?? '';
                return (
                  <article key={document.id} className="library-cover-card" role="listitem">
                    <button
                      className="library-cover-card__open"
                      type="button"
                      onClick={() => onOpenDocument(document.id)}
                    >
                      <span className="library-cover-card__cover" aria-hidden="true">
                        <span>PDF</span>
                        <BookOpen size={24} />
                        <strong>{document.title}</strong>
                      </span>
                      <span className="library-cover-card__title">
                        <strong>{document.title}</strong>
                        <small>{document.fileName}</small>
                      </span>
                      <span className="library-cover-card__progress">
                        <span>{readingProgressText(document, uiLanguage)}</span>
                        <small>{formatLibraryDate(document.readingState?.updatedAt ?? document.lastOpenedAt)}</small>
                      </span>
                    </button>
                    <div className="library-cover-card__meta">
                      <select
                        aria-label={`${t.group}: ${document.title}`}
                        value={selectedGroupId}
                        onChange={(event) => assignDocumentToGroup(document, event.target.value)}
                      >
                        <option value="">{t.noGroup}</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                      <span className="library-cover-card__tags">
                        {document.tags.length
                          ? document.tags.map((tag) => <small key={tag}>{tag}</small>)
                          : <small>{t.untagged}</small>}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function FloatingSettingsPanel({
  provider,
  githubUpload,
  preferences,
  onClose,
  onGitHubAction,
  onSave
}: {
  provider: SafeAiProviderConfig;
  githubUpload: SafeGitHubUploadConfig;
  preferences: AppPreferences;
  onClose(): void;
  onGitHubAction(
    mode: WorkspaceSyncResult['mode'],
    aiConfig: AiProviderConfig,
    uploadConfig: GitHubUploadConfig,
    preferencesConfig: AppPreferences
  ): Promise<WorkspaceSyncResult>;
  onSave(aiConfig: AiProviderConfig, uploadConfig: GitHubUploadConfig, preferencesConfig: AppPreferences): void;
}): ReactElement {
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [temperature, setTemperature] = useState(provider.temperature);
  const [apiKey, setApiKey] = useState('');
  const [uploadEnabled, setUploadEnabled] = useState(githubUpload.enabled);
  const [owner, setOwner] = useState(githubUpload.owner);
  const [repo, setRepo] = useState(githubUpload.repo);
  const [branch, setBranch] = useState(githubUpload.branch);
  const [basePath, setBasePath] = useState(githubUpload.basePath);
  const [token, setToken] = useState('');
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(preferences.uiLanguage);
  const [aiLanguage, setAiLanguage] = useState<AiPreferredLanguage>(preferences.aiLanguage);
  const [selectionColors, setSelectionColors] = useState(normalizeSelectionColors(preferences.selectionColors));
  const [modelOptions, setModelOptions] = useState<AiModelInfo[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string>();
  const [githubAction, setGithubAction] = useState<WorkspaceSyncResult['mode']>();
  const [githubStatus, setGithubStatus] = useState<string>();
  const [githubError, setGithubError] = useState<string>();
  const t = appText(uiLanguage);

  const currentAiConfig = (): AiProviderConfig => ({
    displayName: displayName.trim() || 'OpenAI-compatible',
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    temperature,
    apiKey: apiKey.trim() || undefined
  });

  const currentUploadConfig = (): GitHubUploadConfig => ({
    enabled: uploadEnabled,
    owner,
    repo,
    branch,
    basePath,
    token: token.trim() || undefined
  });

  const currentPreferences = (): AppPreferences => ({
    uiLanguage,
    aiLanguage,
    selectionColors: normalizeSelectionColors(selectionColors),
    experimentalCodexAgent: preferences.experimentalCodexAgent
  });

  const fetchModels = async (): Promise<void> => {
    setModelLoading(true);
    setModelError(undefined);

    try {
      const models = await window.sidelight.listAiModels({
        displayName: displayName.trim() || 'OpenAI-compatible',
        baseUrl: baseUrl.trim(),
        model: model.trim() || provider.model,
        temperature,
        apiKey: apiKey.trim() || undefined
      });
      setModelOptions(models);
      if (!model.trim() && models[0]) {
        setModel(models[0].id);
      }
      if (models.length === 0) {
        setModelError(t.noModelsFound);
      }
    } catch (error) {
      setModelOptions([]);
      setModelError(presentableAiError(error));
    } finally {
      setModelLoading(false);
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(currentAiConfig(), currentUploadConfig(), currentPreferences());
  };

  const runGithubAction = async (mode: WorkspaceSyncResult['mode']): Promise<void> => {
    setGithubAction(mode);
    setGithubStatus(undefined);
    setGithubError(undefined);
    try {
      const result = await onGitHubAction(mode, currentAiConfig(), currentUploadConfig(), currentPreferences());
      setGithubStatus(result.message);
    } catch (error) {
      setGithubError(presentableAiError(error));
    } finally {
      setGithubAction(undefined);
    }
  };

  const updateSelectionColor = (role: SelectionColorRole, color: string): void => {
    setSelectionColors((current) => normalizeSelectionColors({
      ...current,
      [role]: color
    }));
  };
  const canRunGithubAction = uploadEnabled &&
    owner.trim().length > 0 &&
    repo.trim().length > 0 &&
    (token.trim().length > 0 || githubUpload.hasToken);

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="floating-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div>
            <span>{provider.hasApiKey ? t.keyStored : t.localDraftMode}</span>
            <strong id="settings-title">{t.settings}</strong>
          </div>
          <button className="icon-button" type="button" title={t.close} onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <form className="settings-form" onSubmit={submit}>
          <nav className="settings-nav" aria-label={t.settingsSections}>
            <a href="#settings-ai">
              <Bot size={15} />
              {t.aiProvider}
            </a>
            <a href="#settings-language">
              <LanguagesIcon />
              {t.language}
            </a>
            <a href="#settings-appearance">
              <Palette size={15} />
              {t.appearance}
            </a>
            <a href="#settings-github">
              <Github size={15} />
              {t.githubUpload}
            </a>
            <a href="#settings-workspace">
              <SlidersHorizontal size={15} />
              {t.workspace}
            </a>
          </nav>

          <div className="settings-sections">
            <section className="settings-section" id="settings-ai">
              <div className="settings-section__heading">
                <Bot size={17} />
                <div>
                  <strong>{t.aiProvider}</strong>
                  <span>{t.openAiCompatible}</span>
                </div>
              </div>
              <div className="settings-grid">
                <label>
                  {t.name}
                  <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>
                <label className="settings-model-field">
                  {t.model}
                  <span className="settings-model-control">
                    <input
                      value={model}
                      list="settings-model-options"
                      onChange={(event) => setModel(event.target.value)}
                    />
                    <button
                      className="quiet-button settings-model-fetch"
                      type="button"
                      disabled={!baseUrl.trim() || modelLoading}
                      onClick={() => void fetchModels()}
                    >
                      <RefreshCw size={14} />
                      {modelLoading ? t.loadingModels : t.fetchModels}
                    </button>
                  </span>
                  <datalist id="settings-model-options">
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.ownedBy ?? option.id}
                      </option>
                    ))}
                  </datalist>
                  {modelOptions.length > 0 && (
                    <select
                      aria-label={t.availableModels}
                      value={modelOptions.some((option) => option.id === model) ? model : ''}
                      onChange={(event) => setModel(event.target.value)}
                    >
                      <option value="" disabled>{t.chooseModel}</option>
                      {modelOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id}
                        </option>
                      ))}
                    </select>
                  )}
                  {modelError && <small className="settings-field-status">{modelError}</small>}
                </label>
                <label className="settings-field--wide">
                  {t.baseUrl}
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
                </label>
                <label className="settings-field--wide">
                  {t.apiKey}
                  <input
                    value={apiKey}
                    type="password"
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={provider.hasApiKey ? t.storedKeyPlaceholder : 'sk-...'}
                  />
                </label>
                <label>
                  {t.temperature}
                  <input
                    value={temperature}
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    onChange={(event) => setTemperature(Number(event.target.value))}
                  />
                </label>
              </div>
            </section>

            <section className="settings-section" id="settings-language">
              <div className="settings-section__heading">
                <SlidersHorizontal size={17} />
                <div>
                  <strong>{t.language}</strong>
                  <span>{t.languageHelp}</span>
                </div>
              </div>
              <div className="settings-grid">
                <label>
                  {t.uiLanguage}
                  <select value={uiLanguage} onChange={(event) => setUiLanguage(event.target.value as UiLanguage)}>
                    <option value="en">English</option>
                    <option value="zh-CN">简体中文</option>
                  </select>
                </label>
                <label>
                  {t.aiPreferredLanguage}
                  <select
                    value={aiLanguage}
                    onChange={(event) => setAiLanguage(event.target.value as AiPreferredLanguage)}
                  >
                    <option value="English">English</option>
                    <option value="Chinese">中文</option>
                    <option value="Simplified Chinese">简体中文</option>
                  </select>
                </label>
              </div>
              <div className="settings-muted-row">
                {t.languageMuted}
              </div>
            </section>

            <section className="settings-section" id="settings-appearance">
              <div className="settings-section__heading">
                <Palette size={17} />
                <div>
                  <strong>{t.appearance}</strong>
                  <span>{t.annotationColorsHelp}</span>
                </div>
              </div>
              <div className="settings-color-grid">
                <SelectionColorField
                  label={t.highlightColor}
                  value={selectionColors.highlight}
                  onChange={(color) => updateSelectionColor('highlight', color)}
                />
                <SelectionColorField
                  label={t.underlineColor}
                  value={selectionColors.underline}
                  onChange={(color) => updateSelectionColor('underline', color)}
                />
                <SelectionColorField
                  label={t.chatColor}
                  value={selectionColors.chat}
                  onChange={(color) => updateSelectionColor('chat', color)}
                />
                <SelectionColorField
                  label={t.noteColor}
                  value={selectionColors.note}
                  onChange={(color) => updateSelectionColor('note', color)}
                />
                <SelectionColorField
                  label={t.summaryColor}
                  value={selectionColors.summary}
                  onChange={(color) => updateSelectionColor('summary', color)}
                />
                <SelectionColorField
                  label={t.translateColor}
                  value={selectionColors.translate}
                  onChange={(color) => updateSelectionColor('translate', color)}
                />
              </div>
            </section>

            <section className="settings-section" id="settings-github">
              <div className="settings-section__heading">
                <Github size={17} />
                <div>
                  <strong>{t.githubUpload}</strong>
                  <span>{githubUpload.hasToken ? t.tokenStored : t.repositoryTarget}</span>
                </div>
                <label className="settings-switch">
                  <input
                    type="checkbox"
                    checked={uploadEnabled}
                    onChange={(event) => setUploadEnabled(event.target.checked)}
                  />
                  {t.enabled}
                </label>
              </div>
              <div className="settings-grid">
                <label>
                  {t.owner}
                  <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="octocat" />
                </label>
                <label>
                  {t.repo}
                  <input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="notebook" />
                </label>
                <label>
                  {t.branch}
                  <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
                </label>
                <label>
                  {t.path}
                  <input value={basePath} onChange={(event) => setBasePath(event.target.value)} placeholder="sidelight" />
                </label>
                <label className="settings-field--wide">
                  {t.token}
                  <input
                    value={token}
                    type="password"
                    onChange={(event) => setToken(event.target.value)}
                    placeholder={githubUpload.hasToken ? t.storedTokenPlaceholder : 'github_pat_...'}
                  />
                </label>
              </div>
              <div className="settings-github-actions">
                <button
                  className="quiet-button"
                  type="button"
                  disabled={!canRunGithubAction || Boolean(githubAction)}
                  onClick={() => void runGithubAction('sync')}
                >
                  <RefreshCw size={14} />
                  {githubAction === 'sync' ? t.githubSyncing : t.githubSyncNow}
                </button>
                <button
                  className="quiet-button"
                  type="button"
                  disabled={!canRunGithubAction || Boolean(githubAction)}
                  onClick={() => void runGithubAction('upload')}
                >
                  <UploadCloud size={14} />
                  {githubAction === 'upload' ? t.githubUploading : t.githubUploadNow}
                </button>
                <small className={githubError ? 'settings-field-status is-error' : 'settings-field-status'}>
                  {githubError ?? githubStatus ?? t.githubManualHelp}
                </small>
              </div>
            </section>

            <section className="settings-section" id="settings-workspace">
              <div className="settings-section__heading">
                <SlidersHorizontal size={17} />
                <div>
                  <strong>{t.workspace}</strong>
                  <span>{t.localFirstLibraryData}</span>
                </div>
              </div>
              <div className="settings-muted-row">
                {t.workspaceMuted}
              </div>
            </section>
          </div>

          <footer className="settings-actions">
            <button className="quiet-button" type="button" onClick={onClose}>
              {t.cancel}
            </button>
            <button className="primary-button" type="submit" disabled={!baseUrl.trim() || !model.trim()}>
              <Check size={15} />
              {t.save}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function SelectionColorField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange(color: string): void;
}): ReactElement {
  return (
    <label className="settings-color-field">
      <span>{label}</span>
      <input
        type="color"
        aria-label={label}
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function FloatingChatPanel({
  conversation,
  busy,
  onClose,
  onSend
}: {
  conversation: Conversation;
  busy: boolean;
  onClose(): void;
  onSend(prompt: string): void;
}): ReactElement {
  const [draft, setDraft] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || busy) {
      return;
    }

    setDraft('');
    onSend(prompt);
  };

  return (
    <section className="floating-chat">
      <header>
        <div>
          <span>p.{conversation.pageNumber ?? '-'}</span>
          <strong>{conversation.summary.title}</strong>
        </div>
        <button className="icon-button" type="button" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      {conversation.anchor && <blockquote>{conversation.anchor.quote}</blockquote>}

      <div className="floating-chat__messages">
        {conversation.messages.length === 0 && (
          <div className="floating-chat__empty">
            <MessageCircle size={22} />
            <span>{conversation.anchor ? 'Ask anything about the selected passage.' : 'Ask anything about this page.'}</span>
          </div>
        )}
        {conversation.messages.map((message) => (
          <article key={message.id} className={`message message--${message.role}`}>
            <div className="message__role">{message.role === 'assistant' ? 'Sidelight' : 'You'}</div>
            <MarkdownView>{message.content}</MarkdownView>
          </article>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={conversation.anchor ? 'Ask about this selection...' : 'Ask about this page...'}
        />
        <button className="primary-button" type="submit" disabled={busy || !draft.trim()}>
          <Check size={15} />
          Send
        </button>
      </form>
    </section>
  );
}

function promptForMode(mode: AiMode, language: AiPreferredLanguage = 'Simplified Chinese'): string {
  const suffix = `Respond in ${language}.`;
  switch (mode) {
    case 'translate':
      return `Translate this passage into fluent ${language}, while preserving important English technical terms in parentheses.`;
    case 'summarize':
      return `Give me the gist of this passage, then list the key concepts and any assumptions it depends on. ${suffix}`;
    case 'lesson':
      return `Turn this passage into teachable Markdown notes with concepts, examples, and questions to check understanding. ${suffix}`;
    case 'explain':
      return `Explain this passage carefully. Define concepts, unpack hidden assumptions, and keep the answer grounded in the text. ${suffix}`;
    default:
      return `Help me understand this selected passage. ${suffix}`;
  }
}

function promptForQuotedSelection(selection: PdfSelectionPayload, language: AiPreferredLanguage): string {
  if (language === 'English') {
    return [
      `Quoted p.${selection.pageNumber}:`,
      `> ${selection.quote}`,
      '',
      'Continue the current conversation using this passage as the new reference. Connect it to the earlier context and explain what matters.'
    ].join('\n');
  }

  return [
    `引用 p.${selection.pageNumber}:`,
    `> ${selection.quote}`,
    '',
    '请结合这段新引用继续当前对话，说明它和上文问题的关系，并解释关键点。'
  ].join('\n');
}

function summarizeConversation(
  mode: AiMode,
  messages: ConversationMessage[],
  anchor?: TextAnchor
): Conversation['summary'] {
  const firstUser = messages.find((message) => message.role === 'user')?.content ?? promptForMode(mode);
  const firstAssistant = messages.find((message) => message.role === 'assistant')?.content;
  const title = compactTitle(anchor?.quote || firstUser, mode);
  const briefSource = firstAssistant || anchor?.quote || firstUser;

  return {
    title,
    brief: compactSentence(briefSource, 128),
    keywords: extractKeywords([anchor?.quote, firstUser, firstAssistant].filter(Boolean).join(' '))
  };
}

async function requestConversationSummary(
  conversation: Conversation,
  documentTitle: string,
  language: AiPreferredLanguage
): Promise<ConversationSummary | undefined> {
  const transcript = conversation.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n')
    .slice(0, 8000);

  if (!transcript.trim()) {
    return undefined;
  }

  try {
    const response = await window.sidelight.completeAi({
      mode: 'summarize',
      documentTitle,
      contextText: conversation.anchor?.quote,
      prompt: [
        'Summarize this PDF reading chat for a compact sidebar item.',
        `Write title, brief, and keywords in ${language}.`,
        'Return JSON only with this exact shape:',
        '{"title":"short title under 64 characters","brief":"one sentence under 140 characters","keywords":["keyword"]}',
        '',
        transcript
      ].join('\n'),
      preferredLanguage: language
    });

    return parseConversationSummary(response.content);
  } catch (error) {
    console.warn('Conversation summary could not be refreshed', error);
    return undefined;
  }
}

function notePromptForLanguage(pageStart: number, pageEnd: number, language: AiPreferredLanguage): string {
  return [
    `Create a concise markdown study note for pages ${pageStart}-${pageEnd}.`,
    'Use headings, bullets, key terms, and a short recap.',
    'Ground the note in the PDF text, highlights, and previous conversations.',
    'Do not include raw transcripts unless needed.',
    `Write the note in ${language}.`
  ].join(' ');
}

function outlinePromptForLanguage(totalPages: number, language: AiPreferredLanguage): string {
  return [
    'Create an external PDF table of contents for the currently open PDF.',
    'Use the PDF tools. First check the embedded outline; if it is empty, inspect page text with view_current_pdf.',
    totalPages <= 48
      ? 'For this short PDF, inspect enough page ranges to cover the full document.'
      : 'For this longer PDF, inspect the beginning, ending, and representative middle page ranges before proposing sections.',
    'Return JSON only, with this exact shape:',
    '{"items":[{"title":"Section title","level":0,"pageNumber":1}]}',
    'Rules: pageNumber is 1-based, level starts at 0, keep titles compact, include only real sections supported by the PDF text, and sort items by pageNumber.',
    `Write titles in ${language}, preserving important original technical terms.`
  ].join(' ');
}

function parseGeneratedOutlineItems(content: string, totalPages: number): PdfGeneratedOutlineItem[] {
  const parsed = parseOutlineJson(content);
  const rawItems = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown[] } | undefined)?.items)
      ? (parsed as { items: unknown[] }).items
      : [];

  const seen = new Set<string>();
  return rawItems
    .map((item, index) => {
      const candidate = item as { title?: unknown; level?: unknown; pageNumber?: unknown; page?: unknown };
      const title = String(candidate.title ?? '').replace(/\s+/g, ' ').trim();
      const rawPage = Number(candidate.pageNumber ?? candidate.page);
      const pageNumber = Number.isFinite(rawPage)
        ? Math.max(1, Math.min(totalPages, Math.floor(rawPage)))
        : undefined;
      const rawLevel = Number(candidate.level);
      return {
        id: createId('outline'),
        title: compactSentence(title, 110),
        level: Number.isFinite(rawLevel) ? Math.max(0, Math.min(6, Math.floor(rawLevel))) : 0,
        ...(pageNumber ? { pageNumber } : {}),
        order: index
      };
    })
    .filter((item) => item.title)
    .sort((a, b) => (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER) || a.order - b.order)
    .filter((item) => {
      const key = `${item.level}:${item.pageNumber ?? ''}:${item.title.toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(({ order: _order, ...item }) => item)
    .slice(0, 180);
}

function parseOutlineJson(content: string): unknown {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(clean);
  } catch {
    const objectMatch = clean.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    const arrayMatch = clean.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      return JSON.parse(arrayMatch[0]);
    }
    throw new Error('No JSON outline was found in the AI response.');
  }
}

function parseConversationSummary(content: string): ConversationSummary | undefined {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[0]) as Partial<ConversationSummary>;
    if (!parsed.title || !parsed.brief) {
      return undefined;
    }

    return {
      title: compactSentence(String(parsed.title), 72),
      brief: compactSentence(String(parsed.brief), 160),
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.map((keyword) => String(keyword).trim()).filter(Boolean).slice(0, 8)
        : []
    };
  } catch {
    return undefined;
  }
}

function compactTitle(text: string, mode: AiMode): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const prefix = mode === 'ask' ? 'Question' : mode[0].toUpperCase() + mode.slice(1);
  return `${prefix}: ${compactSentence(clean, 54)}`;
}

function compactSentence(text: string, limit: number): string {
  const clean = text.replace(/[#*_`>$[\]{}]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) {
    return clean;
  }

  return `${clean.slice(0, limit - 1).trim()}...`;
}

function buildNoteContext(
  pageStart: number,
  pageEnd: number,
  pageText: string,
  marks: PdfMark[],
  conversations: Conversation[]
): string {
  const highlights = marks.length
    ? marks.map((mark) => `- p.${mark.pageNumber} ${mark.kind}: ${mark.quote}`).join('\n')
    : '- No highlights in this page range.';
  const chatDigest = conversations.length
    ? conversations.map((conversation) => {
        const transcript = conversation.messages
          .map((message) => `${message.role}: ${message.content}`)
          .join('\n')
          .slice(0, 2200);
        return [
          `## Conversation p.${conversation.pageNumber ?? conversation.anchor?.pageNumber ?? '-'}: ${conversation.summary.title}`,
          conversation.anchor ? `Anchor: ${conversation.anchor.quote}` : undefined,
          transcript
        ].filter(Boolean).join('\n');
      }).join('\n\n')
    : 'No conversations in this page range.';

  return [
    `Document pages: ${pageStart}-${pageEnd}`,
    '',
    'PDF text:',
    pageText.trim().slice(0, 18000) || 'No extractable PDF text was available for this page range.',
    '',
    'Highlights:',
    highlights.slice(0, 6000),
    '',
    'Relevant conversations:',
    chatDigest.slice(0, 10000)
  ].join('\n');
}

function buildAiDocumentToolContext({
  document,
  context,
  marks,
  conversations,
  pageStart,
  pageEnd,
  pdfText,
  selectedText,
  selectionRects
}: {
  document: PdfDocumentMeta;
  context?: AiDocumentToolContext;
  marks: PdfMark[];
  conversations: Conversation[];
  pageStart?: number;
  pageEnd?: number;
  pdfText?: string;
  selectedText?: string;
  selectionRects?: TextAnchor['rects'];
}): AiDocumentToolContext {
  const fallbackPage = context?.currentPage ?? document.readingState?.lastPage ?? 1;
  const start = clampPageNumber(pageStart ?? context?.pageStart ?? fallbackPage);
  const end = clampPageNumber(pageEnd ?? context?.pageEnd ?? start, start);
  const pageMarks = marks.filter((mark) => mark.pageNumber >= start && mark.pageNumber <= end);
  const pageConversations = conversations.filter((conversation) => {
    const pageNumber = conversation.pageNumber ?? conversation.anchor?.pageNumber;
    return pageNumber !== undefined && pageNumber >= start && pageNumber <= end;
  });

  return {
    ...context,
    documentId: document.id,
    documentTitle: document.title,
    fileName: document.fileName,
    currentPage: context?.currentPage ?? fallbackPage,
    totalPages: context?.totalPages ?? document.pageCount,
    pageStart: start,
    pageEnd: end,
    selectedText: selectedText ?? context?.selectedText,
    selectionRects: selectionRects ?? context?.selectionRects,
    pdfText: pdfText ?? context?.pdfText,
    highlights: mergeAiHighlights(context?.highlights, pageMarks),
    conversations: mergeAiConversations(context?.conversations, pageConversations)
  };
}

function buildChatConversationContext(
  conversation: Conversation,
  documentTitle: string,
  attachments: ConversationAttachment[]
): string {
  const pageNumber = conversation.pageNumber ?? conversation.anchor?.pageNumber;
  return [
    `Conversation mode: ${conversation.mode}.`,
    `Document: ${documentTitle}.`,
    pageNumber ? `Conversation is attached to page ${pageNumber}.` : undefined,
    conversation.anchor ? `Anchor quote: ${conversation.anchor.quote}` : undefined,
    conversation.summary.title ? `Conversation title: ${conversation.summary.title}.` : undefined,
    conversation.summary.brief ? `Conversation brief: ${conversation.summary.brief}.` : undefined,
    attachments.length ? `The latest user message includes images: ${attachments.map((attachment) => attachment.name).join(', ')}.` : undefined
  ].filter(Boolean).join('\n');
}

function buildNoteConversationContext(
  pageStart: number,
  pageEnd: number,
  conversations: Conversation[]
): string {
  return [
    'Task: generate a study note for the current PDF range.',
    `Target pages: ${pageStart}-${pageEnd}.`,
    conversations.length
      ? `There are ${conversations.length} existing conversations attached to this page range; use them as supporting context when relevant.`
      : 'There are no existing conversations attached to this page range.'
  ].join('\n');
}

function buildSelectionConversationContext(pageNumber: number, quote: string): string {
  return [
    `Selection action on page ${pageNumber}.`,
    `Selected quote: ${quote}`
  ].join('\n');
}

function mergeAiHighlights(existing: AiDocumentToolContext['highlights'], marks: PdfMark[]): AiDocumentToolContext['highlights'] {
  const rows = [
    ...(existing ?? []),
    ...marks.map((mark) => ({
      kind: mark.kind,
      pageNumber: mark.pageNumber,
      quote: compactSentence(mark.quote, 700)
    }))
  ];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.kind}:${row.pageNumber}:${row.quote}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 48);
}

function mergeAiConversations(
  existing: AiDocumentToolContext['conversations'],
  conversations: Conversation[]
): AiDocumentToolContext['conversations'] {
  const rows = [
    ...(existing ?? []),
    ...conversations.map((conversation) => ({
      title: conversation.summary.title,
      brief: conversation.summary.brief,
      pageNumber: conversation.pageNumber ?? conversation.anchor?.pageNumber,
      anchorQuote: conversation.anchor?.quote ? compactSentence(conversation.anchor.quote, 700) : undefined,
      transcript: conversation.messages
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n')
        .slice(0, 3200)
    }))
  ];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.title}:${row.pageNumber ?? ''}:${row.anchorQuote ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function mergeToolCallEvents(
  current: AiToolCallEvent[] | undefined,
  event: AiToolCallEvent
): AiToolCallEvent[] {
  return [
    event,
    ...(current ?? []).filter((candidate) => candidate.id !== event.id)
  ].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

function mergeAgentActivityEvents(
  current: AgentActivityEvent[] | undefined,
  event: AgentActivityEvent
): AgentActivityEvent[] {
  return [
    event,
    ...(current ?? []).filter((candidate) => candidate.id !== event.id)
  ].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

function appendAgentTimelineOutput(
  current: AgentTimelineEntry[] | undefined,
  content: string
): AgentTimelineEntry[] {
  if (!content) {
    return current ?? [];
  }
  const entries = [...(current ?? [])];
  const latest = entries.at(-1);
  if (latest?.type === 'output') {
    entries[entries.length - 1] = { ...latest, content: `${latest.content}${content}` };
    return entries;
  }
  const now = new Date().toISOString();
  return [...entries, { id: createId('timeline-output'), type: 'output', content, createdAt: now }];
}

function mergeAgentTimelineActivity(
  current: AgentTimelineEntry[] | undefined,
  event: AgentActivityEvent
): AgentTimelineEntry[] {
  const entries = [...(current ?? [])];
  const existingIndex = entries.findIndex(
    (entry) => entry.type === 'activity' && entry.activities.some((activity) => activity.id === event.id)
  );
  if (existingIndex >= 0) {
    const existing = entries[existingIndex];
    if (existing.type === 'activity') {
      entries[existingIndex] = {
        ...existing,
        activities: mergeAgentActivityEvents(existing.activities, event)
      };
    }
    return entries;
  }
  const latest = entries.at(-1);
  if (latest?.type === 'activity') {
    entries[entries.length - 1] = {
      ...latest,
      activities: mergeAgentActivityEvents(latest.activities, event)
    };
    return entries;
  }
  return [
    ...entries,
    {
      id: createId('timeline-activity'),
      type: 'activity',
      activities: [event],
      createdAt: event.updatedAt
    }
  ];
}

function mergeConversationAttachments(
  current: ConversationAttachment[] | undefined,
  additions: ConversationAttachment[]
): ConversationAttachment[] {
  return [
    ...(current ?? []),
    ...additions.filter((attachment) => !(current ?? []).some((candidate) => candidate.id === attachment.id))
  ];
}

function clampPageNumber(value: number, min = 1): number {
  const page = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, page);
}

function reasoningEffortLabel(effort: string): string {
  switch (effort) {
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
    case 'xhigh': return 'Extra high';
    case 'max': return 'Max';
    case 'ultra': return 'Ultra';
    case 'minimal': return 'Minimal';
    case 'none': return 'None';
    default: return effort;
  }
}

function normalizeGeneratedNote(content: string, pageStart: number, pageEnd: number): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return `# AI notes p.${pageStart}-${pageEnd}\n\nNo note content was generated.`;
  }

  return /^#\s/.test(trimmed) ? trimmed : `# AI notes p.${pageStart}-${pageEnd}\n\n${trimmed}`;
}

function presentableAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const clean = summarizeErrorText(message);
  return clean || 'The AI provider returned an unreadable error.';
}

function stoppedGenerationText(language: AiPreferredLanguage): string {
  return language === 'English' ? 'Response stopped.' : '已停止回答。';
}

function summarizeErrorText(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return '';
  }

  if (/<(?:!doctype|html|head|body|script|style|div|meta|title)\b/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const heading = trimmed.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    return limitErrorText(stripHtmlForError(title ?? heading ?? trimmed));
  }

  return limitErrorText(trimmed.replace(/\s+/g, ' '));
}

function stripHtmlForError(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function limitErrorText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function formatLibraryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function readingProgressText(document: PdfDocumentMeta, language: UiLanguage): string {
  const page = Math.max(1, Math.floor(document.readingState?.lastPage ?? 1));
  const pageCount = document.pageCount ? Math.max(1, Math.floor(document.pageCount)) : undefined;
  if (language === 'zh-CN') {
    return pageCount ? `读到第 ${page} / ${pageCount} 页` : `读到第 ${page} 页`;
  }

  return pageCount ? `Page ${page} of ${pageCount}` : `Page ${page}`;
}

function extractKeywords(text: string): string[] {
  const stop = new Set(['this', 'that', 'with', 'from', 'into', 'about', 'while', 'what', 'when', 'where', 'which']);
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .match(/[a-z][a-z-]{3,}/g)
        ?.filter((word) => !stop.has(word))
        .slice(0, 6) ?? []
    )
  );
}

function anchorFromSelection(documentId: string, selection: PdfSelectionPayload): TextAnchor {
  return {
    id: createId('anchor'),
    documentId,
    pageNumber: selection.pageNumber,
    quote: selection.quote,
    rects: selection.areas.map((area) => ({
      pageNumber: area.pageIndex + 1,
      left: area.left,
      top: area.top,
      width: area.width,
      height: area.height
    })),
    createdAt: new Date().toISOString()
  };
}

function selectionAreasToAnchorRects(selection: PdfSelectionPayload): TextAnchor['rects'] {
  return selection.areas.map((area) => ({
    pageNumber: area.pageIndex + 1,
    left: area.left,
    top: area.top,
    width: area.width,
    height: area.height
  }));
}

function sameSelection(mark: PdfMark, selection: PdfSelectionPayload): boolean {
  return (
    mark.pageNumber === selection.pageNumber &&
    mark.quote === selection.quote &&
    mark.areas.length === selection.areas.length &&
    mark.areas.every((area, index) => {
      const selectedArea = selection.areas[index];
      return (
        selectedArea !== undefined &&
        closeTo(area.pageIndex, selectedArea.pageIndex) &&
        closeTo(area.left, selectedArea.left) &&
        closeTo(area.top, selectedArea.top) &&
        closeTo(area.width, selectedArea.width) &&
        closeTo(area.height, selectedArea.height)
      );
    })
  );
}

function closeTo(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}
