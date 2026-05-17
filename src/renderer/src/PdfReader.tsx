import {
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { Splitter, SplitterPanel } from 'primereact/splitter';
import { InputText } from 'primereact/inputtext';
import { Badge } from 'primereact/badge';
import { Button } from 'primereact/button';
import { ScrollPanel } from 'primereact/scrollpanel';
import * as pdfjsLib from 'pdfjs-dist';
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFDocumentProxy
} from 'pdfjs-dist/types/src/display/api';
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode
} from 'pdfjs-dist/web/pdf_viewer';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import {
  BookOpen,
  BookmarkPlus,
  ChevronsLeft,
  ChevronsRight,
  Check,
  ArrowUp,
  FilePlus2,
  FileText,
  FolderOpen,
  Highlighter,
  Languages,
  ListTree,
  MessageCircle,
  Minus,
  Plus,
  Search,
  Settings,
  Pin,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react';
import {
  AiMode,
  Conversation,
  ConversationAttachment,
  AiDocumentToolContext,
  AiToolCallEvent,
  LibraryGroup,
  NoteDocument,
  PdfGeneratedOutline,
  PdfDocumentMeta,
  PdfMark,
  PdfMarkArea,
  PdfMarkKind,
  PdfSourceDescriptor,
  PdfUserBookmark,
  SelectionColorPreferences,
  SelectionColorRole,
  TextAnchor,
  UiLanguage,
  WorkspaceBlock,
  pdfRangeChunkSize
} from '../../shared/domain';
import { createId } from '../../shared/ids';
import { isPendingGeneratedNoteDraft } from '../../shared/notes';
import { normalizeSelectionColors, selectionColorForRole } from '../../shared/selectionColors';
import { canOpenWorkspaceBlockSource, defaultWorkspaceBlockWidth, workspaceBlockSpec } from '../../shared/workspacePins';
import { MarkdownView } from './MarkdownView';
import { MarkdownNoteEditor } from './MarkdownNoteEditor';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfSelectionPayload {
  quote: string;
  areas: PdfMarkArea[];
  pageNumber: number;
}

export interface ReaderTransientAid {
  id: string;
  mode: Extract<AiMode, 'summarize' | 'translate'>;
  pageNumber: number;
  quote: string;
  content: string;
  busy: boolean;
  error?: string;
}

interface PdfReaderProps {
  documents: PdfDocumentMeta[];
  libraryGroups: LibraryGroup[];
  source?: PdfSourceDescriptor;
  meta?: PdfDocumentMeta;
  uiLanguage?: UiLanguage;
  selectionColors: SelectionColorPreferences;
  activePage: number;
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  conversations: Conversation[];
  workspaceBlocks: WorkspaceBlock[];
  generatedOutline?: PdfGeneratedOutline | null;
  activeConversation?: Conversation;
  activeConversationId?: string;
  notes: NoteDocument[];
  transientAid?: ReaderTransientAid;
  chatOpen: boolean;
  busy: boolean;
  canStopGeneration: boolean;
  noteBusy: boolean;
  outlineGenerationBusy: boolean;
  outlineGenerationError?: string;
  onOpenPdf(): void;
  onOpenSettings(): void;
  onLoadDocument(documentId: string): void;
  onAddToLibrary(): void;
  onPageChange(pageNumber: number): void;
  onCreateMark(kind: PdfMarkKind, selection: PdfSelectionPayload, colorRole?: SelectionColorRole): void;
  onSelectionAction(mode: AiMode, selection: PdfSelectionPayload): void;
  onAddBookmark(pageNumber: number): void;
  onDeleteBookmark(bookmarkId: string): void;
  onDeleteMark(markId: string): void;
  onCreatePageChat(pageNumber: number): void;
  onOpenConversation(conversationId: string): void;
  onCloseConversation(): void;
  onCloseTransientAid(): void;
  onSendMessage(
    conversationId: string,
    prompt: string,
    attachments: ConversationAttachment[],
    toolContext?: AiDocumentToolContext
  ): void;
  onStopGeneration(): void;
  onSaveWorkspaceBlock(block: WorkspaceBlock): void | Promise<void>;
  onDeleteWorkspaceBlock(blockId: string): void;
  onSaveNote(note: NoteDocument): void | Promise<void>;
  onDeleteNote(noteId: string): void;
  onGenerateNote(pageStart: number, pageEnd: number, pageText: string, toolContext?: AiDocumentToolContext): void;
  onGenerateOutline(toolContext?: AiDocumentToolContext): void;
}

type DockTab = 'chat' | 'notes' | 'search' | 'bookmarks' | 'marks';
type DockForegroundPanel = 'chat' | 'note' | 'transient';
type LeftTab = 'library' | 'outline';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

const dockHandleGutter = 24;

interface PdfRuntime {
  eventBus: EventBus;
  findController: PDFFindController;
  linkService: PDFLinkService;
  pdfDocument: PDFDocumentProxy;
  pdfViewer: PDFViewer;
}

interface ActiveMarkPopover {
  markId: string;
  left: number;
  top: number;
}

interface SelectionPopover {
  left: number;
  top: number;
  selection: PdfSelectionPayload;
}

interface PdfOutlineItem {
  id: string;
  title: string;
  level: number;
  dest: string | unknown[] | null;
  pageNumber?: number;
}

interface PdfJsOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: PdfJsOutlineNode[];
}

interface ZoomAnchor {
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  scrollLeft: number;
  scrollTop: number;
  pageNumber?: string;
  pageWidth?: number;
  pageOffsetX?: number;
  pageOffsetY?: number;
}

interface ZoomPageLock {
  enforceScroll?: boolean;
  pageNumber: number;
  releaseTimer?: number;
  version: number;
}

interface WorkspaceBlockLayout {
  left: number;
  pageScale: number;
  pageTop: number;
  renderedY: number;
  top: number;
}

function readerText(language: UiLanguage) {
  if (language === 'zh-CN') {
    return {
      addBookmark: '添加书签',
      addToLibrary: '加入资料库',
      aiDraft: 'AI 草稿',
      aiNote: 'AI 笔记',
      askAboutPage: '询问这个页面。',
      askAboutSelection: '询问选中的内容。',
      attachImages: '上传图片',
      bookmarkCurrentPage: '收藏当前页',
      bookmarkPage: '收藏页面',
      bookmarks: '书签',
      chat: '对话',
      chats: '对话',
      close: '关闭',
      collapseChat: '收起对话',
      conversation: '对话',
      delete: '删除',
      deleteMark: '删除标注',
      deleteNote: '删除笔记',
      editing: '编辑中',
      fitWidth: '适应宽度',
      from: '从',
      generateAiOutline: 'AI 自动生成 PDF 目录',
      generateAiNote: '生成 AI 笔记',
      generatedOutline: 'AI 生成目录',
      generateFromSources: '从 PDF、标注和对话生成',
      generating: '生成中...',
      generatingOutline: '正在分析 PDF...',
      highlight: '高亮',
      highlights: '高亮',
      hideSidebar: '隐藏侧边栏',
      image: '图片',
      library: '资料库',
      loadingPdf: '正在加载 PDF',
      localPdfWorkspace: '本地 PDF 工作区',
      transientPdf: '临时打开，尚未加入资料库',
      manual: '手动',
      messageSidelight: '给 Sidelight 发消息',
      newPageChat: '新建页面对话',
      newPageNote: '新建页面笔记',
      noConversations: '这个文档还没有对话。',
      noHighlights: '当前页还没有高亮。',
      noNoteCoversPage: '当前页没有可见笔记',
      noNoteVisible: '这里没有可见笔记',
      noNoteVisibleHelp: '创建页面笔记、生成 AI 笔记，或移动到已有笔记覆盖的页面。',
      noSearchResults: '没有匹配结果。',
      noOutline: '这个 PDF 没有目录。',
	      noPdfOpen: '未打开 PDF',
	      noPdfs: '资料库里还没有 PDF。',
	      noBookmarks: '还没有页面书签。',
	      notes: '笔记',
	      notePreview: '预览',
	      emptyNotePreview: '暂无内容',
	      openChat: '打开对话',
      openNote: '打开笔记',
      openPdf: '打开 PDF',
      outline: '目录',
      page: '页',
      pageNotes: '页面笔记',
      pdfFailed: 'PDF 加载失败',
      pdfFailedHelp: 'PDF.js 无法读取这个文档。',
      readingOutline: '正在读取 PDF 目录...',
      readingSidePanel: '阅读侧边栏',
      removeBookmark: '移除书签',
      removeImage: '移除图片',
      resizeSidePanel: '调整侧边栏宽度',
      save: '保存',
      search: '搜索',
      searchAll: '全部',
      searchChats: '问答',
      searchNotes: '笔记',
      searchNotesAndChats: '搜索笔记和问答',
      searchPlaceholder: '搜索内容、标题或摘要',
      scopedByPageRange: '按页码范围显示',
      searchInPdf: '搜索 PDF',
      send: '发送',
      settings: '设置',
      showSidebar: '显示侧边栏',
	      stopGenerating: '停止回答',
	      toolCompleted: '已完成',
	      toolFailed: '失败',
	      toolReading: '读取中',
	      toolReadPdf: '读取 PDF',
	      toolReadOutline: '查看目录',
      pinToCanvas: '贴到学习空间',
      pinImageToCanvas: '贴图片到学习空间',
      moveBlock: '移动卡片',
      resizeBlock: '调整卡片宽度',
      unpinFromCanvas: '从学习空间移除',
      summary: '总结',
      temporaryReadingAid: '临时阅读辅助',
      thinking: '思考中...',
      title: '标题',
      to: '到',
      translate: '翻译',
      translation: '翻译',
      underline: '下划线',
      visibleNotes: '可见笔记',
      visibleOnPage: (count: number) => `${count} 条在当前页可见`,
      zoomIn: '放大',
      zoomOut: '缩小'
    };
  }

  return {
    addBookmark: 'Add bookmark',
    addToLibrary: 'Add to library',
    aiDraft: 'AI draft',
    aiNote: 'AI note',
    askAboutPage: 'Ask about this page.',
    askAboutSelection: 'Ask about the selected passage.',
    attachImages: 'Attach images',
    bookmarkCurrentPage: 'Bookmark current page',
    bookmarkPage: 'Bookmark page',
    bookmarks: 'Bookmarks',
    chat: 'Chat',
    chats: 'Chats',
    close: 'Close',
    collapseChat: 'Collapse chat',
    conversation: 'Conversation',
    delete: 'Delete',
    deleteMark: 'Delete mark',
    deleteNote: 'Delete note',
    editing: 'Editing',
      fitWidth: 'Fit to width',
      from: 'From',
      generateAiOutline: 'AI-generate PDF outline',
      generateAiNote: 'Generate AI note',
      generatedOutline: 'AI-generated outline',
      generateFromSources: 'Generate from PDF, highlights, and chats',
      generating: 'Generating...',
      generatingOutline: 'Analyzing PDF...',
    highlight: 'Highlight',
    highlights: 'Highlights',
    hideSidebar: 'Hide sidebar',
    image: 'Image',
    library: 'Library',
    loadingPdf: 'Loading PDF',
    localPdfWorkspace: 'Local PDF workspace',
    transientPdf: 'Opened temporarily, not in library',
    manual: 'Manual',
    messageSidelight: 'Message Sidelight',
    newPageChat: 'New page chat',
    newPageNote: 'New page note',
    noConversations: 'No conversations on this document yet.',
    noHighlights: 'No highlights on this page yet.',
    noNoteCoversPage: 'No note covers this page',
      noNoteVisible: 'No note is visible here',
      noNoteVisibleHelp: 'Create a page note, generate an AI note, or move to a page covered by an existing note.',
      noSearchResults: 'No matching results.',
      noOutline: 'No outline in this PDF.',
	    noPdfOpen: 'No PDF open',
	    noPdfs: 'No PDFs in the library yet.',
	    noBookmarks: 'No page bookmarks yet.',
	    notes: 'Notes',
	    notePreview: 'Preview',
	    emptyNotePreview: 'No content',
	      openChat: 'Open chat',
      openNote: 'Open note',
      openPdf: 'Open PDF',
    outline: 'Outline',
    page: 'Page',
    pageNotes: 'Page notes',
    pdfFailed: 'PDF failed to load',
    pdfFailedHelp: 'The document could not be read by PDF.js.',
    readingOutline: 'Reading PDF outline...',
    readingSidePanel: 'Reading side panel',
    removeBookmark: 'Remove bookmark',
      removeImage: 'Remove image',
    resizeSidePanel: 'Resize side panel',
    save: 'Save',
      search: 'Search',
      searchAll: 'All',
      searchChats: 'Q&A',
      searchNotes: 'Notes',
      searchNotesAndChats: 'Search notes and Q&A',
      searchPlaceholder: 'Search content, titles, or summaries',
      scopedByPageRange: 'Scoped by page range',
    searchInPdf: 'Search in PDF',
    send: 'Send',
    settings: 'Settings',
	    showSidebar: 'Show sidebar',
	    stopGenerating: 'Stop generating',
	    toolCompleted: 'Done',
	    toolFailed: 'Failed',
	    toolReading: 'Reading',
	    toolReadPdf: 'Read PDF',
	    toolReadOutline: 'Read outline',
    pinToCanvas: 'Pin to learning space',
    pinImageToCanvas: 'Pin image to learning space',
    moveBlock: 'Move block',
    resizeBlock: 'Resize block',
    unpinFromCanvas: 'Remove from learning space',
    summary: 'Summary',
    temporaryReadingAid: 'Temporary reading aid',
    thinking: 'Thinking...',
    title: 'Title',
    to: 'To',
    translate: 'Translate',
    translation: 'Translation',
    underline: 'Underline',
    visibleNotes: 'Visible notes',
    visibleOnPage: (count: number) => `${count} visible on this page`,
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out'
  };
}

type ReaderText = ReturnType<typeof readerText>;

