import {
  type Dispatch,
  type FormEvent,
  type ReactElement,
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
  BookmarkPlus,
  ChevronsLeft,
  ChevronsRight,
  Check,
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
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import {
  AiMode,
  Conversation,
  ConversationAttachment,
  NoteDocument,
  PdfDocumentMeta,
  PdfMark,
  PdfMarkArea,
  PdfMarkKind,
  PdfSourceDescriptor,
  PdfUserBookmark,
  pdfRangeChunkSize
} from '../../shared/domain';
import { createId } from '../../shared/ids';
import { MarkdownView } from './MarkdownView';

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
  source?: PdfSourceDescriptor;
  meta?: PdfDocumentMeta;
  activePage: number;
  marks: PdfMark[];
  bookmarks: PdfUserBookmark[];
  conversations: Conversation[];
  activeConversation?: Conversation;
  activeConversationId?: string;
  note?: NoteDocument;
  transientAid?: ReaderTransientAid;
  chatOpen: boolean;
  busy: boolean;
  onOpenPdf(): void;
  onOpenSettings(): void;
  onLoadDocument(documentId: string): void;
  onPageChange(pageNumber: number): void;
  onCreateMark(kind: PdfMarkKind, selection: PdfSelectionPayload): void;
  onSelectionAction(mode: AiMode, selection: PdfSelectionPayload): void;
  onAddBookmark(pageNumber: number): void;
  onDeleteBookmark(bookmarkId: string): void;
  onDeleteMark(markId: string): void;
  onCreatePageChat(pageNumber: number): void;
  onOpenConversation(conversationId: string): void;
  onCloseConversation(): void;
  onCloseTransientAid(): void;
  onSendMessage(conversationId: string, prompt: string, attachments: ConversationAttachment[]): void;
  onSaveNote(markdown: string): void;
}

type DockTab = 'chat' | 'notes' | 'bookmarks' | 'marks';
type LeftTab = 'library' | 'outline';
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

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

