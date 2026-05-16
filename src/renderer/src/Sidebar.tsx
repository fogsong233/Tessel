import { type FormEvent, type ReactElement, useMemo, useState } from 'react';
import {
  Bot,
  Check,
  FileSearch,
  MessageSquareText,
  PanelRight,
  PenLine,
  Plus,
  Search,
  Settings,
  Sparkles
} from 'lucide-react';
import { Conversation, NoteDocument, SafeAiProviderConfig } from '../../shared/domain';
import { MarkdownView } from './MarkdownView';

export type SidebarTab = 'chats' | 'notes' | 'search' | 'settings';

interface SidebarProps {
  activeTab: SidebarTab;
  onTabChange(tab: SidebarTab): void;
  conversations: Conversation[];
  activeConversation?: Conversation;
  currentPage: number;
  note?: NoteDocument;
  aiProvider?: SafeAiProviderConfig;
  busy: boolean;
  onCreateChat(): void;
  onSelectConversation(conversationId: string): void;
  onSendMessage(conversationId: string, prompt: string): void;
  onNoteChange(markdown: string): void;
  onSaveNote(): void;
  onSaveAiProvider(config: SafeAiProviderConfig & { apiKey?: string }): void;
}

const tabs: Array<{ id: SidebarTab; label: string; icon: typeof MessageSquareText }> = [
  { id: 'chats', label: 'Chats', icon: MessageSquareText },
  { id: 'notes', label: 'Notes', icon: PenLine },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'settings', label: 'Settings', icon: Settings }
];

export function Sidebar({
  activeTab,
  onTabChange,
  conversations,
  activeConversation,
  currentPage,
  note,
  aiProvider,
  busy,
  onCreateChat,
  onSelectConversation,
  onSendMessage,
  onNoteChange,
  onSaveNote,
  onSaveAiProvider
}: SidebarProps): ReactElement {
  return (
    <aside className="sidebar">
      <nav className="sidebar-tabs" aria-label="Workspace panels">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? 'sidebar-tab is-active' : 'sidebar-tab'}
              title={tab.label}
              onClick={() => onTabChange(tab.id)}
            >
              <Icon size={18} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {activeTab === 'chats' && (
        <ChatPanel
          conversations={conversations}
          activeConversation={activeConversation}
          currentPage={currentPage}
          busy={busy}
          onCreateChat={onCreateChat}
          onSelectConversation={onSelectConversation}
          onSendMessage={onSendMessage}
        />
      )}

      {activeTab === 'notes' && note && (
        <NotePanel note={note} onNoteChange={onNoteChange} onSaveNote={onSaveNote} />
      )}

      {activeTab === 'search' && <SearchPanel conversations={conversations} note={note} />}

      {activeTab === 'settings' && aiProvider && (
        <SettingsPanel provider={aiProvider} onSave={onSaveAiProvider} />
      )}
    </aside>
  );
}

function ChatPanel({
  conversations,
  activeConversation,
  currentPage,
  busy,
  onCreateChat,
  onSelectConversation,
  onSendMessage
}: Pick<
  SidebarProps,
  | 'conversations'
  | 'activeConversation'
  | 'currentPage'
  | 'busy'
  | 'onCreateChat'
  | 'onSelectConversation'
  | 'onSendMessage'
>): ReactElement {
  const pageConversations = conversations.filter((conversation) => conversation.pageNumber === currentPage);
  const otherConversations = conversations.filter((conversation) => conversation.pageNumber !== currentPage);
  const visibleConversations = [...pageConversations, ...otherConversations];

  return (
    <div className="panel-body chat-panel">
      <div className="panel-heading">
        <div>
          <span>Page {currentPage}</span>
          <h2>Reading traces</h2>
        </div>
        <button type="button" className="quiet-button" onClick={onCreateChat}>
          <Plus size={16} />
          New
        </button>
      </div>

      <div className="conversation-list">
        {visibleConversations.length === 0 && (
          <EmptyPanel
            icon={PanelRight}
            title="No conversations yet"
            body="Select text in the PDF, then ask Sidelight to explain, translate, or summarize it."
          />
        )}

        {visibleConversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className={
              activeConversation?.id === conversation.id
                ? 'conversation-card is-active'
                : 'conversation-card'
            }
            onClick={() => onSelectConversation(conversation.id)}
          >
            <span className="conversation-card__meta">
              {conversation.pageNumber ? `p.${conversation.pageNumber}` : 'document'}
              <span>{conversation.mode}</span>
            </span>
            <strong>{conversation.summary.title}</strong>
            <span>{conversation.summary.brief}</span>
          </button>
        ))}
      </div>

      {activeConversation && (
        <Thread
          conversation={activeConversation}
          busy={busy}
          onSend={(prompt) => onSendMessage(activeConversation.id, prompt)}
        />
      )}
    </div>
  );
}

