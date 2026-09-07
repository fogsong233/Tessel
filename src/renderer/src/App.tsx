import { type ComponentPropsWithoutRef, type CSSProperties, type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  FolderOpen,
  Languages as LanguagesIcon,
  Maximize2,
  Minimize2,
  Palette,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tablet,
  X
} from 'lucide-react';
import {
  AiProviderConfig,
  AiModelInfo,
  AiMode,
  AiDocumentToolContext,
  AiPreferredLanguage,
  AiStreamEvent,
  AiToolCallEvent,
  AgentActivityEvent,
  AgentTimelineEntry,
  AppPreferences,
  AppearanceFont,
  AppUpdateState,
  CodexAvailability,
  CodexConversationSettings,
  CodexModelInfo,
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  ConversationParticipantNames,
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
  RecentDocumentInfo,
  SelectionColorRole,
  SafeAiProviderConfig,
  SafeWebDavSyncConfig,
  StoredDocumentInfo,
  WebDavSyncConfig,
  TextAnchor,
  TranslationEntry,
  ReaderAiStreamRequest,
  UiLanguage,
  WindowChromeState,
  WorkspaceStorageOverview,
  WorkspaceBlock
} from '../../shared/domain';
import { createId } from '../../shared/ids';
import type { LanDrawingStroke } from '../../shared/lanWhiteboard';
import { mergeNoteDocuments as mergeNotes } from '../../shared/notes';
import { normalizeSelectionColors } from '../../shared/selectionColors';
import {
  PdfReader,
  type OutlineGenerationProgress,
  type PdfSelectionPayload
} from './PdfReader';
import tesselLogoUrl from '../../assets/icons/tessel-logo.png?url';
import { drawingSelectionPng } from './drawing/drawingGeometry';
import { lanWhiteboardText } from './i18n/lanWhiteboardText';
import { MarkdownView } from './MarkdownView';
import { LanWhiteboardSettings } from './settings/LanWhiteboardSettings';
import {
  formatDateTime,
  readerHomeText,
  readerSettingsText,
  updateStatusText
} from './i18n/appText';

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

interface ActiveConversationStreamController {
  streamId: string;
  conversationId: string;
  steer(prompt: string): Promise<void>;
}

interface SidebarTheme {
  color: string;
  activeColor: string;
  ink: string;
  muted: string;
}

