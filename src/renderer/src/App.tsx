import { type FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Check,
  Clock3,
  FileText,
  FolderOpen,
  Library,
  MessageCircle,
  Search,
  Settings,
  Tags,
  X
} from 'lucide-react';
import {
  AiProviderConfig,
  AiMode,
  Conversation,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
  NoteDocument,
  PdfMark,
  PdfMarkKind,
  PdfDocumentMeta,
  PdfSourceDescriptor,
  PdfUserBookmark,
  SafeAiProviderConfig,
  TextAnchor
} from '../../shared/domain';
import { createId } from '../../shared/ids';
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
  const [activeDocument, setActiveDocument] = useState<PdfDocumentMeta>();
  const [pdfSource, setPdfSource] = useState<PdfSourceDescriptor>();
  const [currentPage, setCurrentPage] = useState(1);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [marks, setMarks] = useState<PdfMark[]>([]);
  const [bookmarks, setBookmarks] = useState<PdfUserBookmark[]>([]);
  const [note, setNote] = useState<NoteDocument>();
  const [aiProvider, setAiProvider] = useState<SafeAiProviderConfig>();
  const [transientAid, setTransientAid] = useState<TransientAidState>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadedReaderDocumentRef = useRef<string | undefined>(undefined);
  const readingStateTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void refreshLibrary();
    void refreshAiProvider();
  }, []);

  useEffect(() => {
    if (!readerDocumentId || loadedReaderDocumentRef.current === readerDocumentId) {
      return;
    }

    loadedReaderDocumentRef.current = readerDocumentId;
    void loadDocumentIntoCurrentWindow(readerDocumentId);
  }, [readerDocumentId]);

  useEffect(() => {
    return () => {
      if (readingStateTimer.current) {
        window.clearTimeout(readingStateTimer.current);
      }
    };
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [activeConversationId, conversations]
  );

  async function refreshLibrary(): Promise<void> {
    const loadedDocuments = await window.sidelight.listDocuments();
    setDocuments(loadedDocuments);
  }

  async function refreshAiProvider(): Promise<void> {
    const provider = await window.sidelight.getAiProvider();
    setAiProvider(provider);
  }

  async function openPdf(): Promise<void> {
    const result = await window.sidelight.openPdf();
    if (!result) {
      return;
    }

    await refreshLibrary();
  }

  async function openDocumentWindow(documentId: string): Promise<void> {
    await window.sidelight.openDocumentWindow(documentId);
    await refreshLibrary();
  }

  async function loadDocumentIntoCurrentWindow(documentId: string): Promise<void> {
    const result = await window.sidelight.loadPdf(documentId);
    if (!result) {
      return;
    }

    await activateDocument(result.document, result.source);
  }

  async function activateDocument(document: PdfDocumentMeta, source: PdfSourceDescriptor): Promise<void> {
    const documentId = document.id;
    const [loadedConversations, loadedMarks, loadedBookmarks, readingState, loadedNote] = await Promise.all([
      window.sidelight.listConversations(documentId),
      window.sidelight.listPdfMarks(documentId),
      window.sidelight.listPdfBookmarks(documentId),
      window.sidelight.getReadingState(documentId),
      window.sidelight.getNote(documentId)
    ]);

    setActiveDocument(document);
    setCurrentPage(readingState?.lastPage ?? 1);
    setPdfSource(source);
    setConversations(loadedConversations);
    setActiveConversationId(loadedConversations[0]?.id);
    setMarks(loadedMarks);
    setBookmarks(loadedBookmarks);
    setNote(loadedNote);
    setPanelOpen(Boolean(loadedConversations[0]));
  }

  async function createFreeChat(selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const anchor = anchorFromSelection(activeDocument.id, selection);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createId('chat'),
      documentId: activeDocument.id,
      pageNumber: anchor.pageNumber,
      anchor,
      mode: 'ask',
      summary: {
        title: compactTitle(anchor.quote, 'ask'),
        brief: compactSentence(anchor.quote, 128),
        keywords: []
      },
      messages: [],
      createdAt: now,
      updatedAt: now
    };

    await saveConversationLocally(conversation);
    setActiveConversationId(conversation.id);
    setPanelOpen(true);
  }

  async function createPageChat(pageNumber: number): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createId('chat'),
      documentId: activeDocument.id,
      pageNumber,
      mode: 'ask',
      summary: {
        title: `Question: Page ${pageNumber}`,
        brief: `Free chat attached to page ${pageNumber}.`,
        keywords: []
      },
      messages: [],
      createdAt: now,
      updatedAt: now
    };

    await saveConversationLocally(conversation);
    setActiveConversationId(conversation.id);
    setPanelOpen(true);
  }

  async function startAnchoredAction(mode: AiMode, selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    if (mode === 'ask') {
      await ensureSelectionMark('highlight', selection);
      await createFreeChat(selection);
      return;
    }

    if (mode === 'summarize' || mode === 'translate') {
      await runTransientAid(mode, selection);
    }
  }

  async function runTransientAid(mode: TransientAidMode, selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const aidId = createId('aid');
    const streamId = createId('stream');
    let streamedContent = '';
    let finished = false;
    setTransientAid({
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
          error: event.error
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
      await window.sidelight.completeAiStream({
        streamId,
        request: {
          mode,
          prompt: promptForMode(mode),
          documentTitle: activeDocument.title,
          contextText: selection.quote
        }
      });
    } catch (error) {
      finish({
        content: streamedContent,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function sendMessage(
    conversationId: string,
    prompt: string,
    attachments: ConversationAttachment[] = []
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
    await completeConversation(nextConversation, prompt, attachments);
  }

  async function completeConversation(
    conversation: Conversation,
    prompt: string,
    attachments: ConversationAttachment[] = []
  ): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const lastMessage = conversation.messages.at(-1);
    const history =
      lastMessage?.role === 'user' && lastMessage.content === prompt
        ? conversation.messages.slice(0, -1)
        : conversation.messages;

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
    };

    const unsubscribe = window.sidelight.onAiStreamEvent((event) => {
      if (event.streamId !== streamId) {
        return;
      }

      if (event.delta) {
        streamedContent += event.delta;
      }

      if (event.error) {
        streamedContent = `AI request failed: ${event.error}`;
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
      await window.sidelight.completeAiStream({
        streamId,
        request: {
        mode: conversation.mode,
        prompt,
        documentTitle: activeDocument.title,
        contextText: conversation.anchor?.quote,
          messages: history,
          attachments
        }
      });
    } catch (error) {
      const failedConversation: Conversation = {
        ...draftConversation,
        messages: draftConversation.messages.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: `AI request failed: ${(error as Error).message}` }
            : message
        ),
        updatedAt: new Date().toISOString()
      };
      await finishWithConversation(failedConversation);
    }
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
    if (!activeDocument || conversation.messages.length === 0) {
      return;
    }

    const aiSummary = await requestConversationSummary(conversation, activeDocument.title);
    if (!aiSummary) {
      return;
    }

    await saveConversationLocally({
      ...conversation,
      summary: aiSummary
    });
  }

  async function saveMark(kind: PdfMarkKind, selection: PdfSelectionPayload): Promise<void> {
    if (!activeDocument) {
      return;
    }

    const saved = await window.sidelight.savePdfMark({
      mark: {
        id: createId('mark'),
        documentId: activeDocument.id,
        kind,
        quote: selection.quote,
        areas: selection.areas,
        pageNumber: selection.pageNumber,
        createdAt: new Date().toISOString()
      }
    });
    setMarks((current) => [saved, ...current.filter((mark) => mark.id !== saved.id)]);
  }

  async function ensureSelectionMark(kind: PdfMarkKind, selection: PdfSelectionPayload): Promise<void> {
    if (
      !activeDocument ||
      marks.some((mark) => mark.kind === kind && sameSelection(mark, selection))
    ) {
      return;
    }

    await saveMark(kind, selection);
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

  async function saveAiProvider(config: AiProviderConfig): Promise<void> {
    const saved = await window.sidelight.saveAiProvider(config);
    setAiProvider(saved);
    setSettingsOpen(false);
  }

  async function saveNote(markdown: string): Promise<void> {
    if (!note) {
      return;
    }

    const saved = await window.sidelight.saveNote({
      note: {
        ...note,
        markdown,
        updatedAt: new Date().toISOString()
      }
    });
    setNote(saved);
  }

  function openConversation(conversationId: string): void {
    setActiveConversationId(conversationId);
    setPanelOpen(true);
  }

  function updateCurrentPage(pageNumber: number): void {
    setCurrentPage(pageNumber);

    const documentId = activeDocument?.id;
    if (!documentId) {
      return;
    }

    if (readingStateTimer.current) {
      window.clearTimeout(readingStateTimer.current);
    }

    readingStateTimer.current = window.setTimeout(() => {
      void window.sidelight.saveReadingState({
        documentId,
        lastPage: pageNumber,
        updatedAt: new Date().toISOString()
      });
    }, 400);
  }

  if (!readerDocumentId) {
    return (
      <main className="app-shell">
        <LibraryHome
          documents={documents}
          provider={aiProvider}
          onOpenPdf={() => void openPdf()}
          onOpenDocument={(documentId) => void openDocumentWindow(documentId)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {settingsOpen && aiProvider && (
          <FloatingSettingsPanel
            provider={aiProvider}
            onClose={() => setSettingsOpen(false)}
            onSave={(config) => void saveAiProvider(config)}
          />
        )}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <PdfReader
        documents={documents}
        source={pdfSource}
        meta={activeDocument}
        activePage={currentPage}
        marks={marks}
        bookmarks={bookmarks}
        conversations={conversations}
        activeConversationId={activeConversationId}
        activeConversation={activeConversation}
        note={note}
        chatOpen={panelOpen}
        busy={busy}
        transientAid={transientAid}
        onOpenPdf={openPdf}
        onOpenSettings={() => setSettingsOpen(true)}
        onLoadDocument={(documentId) => void openDocumentWindow(documentId)}
        onPageChange={updateCurrentPage}
        onCreateMark={(kind, selection) => void saveMark(kind, selection)}
        onSelectionAction={(mode, selection) => void startAnchoredAction(mode, selection)}
        onAddBookmark={(pageNumber) => void addBookmark(pageNumber)}
        onDeleteBookmark={(bookmarkId) => void deleteBookmark(bookmarkId)}
        onDeleteMark={(markId) => void deleteMark(markId)}
        onCreatePageChat={(pageNumber) => void createPageChat(pageNumber)}
        onOpenConversation={openConversation}
        onCloseConversation={() => setPanelOpen(false)}
        onCloseTransientAid={() => setTransientAid(undefined)}
        onSendMessage={(conversationId, prompt, attachments) => void sendMessage(conversationId, prompt, attachments)}
        onSaveNote={(markdown) => void saveNote(markdown)}
      />

      {settingsOpen && aiProvider && (
        <FloatingSettingsPanel
          provider={aiProvider}
          onClose={() => setSettingsOpen(false)}
          onSave={(config) => void saveAiProvider(config)}
        />
      )}
    </main>
  );
}

function LibraryHome({
  documents,
  provider,
  onOpenPdf,
  onOpenDocument,
  onOpenSettings
}: {
  documents: PdfDocumentMeta[];
  provider?: SafeAiProviderConfig;
  onOpenPdf(): void;
  onOpenDocument(documentId: string): void;
  onOpenSettings(): void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const visibleDocuments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return documents;
    }

    return documents.filter((document) =>
      [document.title, document.fileName, ...document.tags]
        .join('\n')
        .toLowerCase()
        .includes(needle)
    );
  }, [documents, query]);
  const allTags = useMemo(
    () => Array.from(new Set(documents.flatMap((document) => document.tags))).sort((a, b) => a.localeCompare(b)),
    [documents]
  );

  return (
    <section className="library-home">
      <aside className="library-home__sidebar">
        <header>
          <div className="library-home__brand">
            <Library size={22} />
            <div>
              <strong>Sidelight</strong>
              <span>PDF reading workspace</span>
            </div>
          </div>
          <button className="icon-button" type="button" title="AI provider" onClick={onOpenSettings}>
            <Settings size={16} />
          </button>
        </header>

        <nav className="library-home__nav" aria-label="Library sections">
          <button type="button" className="is-active">
            <BookOpen size={16} />
            <span>Library</span>
            <strong>{documents.length}</strong>
          </button>
          <button type="button">
            <Clock3 size={16} />
            <span>Recent</span>
            <strong>{Math.min(documents.length, 12)}</strong>
          </button>
          <button type="button">
            <Tags size={16} />
            <span>Tags</span>
            <strong>{allTags.length}</strong>
          </button>
        </nav>

        <div className="library-home__provider">
          <Bot size={17} />
          <div>
            <span>{provider?.hasApiKey ? 'AI ready' : 'Local draft mode'}</span>
            <strong>{provider?.model ?? 'No provider loaded'}</strong>
          </div>
        </div>
      </aside>

      <section className="library-home__main">
        <header className="library-toolbar">
          <div>
            <span>Workspace</span>
            <h1>Library</h1>
          </div>
          <div className="library-toolbar__actions">
            <label className="library-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search PDFs or tags"
              />
            </label>
            <button className="primary-button" type="button" onClick={onOpenPdf}>
              <FolderOpen size={16} />
              Open PDF
            </button>
          </div>
        </header>

        <div className="library-table" role="table" aria-label="PDF library">
          <div className="library-table__head" role="row">
            <span>Title</span>
            <span>Tags</span>
            <span>Last opened</span>
          </div>

          {visibleDocuments.length === 0 ? (
            <section className="library-empty">
              <FileText size={38} strokeWidth={1.5} />
              <h2>{documents.length === 0 ? 'Open your first PDF' : 'No matching PDFs'}</h2>
              <p>
                {documents.length === 0
                  ? 'Each PDF opens in its own reading window with persistent chats and notes.'
                  : 'Try a different title, file name, or tag.'}
              </p>
              {documents.length === 0 && (
                <button className="primary-button" type="button" onClick={onOpenPdf}>
                  <FolderOpen size={16} />
                  Open PDF
                </button>
              )}
            </section>
          ) : (
            <div className="library-table__body">
              {visibleDocuments.map((document) => (
                <button
                  key={document.id}
                  className="library-row"
                  type="button"
                  role="row"
                  onClick={() => onOpenDocument(document.id)}
                >
                  <span className="library-row__title">
                    <BookOpen size={17} />
                    <span>
                      <strong>{document.title}</strong>
                      <small>{document.fileName}</small>
                    </span>
                  </span>
                  <span className="library-row__tags">
                    {document.tags.length ? document.tags.map((tag) => <small key={tag}>{tag}</small>) : <small>untagged</small>}
                  </span>
                  <span className="library-row__date">{formatLibraryDate(document.lastOpenedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function FloatingSettingsPanel({
  provider,
  onClose,
  onSave
}: {
  provider: SafeAiProviderConfig;
  onClose(): void;
  onSave(config: AiProviderConfig): void;
}): ReactElement {
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [temperature, setTemperature] = useState(provider.temperature);
  const [apiKey, setApiKey] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave({
      displayName: displayName.trim() || 'OpenAI-compatible',
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      temperature,
      apiKey: apiKey.trim() || undefined
    });
  };

  return (
    <section className="floating-settings">
      <header>
        <div>
          <span>{provider.hasApiKey ? 'Key stored' : 'Local draft mode'}</span>
          <strong>AI provider</strong>
        </div>
        <button className="icon-button" type="button" title="Close" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <form className="settings-form" onSubmit={submit}>
        <div className="settings-form__badge">
          <Bot size={18} />
          <span>OpenAI-compatible chat completions</span>
        </div>
        <label>
          Name
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          Base URL
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          Model
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          API key
          <input
            value={apiKey}
            type="password"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider.hasApiKey ? 'Stored. Enter a new key to replace it.' : 'sk-...'}
          />
        </label>
        <label>
          Temperature
          <input
            value={temperature}
            type="number"
            min="0"
            max="2"
            step="0.1"
            onChange={(event) => setTemperature(Number(event.target.value))}
          />
        </label>
        <button className="primary-button" type="submit" disabled={!baseUrl.trim() || !model.trim()}>
          <Check size={15} />
          Save
        </button>
      </form>
    </section>
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

function promptForMode(mode: AiMode): string {
  switch (mode) {
    case 'translate':
      return 'Translate this passage into fluent Chinese, while preserving important English technical terms in parentheses.';
    case 'summarize':
      return 'Give me the gist of this passage, then list the key concepts and any assumptions it depends on.';
    case 'lesson':
      return 'Turn this passage into teachable Markdown notes with concepts, examples, and questions to check understanding.';
    case 'explain':
      return 'Explain this passage carefully. Define concepts, unpack hidden assumptions, and keep the answer grounded in the text.';
    default:
      return 'Help me understand this selected passage.';
  }
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
  documentTitle: string
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
        'Return JSON only with this exact shape:',
        '{"title":"short title under 64 characters","brief":"one sentence under 140 characters","keywords":["keyword"]}',
        '',
        transcript
      ].join('\n')
    });

    return parseConversationSummary(response.content);
  } catch (error) {
    console.warn('Conversation summary could not be refreshed', error);
    return undefined;
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