function Thread({
  conversation,
  busy,
  onSend
}: {
  conversation: Conversation;
  busy: boolean;
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
    <section className="thread">
      {conversation.anchor && (
        <blockquote className="anchor-quote">
          {conversation.anchor.quote.slice(0, 320)}
          {conversation.anchor.quote.length > 320 ? '...' : ''}
        </blockquote>
      )}

      <div className="message-list">
        {conversation.messages.map((message) => (
          <article key={message.id} className={`message message--${message.role}`}>
            <div className="message__role">{message.role === 'assistant' ? 'Sidelight' : 'You'}</div>
            <MarkdownView>{message.content}</MarkdownView>
          </article>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about this passage, concept, proof, or translation..."
          rows={3}
        />
        <button type="submit" className="primary-button" disabled={busy || !draft.trim()}>
          <Sparkles size={16} />
          Send
        </button>
      </form>
    </section>
  );
}

function NotePanel({
  note,
  onNoteChange,
  onSaveNote
}: {
  note: NoteDocument;
  onNoteChange(markdown: string): void;
  onSaveNote(): void;
}): ReactElement {
  return (
    <div className="panel-body note-panel">
      <div className="panel-heading">
        <div>
          <span>Markdown</span>
          <h2>{note.title}</h2>
        </div>
        <button type="button" className="quiet-button" onClick={onSaveNote}>
          <Check size={16} />
          Save
        </button>
      </div>
      <textarea
        className="note-editor"
        value={note.markdown}
        onChange={(event) => onNoteChange(event.target.value)}
        spellCheck={false}
      />
      <div className="note-preview">
        <MarkdownView>{note.markdown}</MarkdownView>
      </div>
    </div>
  );
}

function SearchPanel({
  conversations,
  note
}: {
  conversations: Conversation[];
  note?: NoteDocument;
}): ReactElement {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }

    return conversations.filter((conversation) => {
      const haystack = [
        conversation.summary.title,
        conversation.summary.brief,
        conversation.anchor?.quote,
        ...conversation.messages.map((message) => message.content)
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [conversations, query]);

  return (
    <div className="panel-body">
      <div className="panel-heading">
        <div>
          <span>Local</span>
          <h2>Search traces</h2>
        </div>
      </div>
      <label className="search-field">
        <FileSearch size={17} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats and notes" />
      </label>

      <div className="conversation-list">
        {query &&
          results.map((conversation) => (
            <article key={conversation.id} className="conversation-card">
              <span className="conversation-card__meta">p.{conversation.pageNumber ?? '-'}</span>
              <strong>{conversation.summary.title}</strong>
              <span>{conversation.summary.brief}</span>
            </article>
          ))}

        {query && note?.markdown.toLowerCase().includes(query.toLowerCase()) && (
          <article className="conversation-card">
            <span className="conversation-card__meta">note</span>
            <strong>{note.title}</strong>
            <span>Matched in Markdown notes.</span>
          </article>
        )}
      </div>
    </div>
  );
}

function SettingsPanel({
  provider,
  onSave
}: {
  provider: SafeAiProviderConfig;
  onSave(config: SafeAiProviderConfig & { apiKey?: string }): void;
}): ReactElement {
  const [displayName, setDisplayName] = useState(provider.displayName);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [model, setModel] = useState(provider.model);
  const [temperature, setTemperature] = useState(provider.temperature);
  const [apiKey, setApiKey] = useState('');

  return (
    <form
      className="panel-body settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ displayName, baseUrl, model, temperature, apiKey, hasApiKey: provider.hasApiKey || Boolean(apiKey) });
      }}
    >
      <div className="panel-heading">
        <div>
          <span>Private model</span>
          <h2>AI provider</h2>
        </div>
        <Bot size={22} />
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
          placeholder={provider.hasApiKey ? 'Stored securely. Enter a new key to replace it.' : 'sk-...'}
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

      <button type="submit" className="primary-button">
        Save provider
      </button>
    </form>
  );
}

function EmptyPanel({
  icon: Icon,
  title,
  body
}: {
  icon: typeof PanelRight;
  title: string;
  body: string;
}): ReactElement {
  return (
    <div className="empty-panel">
      <Icon size={24} />
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