export function PdfReader({
  documents,
  libraryGroups,
  source,
  meta,
  uiLanguage = 'en',
  selectionColors,
  activePage,
  marks,
  bookmarks,
  conversations,
  workspaceBlocks,
  generatedOutline,
  activeConversation,
  activeConversationId,
  notes,
  transientAid,
  chatOpen,
  busy,
  canStopGeneration,
  noteBusy,
  outlineGenerationBusy,
  outlineGenerationError,
  onOpenPdf,
  onOpenSettings,
  onLoadDocument,
  onAddToLibrary,
  onPageChange,
  onCreateMark,
  onSelectionAction,
  onAddBookmark,
  onDeleteBookmark,
  onDeleteMark,
  onCreatePageChat,
  onOpenConversation,
  onCloseConversation,
  onCloseTransientAid,
  onSendMessage,
  onStopGeneration,
  onSaveWorkspaceBlock,
  onDeleteWorkspaceBlock,
  onSaveNote,
  onDeleteNote,
  onGenerateNote,
  onGenerateOutline
}: PdfReaderProps): ReactElement {
  const t = readerText(uiLanguage);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PdfRuntime>();
  const marksRef = useRef(marks);
  const selectionColorsRef = useRef(normalizeSelectionColors(selectionColors));
  const notesRef = useRef(notes);
  const conversationsRef = useRef(conversations);
  const workspaceBlocksRef = useRef(workspaceBlocks);
  const optimisticWorkspaceBlocksRef = useRef<WorkspaceBlock[]>([]);
  const workspaceBlockCoordinateScalesRef = useRef<Record<string, number>>({});
  const workspacePinTailRef = useRef<Record<string, number>>({});
  const dockTabRef = useRef<DockTab>('chat');
  const activeConversationRef = useRef(activeConversation);
  const chatOpenRef = useRef(chatOpen);
  const transientAidRef = useRef(transientAid);
  const onCloseConversationRef = useRef(onCloseConversation);
  const onCloseTransientAidRef = useRef(onCloseTransientAid);
  const onOpenConversationRef = useRef(onOpenConversation);
  const onPageChangeRef = useRef(onPageChange);
  const activePageRef = useRef(activePage);
  const zoomPageLockRef = useRef<ZoomPageLock>();
  const zoomLockVersionRef = useRef(0);
  const pendingRevealScrollTopRef = useRef<number>();
  const lastPdfReadingIntentRef = useRef(0);

  const [status, setStatus] = useState<LoadStatus>('idle');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [pageDraft, setPageDraft] = useState(String(activePage));
  const [pageDraftFocused, setPageDraftFocused] = useState(false);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [selectionPopover, setSelectionPopover] = useState<SelectionPopover>();
  const [activeMark, setActiveMark] = useState<ActiveMarkPopover>();
  const [leftTab, setLeftTab] = useState<LeftTab>('outline');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>('chat');
  const [dockWidth, setDockWidth] = useState<number>();
  const [searchQuery, setSearchQuery] = useState('');
  const [noteEditorNote, setNoteEditorNote] = useState<NoteDocument>();
  const [workspaceBlockLayouts, setWorkspaceBlockLayouts] = useState<Record<string, WorkspaceBlockLayout>>({});
  const [pendingRevealBlockId, setPendingRevealBlockId] = useState<string>();
  const [optimisticWorkspaceBlocks, setOptimisticWorkspaceBlocks] = useState<WorkspaceBlock[]>([]);
  const [pdfReadingSignal, setPdfReadingSignal] = useState(0);

  const effectiveWorkspaceBlocks = useMemo(() => {
    const byId = new Map<string, WorkspaceBlock>();
    for (const block of workspaceBlocks) {
      byId.set(block.id, block);
    }
    for (const block of optimisticWorkspaceBlocks) {
      byId.set(block.id, block);
    }
    return Array.from(byId.values());
  }, [optimisticWorkspaceBlocks, workspaceBlocks]);
  const displayOutline = useMemo<PdfOutlineItem[]>(() => {
    if (outline.length > 0) {
      return outline;
    }

    return (generatedOutline?.items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      level: item.level,
      pageNumber: item.pageNumber,
      dest: null
    }));
  }, [generatedOutline, outline]);
  const outlineIsGenerated = outline.length === 0 && displayOutline.length > 0;
  const resolvedSelectionColors = useMemo(() => normalizeSelectionColors(selectionColors), [selectionColors]);

  marksRef.current = marks;
  selectionColorsRef.current = resolvedSelectionColors;
  notesRef.current = notes;
  conversationsRef.current = conversations;
  workspaceBlocksRef.current = effectiveWorkspaceBlocks;
  dockTabRef.current = dockTab;
  activeConversationRef.current = activeConversation;
  chatOpenRef.current = chatOpen;
  transientAidRef.current = transientAid;
  onCloseConversationRef.current = onCloseConversation;
  onCloseTransientAidRef.current = onCloseTransientAid;
  onOpenConversationRef.current = onOpenConversation;
  onPageChangeRef.current = onPageChange;
  activePageRef.current = activePage;

  const visibleConversations = useMemo(
    () => filterConversations(conversations, activePage),
    [activePage, conversations]
  );
  const pageConversationCount = conversations.filter((conversation) => conversation.pageNumber === activePage).length;
  const pageMarks = marks.filter((mark) => mark.pageNumber === activePage);
  const visibleNotes = notes.filter((note) => note.pageStart <= activePage && note.pageEnd >= activePage);
  useEffect(() => {
    if (!noteEditorNote) {
      return;
    }

    const latest = notes.find((note) => note.id === noteEditorNote.id);
    if (latest && shouldRefreshOpenNoteDraft(noteEditorNote, latest)) {
      setNoteEditorNote(latest);
    }
  }, [noteEditorNote, notes]);
  const workspaceCanvasTail = useMemo(() => {
    return effectiveWorkspaceBlocks.reduce((maxTail, block) => {
      if (block.anchor !== 'page') {
        return maxTail;
      }

      return Math.max(maxTail, block.x > 0 ? block.x + block.width + 180 : 0);
    }, 0);
  }, [effectiveWorkspaceBlocks]);
  const workspaceLeftGutter = useMemo(() => {
    const neededGutter = effectiveWorkspaceBlocks.reduce((maxGutter, block) => {
      if (block.anchor !== 'page' || block.x >= 0) {
        return maxGutter;
      }

      return Math.max(maxGutter, Math.abs(block.x) + 48);
    }, 0);

    return neededGutter > 0 ? Math.max(420, neededGutter) : 0;
  }, [effectiveWorkspaceBlocks]);
  const chatPanelOpen = chatOpen && Boolean(activeConversation);
  const hasTransientAid = Boolean(transientAid);
  const hasOpenDock = chatPanelOpen || hasTransientAid || Boolean(noteEditorNote);
  const activeDockTab: DockTab | undefined = transientAid
    ? undefined
    : noteEditorNote
      ? 'notes'
      : chatPanelOpen
        ? 'chat'
        : dockTab;
  const defaultDockWidth = noteEditorNote ? 880 : hasOpenDock ? 560 : 372;
  const resolvedDockWidth = dockWidth === undefined
    ? defaultDockWidth
    : noteEditorNote
      ? Math.max(760, dockWidth)
      : dockWidth;
  const stageStyle = useMemo(
    () => ({
      '--dock-panel-width': `${resolvedDockWidth}px`,
      '--dock-lane-width': `${resolvedDockWidth + dockHandleGutter}px`,
      ...selectionColorCssVars(resolvedSelectionColors),
      ...(workspaceLeftGutter > 0 ? { '--canvas-left-gutter': `${workspaceLeftGutter}px` } : {})
    }) as CSSProperties,
    [resolvedDockWidth, resolvedSelectionColors, workspaceLeftGutter]
  );

  const closeNoteForForeground = useCallback((nextNoteId?: string): void => {
    if (!noteEditorNote || noteEditorNote.id === nextNoteId) {
      return;
    }

    onSaveNote(noteEditorNote);
    setNoteEditorNote(undefined);
  }, [noteEditorNote, onSaveNote]);

  const replaceForegroundPanel = useCallback((nextPanel: DockForegroundPanel, note?: NoteDocument): void => {
    if (nextPanel !== 'note') {
      closeNoteForForeground();
    } else {
      closeNoteForForeground(note?.id);
    }

    if (nextPanel !== 'transient' && hasTransientAid) {
      onCloseTransientAid();
    }

    if (nextPanel !== 'chat' && chatPanelOpen) {
      onCloseConversation();
    }

    if (nextPanel === 'chat') {
      setDockTab('chat');
    } else if (nextPanel === 'note' && note) {
      setDockTab('notes');
      setNoteEditorNote(note);
    }
  }, [
    chatPanelOpen,
    closeNoteForForeground,
    hasTransientAid,
    onCloseConversation,
    onCloseTransientAid
  ]);

  useEffect(() => {
    if (chatPanelOpen) {
      replaceForegroundPanel('chat');
    }
  }, [activeConversation?.id, chatPanelOpen, replaceForegroundPanel]);

  useEffect(() => {
    if (hasTransientAid) {
      replaceForegroundPanel('transient');
    }
  }, [hasTransientAid, replaceForegroundPanel, transientAid?.id]);

  const renderMarks = useCallback(() => {
    if (!viewerRef.current) {
      return;
    }

    renderMarkLayers(viewerRef.current, marksRef.current, selectionColorsRef.current, (markId, event) => {
      setSelectionPopover(undefined);
      const mark = marksRef.current.find((candidate) => candidate.id === markId);
      if (mark && dockTabRef.current === 'chat') {
        const conversation = conversationsRef.current.find((candidate) => conversationMatchesMark(candidate, mark));
        if (conversation) {
          setDockTab('chat');
          if (transientAidRef.current) {
            onCloseTransientAidRef.current();
          }
          onOpenConversationRef.current(conversation.id);
          return;
        }
      }

      if (mark && dockTabRef.current === 'notes') {
        const note = notesRef.current.find((candidate) => noteMatchesMark(candidate, mark));
        if (note) {
          if (transientAidRef.current) {
            onCloseTransientAidRef.current();
          }
          if (chatOpenRef.current && activeConversationRef.current) {
            onCloseConversationRef.current();
          }
          setDockTab('notes');
          setNoteEditorNote(note);
          return;
        }
      }

      setActiveMark({
        markId,
        left: Math.max(12, Math.min(event.clientX + 10, window.innerWidth - 312)),
        top: Math.max(12, Math.min(event.clientY + 10, window.innerHeight - 220))
      });
    });
  }, []);

  const switchDockTab = useCallback((nextTab: DockTab): void => {
    if (nextTab !== 'notes') {
      closeNoteForForeground();
    }

    setDockTab(nextTab);

    if (hasTransientAid) {
      onCloseTransientAid();
    }

    if (nextTab !== 'chat' && chatPanelOpen) {
      onCloseConversation();
    }
  }, [chatPanelOpen, closeNoteForForeground, hasTransientAid, onCloseConversation, onCloseTransientAid]);

  const openDockConversation = useCallback((conversationId: string): void => {
    replaceForegroundPanel('chat');
    onOpenConversation(conversationId);
  }, [onOpenConversation, replaceForegroundPanel]);

  const createDockPageChat = useCallback((pageNumber: number): void => {
    replaceForegroundPanel('chat');
    onCreatePageChat(pageNumber);
  }, [onCreatePageChat, replaceForegroundPanel]);

  const openDockNote = useCallback((note: NoteDocument): void => {
    replaceForegroundPanel('note', note);
  }, [replaceForegroundPanel]);

  const openDockNoteById = useCallback((noteId: string): void => {
    const note = notes.find((candidate) => candidate.id === noteId);
    if (note) {
      openDockNote(note);
    }
  }, [notes, openDockNote]);

  const createDockNote = useCallback((selection?: PdfSelectionPayload): void => {
    if (!meta) {
      return;
    }

    const now = new Date().toISOString();
    const title = selection ? `Note p.${selection.pageNumber}` : `Notes p.${activePage}`;
    const note: NoteDocument = {
      id: createId('note'),
      documentId: meta.id,
      title,
      markdown: selection
        ? `# ${title}\n\n> ${selection.quote}\n\n`
        : `# ${title}\n\n`,
      pageStart: selection?.pageNumber ?? activePage,
      pageEnd: selection?.pageNumber ?? activePage,
      anchor: selection ? anchorFromSelection(meta.id, selection) : undefined,
      source: 'manual',
      createdAt: now,
      updatedAt: now
    };

    if (selection) {
      onCreateMark('highlight', selection, 'note');
    }

    replaceForegroundPanel('note', note);
  }, [
    activePage,
    meta,
    onCreateMark,
    replaceForegroundPanel
  ]);

  const closeDockNote = useCallback((noteToSave?: NoteDocument): void => {
    const draft = noteToSave ?? noteEditorNote;
    if (draft) {
      onSaveNote(draft);
      setNoteEditorNote(undefined);
    }
  }, [noteEditorNote, onSaveNote]);

  const deleteDockNote = useCallback((noteId: string): void => {
    setNoteEditorNote((current) => current?.id === noteId ? undefined : current);
    onDeleteNote(noteId);
  }, [onDeleteNote]);

  const defaultWorkspaceBlockX = useCallback((width = 292): number => -(width + 24), []);

  const currentWorkspacePageScale = useCallback((): number => {
    return sanitizeWorkspaceBlockScale(runtimeRef.current?.pdfViewer.currentScale) ?? sanitizeWorkspaceBlockScale(scale) ?? 1;
  }, [scale]);

  const workspaceBlocksForPlacement = useCallback((): WorkspaceBlock[] => {
    const byId = new Map<string, WorkspaceBlock>();
    for (const block of workspaceBlocksRef.current) {
      byId.set(block.id, block);
    }
    for (const block of optimisticWorkspaceBlocksRef.current) {
      byId.set(block.id, block);
    }
    return Array.from(byId.values());
  }, []);

  const workspacePinTailKey = useCallback((pageNumber: number, x: number): string => {
    return `${pageNumber}:${Math.sign(x) || 1}`;
  }, []);

  const rememberWorkspacePinTail = useCallback((pageNumber: number, x: number, y: number, height = 118): void => {
    const key = workspacePinTailKey(pageNumber, x);
    workspacePinTailRef.current[key] = Math.max(workspacePinTailRef.current[key] ?? 24, y + height + 14);
  }, [workspacePinTailKey]);

  useEffect(() => {
    optimisticWorkspaceBlocksRef.current = optimisticWorkspaceBlocksRef.current.filter(
      (pending) => !workspaceBlocks.some((block) => block.id === pending.id && block.updatedAt === pending.updatedAt)
    );
    setOptimisticWorkspaceBlocks((current) =>
      current.filter((pending) =>
        !workspaceBlocks.some((block) => block.id === pending.id && block.updatedAt === pending.updatedAt)
      )
    );
  }, [workspaceBlocks]);

  const avoidWorkspaceBlockOverlap = useCallback((
    pageNumber: number,
    x: number,
    y: number,
    width: number,
    excludeBlockId?: string
  ): { x: number; y: number } => {
    const page = viewerRef.current?.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
    const canvas = containerRef.current?.querySelector<HTMLElement>('.pdf-canvas');
    const pageBounds = page && canvas ? elementBoundsInCanvas(page, canvas) : undefined;
    const pageScale = currentWorkspacePageScale();
    const blockHeight = 118;
    const gap = 14;
    let nextY = y;
    const pageLimit = Math.max(24, (pageBounds?.height ?? page?.offsetHeight ?? 1600) - blockHeight - 24);
    const rememberedTail = workspacePinTailRef.current[workspacePinTailKey(pageNumber, x)];
    if (rememberedTail && rememberedTail <= pageLimit) {
      nextY = Math.max(nextY, rememberedTail);
    }
    const modelSiblings = workspaceBlocksForPlacement()
      .filter((block) =>
        block.anchor === 'page' &&
        block.pageNumber === pageNumber &&
        block.id !== excludeBlockId &&
        Math.sign(block.x) === Math.sign(x)
      )
      .map((block) => ({
        id: block.id,
        x: block.x,
        y: renderedWorkspaceBlockY(
          block,
          pageScale,
          workspaceBlockCoordinateScale(block, pageScale, workspaceBlockCoordinateScalesRef.current[block.id])
        ),
        width: block.width,
        height: block.height ?? blockHeight
      }));
    const renderedSiblings = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('.workspace-block-card') ?? [])
      .filter((element) =>
        element.dataset.pageNumber === String(pageNumber) &&
        element.dataset.blockId !== excludeBlockId &&
        Math.sign(Number(element.dataset.blockX ?? 0)) === Math.sign(x)
      )
      .map((element) => ({
        id: element.dataset.blockId ?? '',
        x: Number(element.dataset.blockX ?? 0),
        y: Math.max(0, element.offsetTop - (pageBounds?.top ?? page?.offsetTop ?? 0)),
        width: element.offsetWidth,
        height: element.offsetHeight || blockHeight
      }));
    const siblingsById = new Map<string, { id: string; x: number; y: number; width: number; height: number }>();
    for (const block of modelSiblings) {
      siblingsById.set(block.id, block);
    }
    for (const block of renderedSiblings) {
      siblingsById.set(block.id, block);
    }
    const siblings = Array.from(siblingsById.values());

    for (let attempts = 0; attempts < 24; attempts += 1) {
      const overlap = siblings.find((block) => {
        const otherHeight = block.height;
        const otherWidth = block.width;
        const horizontalOverlap = x < block.x + otherWidth + gap && x + width + gap > block.x;
        const verticalOverlap = nextY < block.y + otherHeight + gap && nextY + blockHeight + gap > block.y;
        return horizontalOverlap && verticalOverlap;
      });

      if (!overlap) {
        return { x, y: Math.round(nextY) };
      }

      nextY = Math.max(nextY + blockHeight + gap, overlap.y + overlap.height + gap);
      if (nextY > pageLimit) {
        nextY = 24;
      }
    }

    return { x, y: Math.round(clamp(nextY, 24, pageLimit)) };
  }, [currentWorkspacePageScale, workspaceBlocksForPlacement, workspacePinTailKey]);

  const defaultWorkspaceBlockY = useCallback((pageNumber: number, fallback: number): number => {
    const container = containerRef.current;
    const page = viewerRef.current?.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
    if (!container || !page) {
      return fallback;
    }

    const canvas = container.querySelector<HTMLElement>('.pdf-canvas');
    const pageBounds = canvas ? elementBoundsInCanvas(page, canvas) : undefined;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const pageTop = pageBounds?.top ?? page.offsetTop;
    const pageHeight = pageBounds?.height ?? page.offsetHeight;
    const pageBottom = pageTop + pageHeight;
    const pageVisible = pageBottom > viewportTop && pageTop < viewportBottom;
    if (!pageVisible) {
      return Math.round(clamp(Math.max(fallback, 220), 24, Math.max(24, pageHeight - 160)));
    }

    const viewportOffset = Math.max(72, Math.min(container.clientHeight * 0.28, 180));
    const pageRelativeY = container.scrollTop - pageTop + viewportOffset;
    return Math.round(clamp(pageRelativeY, 24, Math.max(24, pageHeight - 160)));
  }, []);

  const updateWorkspaceBlockLayouts = useCallback((): void => {
    const viewer = viewerRef.current;
    const canvas = containerRef.current?.querySelector<HTMLElement>('.pdf-canvas');
    if (!viewer || !canvas) {
      setWorkspaceBlockLayouts({});
      return;
    }

    const pageScale = currentWorkspacePageScale();
    const nextLayouts: Record<string, WorkspaceBlockLayout> = {};
    for (const block of workspaceBlocksRef.current) {
      if (block.anchor !== 'page' || !block.pageNumber) {
        continue;
      }

      const page = viewer.querySelector<HTMLElement>(`.page[data-page-number="${block.pageNumber}"]`);
      if (!page) {
        continue;
      }

      const pageBounds = elementBoundsInCanvas(page, canvas);
      const coordinateScale = workspaceBlockCoordinateScale(
        block,
        pageScale,
        workspaceBlockCoordinateScalesRef.current[block.id]
      );
      workspaceBlockCoordinateScalesRef.current[block.id] = coordinateScale;
      const renderedY = renderedWorkspaceBlockY(block, pageScale, coordinateScale);
      nextLayouts[block.id] = {
        left: block.x < 0 ? pageBounds.left + block.x : pageBounds.left + pageBounds.width + block.x,
        pageScale,
        pageTop: pageBounds.top,
        renderedY,
        top: pageBounds.top + renderedY
      };
    }

    setWorkspaceBlockLayouts(nextLayouts);
  }, [currentWorkspacePageScale]);

  const currentWorkspacePageNumber = useCallback((): number => {
    const runtimePage = runtimeRef.current?.pdfViewer.currentPageNumber;
    if (runtimePage && Number.isInteger(runtimePage)) {
      return runtimePage;
    }

    return activePage;
  }, [activePage]);

  const revealWorkspaceBlock = useCallback((blockId: string): void => {
    const container = containerRef.current;
    const canvas = container?.querySelector<HTMLElement>('.pdf-canvas');
    const block = container?.querySelector<HTMLElement>(`.workspace-block-card[data-block-id="${blockId}"]`);
    if (!container || !canvas || !block) {
      return;
    }

    const viewportRect = container.getBoundingClientRect();
    const dockRect = container.querySelector<HTMLElement>('.reader-dock-lane')?.getBoundingClientRect();
    const availableRight = dockRect && dockRect.left < viewportRect.right ? dockRect.left : viewportRect.right;
    const availableWidth = Math.max(220, availableRight - viewportRect.left);
    const targetInset = Math.max(36, Math.min(96, (availableWidth - block.offsetWidth) / 2));
    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    const targetScrollLeft = Math.max(0, block.offsetLeft - targetInset);
    if (targetScrollLeft > maxScrollLeft) {
      const currentPaddingRight = Number.parseFloat(window.getComputedStyle(canvas).paddingRight) || 0;
      canvas.style.paddingRight = `${Math.ceil(currentPaddingRight + targetScrollLeft - maxScrollLeft + 48)}px`;
    }

    container.scrollLeft = targetScrollLeft;
    const blockTop = block.offsetTop;
    const blockBottom = blockTop + block.offsetHeight;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const blockVisibleVertically = blockBottom > viewportTop + 24 && blockTop < viewportBottom - 24;
    const preservedScrollTop = pendingRevealScrollTopRef.current;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (!blockVisibleVertically) {
      const targetTopInset = Math.max(72, Math.min(container.clientHeight * 0.24, 180));
      const targetScrollTop = Math.max(0, blockTop - targetTopInset);
      container.scrollTop = Math.min(maxScrollTop, Math.max(targetScrollTop, preservedScrollTop ?? 0));
    } else if (preservedScrollTop !== undefined) {
      container.scrollTop = Math.min(maxScrollTop, Math.max(container.scrollTop, preservedScrollTop));
    }
  }, []);

  const visibleWorkspaceBlockId = useCallback((pageNumber: number): string | undefined => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const viewportRect = container.getBoundingClientRect();
    const blocks = Array.from(
      container.querySelectorAll<HTMLElement>(`.workspace-block-card[data-page-number="${pageNumber}"]`)
    );

    let bestBlock: { id: string; area: number } | undefined;
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, viewportRect.right) - Math.max(rect.left, viewportRect.left));
      const height = Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top));
      const area = width * height;
      const id = block.dataset.blockId;
      if (id && area > 0 && (!bestBlock || area > bestBlock.area)) {
        bestBlock = { id, area };
      }
    }

    return bestBlock?.id;
  }, []);

  useEffect(() => {
    if (!pendingRevealBlockId || !workspaceBlockLayouts[pendingRevealBlockId]) {
      return;
    }

    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      revealWorkspaceBlock(pendingRevealBlockId);
      secondFrame = window.requestAnimationFrame(() => {
        revealWorkspaceBlock(pendingRevealBlockId);
        pendingRevealScrollTopRef.current = undefined;
        setPendingRevealBlockId(undefined);
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [pendingRevealBlockId, revealWorkspaceBlock, workspaceBlockLayouts]);

  const pinConversationToCanvas = useCallback((conversation: Conversation): void => {
    if (!meta) {
      return;
    }

    const now = new Date().toISOString();
    const pageNumber = currentWorkspacePageNumber();
    const layoutScale = currentWorkspacePageScale();
    const existing = workspaceBlocksForPlacement().find((block) => block.kind === 'conversation' && block.sourceId === conversation.id);
    const width = existing?.width ?? defaultWorkspaceBlockWidth('conversation');
    const position = avoidWorkspaceBlockOverlap(
      pageNumber,
      defaultWorkspaceBlockX(width),
      defaultWorkspaceBlockY(pageNumber, 220),
      width,
      existing?.id
    );
    const block: WorkspaceBlock = {
      id: existing?.id ?? createId('block'),
      documentId: meta.id,
      kind: 'conversation',
      anchor: 'page',
      sourceId: conversation.id,
      sourceKind: 'conversation',
      contentKind: 'markdown',
      pageNumber,
      title: conversation.summary.title,
      body: conversation.summary.brief || compactPreview(conversation.messages.at(-1)?.content ?? ''),
      payload: workspaceBlockPayloadWithLayoutScale(existing?.payload, layoutScale),
      x: position.x,
      y: position.y,
      width,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    optimisticWorkspaceBlocksRef.current = [
      block,
      ...optimisticWorkspaceBlocksRef.current.filter((candidate) => candidate.id !== block.id)
    ];
    rememberWorkspacePinTail(pageNumber, block.x, block.y, block.height);
    setOptimisticWorkspaceBlocks((current) => [
      block,
      ...current.filter((candidate) => candidate.id !== block.id)
    ]);
    workspaceBlocksRef.current = [block, ...workspaceBlocksRef.current.filter((candidate) => candidate.id !== block.id)];
    onSaveWorkspaceBlock(block);
    pendingRevealScrollTopRef.current = containerRef.current?.scrollTop;
    setPendingRevealBlockId(block.id);
  }, [
    avoidWorkspaceBlockOverlap,
    currentWorkspacePageNumber,
    currentWorkspacePageScale,
    defaultWorkspaceBlockX,
    defaultWorkspaceBlockY,
    meta,
    onSaveWorkspaceBlock,
    rememberWorkspacePinTail,
    workspaceBlocksForPlacement
  ]);

  const pinNoteToCanvas = useCallback((note: NoteDocument): void => {
    if (!meta) {
      return;
    }

    void (async () => {
      const now = new Date().toISOString();
      const pageNumber = currentWorkspacePageNumber();
      const layoutScale = currentWorkspacePageScale();
      const existing = workspaceBlocksForPlacement().find((block) => block.kind === 'note' && block.sourceId === note.id);
      const width = existing?.width ?? defaultWorkspaceBlockWidth('note');
      const position = avoidWorkspaceBlockOverlap(
        pageNumber,
        defaultWorkspaceBlockX(width),
        defaultWorkspaceBlockY(pageNumber, 260),
        width,
        existing?.id
      );
      const block: WorkspaceBlock = {
        id: existing?.id ?? createId('block'),
        documentId: meta.id,
        kind: 'note',
        anchor: 'page',
        sourceId: note.id,
        sourceKind: 'note',
        contentKind: 'markdown',
        pageNumber,
        title: note.title,
        body: compactPreview(note.markdown),
        payload: workspaceBlockPayloadWithLayoutScale(existing?.payload, layoutScale),
        x: position.x,
        y: position.y,
        width,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };

      optimisticWorkspaceBlocksRef.current = [
        block,
        ...optimisticWorkspaceBlocksRef.current.filter((candidate) => candidate.id !== block.id)
      ];
      rememberWorkspacePinTail(pageNumber, block.x, block.y, block.height);
      setOptimisticWorkspaceBlocks((current) => [
        block,
        ...current.filter((candidate) => candidate.id !== block.id)
      ]);
      workspaceBlocksRef.current = [block, ...workspaceBlocksRef.current.filter((candidate) => candidate.id !== block.id)];
      pendingRevealScrollTopRef.current = containerRef.current?.scrollTop;
      setPendingRevealBlockId(block.id);
      await onSaveNote(note);
      await onSaveWorkspaceBlock(block);
    })();
  }, [
    avoidWorkspaceBlockOverlap,
    currentWorkspacePageNumber,
    currentWorkspacePageScale,
    defaultWorkspaceBlockX,
    defaultWorkspaceBlockY,
    meta,
    onSaveNote,
    onSaveWorkspaceBlock,
    rememberWorkspacePinTail,
    workspaceBlocksForPlacement
  ]);

  const pinImageToCanvas = useCallback((attachment: ConversationAttachment, conversation?: Conversation): void => {
    if (!meta || attachment.kind !== 'image') {
      return;
    }

    const now = new Date().toISOString();
    const pageNumber = currentWorkspacePageNumber();
    const layoutScale = currentWorkspacePageScale();
    const sourceId = `${conversation?.id ?? 'draft'}:${attachment.id}`;
    const existing = workspaceBlocksForPlacement().find((block) => block.kind === 'image' && block.sourceId === sourceId);
    const width = existing?.width ?? defaultWorkspaceBlockWidth('image');
    const height = existing?.height ?? 240;
    const position = avoidWorkspaceBlockOverlap(
      pageNumber,
      defaultWorkspaceBlockX(width),
      defaultWorkspaceBlockY(pageNumber, 320),
      width,
      existing?.id
    );
    const block: WorkspaceBlock = {
      id: existing?.id ?? createId('block'),
      documentId: meta.id,
      kind: 'image',
      anchor: 'page',
      sourceId,
      sourceKind: conversation ? 'conversation' : 'manual',
      contentKind: 'image',
      pageNumber,
      title: attachment.name || 'Image',
      body: conversation?.summary.title,
      payload: {
        attachmentId: attachment.id,
        conversationId: conversation?.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: attachment.dataUrl,
        layoutScale
      },
      x: position.x,
      y: position.y,
      width,
      height,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    optimisticWorkspaceBlocksRef.current = [
      block,
      ...optimisticWorkspaceBlocksRef.current.filter((candidate) => candidate.id !== block.id)
    ];
    rememberWorkspacePinTail(pageNumber, block.x, block.y, block.height);
    setOptimisticWorkspaceBlocks((current) => [
      block,
      ...current.filter((candidate) => candidate.id !== block.id)
    ]);
    workspaceBlocksRef.current = [block, ...workspaceBlocksRef.current.filter((candidate) => candidate.id !== block.id)];
    onSaveWorkspaceBlock(block);
    pendingRevealScrollTopRef.current = containerRef.current?.scrollTop;
    setPendingRevealBlockId(block.id);
  }, [
    avoidWorkspaceBlockOverlap,
    currentWorkspacePageNumber,
    currentWorkspacePageScale,
    defaultWorkspaceBlockX,
    defaultWorkspaceBlockY,
    meta,
    onSaveWorkspaceBlock,
    rememberWorkspacePinTail,
    workspaceBlocksForPlacement
  ]);

  const pinImageFilesToCanvas = useCallback((files: FileList | File[] | null): void => {
    void imageFilesToAttachments(files)
      .then((attachments) => {
        for (const attachment of attachments) {
          pinImageToCanvas(attachment);
        }
      })
      .catch((error: unknown) => {
        console.error('Could not pin pasted image.', error);
      });
  }, [pinImageToCanvas]);

  useEffect(() => {
    if (!pageDraftFocused) {
      setPageDraft(String(activePage));
    }
  }, [activePage, pageDraftFocused]);

  useEffect(() => {
    if (!meta) {
      return undefined;
    }

    const handlePaste = (event: ClipboardEvent): void => {
      if (
        !event.clipboardData ||
        !hasImageFiles(event.clipboardData) ||
        shouldIgnoreImagePinPaste(event.target)
      ) {
        return;
      }

      event.preventDefault();
      pinImageFilesToCanvas(event.clipboardData.files);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [meta, pinImageFilesToCanvas]);

  useEffect(() => {
    if (chatPanelOpen) {
      setDockTab('chat');
    }
  }, [activeConversation?.id, chatPanelOpen]);

  useEffect(() => {
    renderMarks();
  }, [marks, renderMarks, resolvedSelectionColors, scale, totalPages]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateWorkspaceBlockLayouts);
    return () => window.cancelAnimationFrame(frame);
  }, [scale, status, totalPages, updateWorkspaceBlockLayouts, effectiveWorkspaceBlocks]);

  useEffect(() => {
    window.addEventListener('resize', updateWorkspaceBlockLayouts);
    return () => window.removeEventListener('resize', updateWorkspaceBlockLayouts);
  }, [updateWorkspaceBlockLayouts]);

  const alignDockRight = useCallback((): void => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    window.requestAnimationFrame(() => {
      const dock = container.querySelector<HTMLElement>('.reader-dock-lane');
      if (!dock) {
        return;
      }

      const viewportRect = container.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      const delta = dockRect.right - viewportRect.right;
      if (Math.abs(delta) > 1) {
        container.scrollLeft += delta;
      }
    });
  }, []);

  useEffect(() => {
    if (!source || !hasOpenDock) {
      return;
    }

    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      alignDockRight();
      secondFrame = window.requestAnimationFrame(alignDockRight);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [activeConversationId, alignDockRight, dockTab, hasOpenDock, noteEditorNote?.id, scale, source, transientAid?.id]);

  useEffect(() => {
    if (leftPanelOpen || hasOpenDock || status !== 'ready') {
      return;
    }

    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollLeft = 0;
      }
      secondFrame = window.requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollLeft = 0;
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [hasOpenDock, leftPanelOpen, source?.documentId, status]);

  const beginZoomPageLock = useCallback((pageNumber: number, enforceScroll = false): number => {
    const normalizedPage = Math.max(1, Math.floor(pageNumber));
    const version = zoomLockVersionRef.current + 1;
    zoomLockVersionRef.current = version;

    if (zoomPageLockRef.current?.releaseTimer) {
      window.clearTimeout(zoomPageLockRef.current.releaseTimer);
    }

    zoomPageLockRef.current = {
      enforceScroll,
      pageNumber: normalizedPage,
      releaseTimer: window.setTimeout(() => {
        if (zoomPageLockRef.current?.version === version) {
          zoomPageLockRef.current = undefined;
        }
      }, enforceScroll ? 700 : 900),
      version
    };
    setPageDraft(String(normalizedPage));
    return version;
  }, []);

  const clearZoomPageLock = useCallback((): void => {
    if (zoomPageLockRef.current?.releaseTimer) {
      window.clearTimeout(zoomPageLockRef.current.releaseTimer);
    }
    zoomPageLockRef.current = undefined;
  }, []);

  const updatePageDraft = useCallback((value: string): void => {
    clearZoomPageLock();
    setPageDraftFocused(true);
    setPageDraft(value);
  }, [clearZoomPageLock]);

  const focusPageDraft = useCallback((): void => {
    clearZoomPageLock();
    setPageDraftFocused(true);
  }, [clearZoomPageLock]);

  const blurPageDraft = useCallback((): void => {
    setPageDraftFocused(false);
    setPageDraft(String(activePageRef.current));
  }, []);

  const notePdfReadingIntent = useCallback((target: EventTarget | null): void => {
    if (!busy || shouldIgnoreCanvasFocus(target)) {
      return;
    }

    const now = window.performance.now();
    if (now - lastPdfReadingIntentRef.current < 250) {
      return;
    }

    lastPdfReadingIntentRef.current = now;
    setPdfReadingSignal((current) => current + 1);
  }, [busy]);

  const finishZoomPageLock = useCallback((version: number, pageNumber: number): void => {
    const normalizedPage = Math.max(1, Math.floor(pageNumber));
    const lock = zoomPageLockRef.current;
    if (!lock || lock.version !== version) {
      return;
    }

    setPageDraft(String(normalizedPage));
    if (activePageRef.current !== normalizedPage) {
      onPageChangeRef.current(normalizedPage);
    }

    if (lock.releaseTimer) {
      window.clearTimeout(lock.releaseTimer);
    }
    lock.releaseTimer = window.setTimeout(() => {
      if (zoomPageLockRef.current?.version === version) {
        zoomPageLockRef.current = undefined;
      }
    }, 350);
  }, []);

  const applyZoomAtAnchor = useCallback((anchor: ZoomAnchor, nextScale: number): void => {
    const runtime = runtimeRef.current;
    const container = containerRef.current;
    if (!runtime || !container || status !== 'ready') {
      return;
    }

    const currentScale = runtime.pdfViewer.currentScale;
    const clampedScale = clamp(nextScale, 0.25, 5);
    if (Math.abs(clampedScale - currentScale) < 0.001) {
      return;
    }

    const lockedPage = Number(anchor.pageNumber) || runtime.pdfViewer.currentPageNumber || activePageRef.current;
    const blockToKeepVisible = visibleWorkspaceBlockId(lockedPage);
    const lockVersion = beginZoomPageLock(lockedPage);
    const scaleRatio = clampedScale / currentScale;
    prepareZoomScrollSpace(container, anchor, scaleRatio);
    runtime.pdfViewer.currentScale = clampedScale;
    restoreZoomAnchor(container, anchor, scaleRatio, () => {
      finishZoomPageLock(lockVersion, lockedPage);
      if (blockToKeepVisible) {
        updateWorkspaceBlockLayouts();
        window.requestAnimationFrame(() => {
          updateWorkspaceBlockLayouts();
          window.requestAnimationFrame(() => revealWorkspaceBlock(blockToKeepVisible));
        });
      }
    });
  }, [
    beginZoomPageLock,
    finishZoomPageLock,
    revealWorkspaceBlock,
    status,
    updateWorkspaceBlockLayouts,
    visibleWorkspaceBlockId
  ]);

  const zoomViewport = useCallback((direction: 'in' | 'out'): void => {
    const runtime = runtimeRef.current;
    const container = containerRef.current;
    if (!runtime || !container || status !== 'ready') {
      return;
    }

    const anchor = readViewportZoomAnchor(container, runtime);
    const factor = direction === 'in' ? 1.1 : 1 / 1.1;
    applyZoomAtAnchor(anchor, runtime.pdfViewer.currentScale * factor);
  }, [applyZoomAtAnchor, status]);

  const handleViewerWheel = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    const runtime = runtimeRef.current;
    const container = containerRef.current;
    if (!runtime || !container || status !== 'ready') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const currentScale = runtime.pdfViewer.currentScale;
    const zoomSteps = Math.min(4, Math.max(1, Math.abs(event.deltaY) / 100));
    const zoomFactor = Math.pow(1.1, event.deltaY < 0 ? zoomSteps : -zoomSteps);
    const nextScale = clamp(currentScale * zoomFactor, 0.25, 5);
    if (Math.abs(nextScale - currentScale) < 0.001) {
      return;
    }

    const anchor = readZoomAnchor(container, event.clientX, event.clientY);
    if (!anchor.pageNumber) {
      return;
    }
    applyZoomAtAnchor(anchor, nextScale);
  }, [applyZoomAtAnchor, status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener('wheel', handleViewerWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleViewerWheel);
  }, [handleViewerWheel, source]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (
      !runtime ||
      status !== 'ready' ||
      activePage < 1 ||
      activePage > runtime.pdfViewer.pagesCount ||
      runtime.pdfViewer.currentPageNumber === activePage
    ) {
      return;
    }

    runtime.pdfViewer.currentPageNumber = activePage;
  }, [activePage, status]);

  useEffect(() => {
    if (!source || !containerRef.current || !viewerRef.current) {
      runtimeRef.current = undefined;
      setStatus('idle');
      setLoadProgress(0);
      setTotalPages(0);
      setOutline([]);
      workspaceBlockCoordinateScalesRef.current = {};
      return;
    }

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      ignoreDestinationZoom: true
    });
    const findController = new PDFFindController({ eventBus, linkService });
    const pdfViewer = new PDFViewer({
      container: containerRef.current,
      viewer: viewerRef.current,
      eventBus,
      linkService,
      findController,
      removePageBorders: true,
      maxCanvasPixels: 4096 * 4096
    });

    linkService.setViewer(pdfViewer);
    pdfViewer.scrollMode = ScrollMode.VERTICAL;
    runtimeRef.current = undefined;
    setStatus('loading');
    setLoadError(undefined);
    setLoadProgress(0);
    setTotalPages(0);
    setOutline([]);
    setOutlineBusy(false);
    setSelectionPopover(undefined);
    setActiveMark(undefined);
    workspaceBlockCoordinateScalesRef.current = {};
    viewerRef.current.textContent = '';
    viewerRef.current.style.minWidth = '';
    containerRef.current?.querySelector<HTMLElement>('.pdf-canvas')?.style.removeProperty('padding-right');

    eventBus.on('pagesinit', () => {
      if (cancelled) {
        return;
      }

      pdfViewer.currentScaleValue = 'page-width';
      const initialPageNumber = Math.max(1, activePage);
      window.requestAnimationFrame(() => {
        if (!cancelled && initialPageNumber <= pdfViewer.pagesCount) {
          pdfViewer.currentPageNumber = initialPageNumber;
        }
        renderMarks();
      });
    });

    eventBus.on('pagechanging', (event: { pageNumber: number }) => {
      if (cancelled) {
        return;
      }

      const pageNumber = Number(event.pageNumber);
      const zoomLock = zoomPageLockRef.current;
      if (zoomLock) {
        setPageDraft(String(zoomLock.pageNumber));
        if (zoomLock.enforceScroll) {
          window.requestAnimationFrame(() => {
            if (cancelled || zoomPageLockRef.current?.version !== zoomLock.version) {
              return;
            }

            if (zoomLock.pageNumber <= pdfViewer.pagesCount && pdfViewer.currentPageNumber !== zoomLock.pageNumber) {
              pdfViewer.currentPageNumber = zoomLock.pageNumber;
              pdfViewer.scrollPageIntoView({ pageNumber: zoomLock.pageNumber });
            }
          });
        }
        return;
      }

      setPageDraft(String(pageNumber));
      onPageChangeRef.current(pageNumber);
    });

    eventBus.on('scalechanging', (event: { scale: number }) => {
      if (cancelled) {
        return;
      }

      setScale(event.scale);
      window.requestAnimationFrame(renderMarks);
      window.requestAnimationFrame(updateWorkspaceBlockLayouts);
    });

    eventBus.on('pagerendered', () => {
      renderMarks();
      updateWorkspaceBlockLayouts();
    });
    eventBus.on('pagesloaded', () => {
      renderMarks();
      updateWorkspaceBlockLayouts();
    });

    loadingTask = pdfjsLib.getDocument(createPdfDocumentParams(source)) as PDFDocumentLoadingTask;
    loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (!cancelled && total > 0) {
        setLoadProgress(Math.min(100, (loaded / total) * 100));
      }
    };

    void loadingTask.promise
      .then(async (pdfDocument) => {
        if (cancelled) {
          await pdfDocument.destroy();
          return;
        }

        const runtime: PdfRuntime = {
          eventBus,
          findController,
          linkService,
          pdfDocument,
          pdfViewer
        };
        runtimeRef.current = runtime;
        setTotalPages(pdfDocument.numPages);

        pdfViewer.setDocument(pdfDocument);
        linkService.setDocument(pdfDocument);
        findController.setDocument(pdfDocument);

        setOutlineBusy(true);
        void loadPdfOutline(pdfDocument)
          .then((items) => {
            if (!cancelled) {
              setOutline(items);
            }
          })
          .catch((error: unknown) => {
            console.warn('PDF outline could not be read', error);
          })
          .finally(() => {
            if (!cancelled) {
              setOutlineBusy(false);
            }
          });
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
      runtimeRef.current = undefined;
      setOutlineBusy(false);
      loadingTask?.destroy().catch(() => undefined);
      pdfViewer.cleanup();
    };
  }, [renderMarks, source]);

  const jumpToPage = useCallback((pageNumber: number): void => {
    const runtime = runtimeRef.current;
    if (!runtime || pageNumber < 1 || pageNumber > runtime.pdfViewer.pagesCount) {
      return;
    }

    const lockVersion = beginZoomPageLock(pageNumber, true);
    activePageRef.current = pageNumber;
    onPageChangeRef.current(pageNumber);
    runtime.pdfViewer.currentPageNumber = pageNumber;
    runtime.pdfViewer.scrollPageIntoView({ pageNumber });
    window.requestAnimationFrame(() => {
      if (zoomPageLockRef.current?.version === lockVersion) {
        runtime.pdfViewer.currentPageNumber = pageNumber;
        runtime.pdfViewer.scrollPageIntoView({ pageNumber });
      }
    });
  }, [beginZoomPageLock]);

  const executeSearch = useCallback((again = false, previous = false): void => {
    const runtime = runtimeRef.current;
    const query = searchQuery.trim();
    if (!runtime || !query) {
      return;
    }

    runtime.eventBus.dispatch('find', {
      source: runtime.findController,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: true
    });
  }, [searchQuery]);

  const submitPageJump = (event: FormEvent): void => {
    event.preventDefault();
    setPageDraftFocused(false);
    const form = event.currentTarget as HTMLFormElement;
    const inputValue = form.querySelector<HTMLInputElement>('input')?.value ?? pageDraft;
    const pageNumber = Number(inputValue);
    if (Number.isInteger(pageNumber)) {
      jumpToPage(pageNumber);
    }
  };

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault();
    executeSearch(false);
  };

  const startDockResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-dock');

	    const startX = event.clientX;
	    const startWidth = resolvedDockWidth;
	    const minWidth = noteEditorNote ? 640 : 320;
	    const maxWidth = Math.min(noteEditorNote ? 1040 : 760, Math.max(minWidth, window.innerWidth - 180));
	    let edgeScrollDelta = 0;
    let lastClientX = startX;

    const handlePointerMove = (moveEvent: PointerEvent): void => {
      const container = containerRef.current;
      if (container) {
        const viewportRect = container.getBoundingClientRect();
        const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
        const canUseRightBuffer = moveEvent.clientX >= viewportRect.right - 10 && moveEvent.clientX >= lastClientX;
        if (canUseRightBuffer && container.scrollLeft < maxScrollLeft) {
          const scrollDelta = Math.min(48, maxScrollLeft - container.scrollLeft);
          container.scrollLeft += scrollDelta;
          edgeScrollDelta += scrollDelta;
        }
      }

	      const nextWidth = clamp(startWidth + moveEvent.clientX - startX + edgeScrollDelta, minWidth, maxWidth);
	      setDockWidth(nextWidth);
      lastClientX = moveEvent.clientX;
    };

    const stopResize = (): void => {
      document.body.classList.remove('is-resizing-dock');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize, { once: true });
    window.addEventListener('pointercancel', stopResize, { once: true });
	  }, [noteEditorNote, resolvedDockWidth]);

  const buildDocumentToolContext = useCallback((input: {
    conversation?: Conversation;
    pageStart?: number;
    pageEnd?: number;
    pdfText?: string;
    selectedText?: string;
  } = {}): AiDocumentToolContext | undefined => {
    if (!meta) {
      return undefined;
    }

    const anchorPage = input.conversation?.anchor?.pageNumber ?? input.conversation?.pageNumber;
    const pageStart = Math.max(1, Math.floor(input.pageStart ?? anchorPage ?? activePage));
    const pageEnd = Math.max(pageStart, Math.floor(input.pageEnd ?? pageStart));
    return {
      documentId: meta.id,
      documentTitle: meta.title,
      fileName: source?.fileName ?? meta.fileName,
      currentPage: activePage,
      totalPages,
      pageStart,
      pageEnd,
      selectedText: input.selectedText ?? input.conversation?.anchor?.quote,
      pdfText: input.pdfText,
      outline: displayOutline.map((item) => ({
        title: item.title,
        level: item.level,
        pageNumber: item.pageNumber
      }))
    };
  }, [activePage, displayOutline, meta, source?.fileName, totalPages]);

  const generateNoteForRange = useCallback(async (pageStart: number, pageEnd: number): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const pageText = await extractPdfTextForRange(runtime.pdfDocument, pageStart, pageEnd);
    onGenerateNote(pageStart, pageEnd, pageText, buildDocumentToolContext({ pageStart, pageEnd, pdfText: pageText }));
  }, [buildDocumentToolContext, onGenerateNote]);

  const handleSelectionMouseUp = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.selection-toolbar, .mark-popover, .reader-float-dock')) {
      return;
    }

    window.setTimeout(() => {
      const selection = selectionFromWindow(viewerRef.current);
      const stage = stageRef.current;
      if (!selection || !stage) {
        setSelectionPopover(undefined);
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      setSelectionPopover({
        selection,
        left: Math.max(12, Math.min(event.clientX - stageRect.left, stageRect.width - 560)),
        top: Math.max(12, Math.min(event.clientY - stageRect.top + 12, stageRect.height - 120))
      });
      setActiveMark(undefined);
    }, 0);
  }, []);

  return (
    <section className="reader">
      <Splitter
        className={leftPanelOpen ? 'reader-splitter' : 'reader-splitter is-left-collapsed'}
        gutterSize={7}
        stateKey="sidelight-reader-main-layout-v2"
        stateStorage="local"
      >
        <SplitterPanel className="reader-left-panel" size={20} minSize={16}>
          <ReaderLeftPanel
            activeDocument={meta}
            activeDocumentId={meta?.id}
            activePage={activePage}
            documents={documents}
            groups={libraryGroups}
            leftTab={leftTab}
            loadProgress={loadProgress}
            outline={displayOutline}
            outlineBusy={outlineBusy}
            outlineGenerationBusy={outlineGenerationBusy}
            outlineGenerationError={outlineGenerationError}
            outlineIsGenerated={outlineIsGenerated}
            pageDraft={pageDraft}
            scale={scale}
            searchQuery={searchQuery}
            status={status}
            text={t}
            title={meta?.title}
            totalPages={totalPages}
            onAddBookmark={() => onAddBookmark(activePage)}
            onAddToLibrary={onAddToLibrary}
            onFindNext={() => executeSearch(true)}
            onFindPrevious={() => executeSearch(true, true)}
            onFitWidth={() => {
              if (runtimeRef.current) {
                runtimeRef.current.pdfViewer.currentScaleValue = 'page-width';
              }
            }}
            onJumpToDestination={(dest) => {
              void runtimeRef.current?.linkService.goToDestination(dest as string | unknown[]);
            }}
            onJumpToPage={jumpToPage}
            onGenerateOutline={() => onGenerateOutline(buildDocumentToolContext())}
            onCollapse={() => setLeftPanelOpen(false)}
            onLoadDocument={onLoadDocument}
            onOpenPdf={onOpenPdf}
            onOpenSettings={onOpenSettings}
            onPageDraftBlur={blurPageDraft}
            onPageDraftChange={updatePageDraft}
            onPageDraftFocus={focusPageDraft}
            onSearchQueryChange={setSearchQuery}
            onSubmitPageJump={submitPageJump}
            onSubmitSearch={submitSearch}
            onTabChange={setLeftTab}
            onZoomIn={() => zoomViewport('in')}
            onZoomOut={() => zoomViewport('out')}
          />
        </SplitterPanel>

        <SplitterPanel className="reader-document-panel" size={80} minSize={56}>
          <div
            className={hasOpenDock ? 'pdf-stage has-open-dock' : 'pdf-stage has-float-dock'}
            ref={stageRef}
            style={stageStyle}
          >
            {!leftPanelOpen && (
              <Button
                type="button"
                text
                rounded
                className="left-panel-reopen"
                title={t.showSidebar}
                aria-label={t.showSidebar}
                onClick={() => setLeftPanelOpen(true)}
              >
                <ChevronsRight size={17} />
              </Button>
            )}

            {meta && source ? (
              <>
                <div
                  className="pdf-viewport"
                  ref={containerRef}
                  onMouseUp={handleSelectionMouseUp}
                  onWheel={(event) => notePdfReadingIntent(event.target)}
                  onPointerDown={(event) => {
                    notePdfReadingIntent(event.target);
                    if (!shouldIgnoreCanvasFocus(event.target)) {
                      event.currentTarget.focus({ preventScroll: true });
                    }
                  }}
                  tabIndex={0}
                >
                  <div className="pdf-canvas">
                    <div className="pdfViewer" ref={viewerRef} />
                    <WorkspaceBlockLayer
                      blocks={effectiveWorkspaceBlocks}
                      layouts={workspaceBlockLayouts}
                      text={t}
                      onDelete={onDeleteWorkspaceBlock}
                      onOpenConversation={openDockConversation}
                      onOpenNote={openDockNoteById}
                      onSave={onSaveWorkspaceBlock}
                    />

                    <div className="reader-dock-lane">
                      <ReaderDock
                        activeConversation={activeConversation}
                        activeConversationId={activeConversationId}
                        activePage={activePage}
                        bookmarks={bookmarks}
                        busy={busy}
                        canStopGeneration={canStopGeneration}
                        chatOpen={chatOpen}
                        conversations={visibleConversations}
                        allConversations={conversations}
                        marks={pageMarks}
                        notes={visibleNotes}
                        allNotes={notes}
                        noteEditorNote={noteEditorNote}
                        noteBusy={noteBusy}
                        pdfReadingSignal={pdfReadingSignal}
                        text={t}
                        pageConversationCount={pageConversationCount}
                        activeTab={activeDockTab}
                        tab={dockTab}
                        transientAid={transientAid}
                        onAddBookmark={() => onAddBookmark(activePage)}
                        onCloseConversation={onCloseConversation}
                        onCloseTransientAid={onCloseTransientAid}
                        onCloseNote={closeDockNote}
                        onCreatePageChat={() => createDockPageChat(activePage)}
                        onCreateNote={() => createDockNote()}
                        onDeleteBookmark={onDeleteBookmark}
                        onDeleteMark={onDeleteMark}
                        onDeleteNote={deleteDockNote}
                        onJumpToPage={jumpToPage}
                        onOpenConversation={openDockConversation}
                        onOpenNote={openDockNote}
                        onNoteDraftChange={setNoteEditorNote}
                        onGenerateNote={generateNoteForRange}
                        onSendMessage={(conversationId, prompt, attachments) => {
                          const conversation = conversations.find((candidate) => candidate.id === conversationId);
                          onSendMessage(
                            conversationId,
                            prompt,
                            attachments,
                            buildDocumentToolContext({ conversation })
                          );
                        }}
                        onStopGeneration={onStopGeneration}
                        onPinConversation={pinConversationToCanvas}
                        onPinImage={pinImageToCanvas}
                        onPinNote={pinNoteToCanvas}
                        onTabChange={switchDockTab}
                      />
                      <button
                        type="button"
                        className="dock-resize-handle"
                        aria-label={t.resizeSidePanel}
                        title={t.resizeSidePanel}
                        onPointerDown={startDockResize}
                      />
                    </div>
                    <div className="workspace-canvas-spacer" aria-hidden="true" style={{ flexBasis: workspaceCanvasTail }} />
                  </div>

                  {status !== 'ready' && (
                    <PdfState
                      status={status}
                      progress={loadProgress}
                      error={loadError}
                      text={t}
                    />
                  )}
                </div>

                {selectionPopover && (
                  <SelectionToolbar
                    popover={selectionPopover}
                    text={t}
                    onCreateMark={(kind, selection, colorRole) => {
                      onCreateMark(kind, selection, colorRole);
                      clearSelection();
                      setSelectionPopover(undefined);
                    }}
                    onSelectionAction={(mode, selection) => {
                      onSelectionAction(mode, selection);
                      clearSelection();
                      setSelectionPopover(undefined);
                    }}
                    onCreateNote={(selection) => {
                      createDockNote(selection);
                      clearSelection();
                      setSelectionPopover(undefined);
                    }}
                    onClose={() => {
                      clearSelection();
                      setSelectionPopover(undefined);
                    }}
                  />
                )}

                {activeMark && (
                  <MarkPopover
                    mark={marks.find((mark) => mark.id === activeMark.markId)}
                    left={activeMark.left}
                    top={activeMark.top}
                    text={t}
                    onClose={() => setActiveMark(undefined)}
                    onDelete={(markId) => {
                      onDeleteMark(markId);
                      setActiveMark(undefined);
                    }}
                    onSelectionAction={(mode, mark) => {
                      onSelectionAction(mode, selectionFromMark(mark));
                      setActiveMark(undefined);
                    }}
                    onCreateNote={(mark) => {
                      createDockNote(selectionFromMark(mark));
                      setActiveMark(undefined);
                    }}
                  />
                )}
              </>
            ) : (
              <section className="reader-empty reader-empty--embedded">
                <div className="reader-empty__mark">
                  <FileText size={42} strokeWidth={1.5} />
                </div>
                <h1>Sidelight</h1>
                <p>{uiLanguage === 'zh-CN'
                  ? '打开 PDF，开始使用持久高亮、书签和锚定 AI 对话阅读。'
                  : 'Open a PDF to start reading with durable highlights, bookmarks, and anchored AI conversations.'}</p>
                <button className="primary-button" type="button" onClick={onOpenPdf}>
                  {t.openPdf}
                </button>
              </section>
            )}
          </div>
        </SplitterPanel>
      </Splitter>
    </section>
  );
}