function sidebarTheme(color: string): SidebarTheme {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  const source = match?.[1] ?? defaultAppPreferences.sidebarColor.slice(1);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(source.slice(offset, offset + 2), 16));
  const luminance = (channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722) / 255;
  const isLight = luminance > 0.58;
  const target = isLight ? 0 : 255;
  const amount = isLight ? 0.11 : 0.16;
  const adjusted = channels.map((channel) => Math.round(channel + (target - channel) * amount));
  return {
    color: `#${source.toLowerCase()}`,
    activeColor: `#${adjusted.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
    ink: isLight ? '#39382f' : '#f8f9f5',
    muted: isLight ? '#756f55' : 'rgba(248, 249, 245, 0.72)'
  };
}

function fontStack(font: AppearanceFont): string {
  switch (font) {
    case 'serif':
      return 'Iowan Old Style, Charter, Georgia, ui-serif, serif';
    case 'rounded':
      return 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", Inter, system-ui, sans-serif';
    case 'mono':
      return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    default:
      return 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  }
}

export function App(): ReactElement {
  const route = useMemo(() => new URLSearchParams(window.location.search), []);
  const readerDocumentId = route.get('documentId') ?? undefined;
  const settingsWindow = route.get('view') === 'settings';
  const [activeDocument, setActiveDocument] = useState<PdfDocumentMeta>();
  const [pdfSource, setPdfSource] = useState<PdfSourceDescriptor>();
  const [currentPage, setCurrentPage] = useState(1);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [translations, setTranslations] = useState<TranslationEntry[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [marks, setMarks] = useState<PdfMark[]>([]);
  const [bookmarks, setBookmarks] = useState<PdfUserBookmark[]>([]);
  const [notes, setNotes] = useState<NoteDocument[]>([]);
  const [workspaceBlocks, setWorkspaceBlocks] = useState<WorkspaceBlock[]>([]);
  const [lanWhiteboardStrokes, setLanWhiteboardStrokes] = useState<Record<string, Record<string, LanDrawingStroke>>>({});
  const [generatedOutline, setGeneratedOutline] = useState<PdfGeneratedOutline | null>(null);
  const [aiProvider, setAiProvider] = useState<SafeAiProviderConfig>();
  const [webDavSync, setWebDavSync] = useState<SafeWebDavSyncConfig>();
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(defaultAppPreferences);
  const [transientAid, setTransientAid] = useState<TransientAidState>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [windowChrome, setWindowChrome] = useState<WindowChromeState>({
    macTrafficLightsVisible: false,
    customControls: false,
    maximized: false
  });
  const [busy, setBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [outlineGenerationBusy, setOutlineGenerationBusy] = useState(false);
  const [outlineGenerationError, setOutlineGenerationError] = useState<string>();
  const [outlineGenerationProgress, setOutlineGenerationProgress] = useState<OutlineGenerationProgress>();
  const [recentDocuments, setRecentDocuments] = useState<RecentDocumentInfo[]>([]);
  const [recentDocumentsError, setRecentDocumentsError] = useState<string>();
  const [readerLoadPending, setReaderLoadPending] = useState(false);
  const [readerLoadError, setReaderLoadError] = useState<string>();
  const [activeStream, setActiveStream] = useState<{ streamId: string; conversationId?: string }>();
  const [quotedDraft, setQuotedDraft] = useState<{
    conversationId: string;
    text?: string;
    attachments?: ConversationAttachment[];
    nonce: string;
  }>();
  const loadedReaderDocumentRef = useRef<string | undefined>(undefined);
  const readerLoadRequestRef = useRef<string | undefined>(undefined);
  const stoppedStreamIdsRef = useRef<Set<string>>(new Set());
  const activeConversationStreamRef = useRef<ActiveConversationStreamController>();
  const resolvedSidebarTheme = useMemo(
    () => sidebarTheme(appPreferences.sidebarColor ?? defaultAppPreferences.sidebarColor),
    [appPreferences.sidebarColor]
  );
  const resolvedSidebarColor = resolvedSidebarTheme.color;
  const resolvedSidebarActiveColor = resolvedSidebarTheme.activeColor;
  const appShellStyle = useMemo(() => ({
    '--tessel-sidebar-color': resolvedSidebarColor,
    '--tessel-sidebar-active-color': resolvedSidebarActiveColor,
    '--tessel-sidebar-ink': resolvedSidebarTheme.ink,
    '--tessel-sidebar-muted': resolvedSidebarTheme.muted,
    '--tessel-directory-ink': resolvedSidebarTheme.ink,
    '--tessel-directory-muted': resolvedSidebarTheme.muted,
    '--tessel-ui-font': fontStack(appPreferences.appearance.uiFont),
    '--tessel-agent-font': fontStack(appPreferences.appearance.agentFont),
    '--tessel-code-font': fontStack(appPreferences.appearance.codeFont),
    '--tessel-ui-font-size': `${appPreferences.appearance.uiFontSize}px`,
    '--tessel-sidebar-font-size': `${appPreferences.appearance.sidebarFontSize}px`,
    '--tessel-agent-font-size': `${appPreferences.appearance.agentFontSize}px`,
    '--tessel-composer-font-size': `${appPreferences.appearance.composerFontSize}px`,
    '--tessel-code-font-size': `${appPreferences.appearance.codeFontSize}px`,
    '--tessel-highlight-color': appPreferences.selectionColors.highlight,
    '--tessel-underline-color': appPreferences.selectionColors.underline,
    '--tessel-chat-color': appPreferences.selectionColors.chat,
    '--tessel-note-color': appPreferences.selectionColors.note,
    '--tessel-summary-color': appPreferences.selectionColors.summary,
    '--tessel-translate-color': appPreferences.selectionColors.translate
  } as CSSProperties), [appPreferences.appearance, appPreferences.selectionColors, resolvedSidebarActiveColor, resolvedSidebarColor, resolvedSidebarTheme.ink, resolvedSidebarTheme.muted]);
  const appShellClass = [
    'app-shell',
    windowChrome.macTrafficLightsVisible ? 'has-mac-traffic-lights' : '',
    windowChrome.customControls ? 'has-custom-window-controls' : ''
  ].filter(Boolean).join(' ');

  useEffect(() => {
    void refreshSettings();
  }, []);

  useEffect(() => {
    if (readerDocumentId || settingsWindow) {
      return;
    }
    let disposed = false;
    void window.sidelight.listRecentDocuments(5).then((documents) => {
      if (!disposed) {
        setRecentDocuments(documents);
      }
    }).catch(() => {
      if (!disposed) {
        setRecentDocumentsError(appPreferences.uiLanguage === 'zh-CN' ? '无法读取最近浏览。' : 'Could not load recent documents.');
      }
    });
    return () => {
      disposed = true;
    };
  }, [readerDocumentId, settingsWindow]);

  useEffect(() => {
    let disposed = false;
    void window.sidelight.getWindowChromeState().then((state) => {
      if (!disposed) {
        setWindowChrome(state);
      }
    }).catch(() => undefined);
    const unsubscribe = window.sidelight.onWindowChromeState(setWindowChrome);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => window.sidelight.onSettingsChanged(() => {
    void refreshSettings();
  }), []);

  useEffect(() => window.sidelight.onLanWhiteboardEvent((event) => {
    if (event.type === 'canvas-upsert') {
      if (event.block.documentId === activeDocument?.id) {
        setWorkspaceBlocks((current) => [
          event.block,
          ...current.filter((block) => block.id !== event.block.id)
        ]);
      }
      return;
    }
    if (event.type === 'canvas-delete') {
      setWorkspaceBlocks((current) => current.filter((block) => block.id !== event.blockId));
      setLanWhiteboardStrokes((current) => {
        const { [event.blockId]: _deleted, ...rest } = current;
        return rest;
      });
      return;
    }
    if (event.type === 'stroke-begin') {
      setLanWhiteboardStrokes((current) => ({
        ...current,
        [event.canvasId]: {
          ...current[event.canvasId],
          [event.stroke.id]: event.stroke
        }
      }));
      return;
    }
    if (event.type === 'stroke-points') {
      setLanWhiteboardStrokes((current) => {
        const stroke = current[event.canvasId]?.[event.strokeId];
        if (!stroke) {
          return current;
        }
        return {
          ...current,
          [event.canvasId]: {
            ...current[event.canvasId],
            [event.strokeId]: { ...stroke, points: [...stroke.points, ...event.points] }
          }
        };
      });
      return;
    }
    if (event.type === 'stroke-cancel') {
      setLanWhiteboardStrokes((current) => {
        const canvas = { ...current[event.canvasId] };
        delete canvas[event.strokeId];
        return { ...current, [event.canvasId]: canvas };
      });
      return;
    }
    if (event.type === 'selection-share' && event.selection.documentId === activeDocument?.id) {
      void attachDrawingSelectionToConversation(
        event.selection.pageNumber,
        event.selection.canvasId,
        event.selection.strokes
      );
    }
  }), [activeConversationId, activeDocument?.id, conversations, panelOpen]);

  useEffect(() => {
    document.title = settingsWindow ? 'Tessel Settings' : activeDocument?.title ? `${activeDocument.title} — Tessel` : 'Tessel';
  }, [activeDocument?.title, settingsWindow]);

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

  async function openRecentDocument(documentId: string): Promise<void> {
    setRecentDocumentsError(undefined);
    const opened = await window.sidelight.openStoredDocument(documentId);
    if (opened) {
      await window.sidelight.closeWindow();
      return;
    }
    setRecentDocumentsError(appPreferences.uiLanguage === 'zh-CN'
      ? '原 PDF 文件已移动或不可访问。你可以通过“打开 PDF”重新定位。'
      : 'The PDF was moved or is unavailable. Use Open PDF to locate it again.');
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
    const [loadedConversations, loadedTranslations, loadedMarks, loadedBookmarks, readingState, loadedMainNote, loadedWorkspaceBlocks, loadedGeneratedOutline] = await Promise.all([
      window.sidelight.listConversations(documentId),
      window.sidelight.listTranslations(documentId),
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
    setTranslations(loadedTranslations);
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
      codexSettings: appPreferences.experimentalCodexAgent.enabled ? {
        model: appPreferences.experimentalCodexAgent.chatModel,
        effort: appPreferences.experimentalCodexAgent.chatReasoningEffort ?? 'low',
        permissionMode: 'workspace-write'
      } : undefined,
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
    const saved = await createPageConversation(pageNumber);
    if (saved) {
      focusConversation(saved.id);
    }
  }

  async function createPageConversation(pageNumber: number): Promise<Conversation | undefined> {
    if (!activeDocument) {
      return undefined;
    }

    clearTransientForeground();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createId('chat'),
      documentId: activeDocument.id,
      pageNumber,
      mode: 'ask',
      agentKind: appPreferences.experimentalCodexAgent.enabled ? 'codex' : 'default',
      codexSettings: appPreferences.experimentalCodexAgent.enabled ? {
        model: appPreferences.experimentalCodexAgent.chatModel,
        effort: appPreferences.experimentalCodexAgent.chatReasoningEffort ?? 'low',
        permissionMode: 'workspace-write'
      } : undefined,
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
    return saved;
  }

  async function attachDrawingSelectionToConversation(
    pageNumber: number,
    canvasId: string,
    strokes: LanDrawingStroke[]
  ): Promise<void> {
    if (!activeDocument || strokes.length === 0) {
      return;
    }
    const selectedIds = new Set(strokes.map((stroke) => stroke.id));
    const dataUrl = drawingSelectionPng(strokes, selectedIds);
    if (!dataUrl) {
      return;
    }
    const attachment: ConversationAttachment = {
      id: createId('image'),
      kind: 'image',
      name: `handwritten-notes-p${pageNumber}-${canvasId.slice(-6)}.png`,
      mimeType: 'image/png',
      dataUrl,
      createdAt: new Date().toISOString()
    };
    const expandedConversation = panelOpen
      ? conversations.find((conversation) => conversation.id === activeConversationId)
      : undefined;
    const conversation = expandedConversation ?? await createPageConversation(pageNumber);
    if (!conversation) {
      return;
    }
    focusConversation(conversation.id);
    setQuotedDraft({
      conversationId: conversation.id,
      attachments: [attachment],
      nonce: createId('canvas-selection')
    });
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

    const now = new Date().toISOString();
    const translation: TranslationEntry | undefined = mode === 'translate'
      ? {
          id: createId('translation'),
          documentId: activeDocument.id,
          pageNumber: selection.pageNumber,
          quote: selection.quote,
          rects: selectionAreasToAnchorRects(selection),
          content: '',
          backend: appPreferences.translationBackend,
          status: 'pending',
          createdAt: now,
          updatedAt: now
        }
      : undefined;
    const aidId = translation?.id ?? createId('aid');
    const streamId = createId('stream');
    let streamedContent = '';
    let finished = false;
    if (translation) {
      await saveTranslationLocally(translation);
    }
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
      if (translation) {
        const updatedAt = new Date().toISOString();
        void saveTranslationLocally({
          ...translation,
          content: patch.content ?? streamedContent,
          status: patch.error ? 'error' : 'completed',
          ...(patch.error ? { error: patch.error } : {}),
          updatedAt
        });
      }
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
        task: mode,
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
    const activeController = activeConversationStreamRef.current;
    if (activeController?.conversationId === conversationId) {
      if (!prompt.trim() || attachments.length > 0) {
        return;
      }
      await activeController.steer(prompt);
      return;
    }
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

  async function updateConversationCodexSettings(
    conversationId: string,
    codexSettings: CodexConversationSettings
  ): Promise<void> {
    const conversation = conversations.find((candidate) => candidate.id === conversationId);
    const canUseCodex = Boolean(
      conversation && (
        appPreferences.experimentalCodexAgent.enabled ||
        conversation.agentKind === 'codex' ||
        conversation.codexThreadId ||
        conversation.codexSettings
      )
    );
    if (!conversation || !canUseCodex || busy) {
      return;
    }
    await saveConversationLocally({
      ...conversation,
      agentKind: 'codex',
      codexSettings,
      updatedAt: new Date().toISOString()
    });
  }

  async function updateConversationParticipantNames(
    conversationId: string,
    participantNames: ConversationParticipantNames
  ): Promise<void> {
    const conversation = conversations.find((candidate) => candidate.id === conversationId);
    if (!conversation || busy) {
      return;
    }
    await saveConversationLocally({
      ...conversation,
      participantNames: {
        user: participantNames.user.trim().slice(0, 32),
        assistant: participantNames.assistant.trim().slice(0, 32)
      },
      updatedAt: new Date().toISOString()
    });
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
    const streamHistory = appPreferences.experimentalCodexAgent.enabled
      ? compactCodexHistory(history)
      : history;
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
    let activeAssistantMessageId = assistantMessage.id;
    let draftConversation: Conversation = {
      ...conversation,
      messages: [...conversation.messages, assistantMessage],
      updatedAt: new Date().toISOString()
    };
    putConversationInState(draftConversation);

    const streamId = createId('stream');
    setActiveStream({ streamId, conversationId: conversation.id });
    let finished = false;
    let pendingRenderFrame: number | undefined;
    const renderDraftOnNextFrame = (): void => {
      if (pendingRenderFrame !== undefined || finished) {
        return;
      }
      pendingRenderFrame = window.requestAnimationFrame(() => {
        pendingRenderFrame = undefined;
        if (!finished) {
          putConversationInState(draftConversation);
        }
      });
    };
    const flushDraftRender = (nextConversation: Conversation): void => {
      if (pendingRenderFrame !== undefined) {
        window.cancelAnimationFrame(pendingRenderFrame);
        pendingRenderFrame = undefined;
      }
      putConversationInState(nextConversation);
    };
    activeConversationStreamRef.current = {
      streamId,
      conversationId: conversation.id,
      steer: async (guidance) => {
        if (finished) {
          throw new Error('This Codex turn is no longer active.');
        }
        const createdAt = new Date().toISOString();
        const guidanceMessage: ConversationMessage = {
          id: createId('msg'),
          role: 'user',
          content: guidance,
          createdAt
        };
        const continuationMessage: ConversationMessage = {
          id: createId('msg'),
          role: 'assistant',
          content: '',
          createdAt
        };
        activeAssistantMessageId = continuationMessage.id;
        streamedContent = '';
        draftConversation = {
          ...draftConversation,
          messages: [...draftConversation.messages, guidanceMessage, continuationMessage],
          updatedAt: createdAt
        };
        putConversationInState(draftConversation);
        try {
          await window.sidelight.steerAiStream({ streamId, prompt: guidance });
        } catch (error) {
          streamedContent = `Could not send guidance: ${presentableAiError(error)}`;
          draftConversation = {
            ...draftConversation,
            messages: draftConversation.messages.map((message) =>
              message.id === activeAssistantMessageId ? { ...message, content: streamedContent } : message
            ),
            updatedAt: new Date().toISOString()
          };
          putConversationInState(draftConversation);
          throw error;
        }
      }
    };
    const finishWithConversation = async (conversationToSave: Conversation): Promise<void> => {
      if (finished) {
        return;
      }

      finished = true;
      unsubscribe();
      flushDraftRender(conversationToSave);
      const saved = await saveConversationLocally({
        ...conversationToSave,
        summary: summarizeConversation(conversationToSave.mode, conversationToSave.messages, conversationToSave.anchor)
      });
      void refreshConversationSummary(saved);
      setBusy(false);
      setActiveStream((current) => current?.streamId === streamId ? undefined : current);
      if (activeConversationStreamRef.current?.streamId === streamId) {
        activeConversationStreamRef.current = undefined;
      }
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
            message.id === activeAssistantMessageId
              ? { ...message, toolCalls: mergeToolCallEvents(message.toolCalls, event.toolCall!) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        renderDraftOnNextFrame();
      }

      if (event.activity) {
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === activeAssistantMessageId
              ? {
                  ...message,
                  agentActivities: mergeAgentActivityEvents(message.agentActivities, event.activity!),
                  agentTimeline: mergeAgentTimelineActivity(message.agentTimeline, event.activity!)
                }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        renderDraftOnNextFrame();
      }

      if (event.artifacts?.length) {
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === activeAssistantMessageId
              ? { ...message, attachments: mergeConversationAttachments(message.attachments, event.artifacts!) }
              : message
          ),
          updatedAt: new Date().toISOString()
        };
        renderDraftOnNextFrame();
      }

      if (event.agentThreadId) {
        draftConversation = {
          ...draftConversation,
          agentKind: 'codex',
          codexThreadId: event.agentThreadId,
          updatedAt: new Date().toISOString()
        };
        renderDraftOnNextFrame();
      }

      if (event.delta) {
        streamedContent += event.delta;
        draftConversation = {
          ...draftConversation,
          messages: draftConversation.messages.map((message) =>
            message.id === activeAssistantMessageId
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
            message.id === activeAssistantMessageId
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
            message.id === activeAssistantMessageId ? { ...message, content: streamedContent } : message
          ),
          updatedAt: new Date().toISOString()
        };
        renderDraftOnNextFrame();
      }

      if (event.done) {
        void finishWithConversation(draftConversation);
      }
    });

    try {
      await window.sidelight.completeReaderAiStream({
        streamId,
        task: 'chat',
        conversationId: conversation.id,
        codexThreadId: conversation.codexThreadId,
        codexOptions: conversation.codexSettings,
        documentId: activeDocument.id,
        history: streamHistory,
        codexContext: enrichedToolContext,
        request: {
          mode: conversation.mode,
          prompt,
          documentTitle: activeDocument.title,
          contextText: conversation.anchor?.quote,
          messages: streamHistory,
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
            message.id === activeAssistantMessageId
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
          message.id === activeAssistantMessageId
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

  async function saveTranslationLocally(translation: TranslationEntry): Promise<TranslationEntry> {
    const saved = await window.sidelight.saveTranslation({ translation });
    setTranslations((current) => [
      saved,
      ...current.filter((candidate) => candidate.id !== saved.id)
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10));
    return saved;
  }

  function openTranslation(translation: TranslationEntry): void {
    setPanelOpen(false);
    setTransientAid({
      id: translation.id,
      mode: 'translate',
      pageNumber: translation.pageNumber,
      quote: translation.quote,
      content: translation.content,
      busy: translation.status === 'pending',
      error: translation.error
    });
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
    if (activeDocument && sync.enabled) {
      await window.sidelight.syncDocumentMetadata(activeDocument.id).catch(() => undefined);
      await loadDocumentIntoCurrentWindow(activeDocument.id);
    }
    if (settingsWindow) {
      void window.sidelight.closeWindow();
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

  async function completeReaderAi(
    input: Omit<ReaderAiStreamRequest, 'streamId'>,
    onStreamEvent?: (event: AiStreamEvent) => void
  ): Promise<string> {
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
        onStreamEvent?.(event);
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
        task: 'note',
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
    setOutlineGenerationProgress({ phase: 'preparing', percent: 8 });

    try {
      let receivedCharacters = 0;
      const content = await completeReaderAi({
        task: 'outline',
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
      }, (event) => {
        if (event.activity?.id === 'outline:samples') {
          setOutlineGenerationProgress({
            phase: 'reading',
            percent: event.activity.status === 'completed' ? 52 : 28,
            detail: event.activity.detail
          });
          return;
        }
        if (event.activity?.id === 'transport:exec') {
          setOutlineGenerationProgress({ phase: 'connecting', percent: 18 });
          return;
        }
        if (event.activity?.id.startsWith('session:')) {
          setOutlineGenerationProgress({
            phase: event.activity.status === 'completed' ? 'generating' : 'connecting',
            percent: event.activity.status === 'completed' ? 62 : 22
          });
          return;
        }
        if (event.activity) {
          setOutlineGenerationProgress((current) => ({
            phase: 'generating',
            percent: Math.max(current?.percent ?? 0, 66),
            detail: event.activity?.label
          }));
        }
        if (event.delta) {
          receivedCharacters += event.delta.length;
          setOutlineGenerationProgress({
            phase: 'generating',
            percent: Math.min(88, 70 + Math.floor(receivedCharacters / 180))
          });
        }
        if (event.done && !event.error) {
          setOutlineGenerationProgress({ phase: 'validating', percent: 90 });
        }
      });
      setOutlineGenerationProgress({ phase: 'validating', percent: 92 });
      const items = parseGeneratedOutlineItems(content, Math.max(1, totalPages));
      if (items.length === 0) {
        throw new Error('The AI response did not contain a usable outline JSON array.');
      }

      setOutlineGenerationProgress({ phase: 'saving', percent: 96 });
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
      setOutlineGenerationProgress({ phase: 'complete', percent: 100 });
    } catch (error) {
      setOutlineGenerationError(presentableAiError(error));
      setOutlineGenerationProgress(undefined);
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
    void window.sidelight.saveReadingState(nextState);
  }

  if (settingsWindow) {
    return (
      <main className={appShellClass} style={appShellStyle}>
        <WindowChrome state={windowChrome} title="Settings" onStateChange={setWindowChrome} />
        <div className="settings-window">
          {aiProvider && webDavSync ? (
            <ReaderSettingsPanel
              provider={aiProvider}
              webDavSync={webDavSync}
              preferences={appPreferences}
              onClose={() => void window.sidelight.closeWindow()}
              onSave={(aiConfig, syncConfig, preferencesConfig) =>
                void saveReaderSettings(aiConfig, syncConfig, preferencesConfig)}
            />
          ) : (
            <section className="settings-window__loading" aria-label="Loading settings">
              <img src={tesselLogoUrl} alt="" />
              <span>Loading settings...</span>
            </section>
          )}
        </div>
      </main>
    );
  }

  if (!readerDocumentId) {
    const homeText = readerHomeText(appPreferences.uiLanguage);
    return (
      <main className={appShellClass} style={appShellStyle}>
        <WindowChrome state={windowChrome} title="Tessel" onStateChange={setWindowChrome} />
        <section className="reader-home" aria-label="PDF reader start">
          <div className="reader-home__brand">
            <img className="tessel-brand-mark" src={tesselLogoUrl} alt="" />
            <strong>Tessel</strong>
          </div>
          <div className={recentDocuments.length > 0 ? 'reader-home__content reader-home__content--with-history' : 'reader-home__content'}>
            <div className="reader-home__identity">
              <img className="tessel-brand-mark tessel-brand-mark--large" src={tesselLogoUrl} alt="" />
              <div>
                <span>{homeText.pdfReader}</span>
                <h1>Tessel</h1>
              </div>
            </div>
            <div className="reader-home__actions">
              <button className="primary-button reader-home__open" type="button" onClick={() => void openPdf()}><FolderOpen size={17} />{homeText.openPdf}</button>
              <button className="quiet-button reader-home__settings" type="button" onClick={() => void window.sidelight.openSettings()}><Settings size={17} />{homeText.settings}</button>
            </div>
            {recentDocuments.length > 0 && (
              <section className="reader-home__recent" aria-label={homeText.recentDocuments}>
                <header><span>{homeText.recentDocuments}</span><small>{homeText.bookCount(recentDocuments.length)}</small></header>
                <div className="reader-home__recent-list">
                  {recentDocuments.map(({ document, fileAvailable }) => (
                    <button
                      key={document.id}
                      className={!fileAvailable ? 'is-unavailable' : ''}
                      type="button"
                      title={document.filePath}
                      onClick={() => void openRecentDocument(document.id)}
                    >
                      <BookOpen size={17} />
                      <span><strong>{document.title}</strong><small>{homeText.recentMeta(document)}</small></span>
                      {!fileAvailable && <em>{homeText.missing}</em>}
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {recentDocumentsError && <p className="reader-home__error" role="status">{recentDocumentsError}</p>}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className={appShellClass} style={appShellStyle}>
      <WindowChrome state={windowChrome} title={activeDocument?.title ?? 'Tessel Reader'} onStateChange={setWindowChrome} />
      <PdfReader
        source={pdfSource}
        meta={activeDocument}
        documentLoadPending={readerLoadPending}
        documentLoadError={readerLoadError}
        uiLanguage={appPreferences.uiLanguage}
        codexEnabled={appPreferences.experimentalCodexAgent.enabled}
        selectionColors={appPreferences.selectionColors}
        sidebarColor={resolvedSidebarColor}
        sidebarActiveColor={resolvedSidebarActiveColor}
        sidebarInk={resolvedSidebarTheme.ink}
        sidebarMuted={resolvedSidebarTheme.muted}
        activePage={currentPage}
        marks={marks}
        bookmarks={bookmarks}
        conversations={conversations}
        translations={translations}
        workspaceBlocks={workspaceBlocks}
        lanWhiteboardStrokes={lanWhiteboardStrokes}
        generatedOutline={generatedOutline}
        activeConversationId={activeConversationId}
        activeConversation={activeConversation}
        notes={notes}
        chatOpen={panelOpen}
        busy={busy}
        canStopGeneration={busy && activeStream?.conversationId === activeConversation?.id}
        transientAid={transientAid}
        composerPrefill={quotedDraft}
        onOpenPdf={openPdf}
        onOpenSettings={() => void window.sidelight.openSettings()}
        onPageChange={updateCurrentPage}
        onCreateMark={(kind, selection, colorRole) => void saveMark(kind, selection, colorRole)}
        onSelectionAction={(mode, selection) => void startAnchoredAction(mode, selection)}
        onQuoteSelection={(selection) => void quoteSelectionInActiveConversation(selection)}
        onAddBookmark={(pageNumber) => void addBookmark(pageNumber)}
        onDeleteBookmark={(bookmarkId) => void deleteBookmark(bookmarkId)}
        onDeleteMark={(markId) => void deleteMark(markId)}
        onCreatePageChat={(pageNumber) => void createPageChat(pageNumber)}
        onOpenConversation={openConversation}
        onOpenTranslation={openTranslation}
        onCloseConversation={() => setPanelOpen(false)}
        onCloseTransientAid={() => setTransientAid(undefined)}
        onSendMessage={(conversationId, prompt, attachments, toolContext) =>
          void sendMessage(conversationId, prompt, attachments, toolContext)}
        onUpdateConversationCodexSettings={(conversationId, settings) =>
          void updateConversationCodexSettings(conversationId, settings)}
        onUpdateConversationParticipantNames={(conversationId, names) =>
          void updateConversationParticipantNames(conversationId, names)}
        onStopGeneration={stopActiveGeneration}
        noteBusy={noteBusy}
        outlineGenerationBusy={outlineGenerationBusy}
        outlineGenerationError={outlineGenerationError}
        outlineGenerationProgress={outlineGenerationProgress}
        onSaveWorkspaceBlock={saveWorkspaceBlock}
        onDeleteWorkspaceBlock={(blockId) => void deleteWorkspaceBlock(blockId)}
        onShareDrawingSelection={(pageNumber, canvasId, strokes) =>
          void attachDrawingSelectionToConversation(pageNumber, canvasId, strokes)}
        onSaveNote={saveNote}
        onDeleteNote={(noteId) => void deleteNote(noteId)}
        onGenerateNote={(pageStart, pageEnd, pageText, toolContext) =>
          void generateAiNote(pageStart, pageEnd, pageText, toolContext)}
        onGenerateOutline={(toolContext) => void generatePdfOutline(toolContext)}
      />

    </main>
  );
}

function WindowChrome({
  state,
  title,
  onStateChange
}: {
  state: WindowChromeState;
  title: string;
  onStateChange(state: WindowChromeState): void;
}): ReactElement | null {
  if (!state.customControls) {
    return null;
  }
  return (
    <header className="window-chrome">
      <div className="window-chrome__identity">
        <img src={tesselLogoUrl} alt="" />
        <span>{title}</span>
      </div>
      <div className="window-chrome__controls">
        <button
          type="button"
          aria-label={state.maximized ? 'Restore window' : 'Maximize window'}
          title={state.maximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.sidelight.toggleWindowMaximize().then(onStateChange)}
        >
          {state.maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button className="window-chrome__close" type="button" aria-label="Close window" title="Close" onClick={() => void window.sidelight.closeWindow()}>
          <X size={16} />
        </button>
      </div>
    </header>
  );
}

type ReaderSettingsSection = 'provider' | 'codex' | 'sync' | 'lan' | 'storage' | 'appearance' | 'language' | 'updates';

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
  const [translationBackend, setTranslationBackend] = useState(preferences.translationBackend);
  const [sidebarColor, setSidebarColor] = useState(preferences.sidebarColor ?? defaultAppPreferences.sidebarColor);
  const [selectionColors, setSelectionColors] = useState(normalizeSelectionColors(preferences.selectionColors));
  const [appearance, setAppearance] = useState(preferences.appearance ?? defaultAppPreferences.appearance);
  const [settingsSection, setSettingsSection] = useState<ReaderSettingsSection>('provider');
  const [settingsQuery, setSettingsQuery] = useState('');
  const [updateState, setUpdateState] = useState<AppUpdateState>();
  const [storageOverview, setStorageOverview] = useState<WorkspaceStorageOverview>();
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string>();
  const [codexAvailability, setCodexAvailability] = useState<CodexAvailability>();
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>([]);
  const [codexEnabled, setCodexEnabled] = useState(preferences.experimentalCodexAgent.enabled);
  const [codexExecutablePath, setCodexExecutablePath] = useState(preferences.experimentalCodexAgent.executablePath ?? '');
  const [codexChatModel, setCodexChatModel] = useState(preferences.experimentalCodexAgent.chatModel ?? '');
  const [codexTranslationModel, setCodexTranslationModel] = useState(preferences.experimentalCodexAgent.translationModel ?? '');
  const [codexChatEffort, setCodexChatEffort] = useState(preferences.experimentalCodexAgent.chatReasoningEffort ?? '');
  const [codexTranslationEffort, setCodexTranslationEffort] = useState(preferences.experimentalCodexAgent.translationReasoningEffort ?? '');
  const t = readerSettingsText(uiLanguage);
  const lanText = lanWhiteboardText(uiLanguage);
  const resolvedSettingsSidebarTheme = sidebarTheme(sidebarColor || defaultAppPreferences.sidebarColor);
  const settingsItems: Array<{ id: ReaderSettingsSection; label: string; icon: typeof Bot }> = [
    { id: 'provider', label: t.provider, icon: Bot },
    { id: 'codex', label: 'Codex', icon: Sparkles },
    { id: 'sync', label: t.sync, icon: Cloud },
    { id: 'lan', label: lanText.sectionLabel, icon: Tablet },
    { id: 'storage', label: t.storage, icon: Database },
    { id: 'appearance', label: t.appearance, icon: Palette },
    { id: 'language', label: t.language, icon: LanguagesIcon },
    { id: 'updates', label: t.updates, icon: RefreshCw }
  ];
  const normalizedSettingsQuery = settingsQuery.trim().toLocaleLowerCase();
  const visibleSettingsItems = normalizedSettingsQuery
    ? settingsItems.filter((item) => item.label.toLocaleLowerCase().includes(normalizedSettingsQuery))
    : settingsItems;
  const activeSettingsItem = settingsItems.find((item) => item.id === settingsSection) ?? settingsItems[0];

  useEffect(() => {
    let disposed = false;
    void window.sidelight.getAppUpdateState().then((state) => {
      if (!disposed) {
        setUpdateState(state);
      }
    }).catch(() => undefined);
    const unsubscribe = window.sidelight.onAppUpdateState((state) => setUpdateState(state));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const availability = await window.sidelight.getCodexAvailability(codexExecutablePath.trim() || undefined);
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
  }, [codexExecutablePath]);

  const refreshStorageOverview = async (): Promise<void> => {
    setStorageLoading(true);
    setStorageError(undefined);
    try {
      setStorageOverview(await window.sidelight.getStorageOverview());
    } catch (error) {
      setStorageError(presentableAiError(error));
    } finally {
      setStorageLoading(false);
    }
  };

  useEffect(() => {
    if (settingsSection === 'storage' && !storageOverview && !storageLoading) {
      void refreshStorageOverview();
    }
  }, [settingsSection]);

  const installAppUpdate = async (): Promise<void> => {
    setUpdateState((current) => current?.status === 'ready' ? { ...current, status: 'installing' } : current);
    try {
      setUpdateState(await window.sidelight.installAppUpdate());
    } catch (error) {
      setUpdateState((current) => current ? {
        ...current,
        status: 'ready',
        message: presentableAiError(error)
      } : current);
    }
  };

  const reasoningEffortsFor = (modelId: string): string[] => {
    const selected = codexModels.find((modelInfo) => modelInfo.id === modelId);
    if (selected?.supportedReasoningEfforts.length) {
      return selected.supportedReasoningEfforts;
    }
    return Array.from(new Set(codexModels.flatMap((modelInfo) => modelInfo.supportedReasoningEfforts)));
  };
  const chatEfforts = reasoningEffortsFor(codexChatModel);
  const translationEfforts = reasoningEffortsFor(codexTranslationModel);
  const codexDetectedLabel = uiLanguage === 'zh-CN' ? '已自动发现原生可执行文件' : 'Native executable auto-detected';

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
        translationBackend: translationBackend === 'codex' && codexEnabled && Boolean(codexAvailability?.available)
          ? 'codex'
          : 'provider',
        sidebarColor,
        selectionColors: normalizeSelectionColors(selectionColors),
        appearance,
        experimentalCodexAgent: {
          enabled: codexEnabled && Boolean(codexAvailability?.available),
          ...(codexExecutablePath.trim() ? { executablePath: codexExecutablePath.trim() } : {}),
          ...(codexChatModel.trim() ? { chatModel: codexChatModel.trim() } : {}),
          ...(codexTranslationModel.trim() ? { translationModel: codexTranslationModel.trim() } : {}),
          ...(codexChatEffort.trim() ? { chatReasoningEffort: codexChatEffort.trim() } : {}),
          ...(codexTranslationEffort.trim() ? { translationReasoningEffort: codexTranslationEffort.trim() } : {})
        }
      }
    );
  };

  return (
      <section
        className="reader-settings reader-settings--window"
        aria-labelledby="settings-title"
        style={{
          '--tessel-sidebar-color': resolvedSettingsSidebarTheme.color,
          '--tessel-sidebar-active-color': resolvedSettingsSidebarTheme.activeColor,
          '--tessel-sidebar-ink': resolvedSettingsSidebarTheme.ink,
          '--tessel-sidebar-muted': resolvedSettingsSidebarTheme.muted,
          '--tessel-directory-ink': resolvedSettingsSidebarTheme.ink,
          '--tessel-directory-muted': resolvedSettingsSidebarTheme.muted,
          '--tessel-ui-font': fontStack(appearance.uiFont),
          '--tessel-agent-font': fontStack(appearance.agentFont),
          '--tessel-code-font': fontStack(appearance.codeFont),
          '--tessel-ui-font-size': `${appearance.uiFontSize}px`,
          '--tessel-sidebar-font-size': `${appearance.sidebarFontSize}px`,
          '--tessel-agent-font-size': `${appearance.agentFontSize}px`,
          '--tessel-composer-font-size': `${appearance.composerFontSize}px`,
          '--tessel-code-font-size': `${appearance.codeFontSize}px`
        } as CSSProperties}
      >
        <form className="reader-settings__form" onSubmit={submit}>
          <div className="reader-settings__workspace">
            <aside className="reader-settings__sidebar">
              <header className="reader-settings__sidebar-header">
                <div className="reader-settings__brand">
                  <img src={tesselLogoUrl} alt="" />
                  <span><strong>Tessel</strong><small>{t.settings}</small></span>
                </div>
              </header>
              <label className="reader-settings__search">
                <Search size={16} />
                <input
                  type="search"
                  value={settingsQuery}
                  placeholder={t.searchSettings}
                  aria-label={t.searchSettings}
                  onChange={(event) => setSettingsQuery(event.target.value)}
                />
              </label>
              <span className="reader-settings__nav-label">{t.configuration}</span>
              <nav className="reader-settings__nav" aria-label={t.settingsSections}>
                {visibleSettingsItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      className={settingsSection === item.id ? 'is-active' : ''}
                      type="button"
                      onClick={() => setSettingsSection(item.id)}
                    >
                      <Icon size={16} />
                      {item.label}
                    </button>
                  );
                })}
                {visibleSettingsItems.length === 0 && <span className="reader-settings__nav-empty">{t.noSettingsFound}</span>}
              </nav>
            </aside>
            <div className="reader-settings__main">
              <div className="reader-settings__body">
                <div className="reader-settings__body-content">
                  <header className="reader-settings__page-heading">
                    <h1 id="settings-title">{activeSettingsItem.label}</h1>
                  </header>
            {settingsSection === 'provider' && (
              <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Bot size={17} /><div><strong>{t.aiProvider}</strong><span>OpenAI-compatible</span></div></div>
              <div className="reader-settings__fields">
                <label>{t.displayName}<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
                <label>{t.temperature}<input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></label>
                <label className="reader-settings__wide">{t.baseUrl}<input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
                <label className="reader-settings__wide">{t.apiKey}<input type="password" value={apiKey} placeholder={provider.hasApiKey ? t.storedKey : ''} onChange={(event) => setApiKey(event.target.value)} /></label>
                <label className="reader-settings__wide">{t.model}
                  <span className="reader-settings__model"><input required list="reader-model-options" value={model} onChange={(event) => setModel(event.target.value)} /><button className="quiet-button" type="button" onClick={() => void fetchModels()} disabled={loadingModels}>{loadingModels ? t.loading : t.fetchModels}</button></span>
                  <datalist id="reader-model-options">{models.map((item) => <option key={item.id} value={item.id}>{item.ownedBy}</option>)}</datalist>
                  {modelError && <small className="reader-settings__status is-error">{modelError}</small>}
                </label>
              </div>
            </section>
            )}
            {settingsSection === 'codex' && (
              <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Sparkles size={17} /><div><strong>Codex</strong><span title={codexAvailability?.executablePath}>{codexAvailability?.available ? `${codexAvailability.version ?? t.codexAvailable}${codexAvailability.executablePath ? ` · ${codexDetectedLabel}` : ''}` : codexAvailability?.reason ?? t.codexChecking}</span></div><SettingsToggle label={t.enabled} title={codexAvailability?.available ? undefined : codexAvailability?.reason ?? t.codexChecking} checked={codexEnabled} disabled={!codexAvailability?.available} onChange={(event) => setCodexEnabled(event.target.checked)} /></div>
              <div className="reader-settings__fields">
                <label className="reader-settings__wide">{t.codexExecutablePath}<span className="reader-settings__codex-path"><input value={codexExecutablePath} placeholder={t.codexExecutablePathHint} spellCheck={false} onChange={(event) => setCodexExecutablePath(event.target.value)} />{!codexExecutablePath.trim() && codexAvailability?.executablePath && <small title={codexAvailability.executablePath}>{codexDetectedLabel}: {codexAvailability.executablePath}</small>}</span></label>
              </div>
              <div className="reader-settings__subsection"><strong>{t.chat}</strong><div className="reader-settings__fields">
                <label>{t.chatModel}<SettingsSelect value={codexChatModel} disabled={!codexEnabled || !codexAvailability?.available} onChange={(event) => { setCodexChatModel(event.target.value); setCodexChatEffort(''); }}><option value="">{t.codexDefault}</option>{codexModels.map((modelInfo) => <option key={modelInfo.id} value={modelInfo.id}>{modelInfo.displayName}</option>)}</SettingsSelect></label>
                <label>{t.chatReasoning}<SettingsSelect value={codexChatEffort} disabled={!codexEnabled || !codexAvailability?.available || chatEfforts.length === 0} onChange={(event) => setCodexChatEffort(event.target.value)}><option value="">{t.readerDefault}</option>{chatEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort, uiLanguage)}</option>)}</SettingsSelect></label>
              </div></div>
              <div className="reader-settings__subsection"><strong>{t.translation}</strong><div className="reader-settings__fields">
                <label>{t.translationBackend}<SettingsSelect value={translationBackend} onChange={(event) => setTranslationBackend(event.target.value as AppPreferences['translationBackend'])}><option value="provider">{t.aiProvider}</option><option value="codex" disabled={!codexEnabled || !codexAvailability?.available}>Codex</option></SettingsSelect></label>
                <label>{t.translationModel}<SettingsSelect value={codexTranslationModel} disabled={translationBackend !== 'codex' || !codexEnabled || !codexAvailability?.available} onChange={(event) => { setCodexTranslationModel(event.target.value); setCodexTranslationEffort(''); }}><option value="">{t.fastestAvailable}</option>{codexModels.map((modelInfo) => <option key={modelInfo.id} value={modelInfo.id}>{modelInfo.displayName}</option>)}</SettingsSelect></label>
                <label>{t.translationReasoning}<SettingsSelect value={codexTranslationEffort} disabled={translationBackend !== 'codex' || !codexEnabled || !codexAvailability?.available || translationEfforts.length === 0} onChange={(event) => setCodexTranslationEffort(event.target.value)}><option value="">{t.readerDefault}</option>{translationEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort, uiLanguage)}</option>)}</SettingsSelect></label>
              </div></div>
            </section>
            )}
            {settingsSection === 'sync' && (
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Cloud size={17} /><div><strong>{t.webDavSync}</strong><span>{t.perPdfMetadata}</span></div><SettingsToggle label={t.enabled} checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} /></div>
              <div className="reader-settings__fields">
                <label className="reader-settings__wide">{t.serverUrl}<input value={webDavUrl} placeholder="https://dav.example.com/remote.php/dav/files/name" onChange={(event) => setWebDavUrl(event.target.value)} /></label>
                <label>{t.folder}<input value={webDavPath} placeholder="tessel" onChange={(event) => setWebDavPath(event.target.value)} /></label>
                <label>{t.username}<input value={webDavUsername} onChange={(event) => setWebDavUsername(event.target.value)} /></label>
                <label className="reader-settings__wide">{t.password}<input type="password" value={webDavPassword} placeholder={webDavSync.hasPassword ? t.storedPassword : ''} onChange={(event) => setWebDavPassword(event.target.value)} /></label>
              </div>
            </section>
            )}
            {settingsSection === 'lan' && (
              <LanWhiteboardSettings language={uiLanguage} />
            )}
            {settingsSection === 'language' && (
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><LanguagesIcon size={17} /><div><strong>{t.language}</strong><span>{t.languageDescription}</span></div></div>
              <div className="reader-settings__fields">
                <label>{t.uiLanguage}<SettingsSelect value={uiLanguage} onChange={(event) => setUiLanguage(event.target.value as UiLanguage)}><option value="en">English</option><option value="zh-CN">简体中文</option></SettingsSelect></label>
                <label>{t.aiPreferredLanguage}<SettingsSelect value={aiLanguage} onChange={(event) => setAiLanguage(event.target.value as AiPreferredLanguage)}><option value="Simplified Chinese">简体中文</option><option value="Chinese">中文</option><option value="English">English</option></SettingsSelect></label>
              </div>
            </section>
            )}
            {settingsSection === 'storage' && (
            <section className="reader-settings__section reader-settings__storage">
              <div className="reader-settings__section-heading">
                <Database size={17} />
                <div><strong>{t.storageOverview}</strong><span>{t.storageDescription}</span></div>
                <button className="quiet-button reader-settings__storage-refresh" type="button" disabled={storageLoading} onClick={() => void refreshStorageOverview()}>{storageLoading ? t.loading : t.refresh}</button>
              </div>
              {storageError && <span className="reader-settings__status is-error">{storageError}</span>}
              {storageOverview && (
                <>
                  <div className="reader-settings__storage-summary">
                    <div><span>{t.books}</span><strong>{storageOverview.documents.length}</strong></div>
                    <div><span>{t.pdfStorage}</span><strong>{formatBytes(storageOverview.documents.reduce((total, item) => total + (item.document.fingerprint?.byteSize ?? 0), 0))}</strong></div>
                    <div><span>{t.metadataStorage}</span><strong>{formatBytes(storageOverview.metadataBytes)}</strong></div>
                  </div>
                  <div className="reader-settings__storage-path"><span>{t.metadataLocation}</span><code title={storageOverview.metadataPath}>{storageOverview.metadataPath}</code></div>
                  {storageOverview.documents.length === 0 ? (
                    <div className="reader-settings__storage-empty"><BookOpen size={22} /><span>{t.noStoredBooks}</span></div>
                  ) : (
                    <div className="reader-settings__book-list">
                      {storageOverview.documents.map((item) => {
                        const document = item.document;
                        const messageCount = item.conversations.reduce((total, conversation) => total + conversation.messageCount, 0);
                        const contentCount = item.conversations.length + item.translations.length + item.notes.length + item.marks.length + item.bookmarks.length + item.workspaceBlocks.length + (item.generatedOutline?.itemCount ?? 0);
                        return (
                          <details className="reader-settings__book" key={document.id}>
                            <summary>
                              <BookOpen size={18} />
                              <span><strong>{document.title}</strong><small>{document.fileName} · {formatDateTime(document.lastOpenedAt, uiLanguage)}</small></span>
                              <em>{contentCount} {t.items}</em>
                              <ChevronDown size={16} />
                            </summary>
                            <div className="reader-settings__book-detail">
                              <dl>
                                <div><dt>{t.fileStatus}</dt><dd className={item.fileAvailable ? '' : 'is-missing'}>{item.fileAvailable ? t.available : t.missing}</dd></div>
                                <div><dt>{t.fileSize}</dt><dd>{formatBytes(document.fingerprint?.byteSize ?? 0)}</dd></div>
                                <div><dt>{t.pages}</dt><dd>{document.pageCount ?? '—'}</dd></div>
                                <div><dt>{t.lastReadPage}</dt><dd>{document.readingState?.lastPage ?? '—'}</dd></div>
                                <div><dt>{t.addedAt}</dt><dd>{formatDateTime(document.createdAt, uiLanguage)}</dd></div>
                                <div><dt>{t.lastOpened}</dt><dd>{formatDateTime(document.lastOpenedAt, uiLanguage)}</dd></div>
                                <div className="is-wide"><dt>{t.filePath}</dt><dd title={document.filePath}>{document.filePath}</dd></div>
                                <div className="is-wide"><dt>SHA-256</dt><dd title={document.sha256}>{document.sha256}</dd></div>
                              </dl>
                              <div className="reader-settings__content-counts" aria-label={t.storedContent}>
                                <span>{t.conversations}<strong>{item.conversations.length}</strong></span>
                                <span>{t.messages}<strong>{messageCount}</strong></span>
                                <span>{t.translations}<strong>{item.translations.length}</strong></span>
                                <span>{t.notes}<strong>{item.notes.length}</strong></span>
                                <span>{t.marks}<strong>{item.marks.length}</strong></span>
                                <span>{t.bookmarks}<strong>{item.bookmarks.length}</strong></span>
                                <span>{t.canvasItems}<strong>{item.workspaceBlocks.length}</strong></span>
                                <span>{t.outlineItems}<strong>{item.generatedOutline?.itemCount ?? 0}</strong></span>
                              </div>
                              <StoredContentPreview item={item} language={uiLanguage} labels={t} />
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </section>
            )}
            {settingsSection === 'appearance' && (
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><Palette size={17} /><div><strong>{t.appearance}</strong><span>{t.appearanceDescription}</span></div></div>
              <div className="reader-settings__fields">
                <label className="reader-settings__wide">{t.sidebarColor}
                  <span className="reader-settings__color-control">
                    <input type="color" value={sidebarColor} aria-label={t.sidebarColor} onChange={(event) => setSidebarColor(event.target.value)} />
                    <output>{sidebarColor.toUpperCase()}</output>
                    <button className="quiet-button" type="button" onClick={() => setSidebarColor(defaultAppPreferences.sidebarColor)}>{t.reset}</button>
                  </span>
                </label>
                <div className="reader-settings__wide reader-settings__appearance-group">
                  <strong>{t.annotationColors}</strong>
                  <span>{t.annotationColorsDescription}</span>
                  <div className="reader-settings__color-grid">
                    {([
                      ['highlight', t.highlightColor], ['underline', t.underlineColor], ['chat', t.chatColor],
                      ['note', t.noteColor], ['summary', t.summaryColor], ['translate', t.translateColor]
                    ] as Array<[keyof typeof selectionColors, string]>).map(([role, label]) => (
                      <label key={role} className="reader-settings__swatch-field">
                        <span>{label}</span>
                        <input type="color" value={selectionColors[role]} aria-label={label} onChange={(event) => setSelectionColors((current) => ({ ...current, [role]: event.target.value }))} />
                      </label>
                    ))}
                  </div>
                </div>
                <div className="reader-settings__wide reader-settings__appearance-group">
                  <strong>{t.typography}</strong>
                  <span>{t.typographyDescription}</span>
                  <div className="reader-settings__typography-grid">
                    <section>
                      <strong>{t.interfaceTypography}</strong>
                      <label>{t.uiFont}<SettingsSelect value={appearance.uiFont} onChange={(event) => setAppearance((current) => ({ ...current, uiFont: event.target.value as AppearanceFont }))}><option value="system">{t.fontSystem}</option><option value="rounded">{t.fontRounded}</option><option value="serif">{t.fontSerif}</option></SettingsSelect></label>
                      <FontSizeControl label={t.uiFontSize} value={appearance.uiFontSize} onChange={(uiFontSize) => setAppearance((current) => ({ ...current, uiFontSize }))} />
                      <FontSizeControl label={t.sidebarFontSize} value={appearance.sidebarFontSize} onChange={(sidebarFontSize) => setAppearance((current) => ({ ...current, sidebarFontSize }))} />
                    </section>
                    <section>
                      <strong>{t.conversationTypography}</strong>
                      <label>{t.agentFont}<SettingsSelect value={appearance.agentFont} onChange={(event) => setAppearance((current) => ({ ...current, agentFont: event.target.value as AppearanceFont }))}><option value="system">{t.fontSystem}</option><option value="rounded">{t.fontRounded}</option><option value="serif">{t.fontSerif}</option><option value="mono">{t.fontMono}</option></SettingsSelect></label>
                      <FontSizeControl label={t.agentFontSize} value={appearance.agentFontSize} onChange={(agentFontSize) => setAppearance((current) => ({ ...current, agentFontSize }))} />
                      <FontSizeControl label={t.composerFontSize} value={appearance.composerFontSize} onChange={(composerFontSize) => setAppearance((current) => ({ ...current, composerFontSize }))} />
                    </section>
                    <section>
                      <strong>{t.codeTypography}</strong>
                      <label>{t.codeFont}<SettingsSelect value={appearance.codeFont} onChange={(event) => setAppearance((current) => ({ ...current, codeFont: event.target.value as AppearanceFont }))}><option value="mono">{t.fontMono}</option><option value="system">{t.fontSystem}</option><option value="serif">{t.fontSerif}</option></SettingsSelect></label>
                      <FontSizeControl label={t.codeFontSize} value={appearance.codeFontSize} onChange={(codeFontSize) => setAppearance((current) => ({ ...current, codeFontSize }))} />
                    </section>
                  </div>
                </div>
              </div>
            </section>
            )}
            {settingsSection === 'updates' && (
            <section className="reader-settings__section">
              <div className="reader-settings__section-heading"><RefreshCw size={17} /><div><strong>{t.updates}</strong><span>{t.updateDescription}</span></div></div>
              <div className="reader-settings__update-summary">
                <div><span>{t.currentVersion}</span><output aria-label={t.currentVersion}>{updateState?.currentVersion ?? '...'}</output></div>
                <div><span>{t.updateStatus}</span><output aria-label={t.updateStatus}>{updateStatusText(updateState, t)}</output></div>
                {updateState?.availableVersion && <div><span>{t.availableVersion}</span><output aria-label={t.availableVersion}>{updateState.availableVersion}</output></div>}
              </div>
              {updateState?.status === 'installing' && (
                <div className="reader-settings__installing" role="status" aria-live="assertive">
                  <RefreshCw size={17} aria-hidden="true" />
                  <div><strong>{t.updateInstalling}</strong><span>{t.updateInstallHint}</span></div>
                </div>
              )}
              <div className="reader-settings__actions reader-settings__actions--inline">
                <button className="quiet-button" type="button" disabled={updateState?.status === 'checking' || updateState?.status === 'downloading' || updateState?.status === 'installing'} onClick={() => void window.sidelight.checkForAppUpdates()}>{t.checkForUpdates}</button>
                {updateState?.status === 'available' && <>
                  <button className="primary-button" type="button" onClick={() => void window.sidelight.downloadAppUpdate()}>{t.downloadUpdate}</button>
                </>}
                {updateState?.status === 'ready' && <button className="primary-button" type="button" onClick={() => void installAppUpdate()}>{t.restartToUpdate}</button>}
                {updateState?.status === 'unsupported' && updateState.message?.includes('manual updates') && <a className="quiet-button" href="https://github.com/fogsong233/Tessel/releases/latest" target="_blank" rel="noreferrer">{t.openDownloads}</a>}
              </div>
              {updateState?.releaseNotes && (
                <section className="reader-settings__release-notes" aria-labelledby="settings-release-notes-title">
                  <header id="settings-release-notes-title">{t.releaseNotes}</header>
                  <div className="reader-settings__release-notes-body">
                    <MarkdownView visualLinkPreviews={false}>{updateState.releaseNotes}</MarkdownView>
                  </div>
                </section>
              )}
            </section>
            )}
                </div>
              </div>
              <footer className="reader-settings__actions"><button className="quiet-button" type="button" onClick={onClose}>{t.cancel}</button><button className="primary-button" type="submit">{t.save}</button></footer>
            </div>
          </div>
        </form>
      </section>
  );
}

function SettingsSelect({ children, ...props }: ComponentPropsWithoutRef<'select'>): ReactElement {
  return (
    <span className="reader-settings__select">
      <select {...props}>{children}</select>
      <ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function FontSizeControl({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}): ReactElement {
  return (
    <label className="reader-settings__font-size">
      <span>{label}</span>
      <span className="reader-settings__font-size-control">
        <input
          type="range"
          min="11"
          max="20"
          step="1"
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output>{value}px</output>
      </span>
    </label>
  );
}

function SettingsToggle({ label, ...props }: ComponentPropsWithoutRef<'input'> & { label: string }): ReactElement {
  return (
    <label className="reader-settings__switch">
      <input {...props} type="checkbox" />
      <span className="reader-settings__switch-control" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

function StoredContentPreview({
  item,
  language,
  labels
}: {
  item: StoredDocumentInfo;
  language: UiLanguage;
  labels: ReturnType<typeof readerSettingsText>;
}): ReactElement | null {
  const groups = [
    {
      label: labels.conversations,
      entries: item.conversations.map((conversation) => `${pagePrefix(conversation.pageNumber, language)}${conversation.title} · ${conversation.messageCount} ${labels.messages.toLocaleLowerCase()}`)
    },
    {
      label: labels.translations,
      entries: item.translations.map((translation) => `${pagePrefix(translation.pageNumber, language)}${compactStorageText(translation.quote)} → ${compactStorageText(translation.content)}`)
    },
    {
      label: labels.notes,
      entries: item.notes.map((note) => `${pageRangeLabel(note.pageStart, note.pageEnd, language)}${note.title}${note.source === 'ai' ? ' · AI' : ''}`)
    },
    {
      label: labels.marks,
      entries: item.marks.map((mark) => `${pagePrefix(mark.pageNumber, language)}${mark.kind === 'highlight' ? labels.highlight : labels.underline}: ${compactStorageText(mark.quote)}`)
    },
    {
      label: labels.bookmarks,
      entries: item.bookmarks.map((bookmark) => `${pagePrefix(bookmark.pageNumber, language)}${bookmark.label}`)
    },
    {
      label: labels.canvasItems,
      entries: item.workspaceBlocks.map((block) => `${pagePrefix(block.pageNumber, language)}${block.title} · ${block.kind}`)
    }
  ].filter((group) => group.entries.length > 0);
  if (groups.length === 0) {
    return <p className="reader-settings__book-no-content">{labels.noBookContent}</p>;
  }
  return (
    <div className="reader-settings__content-preview">
      {groups.map((group) => (
        <section key={group.label}>
          <strong>{group.label}</strong>
          <ul>{group.entries.map((entry, index) => <li key={`${group.label}-${index}`}>{entry}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}

function compactStorageText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function pagePrefix(pageNumber: number | undefined, language: UiLanguage): string {
  if (!pageNumber) {
    return '';
  }
  return language === 'zh-CN' ? `第 ${pageNumber} 页 · ` : `p.${pageNumber} · `;
}

function pageRangeLabel(pageStart: number, pageEnd: number, language: UiLanguage): string {
  const range = pageStart === pageEnd ? String(pageStart) : `${pageStart}–${pageEnd}`;
  return language === 'zh-CN' ? `第 ${range} 页 · ` : `p.${range} · `;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const amount = bytes / (1024 ** unitIndex);
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
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
    'Use the supplied page samples first. When PDF tools are available, use sidelight_pdf_read_outline and sidelight_pdf_read_pages to verify uncertain sections.',
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

function compactCodexHistory(history: ConversationMessage[]): ConversationMessage[] {
  return history.slice(-8).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content.slice(0, 2_000),
    createdAt: message.createdAt
  }));
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

function reasoningEffortLabel(effort: string, language: UiLanguage = 'en'): string {
  if (language === 'zh-CN') {
    const chinese = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '极限' };
    const label = chinese[effort as keyof typeof chinese];
    if (label) {
      return label;
    }
  }
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