export function PdfReader({
  documents,
  source,
  meta,
  activePage,
  marks,
  bookmarks,
  conversations,
  activeConversation,
  activeConversationId,
  note,
  transientAid,
  chatOpen,
  busy,
  onOpenPdf,
  onOpenSettings,
  onLoadDocument,
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
  onSaveNote
}: PdfReaderProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PdfRuntime>();
  const marksRef = useRef(marks);
  const onPageChangeRef = useRef(onPageChange);

  const [status, setStatus] = useState<LoadStatus>('idle');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [pageDraft, setPageDraft] = useState(String(activePage));
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [selectionPopover, setSelectionPopover] = useState<SelectionPopover>();
  const [activeMark, setActiveMark] = useState<ActiveMarkPopover>();
  const [leftTab, setLeftTab] = useState<LeftTab>('outline');
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>('chat');
  const [searchQuery, setSearchQuery] = useState('');

  marksRef.current = marks;
  onPageChangeRef.current = onPageChange;

  const visibleConversations = useMemo(
    () => filterConversations(conversations, activePage),
    [activePage, conversations]
  );
  const pageConversationCount = conversations.filter((conversation) => conversation.pageNumber === activePage).length;
  const pageMarks = marks.filter((mark) => mark.pageNumber === activePage);
  const hasOpenDock = (chatOpen && activeConversation) || Boolean(transientAid);

  const renderMarks = useCallback(() => {
    if (!viewerRef.current) {
      return;
    }

    renderMarkLayers(viewerRef.current, marksRef.current, (markId, event) => {
      setSelectionPopover(undefined);
      setActiveMark({
        markId,
        left: Math.max(12, Math.min(event.clientX + 10, window.innerWidth - 312)),
        top: Math.max(12, Math.min(event.clientY + 10, window.innerHeight - 220))
      });
    });
  }, []);

  useEffect(() => {
    setPageDraft(String(activePage));
  }, [activePage]);

  useEffect(() => {
    renderMarks();
  }, [marks, renderMarks, scale, totalPages]);

  useEffect(() => {
    if (status !== 'ready') {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const runtime = runtimeRef.current;
      const viewer = viewerRef.current;
      const firstPage = viewer?.querySelector<HTMLElement>('.page');
      if (!runtime || !viewer || !firstPage) {
        return;
      }

      const availableWidth = Math.max(240, viewer.clientWidth - 28);
      const pageWidth = firstPage.getBoundingClientRect().width;
      if (pageWidth > availableWidth) {
        runtime.pdfViewer.currentScale = Math.max(0.25, runtime.pdfViewer.currentScale * (availableWidth / pageWidth));
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [dockTab, hasOpenDock, leftPanelOpen, status]);

  const handleViewerWheel = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime || status !== 'ready') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.deltaY < 0) {
      runtime.pdfViewer.increaseScale({ drawingDelay: 80 });
    } else {
      runtime.pdfViewer.decreaseScale({ drawingDelay: 80 });
    }
  }, [status]);

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
    if (!runtime || status !== 'ready' || runtime.pdfViewer.currentPageNumber === activePage) {
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
    viewerRef.current.textContent = '';

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
      setPageDraft(String(pageNumber));
      onPageChangeRef.current(pageNumber);
    });

    eventBus.on('scalechanging', (event: { scale: number }) => {
      if (cancelled) {
        return;
      }

      setScale(event.scale);
      window.requestAnimationFrame(renderMarks);
    });

    eventBus.on('pagerendered', renderMarks);
    eventBus.on('pagesloaded', renderMarks);

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

    runtime.pdfViewer.currentPageNumber = pageNumber;
    runtime.pdfViewer.scrollPageIntoView({ pageNumber });
  }, []);

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
    const pageNumber = Number(pageDraft);
    if (Number.isInteger(pageNumber)) {
      jumpToPage(pageNumber);
    }
  };

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault();
    executeSearch(false);
  };

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
            activeDocumentId={meta?.id}
            activePage={activePage}
            documents={documents}
            leftTab={leftTab}
            loadProgress={loadProgress}
            outline={outline}
            outlineBusy={outlineBusy}
            pageDraft={pageDraft}
            scale={scale}
            searchQuery={searchQuery}
            status={status}
            title={meta?.title}
            totalPages={totalPages}
            onAddBookmark={() => onAddBookmark(activePage)}
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
            onCollapse={() => setLeftPanelOpen(false)}
            onLoadDocument={onLoadDocument}
            onOpenPdf={onOpenPdf}
            onOpenSettings={onOpenSettings}
            onPageDraftChange={setPageDraft}
            onSearchQueryChange={setSearchQuery}
            onSubmitPageJump={submitPageJump}
            onSubmitSearch={submitSearch}
            onTabChange={setLeftTab}
            onZoomIn={() => runtimeRef.current?.pdfViewer.increaseScale({ drawingDelay: 100 })}
            onZoomOut={() => runtimeRef.current?.pdfViewer.decreaseScale({ drawingDelay: 100 })}
          />
        </SplitterPanel>

        <SplitterPanel className="reader-document-panel" size={80} minSize={56}>
          <div className={hasOpenDock ? 'pdf-stage has-open-dock' : 'pdf-stage has-float-dock'} ref={stageRef}>
            {!leftPanelOpen && (
              <Button
                type="button"
                text
                rounded
                className="left-panel-reopen"
                title="Show sidebar"
                aria-label="Show sidebar"
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
                  tabIndex={0}
                >
                  <div className="pdfViewer" ref={viewerRef} />

                  {status !== 'ready' && (
                    <PdfState
                      status={status}
                      progress={loadProgress}
                      error={loadError}
                    />
                  )}
                </div>

                {selectionPopover && (
                  <SelectionToolbar
                    popover={selectionPopover}
                    onCreateMark={(kind, selection) => {
                      onCreateMark(kind, selection);
                      clearSelection();
                      setSelectionPopover(undefined);
                    }}
                    onSelectionAction={(mode, selection) => {
                      onSelectionAction(mode, selection);
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
                    onClose={() => setActiveMark(undefined)}
                    onDelete={(markId) => {
                      onDeleteMark(markId);
                      setActiveMark(undefined);
                    }}
                    onSelectionAction={(mode, mark) => {
                      onSelectionAction(mode, selectionFromMark(mark));
                      setActiveMark(undefined);
                    }}
                  />
                )}

                <div className="reader-dock-lane">
                  <ReaderDock
                    activeConversation={activeConversation}
                    activeConversationId={activeConversationId}
                    activePage={activePage}
                    bookmarks={bookmarks}
                    busy={busy}
                    chatOpen={chatOpen}
                    conversations={visibleConversations}
                    marks={pageMarks}
                    note={note}
                    pageConversationCount={pageConversationCount}
                    tab={dockTab}
                    transientAid={transientAid}
                    onAddBookmark={() => onAddBookmark(activePage)}
                    onCloseConversation={onCloseConversation}
                    onCloseTransientAid={onCloseTransientAid}
                    onCreatePageChat={() => onCreatePageChat(activePage)}
                    onDeleteBookmark={onDeleteBookmark}
                    onDeleteMark={onDeleteMark}
                    onJumpToPage={jumpToPage}
                    onOpenConversation={onOpenConversation}
                    onSaveNote={onSaveNote}
                    onSendMessage={onSendMessage}
                    onTabChange={setDockTab}
                  />
                </div>
              </>
            ) : (
              <section className="reader-empty reader-empty--embedded">
                <div className="reader-empty__mark">
                  <FileText size={42} strokeWidth={1.5} />
                </div>
                <h1>Sidelight</h1>
                <p>Open a PDF to start reading with durable highlights, bookmarks, and anchored AI conversations.</p>
                <button className="primary-button" type="button" onClick={onOpenPdf}>
                  Open PDF
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
  activeDocumentId,
  activePage,
  documents,
  leftTab,
  loadProgress,
  outline,
  outlineBusy,
  pageDraft,
  scale,
  searchQuery,
  status,
  title,
  totalPages,
  onAddBookmark,
  onFindNext,
  onFindPrevious,
  onFitWidth,
  onJumpToDestination,
  onJumpToPage,
  onCollapse,
  onLoadDocument,
  onOpenPdf,
  onOpenSettings,
  onPageDraftChange,
  onSearchQueryChange,
  onSubmitPageJump,
  onSubmitSearch,
  onTabChange,
  onZoomIn,
  onZoomOut
}: {
  activeDocumentId?: string;
  activePage: number;
  documents: PdfDocumentMeta[];
  leftTab: LeftTab;
  loadProgress: number;
  outline: PdfOutlineItem[];
  outlineBusy: boolean;
  pageDraft: string;
  scale: number;
  searchQuery: string;
  status: LoadStatus;
  title?: string;
  totalPages: number;
  onAddBookmark(): void;
  onFindNext(): void;
  onFindPrevious(): void;
  onFitWidth(): void;
  onJumpToDestination(dest: string | unknown[]): void;
  onJumpToPage(pageNumber: number): void;
  onCollapse(): void;
  onLoadDocument(documentId: string): void;
  onOpenPdf(): void;
  onOpenSettings(): void;
  onPageDraftChange(value: string): void;
  onSearchQueryChange(value: string): void;
  onSubmitPageJump(event: FormEvent): void;
  onSubmitSearch(event: FormEvent): void;
  onTabChange(tab: LeftTab): void;
  onZoomIn(): void;
  onZoomOut(): void;
}): ReactElement {
  const hasDocument = Boolean(activeDocumentId);

  return (
    <aside className="left-panel">
      <header className="left-panel__top">
        <div className="reader-title-block">
          <span>Sidelight</span>
          <strong title={title ?? 'No PDF open'}>{title ?? 'No PDF open'}</strong>
          <small>
            {status === 'loading'
              ? `Loading ${Math.round(loadProgress)}%`
              : hasDocument
                ? `Page ${activePage}${totalPages ? ` / ${totalPages}` : ''}`
                : 'Local PDF workspace'}
          </small>
        </div>
        <div className="left-panel__actions">
          <button className="icon-button" type="button" title="Hide sidebar" onClick={onCollapse}>
            <ChevronsLeft size={16} />
          </button>
          <button className="icon-button" type="button" title="Open PDF" onClick={onOpenPdf}>
            <FolderOpen size={16} />
          </button>
          <button className="icon-button" type="button" title="AI settings" onClick={onOpenSettings}>
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
          Library
        </button>
        <span>/</span>
        <button
          type="button"
          className={leftTab === 'outline' ? 'is-active' : ''}
          disabled={!hasDocument}
          onClick={() => onTabChange('outline')}
        >
          <ListTree size={14} />
          Outline
        </button>
      </nav>

      <form className="panel-search" onSubmit={onSubmitSearch}>
        <Search size={15} />
        <InputText
          value={searchQuery}
          type="search"
          placeholder="Search in PDF"
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
            aria-label="Current page"
            onChange={(event) => onPageDraftChange(event.target.value.replace(/[^\d]/g, ''))}
          />
          <span>/</span>
          <span>{totalPages || '-'}</span>
        </form>
        <div className="zoom-control">
          <button className="icon-button" type="button" title="Zoom out" disabled={!hasDocument} onClick={onZoomOut}>
            <Minus size={15} />
          </button>
          <button className="zoom-readout" type="button" title="Fit to width" disabled={!hasDocument} onClick={onFitWidth}>
            {Math.round(scale * 100)}%
          </button>
          <button className="icon-button" type="button" title="Zoom in" disabled={!hasDocument} onClick={onZoomIn}>
            <Plus size={15} />
          </button>
        </div>
        <button className="icon-button" type="button" title="Bookmark page" disabled={!hasDocument} onClick={onAddBookmark}>
          <BookmarkPlus size={15} />
        </button>
      </div>

      <div className="left-panel__body">
        {leftTab === 'library' && (
          <div className="library-panel">
            <button type="button" className="open-document-button" onClick={onOpenPdf}>
              <FilePlus2 size={16} />
              Open PDF
            </button>
            <div className="document-list">
              {documents.length === 0 && <span className="empty-line">No PDFs in the library yet.</span>}
              {documents.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  title={document.title}
                  className={activeDocumentId === document.id ? 'document-row is-active' : 'document-row'}
                  onClick={() => onLoadDocument(document.id)}
                >
                  <FileText size={15} />
                  <span>{document.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {leftTab === 'outline' && (
          <div className="outline-list">
            {outline.length === 0 && (
              <span className="empty-line">{outlineBusy ? 'Reading PDF outline...' : 'No outline in this PDF.'}</span>
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
  error
}: {
  status: LoadStatus;
  progress: number;
  error?: string;
}): ReactElement {
  if (status === 'error') {
    return (
      <div className="pdf-state pdf-state--error">
        <strong>PDF failed to load</strong>
        <small>{error ?? 'The document could not be read by PDF.js.'}</small>
      </div>
    );
  }

  return (
    <div className="pdf-state">
      <div className="pdf-state__bar">
        <span style={{ width: `${Math.max(4, Math.min(100, progress))}%` }} />
      </div>
      <strong>Loading PDF</strong>
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
  chatOpen,
  conversations,
  marks,
  note,
  pageConversationCount,
  tab,
  transientAid,
  onAddBookmark,
  onCloseConversation,
  onCloseTransientAid,
  onCreatePageChat,
  onDeleteBookmark,
  onDeleteMark,
  onJumpToPage,
  onOpenConversation,
  onSaveNote,
  onSendMessage,
  onTabChange
}: {
  activeConversation?: Conversation;
  activeConversationId?: string;
  activePage: number;
  bookmarks: PdfUserBookmark[];
  busy: boolean;
  chatOpen: boolean;
  conversations: Conversation[];
  marks: PdfMark[];
  note?: NoteDocument;
  pageConversationCount: number;
  tab: DockTab;
  transientAid?: ReaderTransientAid;
  onAddBookmark(): void;
  onCloseConversation(): void;
  onCloseTransientAid(): void;
  onCreatePageChat(): void;
  onDeleteBookmark(bookmarkId: string): void;
  onDeleteMark(markId: string): void;
  onJumpToPage(pageNumber: number): void;
  onOpenConversation(conversationId: string): void;
  onSaveNote(markdown: string): void;
  onSendMessage(conversationId: string, prompt: string, attachments: ConversationAttachment[]): void;
  onTabChange(tab: DockTab): void;
}): ReactElement {
  const panelOpen = (chatOpen && activeConversation) || transientAid;

  return (
    <aside className={panelOpen ? 'reader-float-dock is-chat-open' : 'reader-float-dock'}>
      <nav className="dock-iconbar" aria-label="Reading side panel">
        <span className="dock-iconbar__group">
          <Button
            type="button"
            text
            rounded
            className={tab === 'chat' ? 'is-active' : ''}
            title="Chats"
            aria-label="Chats"
            onClick={() => onTabChange('chat')}
          >
            <MessageCircle size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={tab === 'notes' ? 'is-active' : ''}
            title="Notes"
            aria-label="Notes"
            onClick={() => onTabChange('notes')}
          >
            <FileText size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={tab === 'bookmarks' ? 'is-active' : ''}
            title="Bookmarks"
            aria-label="Bookmarks"
            onClick={() => onTabChange('bookmarks')}
          >
            <BookmarkPlus size={17} />
          </Button>
          <Button
            type="button"
            text
            rounded
            className={tab === 'marks' ? 'is-active' : ''}
            title="Highlights"
            aria-label="Highlights"
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
            title="New page chat"
            aria-label="New page chat"
            onClick={onCreatePageChat}
          >
            <Plus size={17} />
          </Button>
        </span>
      </nav>

      {chatOpen && activeConversation ? (
        <DockChatPanel
          busy={busy}
          conversation={activeConversation}
          onClose={onCloseConversation}
          onSend={(prompt, attachments) => onSendMessage(activeConversation.id, prompt, attachments)}
        />
      ) : transientAid ? (
        <TransientAidPanel aid={transientAid} onClose={onCloseTransientAid} />
      ) : (
        <>
          {tab === 'chat' && (
            <div className="dock-section dock-section--page-list" key={`chat:${activePage}`}>
              <div className="trace-list-header">
                <span>Page {activePage}</span>
                <Badge value={pageConversationCount} />
              </div>
              <ScrollPanel className="trace-scroll">
                <div className="trace-list">
                  {conversations.length === 0 && <span className="empty-line">No conversations on this document yet.</span>}
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

          {tab === 'notes' && <DockNotesPanel note={note} onSave={onSaveNote} />}

          {tab === 'bookmarks' && (
            <div className="dock-section">
              <button type="button" className="dock-action" onClick={onAddBookmark}>
                <BookmarkPlus size={15} />
                Bookmark current page
              </button>
              <div className="bookmark-list">
                {bookmarks.length === 0 && <span className="empty-line">No page bookmarks yet.</span>}
                {bookmarks.map((bookmark) => (
                  <div className="bookmark-row" key={bookmark.id}>
                    <button type="button" onClick={() => onJumpToPage(bookmark.pageNumber)}>
                      <strong>p.{bookmark.pageNumber}</strong>
                      <span>{bookmark.label}</span>
                    </button>
                    <button type="button" title="Remove bookmark" onClick={() => onDeleteBookmark(bookmark.id)}>
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
                {marks.length === 0 && <span className="empty-line">No highlights on this page yet.</span>}
                {marks.map((mark) => (
                  <article className="mark-card" key={mark.id}>
                    <header>
                      <span>{mark.kind}</span>
                      <button type="button" title="Delete mark" onClick={() => onDeleteMark(mark.id)}>
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
  onClose
}: {
  aid: ReaderTransientAid;
  onClose(): void;
}): ReactElement {
  const Icon = aid.mode === 'translate' ? Languages : Sparkles;
  const title = aid.mode === 'translate' ? 'Translation' : 'Summary';

  return (
    <section className="transient-aid-panel">
      <header>
        <div>
          <span>Temporary reading aid</span>
          <strong>
            <Icon size={15} />
            {title}
          </strong>
        </div>
        <Badge value={`p.${aid.pageNumber}`} />
        <Button type="button" text rounded className="panel-close-button" title="Close" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </Button>
      </header>

      <blockquote className="transient-aid-panel__quote">{aid.quote}</blockquote>

      <div className="transient-aid-panel__body">
        {aid.error && <span className="transient-aid-panel__error">AI request failed: {aid.error}</span>}
        {aid.content ? <MarkdownView>{aid.content}</MarkdownView> : <span className="typing-dot">Thinking...</span>}
        {aid.busy && aid.content && <span className="typing-dot">Thinking...</span>}
      </div>
    </section>
  );
}

function DockNotesPanel({
  note,
  onSave
}: {
  note?: NoteDocument;
  onSave(markdown: string): void;
}): ReactElement {
  const [draft, setDraft] = useState(note?.markdown ?? '');

  useEffect(() => {
    setDraft(note?.markdown ?? '');
  }, [note?.id, note?.markdown]);

  return (
    <form
      className="dock-section notes-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Markdown notes"
      />
      <button className="dock-action" type="submit" disabled={!note}>
        <Check size={15} />
        Save notes
      </button>
    </form>
  );
}

function DockChatPanel({
  busy,
  conversation,
  onClose,
  onSend
}: {
  busy: boolean;
  conversation: Conversation;
  onClose(): void;
  onSend(prompt: string, attachments: ConversationAttachment[]): void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ConversationAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <section className="dock-chat-panel">
      <header>
        <div className="dock-chat-panel__title">
          <span>Conversation</span>
          <strong>{conversation.summary.title}</strong>
        </div>
        <Badge value={`p.${conversation.pageNumber ?? '-'}`} />
        <Button
          type="button"
          text
          rounded
          className="panel-close-button"
          title="Collapse chat"
          aria-label="Collapse chat"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>

      {conversation.anchor && <blockquote className="dock-chat-anchor">{conversation.anchor.quote}</blockquote>}

      <ScrollPanel className="dock-chat-messages">
        <div className="dock-chat-transcript">
          {conversation.messages.length === 0 && (
            <div className="dock-chat-empty">
              <MessageCircle size={21} />
              <span>{conversation.anchor ? 'Ask about the selected passage.' : 'Ask about this page.'}</span>
            </div>
          )}
          {conversation.messages.map((message) => (
            <article key={message.id} className={`chat-message chat-message--${message.role}`}>
              {message.role === 'assistant' && <div className="chat-avatar">S</div>}
              <div className="chat-message__content">
                <div className="chat-message__role">{message.role === 'assistant' ? 'Sidelight' : 'You'}</div>
                {message.attachments?.length ? (
                  <div className="chat-attachments">
                    {message.attachments.map((attachment) => (
                      <img key={attachment.id} src={attachment.dataUrl} alt={attachment.name} />
                    ))}
                  </div>
                ) : null}
                {message.content ? (
                  <div className="chat-bubble">
                    <MarkdownView>{message.content}</MarkdownView>
                  </div>
                ) : (
                  <span className="typing-dot">Thinking...</span>
                )}
              </div>
            </article>
          ))}
        </div>
      </ScrollPanel>

      <form className="chat-composer" onSubmit={submit}>
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.id}>
                <img src={attachment.dataUrl} alt={attachment.name} />
                <button
                  type="button"
                  title="Remove image"
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
              void addImageAttachments(event.currentTarget.files, setAttachments);
              event.currentTarget.value = '';
            }}
          />
          <Button
            type="button"
            text
            rounded
            className="chat-icon-button"
            title="Attach images"
            aria-label="Attach images"
            onClick={() => fileInputRef.current?.click()}
          >
            <FilePlus2 size={17} />
          </Button>
          <textarea
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message Sidelight"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            type="submit"
            rounded
            className="chat-send-button"
            title="Send"
            aria-label="Send"
            disabled={busy || (!draft.trim() && attachments.length === 0)}
          >
            <Check size={17} />
          </Button>
        </div>
      </form>
    </section>
  );
}

function SelectionToolbar({
  popover,
  onCreateMark,
  onSelectionAction,
  onClose
}: {
  popover: SelectionPopover;
  onCreateMark(kind: PdfMarkKind, selection: PdfSelectionPayload): void;
  onSelectionAction(mode: AiMode, selection: PdfSelectionPayload): void;
  onClose(): void;
}): ReactElement {
  const { selection } = popover;

  return (
    <div className="selection-toolbar" style={{ left: popover.left, top: popover.top }}>
      <button type="button" title="Highlight" onClick={() => onCreateMark('highlight', selection)}>
        <Highlighter size={15} />
        Highlight
      </button>
      <button type="button" title="Underline" onClick={() => onCreateMark('underline', selection)}>
        <Sparkles size={15} />
        Underline
      </button>
      <button type="button" title="Open chat" onClick={() => onSelectionAction('ask', selection)}>
        <MessageCircle size={15} />
        Chat
      </button>
      <button type="button" title="Summarize" onClick={() => onSelectionAction('summarize', selection)}>
        <Sparkles size={15} />
        Summary
      </button>
      <button type="button" title="Translate" onClick={() => onSelectionAction('translate', selection)}>
        <Languages size={15} />
        Translate
      </button>
      <button type="button" title="Close" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function MarkPopover({
  mark,
  left,
  top,
  onClose,
  onDelete,
  onSelectionAction
}: {
  mark?: PdfMark;
  left: number;
  top: number;
  onClose(): void;
  onDelete(markId: string): void;
  onSelectionAction(mode: AiMode, mark: PdfMark): void;
}): ReactElement | null {
  if (!mark) {
    return null;
  }

  return (
    <section className="mark-popover" style={{ left, top }}>
      <header>
        <span>p.{mark.pageNumber}</span>
        <button type="button" className="icon-button" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <p>{mark.quote}</p>
      <div className="mark-popover__actions">
        <button type="button" title="Open chat" onClick={() => onSelectionAction('ask', mark)}>
          <MessageCircle size={15} />
          Chat
        </button>
        <button type="button" title="Summarize" onClick={() => onSelectionAction('summarize', mark)}>
          <Sparkles size={15} />
          Summary
        </button>
        <button type="button" title="Translate" onClick={() => onSelectionAction('translate', mark)}>
          <Languages size={15} />
          Translate
        </button>
        <button type="button" title="Delete mark" onClick={() => onDelete(mark.id)}>
          <Trash2 size={15} />
          Delete
        </button>
      </div>
    </section>
  );
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
        node.type = 'button';
        node.className = mark.kind === 'underline' ? 'pdf-mark pdf-mark--underline' : 'pdf-mark';
        node.title = mark.quote;
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
  const imageFiles = Array.from(files ?? []).filter((file) => file.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    return;
  }

  const attachments = await Promise.all(
    imageFiles.map(async (file) => ({
      id: createId('image'),
      kind: 'image' as const,
      name: file.name,
      mimeType: file.type,
      dataUrl: await readFileAsDataUrl(file),
      createdAt: new Date().toISOString()
    }))
  );

  setAttachments((current) => [...current, ...attachments]);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Image could not be read.')));
    reader.readAsDataURL(file);
  });
}

function selectionFromMark(mark: PdfMark): PdfSelectionPayload {
  return {
    quote: mark.quote,
    areas: mark.areas,
    pageNumber: mark.pageNumber
  };
}