function ReaderLeftPanel({
  activeDocument,
  activeDocumentId,
  activePage,
  documents,
  groups,
  leftTab,
  loadProgress,
  outline,
  outlineBusy,
  outlineGenerationBusy,
  outlineGenerationError,
  outlineIsGenerated,
  pageDraft,
  scale,
  searchQuery,
  status,
  text,
  title,
  totalPages,
  onAddBookmark,
  onAddToLibrary,
  onFindNext,
  onFindPrevious,
  onFitWidth,
  onJumpToDestination,
  onJumpToPage,
  onGenerateOutline,
  onCollapse,
  onLoadDocument,
  onOpenPdf,
  onOpenSettings,
  onPageDraftBlur,
  onPageDraftChange,
  onPageDraftFocus,
  onSearchQueryChange,
  onSubmitPageJump,
  onSubmitSearch,
  onTabChange,
  onZoomIn,
  onZoomOut
}: {
  activeDocument?: PdfDocumentMeta;
  activeDocumentId?: string;
  activePage: number;
  documents: PdfDocumentMeta[];
  groups: LibraryGroup[];
  leftTab: LeftTab;
  loadProgress: number;
  outline: PdfOutlineItem[];
  outlineBusy: boolean;
  outlineGenerationBusy: boolean;
  outlineGenerationError?: string;
  outlineIsGenerated: boolean;
  pageDraft: string;
  scale: number;
  searchQuery: string;
  status: LoadStatus;
  text: ReaderText;
  title?: string;
  totalPages: number;
  onAddBookmark(): void;
  onAddToLibrary(): void;
  onFindNext(): void;
  onFindPrevious(): void;
  onFitWidth(): void;
  onJumpToDestination(dest: string | unknown[]): void;
  onJumpToPage(pageNumber: number): void;
  onGenerateOutline(): void;
  onCollapse(): void;
  onLoadDocument(documentId: string): void;
  onOpenPdf(): void;
  onOpenSettings(): void;
  onPageDraftBlur(): void;
  onPageDraftChange(value: string): void;
  onPageDraftFocus(): void;
  onSearchQueryChange(value: string): void;
  onSubmitPageJump(event: FormEvent): void;
  onSubmitSearch(event: FormEvent): void;
  onTabChange(tab: LeftTab): void;
  onZoomIn(): void;
  onZoomOut(): void;
}): ReactElement {
  const hasDocument = Boolean(activeDocumentId);
  const t = text;

  return (
    <aside className="left-panel">
      <header className="left-panel__top">
        <div className="reader-title-block">
          <span>Sidelight</span>
          <strong title={title ?? t.noPdfOpen}>{title ?? t.noPdfOpen}</strong>
          <small>
            {status === 'loading'
              ? `${t.loadingPdf} ${Math.round(loadProgress)}%`
              : hasDocument
                ? `${t.page} ${activePage}${totalPages ? ` / ${totalPages}` : ''}`
                : t.localPdfWorkspace}
          </small>
        </div>
        <div className="left-panel__actions">
          <button className="icon-button" type="button" title={t.hideSidebar} onClick={onCollapse}>
            <ChevronsLeft size={16} />
          </button>
          <button className="icon-button" type="button" title={t.openPdf} onClick={onOpenPdf}>
            <FolderOpen size={16} />
          </button>
          <button className="icon-button" type="button" title={t.settings} onClick={onOpenSettings}>
            <Settings size={16} />
          </button>
        </div>
      </header>

      <nav className="panel-breadcrumb" aria-label="Left panel view">
        <button
          type="button"
          className={leftTab === 'library' ? 'is-active' : ''}
          onClick={() => onTabChange('library')}
        >
          <FolderOpen size={14} />
          {t.library}
        </button>
        <span>/</span>
        <button
          type="button"
          className={leftTab === 'outline' ? 'is-active' : ''}
          disabled={!hasDocument}
          onClick={() => onTabChange('outline')}
        >
          <ListTree size={14} />
          {t.outline}
        </button>
      </nav>

      {activeDocument && activeDocument.inLibrary === false && (
        <div className="reader-library-status">
          <span>{t.transientPdf}</span>
          <button type="button" className="quiet-button" onClick={onAddToLibrary}>
            <BookOpen size={14} />
            {t.addToLibrary}
          </button>
        </div>
      )}

      <form className="panel-search" onSubmit={onSubmitSearch}>
        <Search size={15} />
        <InputText
          value={searchQuery}
          type="search"
          placeholder={t.searchInPdf}
          disabled={!hasDocument}
          onChange={(event) => onSearchQueryChange(event.target.value)}
        />
        <button type="button" title="Previous match" disabled={!hasDocument || !searchQuery.trim()} onClick={onFindPrevious}>
          <Minus size={14} />
        </button>
        <button type="button" title="Next match" disabled={!hasDocument || !searchQuery.trim()} onClick={onFindNext}>
          <Plus size={14} />
        </button>
      </form>

      <div className="reader-controls">
        <form className="page-control" onSubmit={onSubmitPageJump}>
          <InputText
            value={pageDraft}
            inputMode="numeric"
            disabled={!hasDocument}
            aria-label={t.page}
            onBlur={onPageDraftBlur}
            onChange={(event) => onPageDraftChange(event.target.value.replace(/[^\d]/g, ''))}
            onFocus={onPageDraftFocus}
          />
          <span className="page-control__separator">/</span>
          <span>{totalPages || '-'}</span>
        </form>
        <div className="zoom-control">
          <button className="icon-button" type="button" title={t.zoomOut} disabled={!hasDocument} onClick={onZoomOut}>
            <Minus size={15} />
          </button>
          <button className="zoom-readout" type="button" title={t.fitWidth} disabled={!hasDocument} onClick={onFitWidth}>
            {Math.round(scale * 100)}%
          </button>
          <button className="icon-button" type="button" title={t.zoomIn} disabled={!hasDocument} onClick={onZoomIn}>
            <Plus size={15} />
          </button>
        </div>
        <button className="icon-button" type="button" title={t.bookmarkPage} disabled={!hasDocument} onClick={onAddBookmark}>
          <BookmarkPlus size={15} />
        </button>
      </div>

      <div className="left-panel__body">
        {leftTab === 'library' && (
          <div className="library-panel">
            <button type="button" className="open-document-button" onClick={onOpenPdf}>
              <FilePlus2 size={16} />
              {t.openPdf}
            </button>
            <div className="document-list">
              {documents.length === 0 && <span className="empty-line">{t.noPdfs}</span>}
              {documents.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  title={document.title}
                  className={activeDocumentId === document.id ? 'document-row is-active' : 'document-row'}
                  onClick={() => onLoadDocument(document.id)}
                >
                  <FileText size={15} />
                  <span>
                    {document.title}
                    {document.groupIds?.length ? (
                      <small>{document.groupIds.map((groupId) => groups.find((group) => group.id === groupId)?.name).filter(Boolean).join(', ')}</small>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {leftTab === 'outline' && (
          <div className="outline-list">
            {outline.length === 0 && (
              <div className="outline-empty">
                <span className="empty-line">{outlineBusy ? t.readingOutline : t.noOutline}</span>
                {!outlineBusy && hasDocument && (
                  <button
                    type="button"
                    className="outline-ai-button"
                    disabled={outlineGenerationBusy}
                    onClick={onGenerateOutline}
                  >
                    <Sparkles size={14} />
                    {outlineGenerationBusy ? t.generatingOutline : t.generateAiOutline}
                  </button>
                )}
                {outlineGenerationError && <span className="outline-error">{outlineGenerationError}</span>}
              </div>
            )}
            {outlineIsGenerated && (
              <span className="outline-source">
                <Sparkles size={13} />
                {t.generatedOutline}
              </span>
            )}
            {outline.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.pageNumber === activePage ? 'outline-item is-active' : 'outline-item'}
                style={{ paddingLeft: `${10 + item.level * 14}px` }}
                title={item.title}
                onClick={() => {
                  if (item.dest) {
                    onJumpToDestination(item.dest as string | unknown[]);
                  } else if (item.pageNumber) {
                    onJumpToPage(item.pageNumber);
                  }
                }}
              >
                <span>{item.title}</span>
                {item.pageNumber && <small>{item.pageNumber}</small>}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function PdfState({
  status,
  progress,
  error,
  text
}: {
  status: LoadStatus;
  progress: number;
  error?: string;
  text: ReaderText;
}): ReactElement {
  if (status === 'error') {
    return (
      <div className="pdf-state pdf-state--error">
        <strong>{text.pdfFailed}</strong>
        <small>{error ?? text.pdfFailedHelp}</small>
      </div>
    );
  }

  return (
    <div className="pdf-state">
      <div className="pdf-state__bar">
        <span style={{ width: `${Math.max(4, Math.min(100, progress))}%` }} />
      </div>
      <strong>{text.loadingPdf}</strong>
      <small>{Math.round(progress)}%</small>
    </div>
  );
}

function ReaderDock({
  activeConversation,
  activeConversationId,
  activePage,
  bookmarks,
  busy,
  canStopGeneration,
  chatOpen,
  conversations,
  allConversations,
  marks,
  notes,
  allNotes,
  noteEditorNote,
  noteBusy,
  pdfReadingSignal,
  pageConversationCount,
  text,
  activeTab,
  tab,
  transientAid,
  onAddBookmark,
  onCloseConversation,
  onCloseTransientAid,
  onCloseNote,
  onCreatePageChat,
  onCreateNote,
  onDeleteBookmark,
  onDeleteMark,
  onDeleteNote,
  onJumpToPage,
  onOpenConversation,
  onOpenNote,
  onNoteDraftChange,
  onGenerateNote,
  onSendMessage,
  onStopGeneration,
  onPinConversation,
  onPinImage,
  onPinNote,
  onTabChange
}: {
  activeConversation?: Conversation;
  activeConversationId?: string;
  activePage: number;
  bookmarks: PdfUserBookmark[];
  busy: boolean;
  canStopGeneration: boolean;
  chatOpen: boolean;
  conversations: Conversation[];
  allConversations: Conversation[];
  marks: PdfMark[];
  notes: NoteDocument[];
  allNotes: NoteDocument[];
  noteEditorNote?: NoteDocument;
  noteBusy: boolean;
  pdfReadingSignal: number;
  pageConversationCount: number;
  text: ReaderText;
  activeTab?: DockTab;
  tab: DockTab;
  transientAid?: ReaderTransientAid;
  onAddBookmark(): void;
  onCloseConversation(): void;
  onCloseTransientAid(): void;
  onCloseNote(note?: NoteDocument): void;
  onCreatePageChat(): void;
  onCreateNote(): void;
  onDeleteBookmark(bookmarkId: string): void;
  onDeleteMark(markId: string): void;
  onDeleteNote(noteId: string): void;
  onJumpToPage(pageNumber: number): void;
  onOpenConversation(conversationId: string): void;
  onOpenNote(note: NoteDocument): void;
  onNoteDraftChange(note: NoteDocument): void;
  onGenerateNote(pageStart: number, pageEnd: number): void;
  onSendMessage(conversationId: string, prompt: string, attachments: ConversationAttachment[]): void;
  onStopGeneration(): void;
  onPinConversation(conversation: Conversation): void;
  onPinImage(attachment: ConversationAttachment, conversation?: Conversation): void;
  onPinNote(note: NoteDocument): void;
  onTabChange(tab: DockTab): void;
}): ReactElement {
  const panelOpen = (chatOpen && activeConversation) || transientAid || noteEditorNote;
  const t = text;
  const createsNote = activeTab === 'notes' || (!activeTab && tab === 'notes');
  const createPrimaryItem = createsNote ? onCreateNote : onCreatePageChat;
  const createPrimaryTitle = createsNote ? t.newPageNote : t.newPageChat;

  return (
    <aside
      className={[
        'reader-float-dock',
        panelOpen ? 'is-chat-open' : '',
        noteEditorNote ? 'is-note-open' : ''
      ].filter(Boolean).join(' ')}
    >
      <nav className="dock-iconbar" aria-label={t.readingSidePanel}>
        <span className="dock-iconbar__group">
          <Button
            type="button"
            text
            rounded
            className={activeTab === 'chat' ? 'is-active' : ''}
            title={t.chats}
            aria-label={t.chats}
            onClick={() => onTabChange('chat')}
          >
            <MessageCircle size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={activeTab === 'notes' ? 'is-active' : ''}
            title={t.notes}
            aria-label={t.notes}
            onClick={() => onTabChange('notes')}
          >
            <FileText size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={activeTab === 'search' ? 'is-active' : ''}
            title={t.search}
            aria-label={t.search}
            onClick={() => onTabChange('search')}
          >
            <Search size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={activeTab === 'bookmarks' ? 'is-active' : ''}
            title={t.bookmarks}
            aria-label={t.bookmarks}
            onClick={() => onTabChange('bookmarks')}
          >
            <BookmarkPlus size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={activeTab === 'marks' ? 'is-active' : ''}
            title={t.highlights}
            aria-label={t.highlights}
            onClick={() => onTabChange('marks')}
          >
            <Highlighter size={17} />
          </Button>
        </span>
        <span className="dock-iconbar__actions">
          <Button
            type="button"
            text
            rounded
            title={createPrimaryTitle}
            aria-label={createPrimaryTitle}
            onClick={createPrimaryItem}
          >
            <Plus size={17} />
          </Button>
        </span>
      </nav>

      {chatOpen && activeConversation ? (
        <DockChatPanel
          busy={busy}
          canStopGeneration={canStopGeneration}
          conversation={activeConversation}
          pdfReadingSignal={pdfReadingSignal}
          text={t}
          onClose={onCloseConversation}
          onPin={() => onPinConversation(activeConversation)}
          onPinImage={(attachment) => onPinImage(attachment, activeConversation)}
          onSend={(prompt, attachments) => onSendMessage(activeConversation.id, prompt, attachments)}
          onStop={onStopGeneration}
        />
      ) : noteEditorNote ? (
        <DockNoteEditorPanel
          note={noteEditorNote}
          text={t}
          onChange={onNoteDraftChange}
          onClose={onCloseNote}
          onDelete={() => onDeleteNote(noteEditorNote.id)}
          onPin={() => onPinNote(noteEditorNote)}
        />
      ) : transientAid ? (
        <TransientAidPanel aid={transientAid} text={t} onClose={onCloseTransientAid} />
      ) : (
        <>
          {tab === 'chat' && (
            <div className="dock-section dock-section--page-list" key={`chat:${activePage}`}>
              <div className="trace-list-header">
                <span>{t.page} {activePage}</span>
                <Badge value={pageConversationCount} />
              </div>
              <ScrollPanel className="trace-scroll">
                <div className="trace-list">
                  {conversations.length === 0 && <span className="empty-line">{t.noConversations}</span>}
                  {conversations.map((conversation) => (
                    <Button
                      key={conversation.id}
                      type="button"
                      text
                      className={conversation.id === activeConversationId ? 'trace-card is-active' : 'trace-card'}
                      onClick={() => onOpenConversation(conversation.id)}
                    >
                      <span className="trace-card__meta">
                        <Badge value={`p.${conversation.pageNumber ?? '-'}`} />
                        <span>{conversation.mode}</span>
                      </span>
                      <span className="trace-card__title">{conversation.summary.title}</span>
                      <span className="trace-card__brief">{conversation.summary.brief}</span>
                    </Button>
                  ))}
                </div>
              </ScrollPanel>
            </div>
          )}

          {tab === 'notes' && (
            <DockNotesPanel
              activePage={activePage}
              busy={noteBusy}
              notes={notes}
              text={t}
              onCreate={onCreateNote}
              onGenerate={onGenerateNote}
              onDelete={onDeleteNote}
              onOpen={onOpenNote}
              onPin={onPinNote}
            />
          )}

          {tab === 'search' && (
            <DockSearchPanel
              activePage={activePage}
              conversations={allConversations}
              notes={allNotes}
              text={t}
              onOpenConversation={onOpenConversation}
              onOpenNote={onOpenNote}
              onDeleteNote={onDeleteNote}
              onPinConversation={onPinConversation}
              onPinNote={onPinNote}
            />
          )}

          {tab === 'bookmarks' && (
            <div className="dock-section">
              <button type="button" className="dock-action" onClick={onAddBookmark}>
                <BookmarkPlus size={15} />
                {t.bookmarkCurrentPage}
              </button>
              <div className="bookmark-list">
                {bookmarks.length === 0 && <span className="empty-line">{t.noBookmarks}</span>}
                {bookmarks.map((bookmark) => (
                  <div className="bookmark-row" key={bookmark.id}>
                    <button type="button" onClick={() => onJumpToPage(bookmark.pageNumber)}>
                      <strong>p.{bookmark.pageNumber}</strong>
                      <span>{bookmark.label}</span>
                    </button>
                    <button type="button" title={t.removeBookmark} onClick={() => onDeleteBookmark(bookmark.id)}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'marks' && (
            <div className="dock-section dock-section--page-list" key={`marks:${activePage}`}>
              <div className="mark-list">
                {marks.length === 0 && <span className="empty-line">{t.noHighlights}</span>}
                {marks.map((mark) => (
                  <article className="mark-card" key={mark.id}>
                    <header>
                      <span>{mark.kind}</span>
                      <button type="button" title={t.deleteMark} onClick={() => onDeleteMark(mark.id)}>
                        <Trash2 size={14} />
                      </button>
                    </header>
                    <p>{mark.quote}</p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function TransientAidPanel({
  aid,
  text,
  onClose
}: {
  aid: ReaderTransientAid;
  text: ReaderText;
  onClose(): void;
}): ReactElement {
  const Icon = aid.mode === 'translate' ? Languages : Sparkles;
  const title = aid.mode === 'translate' ? text.translation : text.summary;

  return (
    <section className="transient-aid-panel">
      <header>
        <div>
          <span>{text.temporaryReadingAid}</span>
          <strong>
            <Icon size={15} />
            {title}
          </strong>
        </div>
        <Badge value={`p.${aid.pageNumber}`} />
        <Button type="button" text rounded className="panel-close-button" title={text.close} aria-label={text.close} onClick={onClose}>
          <X size={15} />
        </Button>
      </header>

      <blockquote className="transient-aid-panel__quote">{aid.quote}</blockquote>

      <div className="transient-aid-panel__body">
        {aid.error && <span className="transient-aid-panel__error">AI request failed: {aid.error}</span>}
        {aid.content ? <MarkdownView>{aid.content}</MarkdownView> : <span className="typing-dot">{text.thinking}</span>}
        {aid.busy && aid.content && <span className="typing-dot">{text.thinking}</span>}
      </div>
    </section>
  );
}

function DockNotesPanel({
  activePage,
  busy,
  notes,
  text,
  onCreate,
  onDelete,
  onGenerate,
  onOpen,
  onPin
}: {
  activePage: number;
  busy: boolean;
  notes: NoteDocument[];
  text: ReaderText;
  onCreate(): void;
  onDelete(noteId: string): void;
  onGenerate(pageStart: number, pageEnd: number): void;
  onOpen(note: NoteDocument): void;
  onPin(note: NoteDocument): void;
}): ReactElement {
  const [aiRangeStart, setAiRangeStart] = useState(String(activePage));
  const [aiRangeEnd, setAiRangeEnd] = useState(String(activePage));
  const t = text;

  useEffect(() => {
    setAiRangeStart(String(activePage));
    setAiRangeEnd(String(activePage));
  }, [activePage]);

  const submitAiNote = (): void => {
    const pageStart = Number(aiRangeStart);
    const pageEnd = Number(aiRangeEnd);
    if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd)) {
      return;
    }

    onGenerate(pageStart, pageEnd);
  };

  return (
    <section className="dock-section notes-panel notes-panel--list">
      <div className="notes-panel__topbar">
        <div>
          <span>{t.page} {activePage}</span>
          <strong>{t.notes}</strong>
          <small>{notes.length ? t.visibleOnPage(notes.length) : t.noNoteCoversPage}</small>
        </div>
        <div className="notes-panel__top-actions">
          <button className="dock-action notes-panel__new" type="button" title={t.newPageNote} onClick={onCreate}>
            <FilePlus2 size={15} />
          </button>
        </div>
      </div>

      {notes.length > 0 ? (
        <section className="notes-panel__list" aria-label={t.pageNotes}>
          <header>
            <span>{t.visibleNotes}</span>
            <small>{t.scopedByPageRange}</small>
          </header>
          <div className="notes-panel__tabs" role="tablist" aria-label={t.pageNotes}>
            {notes.map((note) => (
              <div className="notes-panel__tab-row" key={note.id}>
                <button
                  className="notes-panel__tab-main"
                  type="button"
                  onClick={() => onOpen(note)}
                >
                  <span>{note.source === 'ai' ? t.aiDraft : t.manual}</span>
                  <strong>{note.title}</strong>
                  <small>p.{note.pageStart}-{note.pageEnd}</small>
                  <em>{compactPreview(note.markdown)}</em>
                </button>
                <button
                  className="notes-panel__pin"
                  type="button"
                  title={t.pinToCanvas}
                  aria-label={t.pinToCanvas}
                  onClick={() => onPin(note)}
                >
                  <Pin size={14} />
                </button>
                <button
                  className="notes-panel__delete"
                  type="button"
                  title={t.deleteNote}
                  aria-label={t.deleteNote}
                  onClick={() => onDelete(note.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="notes-panel__empty">
          <strong>{t.noNoteVisible}</strong>
          <span>{t.noNoteVisibleHelp}</span>
        </div>
      )}

      <section className="notes-ai-box">
        <div>
          <span>{t.aiNote}</span>
          <strong>{t.generateFromSources}</strong>
        </div>
        <div className="notes-ai-box__range">
          <label>
            {t.from}
            <input value={aiRangeStart} inputMode="numeric" onChange={(event) => setAiRangeStart(event.target.value)} />
          </label>
          <label>
            {t.to}
            <input value={aiRangeEnd} inputMode="numeric" onChange={(event) => setAiRangeEnd(event.target.value)} />
          </label>
        </div>
        <button
          type="button"
          className="dock-action"
          disabled={busy || !Number.isInteger(Number(aiRangeStart)) || !Number.isInteger(Number(aiRangeEnd))}
          onClick={submitAiNote}
        >
          <Sparkles size={15} />
          {busy ? t.generating : t.generateAiNote}
        </button>
      </section>
    </section>
  );
}

function DockNoteEditorPanel({
  note,
  text,
  onChange,
  onClose,
  onDelete,
  onPin
}: {
	  note: NoteDocument;
	  text: ReaderText;
	  onChange(note: NoteDocument): void;
	  onClose(note: NoteDocument): void;
	  onDelete(): void;
	  onPin(): void;
}): ReactElement {
  const [vimMode, setVimMode] = useState(false);

  const patchNote = (patch: Partial<NoteDocument>): void => {
    onChange({
      ...note,
      ...patch,
      updatedAt: new Date().toISOString()
    });
  };

  const updatePageRange = (key: 'pageStart' | 'pageEnd', value: string): void => {
    const nextValue = Number(value.replace(/[^\d]/g, ''));
    if (!Number.isInteger(nextValue)) {
      return;
    }

    const pageStart = key === 'pageStart' ? nextValue : note.pageStart;
    const pageEnd = key === 'pageEnd' ? nextValue : note.pageEnd;
    patchNote({
      pageStart: Math.max(1, Math.min(pageStart, pageEnd)),
      pageEnd: Math.max(pageStart, pageEnd)
    });
  };

  return (
    <section className="dock-note-editor-panel">
      <header>
        <div className="dock-chat-panel__title">
          <span>{text.editing}</span>
          <strong>{note.title}</strong>
        </div>
        <label className="notes-panel__toggle">
          <input type="checkbox" checked={vimMode} onChange={(event) => setVimMode(event.target.checked)} />
          Vim
        </label>
        <Button
          type="button"
          text
          rounded
          className="panel-delete-button"
          title={text.deleteNote}
          aria-label={text.deleteNote}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </Button>
        <Button
          type="button"
          text
          rounded
          className="panel-pin-button"
          title={text.pinToCanvas}
          aria-label={text.pinToCanvas}
          onClick={onPin}
        >
          <Pin size={15} />
        </Button>
        <Button
          type="button"
          text
          rounded
          className="panel-close-button"
          title={text.close}
          aria-label={text.close}
	          onClick={() => onClose(note)}
        >
          <X size={16} />
        </Button>
      </header>

      {note.anchor && <blockquote className="dock-chat-anchor">{note.anchor.quote}</blockquote>}

      <div className="notes-panel__meta">
        <label className="notes-panel__title-field">
          {text.title}
          <input value={note.title} onChange={(event) => patchNote({ title: event.target.value })} />
        </label>
        <label>
          {text.from}
          <input
            value={String(note.pageStart)}
            inputMode="numeric"
            onChange={(event) => updatePageRange('pageStart', event.target.value)}
          />
        </label>
        <label>
          {text.to}
          <input
            value={String(note.pageEnd)}
            inputMode="numeric"
            onChange={(event) => updatePageRange('pageEnd', event.target.value)}
          />
        </label>
      </div>

      <div className="dock-note-editor-panel__body">
        <section className="note-editor-pane note-editor-pane--source">
          <header>
            <span>{text.editing}</span>
            <strong>Markdown</strong>
          </header>
          <MarkdownNoteEditor
            key={`${note.id}:${vimMode ? 'vim' : 'plain'}`}
            value={note.markdown}
            vimMode={vimMode}
            onChange={(markdown) => patchNote({ markdown })}
          />
        </section>
        <section className="note-editor-pane note-editor-pane--preview">
          <header>
            <span>{text.notePreview}</span>
            <strong>{note.title || text.title}</strong>
          </header>
          <div className="note-render-preview">
            {note.markdown.trim() ? (
              <MarkdownView>{note.markdown}</MarkdownView>
            ) : (
              <span className="note-render-preview__empty">{text.emptyNotePreview}</span>
            )}
          </div>
        </section>
      </div>

      <footer className="notes-panel__actions">
        <button className="dock-action" type="button" onClick={() => onClose(note)}>
          <Check size={15} />
          {text.save}
        </button>
      </footer>
    </section>
  );
}

function DockSearchPanel({
  activePage,
  conversations,
  notes,
  text,
  onOpenConversation,
  onOpenNote,
  onDeleteNote,
  onPinConversation,
  onPinNote
}: {
  activePage: number;
  conversations: Conversation[];
  notes: NoteDocument[];
  text: ReaderText;
  onOpenConversation(conversationId: string): void;
  onOpenNote(note: NoteDocument): void;
  onDeleteNote(noteId: string): void;
  onPinConversation(conversation: Conversation): void;
  onPinNote(note: NoteDocument): void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'notes' | 'chats'>('all');
  const [pageStart, setPageStart] = useState('');
  const [pageEnd, setPageEnd] = useState('');
  const rangeStart = pageStart.trim() ? Number(pageStart) : undefined;
  const rangeEnd = pageEnd.trim() ? Number(pageEnd) : undefined;
  const hasStart = rangeStart !== undefined && Number.isInteger(rangeStart);
  const hasEnd = rangeEnd !== undefined && Number.isInteger(rangeEnd);
  const hasRange = hasStart || hasEnd;
  const normalizedStart = hasStart ? rangeStart : 1;
  const normalizedEnd = hasEnd ? rangeEnd : Number.MAX_SAFE_INTEGER;
  const needle = query.trim().toLowerCase();

  const noteResults = useMemo(() => {
    if (scope === 'chats') {
      return [];
    }

    return notes.filter((note) => {
      const inRange = !hasRange || rangesOverlap(note.pageStart, note.pageEnd, normalizedStart, normalizedEnd);
      const haystack = [note.title, note.markdown, note.anchor?.quote].join('\n').toLowerCase();
      return inRange && (!needle || haystack.includes(needle));
    });
  }, [hasRange, needle, normalizedEnd, normalizedStart, notes, scope]);

  const chatResults = useMemo(() => {
    if (scope === 'notes') {
      return [];
    }

    return conversations.filter((conversation) => {
      const pageNumber = conversation.pageNumber ?? conversation.anchor?.pageNumber ?? activePage;
      const inRange = !hasRange || (pageNumber >= normalizedStart && pageNumber <= normalizedEnd);
      const haystack = [
        conversation.summary.title,
        conversation.summary.brief,
        conversation.anchor?.quote,
        ...conversation.messages.map((message) => message.content)
      ].join('\n').toLowerCase();
      return inRange && (!needle || haystack.includes(needle));
    });
  }, [activePage, conversations, hasRange, needle, normalizedEnd, normalizedStart, scope]);

  return (
    <section className="dock-section dock-search-panel">
      <header className="trace-list-header">
        <span>{text.searchNotesAndChats}</span>
        <Badge value={noteResults.length + chatResults.length} />
      </header>

      <label className="trace-search dock-search-panel__query">
        <Search size={15} />
        <input value={query} placeholder={text.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
      </label>

      <div className="dock-search-panel__filters">
        <div className="dock-search-panel__scope" role="tablist" aria-label={text.search}>
          <button type="button" className={scope === 'all' ? 'is-active' : ''} onClick={() => setScope('all')}>
            {text.searchAll}
          </button>
          <button type="button" className={scope === 'notes' ? 'is-active' : ''} onClick={() => setScope('notes')}>
            {text.searchNotes}
          </button>
          <button type="button" className={scope === 'chats' ? 'is-active' : ''} onClick={() => setScope('chats')}>
            {text.searchChats}
          </button>
        </div>
        <div className="notes-ai-box__range">
          <label>
            {text.from}
            <input value={pageStart} inputMode="numeric" onChange={(event) => setPageStart(event.target.value)} />
          </label>
          <label>
            {text.to}
            <input value={pageEnd} inputMode="numeric" onChange={(event) => setPageEnd(event.target.value)} />
          </label>
        </div>
      </div>

      <ScrollPanel className="trace-scroll">
        <div className="trace-list">
          {noteResults.length === 0 && chatResults.length === 0 && <span className="empty-line">{text.noSearchResults}</span>}
          {noteResults.map((note) => (
            <div key={note.id} className="search-result-row">
              <button type="button" className="trace-card search-result-card" onClick={() => onOpenNote(note)}>
                <span className="trace-card__meta">
                  <Badge value={`p.${note.pageStart}-${note.pageEnd}`} />
                  <span>{text.searchNotes}</span>
                </span>
                <span className="trace-card__title">{note.title}</span>
                <span className="trace-card__brief">{compactPreview(note.markdown)}</span>
              </button>
              <button
                type="button"
                className="search-result-row__pin"
                title={text.pinToCanvas}
                aria-label={text.pinToCanvas}
                onClick={() => onPinNote(note)}
              >
                <Pin size={14} />
              </button>
              <button
                type="button"
                className="search-result-row__delete"
                title={text.deleteNote}
                aria-label={text.deleteNote}
                onClick={() => onDeleteNote(note.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {chatResults.map((conversation) => (
            <div key={conversation.id} className="search-result-row">
              <button
                type="button"
                className="trace-card search-result-card"
                onClick={() => onOpenConversation(conversation.id)}
              >
                <span className="trace-card__meta">
                  <Badge value={`p.${conversation.pageNumber ?? conversation.anchor?.pageNumber ?? '-'}`} />
                  <span>{text.searchChats}</span>
                </span>
                <span className="trace-card__title">{conversation.summary.title}</span>
                <span className="trace-card__brief">{conversation.summary.brief}</span>
              </button>
              <button
                type="button"
                className="search-result-row__pin"
                title={text.pinToCanvas}
                aria-label={text.pinToCanvas}
                onClick={() => onPinConversation(conversation)}
              >
                <Pin size={14} />
              </button>
            </div>
          ))}
        </div>
      </ScrollPanel>
    </section>
  );
}

function WorkspaceBlockLayer({
  blocks,
  layouts,
  text,
  onDelete,
  onOpenConversation,
  onOpenNote,
  onSave
}: {
  blocks: WorkspaceBlock[];
  layouts: Record<string, WorkspaceBlockLayout>;
  text: ReaderText;
  onDelete(blockId: string): void;
  onOpenConversation(conversationId: string): void;
  onOpenNote(noteId: string): void;
  onSave(block: WorkspaceBlock): void;
}): ReactElement {
  const [drafts, setDrafts] = useState<Record<string, Partial<Pick<WorkspaceBlock, 'x' | 'y' | 'width'>>>>({});
  const visibleBlocks = blocks.filter((block) => block.anchor === 'page' && layouts[block.id]);
  const displayPlacements = new Map<string, { left: number; top: number; width: number }>();
  const placedByLane = new Map<string, Array<{ left: number; right: number; top: number; bottom: number }>>();
  const sortedVisibleBlocks = [...visibleBlocks].sort((a, b) => {
    const topDelta = (layouts[a.id]?.top ?? 0) - (layouts[b.id]?.top ?? 0);
    return topDelta || a.createdAt.localeCompare(b.createdAt);
  });
  for (const block of sortedVisibleBlocks) {
    const layout = layouts[block.id];
    const draft = drafts[block.id];
    const left = layout.left + (draft?.x ?? block.x) - block.x;
    let top = layout.pageTop + (draft?.y ?? layout.renderedY);
    const width = draft?.width ?? block.width;
    const estimatedHeight = block.height ?? 132;
    const lane = `${block.pageNumber ?? 'none'}:${Math.sign(draft?.x ?? block.x) || 1}`;
    const placed = placedByLane.get(lane) ?? [];
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const overlap = placed.find((candidate) => {
        const horizontalOverlap = left < candidate.right + 14 && left + width + 14 > candidate.left;
        const verticalOverlap = top < candidate.bottom + 14 && top + estimatedHeight + 14 > candidate.top;
        return horizontalOverlap && verticalOverlap;
      });
      if (!overlap) {
        break;
      }
      top = overlap.bottom + 14;
    }
    placed.push({
      left,
      right: left + width,
      top,
      bottom: top + estimatedHeight
    });
    placedByLane.set(lane, placed);
    displayPlacements.set(block.id, { left, top, width });
  }

  const openBlock = (block: WorkspaceBlock): void => {
    if (!canOpenWorkspaceBlockSource(block) || !block.sourceId) {
      return;
    }

    const openHandlers: Partial<Record<WorkspaceBlock['kind'], (sourceId: string) => void>> = {
      conversation: onOpenConversation,
      note: onOpenNote
    };
    openHandlers[block.kind]?.(block.sourceId);
  };

  const startMove = (block: WorkspaceBlock, event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add('is-moving-workspace-block');

    const startX = event.clientX;
    const startY = event.clientY;
    const draft = drafts[block.id];
    const layout = layouts[block.id];
    const originX = draft?.x ?? block.x;
    const originY = draft?.y ?? layout?.renderedY ?? block.y;
    let nextX = originX;
    let nextY = originY;

    const move = (moveEvent: MouseEvent): void => {
      nextX = clamp(originX + moveEvent.clientX - startX, -2400, 3600);
      nextY = Math.max(0, originY + moveEvent.clientY - startY);
      setDrafts((current) => ({
        ...current,
        [block.id]: {
          ...current[block.id],
          x: nextX,
          y: nextY
        }
      }));
    };

    const stop = (): void => {
      document.body.classList.remove('is-moving-workspace-block');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      setDrafts((current) => {
        const { [block.id]: _finished, ...rest } = current;
        return rest;
      });
      onSave(withWorkspaceBlockLayoutScale({
        ...block,
        x: Math.round(nextX),
        y: Math.round(nextY),
        updatedAt: new Date().toISOString()
      }, layout?.pageScale ?? 1));
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop, { once: true });
  };

  const startResize = (block: WorkspaceBlock, event: ReactMouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    document.body.classList.add('is-resizing-workspace-block');

    const startX = event.clientX;
    const draft = drafts[block.id];
    const originWidth = draft?.width ?? block.width;
    const spec = workspaceBlockSpec(block.kind);
    let nextWidth = originWidth;

    const move = (moveEvent: MouseEvent): void => {
      nextWidth = clamp(originWidth + moveEvent.clientX - startX, spec.minWidth, spec.maxWidth);
      setDrafts((current) => ({
        ...current,
        [block.id]: {
          ...current[block.id],
          width: nextWidth
        }
      }));
    };

    const stop = (): void => {
      document.body.classList.remove('is-resizing-workspace-block');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      setDrafts((current) => {
        const { [block.id]: _finished, ...rest } = current;
        return rest;
      });
      onSave({
        ...block,
        width: Math.round(nextWidth),
        updatedAt: new Date().toISOString()
      });
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop, { once: true });
  };

  return (
    <div className="workspace-block-layer" aria-hidden={visibleBlocks.length === 0}>
      {visibleBlocks.map((block) => {
        const placement = displayPlacements.get(block.id);
        const imagePayload = imageBlockPayload(block);
        return (
          <article
            key={block.id}
            data-block-id={block.id}
            data-block-x={block.x}
            data-page-number={block.pageNumber}
            className={`workspace-block-card workspace-block-card--${block.kind}`}
            style={{
              left: placement?.left,
              top: placement?.top,
              width: placement?.width
            }}
          >
            <button
              type="button"
              className="workspace-block-card__drag"
              title={text.moveBlock}
              aria-label={text.moveBlock}
              onMouseDown={(event) => startMove(block, event)}
            />
            <button
              type="button"
              className="workspace-block-card__body"
              onClick={() => openBlock(block)}
            >
              <span className="workspace-block-card__meta">
                {workspaceBlockLabel(block, text)}
                {block.pageNumber ? ` · p.${block.pageNumber}` : ''}
              </span>
              <strong>{block.title}</strong>
              {block.kind === 'image' && imagePayload?.dataUrl && (
                <span className="workspace-block-card__image">
                  <img src={imagePayload.dataUrl} alt={imagePayload.name ?? block.title} />
                </span>
              )}
              {block.body && <span>{block.body}</span>}
            </button>
            <button
              type="button"
              className="workspace-block-card__remove"
              title={text.unpinFromCanvas}
              aria-label={text.unpinFromCanvas}
              onClick={() => onDelete(block.id)}
            >
              <X size={13} />
            </button>
            <button
              type="button"
              className="workspace-block-card__resize"
              title={text.resizeBlock}
              aria-label={text.resizeBlock}
              onMouseDown={(event) => startResize(block, event)}
            />
          </article>
        );
      })}
    </div>
  );
}

function workspaceBlockLabel(block: WorkspaceBlock, text: ReaderText): string {
  if (block.kind === 'conversation') {
    return text.conversation;
  }

  if (block.kind === 'note') {
    return text.notes;
  }

  if (block.kind === 'image') {
    return text.image;
  }

  return block.kind;
}

function imageBlockPayload(block: WorkspaceBlock): { dataUrl?: string; name?: string } | undefined {
  if (block.kind !== 'image' || !block.payload) {
    return undefined;
  }

  const dataUrl = typeof block.payload.dataUrl === 'string' ? block.payload.dataUrl : undefined;
  const name = typeof block.payload.name === 'string' ? block.payload.name : undefined;
  return { dataUrl, name };
}

function DockChatPanel({
  busy,
  canStopGeneration,
  conversation,
  pdfReadingSignal,
  text,
  onClose,
  onPin,
  onPinImage,
  onSend,
  onStop
}: {
  busy: boolean;
  canStopGeneration: boolean;
  conversation: Conversation;
  pdfReadingSignal: number;
  text: ReaderText;
  onClose(): void;
  onPin(): void;
  onPinImage(attachment: ConversationAttachment): void;
  onSend(prompt: string, attachments: ConversationAttachment[]): void;
  onStop(): void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const shouldFollowMessagesRef = useRef(true);
  const previousConversationIdRef = useRef(conversation.id);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [draft]);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }

    const conversationChanged = previousConversationIdRef.current !== conversation.id;
    previousConversationIdRef.current = conversation.id;
    if (conversationChanged) {
      shouldFollowMessagesRef.current = true;
    }

    if (!conversationChanged && !shouldFollowMessagesRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (!conversationChanged && !shouldFollowMessagesRef.current) {
        return;
      }

      node.scrollTop = node.scrollHeight;
      shouldFollowMessagesRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.id, conversation.messages]);

  useEffect(() => {
    if (pdfReadingSignal > 0) {
      shouldFollowMessagesRef.current = false;
    }
  }, [pdfReadingSignal]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const prompt = draft.trim();
    if ((!prompt && attachments.length === 0) || busy) {
      return;
    }

    setDraft('');
    setAttachments([]);
    onSend(prompt || 'Please analyze the attached image in the context of this PDF.', attachments);
  };

  const updateMessageFollowFromScroll = (): void => {
    const node = messagesRef.current;
    if (node) {
      shouldFollowMessagesRef.current = chatMessagesNearBottom(node);
    }
  };

  const attachFiles = (files: FileList | null): void => {
    void addImageAttachments(files, setAttachments);
  };

  return (
    <section className={conversation.anchor ? 'dock-chat-panel has-anchor' : 'dock-chat-panel has-no-anchor'}>
      <header>
        <div className="dock-chat-panel__title">
          <span>{text.conversation}</span>
          <strong>{conversation.summary.title}</strong>
        </div>
        <Badge value={`p.${conversation.pageNumber ?? '-'}`} />
        <Button
          type="button"
          text
          rounded
          className="panel-pin-button"
          title={text.pinToCanvas}
          aria-label={text.pinToCanvas}
          onClick={onPin}
        >
          <Pin size={15} />
        </Button>
        <Button
          type="button"
          text
          rounded
          className="panel-close-button"
          title={text.collapseChat}
          aria-label={text.collapseChat}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>

      {conversation.anchor && <blockquote className="dock-chat-anchor">{conversation.anchor.quote}</blockquote>}

      <div
        className="dock-chat-messages"
        ref={messagesRef}
        role="log"
        aria-live={busy ? 'polite' : 'off'}
        onScroll={updateMessageFollowFromScroll}
      >
        <div className="dock-chat-transcript">
          {conversation.messages.length === 0 && (
            <div className="dock-chat-empty">
              <MessageCircle size={21} />
              <span>{conversation.anchor ? text.askAboutSelection : text.askAboutPage}</span>
            </div>
          )}
          {conversation.messages.map((message) => {
            const toolCalls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
            const shouldShowThinking = message.role === 'assistant' && !message.content && toolCalls.length === 0;
            return (
              <article key={message.id} className={`chat-message chat-message--${message.role}`}>
                {message.role === 'assistant' && <div className="chat-avatar">S</div>}
                <div className="chat-message__content">
                  <div className="chat-message__role">{message.role === 'assistant' ? 'Sidelight' : 'You'}</div>
                  {message.attachments?.length ? (
                    <div className="chat-attachments">
                      {message.attachments.map((attachment) => (
                        <span className="chat-attachment" key={attachment.id}>
                          <img src={attachment.dataUrl} alt={attachment.name} />
                          <button
                            type="button"
                            className="chat-attachment__pin"
                            title={text.pinImageToCanvas}
                            aria-label={text.pinImageToCanvas}
                            onClick={() => onPinImage(attachment)}
                          >
                            <Pin size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {toolCalls.length ? (
                    <ToolCallList toolCalls={toolCalls} text={text} />
                  ) : null}
                  {message.content ? (
                    <div className="chat-bubble">
                      <MarkdownView>{message.content}</MarkdownView>
                    </div>
                  ) : shouldShowThinking ? (
                    <span className="typing-dot">{text.thinking}</span>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <form
        className={dragActive ? 'chat-composer is-drag-active' : 'chat-composer'}
        onSubmit={submit}
        onDragEnter={(event) => {
          if (hasImageFiles(event.dataTransfer)) {
            event.preventDefault();
            setDragActive(true);
          }
        }}
        onDragOver={(event) => {
          if (hasImageFiles(event.dataTransfer)) {
            event.preventDefault();
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false);
          }
        }}
        onDrop={(event) => {
          if (!hasImageFiles(event.dataTransfer)) {
            return;
          }

          event.preventDefault();
          setDragActive(false);
          attachFiles(event.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span className="composer-attachment" key={attachment.id}>
                <img src={attachment.dataUrl} alt={attachment.name} />
                <button
                  type="button"
                  className="composer-attachment__pin"
                  title={text.pinImageToCanvas}
                  aria-label={text.pinImageToCanvas}
                  onClick={() => onPinImage(attachment)}
                >
                  <Pin size={12} />
                </button>
                <button
                  type="button"
                  className="composer-attachment__remove"
                  title={text.removeImage}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-composer__row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              attachFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <Button
            type="button"
            text
            rounded
            className="chat-icon-button"
            title={text.attachImages}
            aria-label={text.attachImages}
            onClick={() => fileInputRef.current?.click()}
          >
            <FilePlus2 size={17} />
          </Button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onPaste={(event) => attachFiles(event.clipboardData.files)}
            placeholder={text.messageSidelight}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !isComposingKeyboardEvent(event, composingRef.current)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {canStopGeneration ? (
            <Button
              type="button"
              rounded
              className="chat-send-button chat-stop-button"
              title={text.stopGenerating}
              aria-label={text.stopGenerating}
              onClick={onStop}
            >
              <Square size={13} fill="currentColor" />
            </Button>
          ) : (
            <Button
              type="submit"
              rounded
              className="chat-send-button"
              title={text.send}
              aria-label={text.send}
              disabled={busy || (!draft.trim() && attachments.length === 0)}
            >
              <ArrowUp size={17} />
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function chatMessagesNearBottom(node: HTMLElement): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
}

function isComposingKeyboardEvent(event: ReactKeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return composing || nativeEvent.isComposing === true || nativeEvent.keyCode === 229;
}

function ToolCallList({
  text,
  toolCalls
}: {
  text: ReaderText;
  toolCalls: AiToolCallEvent[];
}): ReactElement {
  return (
    <div className="chat-toolcalls" aria-label="AI tool calls">
      {toolCalls.map((toolCall) => (
        <div className={`chat-toolcall is-${toolCall.status}`} key={toolCall.id}>
          <Sparkles size={13} />
          <span>{toolCallTitle(toolCall, text)}</span>
          <small>{toolCallDetail(toolCall, text)}</small>
        </div>
      ))}
    </div>
  );
}

function toolCallTitle(toolCall: AiToolCallEvent, text: ReaderText): string {
  if (toolCall.name === 'view_current_pdf') {
    return text.toolReadPdf;
  }

  if (toolCall.name === 'view_pdf_outline') {
    return text.toolReadOutline;
  }

  return toolCall.name;
}

function toolCallDetail(toolCall: AiToolCallEvent, text: ReaderText): string {
  return [
    toolCallStatusText(toolCall, text),
    toolCall.resultSummary ?? toolCallPageRange(toolCall),
    toolCall.error
  ].filter(Boolean).join(' · ');
}

function toolCallStatusText(toolCall: AiToolCallEvent, text: ReaderText): string {
  if (toolCall.status === 'completed') {
    return text.toolCompleted;
  }

  if (toolCall.status === 'error') {
    return text.toolFailed;
  }

  return text.toolReading;
}

function toolCallPageRange(toolCall: AiToolCallEvent): string | undefined {
  if (!toolCall.pageStart) {
    return undefined;
  }

  return toolCall.pageEnd && toolCall.pageEnd !== toolCall.pageStart
    ? `p.${toolCall.pageStart}-${toolCall.pageEnd}`
    : `p.${toolCall.pageStart}`;
}

function SelectionToolbar({
  popover,
  text,
  onCreateMark,
  onCreateNote,
  onSelectionAction,
  onClose
}: {
  popover: SelectionPopover;
  text: ReaderText;
  onCreateMark(kind: PdfMarkKind, selection: PdfSelectionPayload, colorRole?: SelectionColorRole): void;
  onCreateNote(selection: PdfSelectionPayload): void;
  onSelectionAction(mode: AiMode, selection: PdfSelectionPayload): void;
  onClose(): void;
}): ReactElement {
  const { selection } = popover;

  return (
    <div className="selection-toolbar" style={{ left: popover.left, top: popover.top }}>
      <button
        type="button"
        className="selection-toolbar__action selection-toolbar__action--highlight"
        title={text.highlight}
        onClick={() => onCreateMark('highlight', selection, 'highlight')}
      >
        <Highlighter size={15} />
        {text.highlight}
      </button>
      <button
        type="button"
        className="selection-toolbar__action selection-toolbar__action--underline"
        title={text.underline}
        onClick={() => onCreateMark('underline', selection, 'underline')}
      >
        <Sparkles size={15} />
        {text.underline}
      </button>
      <button
        type="button"
        className="selection-toolbar__action selection-toolbar__action--chat"
        title={text.openChat}
        onClick={() => onSelectionAction('ask', selection)}
      >
        <MessageCircle size={15} />
        {text.chat}
      </button>
      <button
        type="button"
        className="selection-toolbar__action selection-toolbar__action--note"
        title={text.openNote}
        onClick={() => onCreateNote(selection)}
      >
        <FileText size={15} />
        {text.notes}
      </button>
      <button
        type="button"
        className="selection-toolbar__action selection-toolbar__action--summary"
        title={text.summary}
        onClick={() => onSelectionAction('summarize', selection)}
      >
        <Sparkles size={15} />
        {text.summary}
      </button>
      <button
        type="button"
        className="selection-toolbar__action selection-toolbar__action--translate"
        title={text.translate}
        onClick={() => onSelectionAction('translate', selection)}
      >
        <Languages size={15} />
        {text.translate}
      </button>
      <button type="button" className="selection-toolbar__close" title={text.close} onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function MarkPopover({
  mark,
  left,
  top,
  text,
  onClose,
  onDelete,
  onCreateNote,
  onSelectionAction
}: {
  mark?: PdfMark;
  left: number;
  top: number;
  text: ReaderText;
  onClose(): void;
  onDelete(markId: string): void;
  onCreateNote(mark: PdfMark): void;
  onSelectionAction(mode: AiMode, mark: PdfMark): void;
}): ReactElement | null {
  if (!mark) {
    return null;
  }

  return (
    <section className="mark-popover" style={{ left, top }}>
      <header>
        <span>p.{mark.pageNumber}</span>
        <button type="button" className="icon-button" title={text.close} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <p>{mark.quote}</p>
      <div className="mark-popover__actions">
        <button type="button" title={text.openChat} onClick={() => onSelectionAction('ask', mark)}>
          <MessageCircle size={15} />
          {text.chat}
        </button>
        <button type="button" title={text.openNote} onClick={() => onCreateNote(mark)}>
          <FileText size={15} />
          {text.notes}
        </button>
        <button type="button" title={text.summary} onClick={() => onSelectionAction('summarize', mark)}>
          <Sparkles size={15} />
          {text.summary}
        </button>
        <button type="button" title={text.translate} onClick={() => onSelectionAction('translate', mark)}>
          <Languages size={15} />
          {text.translate}
        </button>
        <button type="button" title={text.deleteMark} onClick={() => onDelete(mark.id)}>
          <Trash2 size={15} />
          {text.delete}
        </button>
      </div>
    </section>
  );
}

function compactPreview(markdown: string): string {
  const clean = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`[\]()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 150 ? `${clean.slice(0, 147)}...` : clean;
}

function selectionColorCssVars(colors: SelectionColorPreferences): Record<string, string> {
  return {
    '--selection-highlight-color': colors.highlight,
    '--selection-underline-color': colors.underline,
    '--selection-chat-color': colors.chat,
    '--selection-note-color': colors.note,
    '--selection-summary-color': colors.summary,
    '--selection-translate-color': colors.translate
  };
}

function shouldRefreshOpenNoteDraft(current: NoteDocument, latest: NoteDocument): boolean {
  if (current.id !== latest.id || !isPendingGeneratedNoteDraft(current)) {
    return false;
  }

  return latest.markdown !== current.markdown ||
    latest.title !== current.title ||
    latest.pageStart !== current.pageStart ||
    latest.pageEnd !== current.pageEnd;
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function conversationMatchesMark(conversation: Conversation, mark: PdfMark): boolean {
  return Boolean(conversation.anchor && anchorMatchesMark(conversation.anchor, mark));
}

function noteMatchesMark(note: NoteDocument, mark: PdfMark): boolean {
  return Boolean(note.anchor && anchorMatchesMark(note.anchor, mark));
}

function anchorMatchesMark(anchor: TextAnchor, mark: PdfMark): boolean {
  if (anchor.pageNumber !== mark.pageNumber) {
    return false;
  }

  if (anchor.quote.trim() && mark.quote.trim() && anchor.quote.trim() === mark.quote.trim()) {
    return true;
  }

  return anchor.rects.length === mark.areas.length && anchor.rects.every((rect, index) => {
    const area = mark.areas[index];
    return Boolean(
      area &&
      rect.pageNumber === area.pageIndex + 1 &&
      closeTo(rect.left, area.left) &&
      closeTo(rect.top, area.top) &&
      closeTo(rect.width, area.width) &&
      closeTo(rect.height, area.height)
    );
  });
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

function closeTo(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

function filterConversations(conversations: Conversation[], activePage: number): Conversation[] {
  const base = conversations.filter((conversation) => conversation.pageNumber === activePage);
  const sorted = [...base].sort((left, right) => {
    const leftOnPage = left.pageNumber === activePage ? 0 : 1;
    const rightOnPage = right.pageNumber === activePage ? 0 : 1;
    return leftOnPage - rightOnPage || right.updatedAt.localeCompare(left.updatedAt);
  });

  return sorted;
}

function createPdfDocumentParams(source: PdfSourceDescriptor): DocumentInitParameters {
  return {
    range: new ElectronPdfRangeTransport(source),
    length: source.fileSize,
    rangeChunkSize: pdfRangeChunkSize,
    disableStream: true,
    disableAutoFetch: true,
    useSystemFonts: true,
    isEvalSupported: false
  };
}

class ElectronPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private aborted = false;

  constructor(private readonly source: PdfSourceDescriptor) {
    super(
      source.fileSize,
      source.initialData ? new Uint8Array(source.initialData.slice(0)) : null,
      true,
      source.fileName
    );
  }

  override requestDataRange(begin: number, end: number): void {
    if (this.aborted) {
      return;
    }

    void window.sidelight
      .readPdfRange({
        documentId: this.source.documentId,
        begin,
        end
      })
      .then((buffer) => {
        if (!this.aborted) {
          this.onDataRange(begin, new Uint8Array(buffer));
          this.onDataProgress(Math.min(end, this.source.fileSize), this.source.fileSize);
        }
      })
      .catch((error: unknown) => {
        console.error('PDF range read failed', error);
      });
  }

  override abort(): void {
    this.aborted = true;
  }
}

async function loadPdfOutline(pdfDocument: PDFDocumentProxy): Promise<PdfOutlineItem[]> {
  const rawOutline = (await pdfDocument.getOutline()) as PdfJsOutlineNode[] | null;
  if (!rawOutline?.length) {
    return [];
  }

  return flattenOutline(pdfDocument, rawOutline, 0, []);
}

async function flattenOutline(
  pdfDocument: PDFDocumentProxy,
  items: PdfJsOutlineNode[],
  level: number,
  parents: number[]
): Promise<PdfOutlineItem[]> {
  const flattened: PdfOutlineItem[] = [];

  for (const [index, item] of items.entries()) {
    const path = [...parents, index];
    const pageNumber = await pageNumberForDestination(pdfDocument, item.dest);
    flattened.push({
      id: path.join('.'),
      title: item.title || 'Untitled',
      level,
      dest: item.dest,
      pageNumber
    });

    if (item.items?.length) {
      flattened.push(...(await flattenOutline(pdfDocument, item.items, level + 1, path)));
    }
  }

  return flattened;
}

async function pageNumberForDestination(
  pdfDocument: PDFDocumentProxy,
  dest: string | unknown[] | null
): Promise<number | undefined> {
  if (!dest) {
    return undefined;
  }

  const explicitDest = typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest;
  const pageRef = explicitDest?.[0];
  if (typeof pageRef === 'number') {
    return pageRef + 1;
  }

  if (pageRef && typeof pageRef === 'object' && 'num' in pageRef && 'gen' in pageRef) {
    return (await pdfDocument.getPageIndex(pageRef as { num: number; gen: number })) + 1;
  }

  return undefined;
}

async function extractPdfTextForRange(
  pdfDocument: PDFDocumentProxy,
  pageStart: number,
  pageEnd: number
): Promise<string> {
  const start = Math.max(1, Math.floor(Math.min(pageStart, pageEnd)));
  const end = Math.min(pdfDocument.numPages, Math.max(start, Math.floor(Math.max(pageStart, pageEnd))));
  const pages: string[] = [];

  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push(`## Page ${pageNumber}\n${text}`);
  }

  return pages.join('\n\n');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function elementBoundsInCanvas(element: HTMLElement, canvas: HTMLElement): {
  height: number;
  left: number;
  top: number;
  width: number;
} {
  const elementRect = element.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  return {
    height: elementRect.height,
    left: elementRect.left - canvasRect.left,
    top: elementRect.top - canvasRect.top,
    width: elementRect.width
  };
}

function sanitizeWorkspaceBlockScale(value: unknown): number | undefined {
  const scale = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(scale) && scale > 0 ? scale : undefined;
}

function workspaceBlockPayloadWithLayoutScale(
  payload: Record<string, unknown> | undefined,
  layoutScale: number
): Record<string, unknown> {
  return {
    ...(payload ?? {}),
    layoutScale: sanitizeWorkspaceBlockScale(layoutScale) ?? 1
  };
}

function withWorkspaceBlockLayoutScale(block: WorkspaceBlock, layoutScale: number): WorkspaceBlock {
  return {
    ...block,
    payload: workspaceBlockPayloadWithLayoutScale(block.payload, layoutScale)
  };
}

function workspaceBlockCoordinateScale(
  block: WorkspaceBlock,
  pageScale: number,
  fallbackScale?: number
): number {
  return (
    sanitizeWorkspaceBlockScale(block.payload?.layoutScale) ??
    sanitizeWorkspaceBlockScale(fallbackScale) ??
    sanitizeWorkspaceBlockScale(pageScale) ??
    1
  );
}

function renderedWorkspaceBlockY(block: WorkspaceBlock, pageScale: number, coordinateScale: number): number {
  return block.y * ((sanitizeWorkspaceBlockScale(pageScale) ?? 1) / (sanitizeWorkspaceBlockScale(coordinateScale) ?? 1));
}

function readZoomAnchor(container: HTMLElement, clientX: number, clientY: number): ZoomAnchor {
  const containerRect = container.getBoundingClientRect();
  const offsetX = clamp(clientX - containerRect.left, 0, containerRect.width);
  const offsetY = clamp(clientY - containerRect.top, 0, containerRect.height);
  const page = pdfPageAtPoint(container, clientX, clientY);

  if (!page) {
    return {
      clientX,
      clientY,
      offsetX,
      offsetY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop
    };
  }

  const pageRect = page.getBoundingClientRect();
  return {
    clientX,
    clientY,
    offsetX,
    offsetY,
    scrollLeft: container.scrollLeft,
    scrollTop: container.scrollTop,
    pageNumber: page.dataset.pageNumber,
    pageWidth: pageRect.width,
    pageOffsetX: clientX - pageRect.left,
    pageOffsetY: clientY - pageRect.top
  };
}

function pdfPageAtPoint(container: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const directPage = target?.closest<HTMLElement>('.page[data-page-number]');
  if (directPage && container.contains(directPage)) {
    return directPage;
  }

  if (target?.closest('.reader-dock-lane, .workspace-block-card, .selection-toolbar, button, input, textarea, select, [contenteditable="true"]')) {
    return null;
  }

  const pages = Array.from(container.querySelectorAll<HTMLElement>('.page[data-page-number]'));
  return pages.find((page) => {
    const rect = page.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }) ?? null;
}

function readViewportZoomAnchor(container: HTMLElement, runtime: PdfRuntime): ZoomAnchor {
  const containerRect = container.getBoundingClientRect();
  const centerX = containerRect.left + containerRect.width / 2;
  const centerY = containerRect.top + containerRect.height / 2;
  const centeredAnchor = readZoomAnchor(container, centerX, centerY);
  if (centeredAnchor.pageNumber) {
    return centeredAnchor;
  }

  const currentPage = container.querySelector<HTMLElement>(`.page[data-page-number="${runtime.pdfViewer.currentPageNumber}"]`);
  if (currentPage) {
    const pageRect = currentPage.getBoundingClientRect();
    const clientX = clamp((Math.max(pageRect.left, containerRect.left) + Math.min(pageRect.right, containerRect.right)) / 2, containerRect.left, containerRect.right);
    const clientY = clamp((Math.max(pageRect.top, containerRect.top) + Math.min(pageRect.bottom, containerRect.bottom)) / 2, containerRect.top, containerRect.bottom);
    return readZoomAnchor(container, clientX, clientY);
  }

  return centeredAnchor;
}

function prepareZoomScrollSpace(container: HTMLElement, anchor: ZoomAnchor, scaleRatio: number): void {
  if (anchor.pageOffsetX === undefined || scaleRatio <= 1) {
    return;
  }

  const canvas = container.querySelector<HTMLElement>('.pdf-canvas');
  if (!canvas) {
    return;
  }

  const neededScrollLeft = anchor.scrollLeft + anchor.pageOffsetX * (scaleRatio - 1) + 24;
  const currentMaxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  if (neededScrollLeft <= currentMaxScrollLeft) {
    return;
  }

  const currentPaddingRight = Number.parseFloat(window.getComputedStyle(canvas).paddingRight) || 0;
  canvas.style.paddingRight = `${Math.ceil(currentPaddingRight + neededScrollLeft - currentMaxScrollLeft)}px`;
}

function restoreZoomAnchor(container: HTMLElement, anchor: ZoomAnchor, scaleRatio: number, onRestored?: () => void): void {
  const restore = (): void => {
    if (anchor.pageNumber && anchor.pageOffsetX !== undefined && anchor.pageOffsetY !== undefined) {
      const page = container.querySelector<HTMLElement>(`.page[data-page-number="${anchor.pageNumber}"]`);
      if (page) {
        const pageRect = page.getBoundingClientRect();
        container.scrollLeft += pageRect.left + anchor.pageOffsetX * scaleRatio - anchor.clientX;
        container.scrollTop += pageRect.top + anchor.pageOffsetY * scaleRatio - anchor.clientY;
        return;
      }
    }

    container.scrollLeft = anchor.scrollLeft * scaleRatio + anchor.offsetX * (scaleRatio - 1);
    container.scrollTop = anchor.scrollTop * scaleRatio + anchor.offsetY * (scaleRatio - 1);
  };

  window.requestAnimationFrame(() => {
    restore();
    window.requestAnimationFrame(() => {
      restore();
      onRestored?.();
    });
  });
}

function selectionFromWindow(viewerElement: HTMLDivElement | null): PdfSelectionPayload | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !viewerElement || selection.rangeCount === 0) {
    return undefined;
  }

  const range = selection.getRangeAt(0);
  if (!viewerElement.contains(range.commonAncestorContainer)) {
    return undefined;
  }

  const quote = selection.toString().replace(/\s+/g, ' ').trim();
  if (!quote) {
    return undefined;
  }

  const pageElements = Array.from(viewerElement.querySelectorAll<HTMLElement>('.page[data-page-number]'));
  const areas: PdfMarkArea[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 1 || rect.height < 1) {
      continue;
    }

    for (const pageElement of pageElements) {
      const pageRect = pageElement.getBoundingClientRect();
      if (!rectsIntersect(rect, pageRect)) {
        continue;
      }

      const clippedLeft = Math.max(rect.left, pageRect.left);
      const clippedTop = Math.max(rect.top, pageRect.top);
      const clippedRight = Math.min(rect.right, pageRect.right);
      const clippedBottom = Math.min(rect.bottom, pageRect.bottom);
      const pageNumber = Number(pageElement.dataset.pageNumber);
      areas.push({
        pageIndex: pageNumber - 1,
        left: ((clippedLeft - pageRect.left) / pageRect.width) * 100,
        top: ((clippedTop - pageRect.top) / pageRect.height) * 100,
        width: ((clippedRight - clippedLeft) / pageRect.width) * 100,
        height: ((clippedBottom - clippedTop) / pageRect.height) * 100
      });
      break;
    }
  }

  const uniqueAreas = dedupeAreas(areas);
  if (uniqueAreas.length === 0) {
    return undefined;
  }

  return {
    quote,
    areas: uniqueAreas,
    pageNumber: uniqueAreas[0].pageIndex + 1
  };
}

function rectsIntersect(left: DOMRect, right: DOMRect): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function dedupeAreas(areas: PdfMarkArea[]): PdfMarkArea[] {
  const seen = new Set<string>();
  return areas.filter((area) => {
    const key = [
      area.pageIndex,
      area.left.toFixed(2),
      area.top.toFixed(2),
      area.width.toFixed(2),
      area.height.toFixed(2)
    ].join(':');
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function renderMarkLayers(
  viewerElement: HTMLDivElement,
  marks: PdfMark[],
  selectionColors: SelectionColorPreferences,
  onMarkClick: (markId: string, event: MouseEvent) => void
): void {
  viewerElement.querySelectorAll('.sidelight-mark-layer').forEach((layer) => layer.remove());

  const marksByPage = new Map<number, PdfMark[]>();
  for (const mark of marks) {
    for (const area of mark.areas) {
      const pageNumber = area.pageIndex + 1;
      marksByPage.set(pageNumber, [...(marksByPage.get(pageNumber) ?? []), mark]);
    }
  }

  for (const pageElement of Array.from(viewerElement.querySelectorAll<HTMLElement>('.page[data-page-number]'))) {
    const pageNumber = Number(pageElement.dataset.pageNumber);
    const pageMarks = marksByPage.get(pageNumber);
    if (!pageMarks?.length) {
      continue;
    }

    const layer = document.createElement('div');
    layer.className = 'sidelight-mark-layer';
    pageElement.appendChild(layer);

    const renderedAreas = new Set<string>();
    for (const mark of pageMarks) {
      for (const [areaIndex, area] of mark.areas.entries()) {
        if (area.pageIndex + 1 !== pageNumber) {
          continue;
        }

        const key = `${mark.id}:${areaIndex}`;
        if (renderedAreas.has(key)) {
          continue;
        }

        renderedAreas.add(key);
        const node = document.createElement('button');
        const colorRole = mark.colorRole ?? mark.kind;
        node.type = 'button';
        node.className = [
          'pdf-mark',
          mark.kind === 'underline' ? 'pdf-mark--underline' : '',
          `pdf-mark--${colorRole}`
        ].filter(Boolean).join(' ');
        node.title = mark.quote;
        node.dataset.colorRole = colorRole;
        node.style.setProperty('--mark-color', selectionColorForRole(colorRole, selectionColors));
        node.style.left = `${area.left}%`;
        node.style.top = `${area.top}%`;
        node.style.width = `${area.width}%`;
        node.style.height = `${area.height}%`;
        node.addEventListener('click', (event) => {
          event.stopPropagation();
          onMarkClick(mark.id, event);
        });
        layer.appendChild(node);
      }
    }
  }
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

async function addImageAttachments(
  files: FileList | null,
  setAttachments: Dispatch<SetStateAction<ConversationAttachment[]>>
): Promise<void> {
  const attachments = await imageFilesToAttachments(files);
  if (attachments.length === 0) {
    return;
  }

  setAttachments((current) => [...current, ...attachments]);
}

async function imageFilesToAttachments(files: FileList | File[] | null): Promise<ConversationAttachment[]> {
  const imageFiles = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    return [];
  }

  return Promise.all(
    imageFiles.map(async (file) => ({
      id: createId('image'),
      kind: 'image' as const,
      name: file.name,
      mimeType: file.type,
      dataUrl: await readFileAsDataUrl(file),
      createdAt: new Date().toISOString()
    }))
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Image could not be read.')));
    reader.readAsDataURL(file);
  });
}

function hasImageFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'));
}

function shouldIgnoreCanvasFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], .reader-dock-lane, .workspace-block-layer, .settings-overlay, .floating-settings'
    )
  );
}

function shouldIgnoreImagePinPaste(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], .chat-composer, .dock-chat-panel, .dock-note-editor-panel, .reader-dock-lane, .settings-overlay, .floating-settings'
    )
  );
}

function selectionFromMark(mark: PdfMark): PdfSelectionPayload {
  return {
    quote: mark.quote,
    areas: mark.areas,
    pageNumber: mark.pageNumber
  };
}
