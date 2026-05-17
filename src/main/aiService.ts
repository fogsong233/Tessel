import {
  AiCompletionRequest,
  AiCompletionResponse,
  AiDocumentToolContext,
  AiModelInfo,
  AiMode,
  AiProviderConfig,
  AiStreamEvent,
  AiToolCallEvent,
  ConversationAttachment
} from '../shared/domain';

export class AiService {
  constructor(
    private readonly loadProvider: () => Promise<AiProviderConfig>,
    private readonly pdfTools?: AiPdfToolRuntime
  ) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const provider = await this.loadProvider();
    if (!provider.apiKey) {
      return {
        content: buildLocalDraft(request),
        usedProvider: 'local-draft'
      };
    }

    const resolved = await resolveToolCalls(provider, request, buildProviderMessages(request), this.pdfTools);
    if (resolved.directContent !== undefined) {
      return {
        content: resolved.directContent,
        usedProvider: provider.displayName || provider.model
      };
    }

    const response = await postChatCompletion(provider, {
      messages: resolved.messages
    });

    if (!response.ok) {
      throw new Error(await describeProviderError(response));
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return {
      content: json.choices?.[0]?.message?.content?.trim() || 'No response content was returned.',
      usedProvider: provider.displayName || provider.model
    };
  }

  async stream(
    request: AiCompletionRequest,
    onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const provider = await this.loadProvider();
    if (!provider.apiKey) {
      await streamLocalDraft(request, onEvent, signal);
      return;
    }

    const baseMessages = buildProviderMessages(request);
    const tools = providerToolsForRequest(request);
    let response = await postChatCompletion(provider, {
      messages: baseMessages,
      stream: true,
      tools
    }, signal);

    if (!response.ok && tools) {
      response = await postChatCompletion(provider, {
        messages: baseMessages,
        stream: true
      }, signal);
    }

    if (!response.ok) {
      throw new Error(await describeProviderError(response));
    }

    if (!response.body) {
      throw new Error(`AI provider returned ${response.status} without a streaming response body.`);
    }

    const streamResult = await readOpenAiStream(response.body, onEvent, signal);
    if (streamResult.toolCalls.length > 0 && !signal?.aborted) {
      const toolMessages = await executeToolCalls(streamResult.toolCalls, request, this.pdfTools, (toolCall) => {
        onEvent({ toolCall });
      });
      const secondResponse = await postChatCompletion(provider, {
        messages: [
          ...baseMessages,
          {
            role: 'assistant',
            content: streamResult.content || null,
            tool_calls: streamResult.toolCalls
          },
          ...toolMessages
        ],
        stream: true
      }, signal);

      if (!secondResponse.ok) {
        throw new Error(await describeProviderError(secondResponse));
      }

      if (!secondResponse.body) {
        throw new Error(`AI provider returned ${secondResponse.status} without a streaming response body.`);
      }

      await readOpenAiStream(secondResponse.body, onEvent, signal);
    }

    if (!signal?.aborted) {
      onEvent({ done: true, usedProvider: provider.displayName || provider.model });
    }
  }

  async listModels(provider: AiProviderConfig): Promise<AiModelInfo[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (provider.apiKey?.trim()) {
      headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
    }

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(await describeProviderError(response));
    }

    const json = (await response.json()) as {
      data?: Array<{ id?: string; owned_by?: string; ownedBy?: string }>;
    };

    const models: AiModelInfo[] = (json.data ?? [])
      .map((model) => ({
        id: model.id?.trim() ?? '',
        ownedBy: model.owned_by ?? model.ownedBy
      }))
      .filter((model) => Boolean(model.id));

    return models.sort((a, b) => a.id.localeCompare(b.id));
  }
}

type ProviderTextContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface AiPdfToolRuntime {
  readOutline(documentId: string, maxItems?: number): Promise<{
    outline: AiDocumentToolContext['outline'];
    pageCount: number;
  }>;
  readPages(documentId: string, pageStart: number, pageEnd: number, maxChars?: number): Promise<{
    pageCount: number;
    pageStart: number;
    pageEnd: number;
    pages: Array<{ pageNumber: number; text: string }>;
  }>;
}

interface ProviderToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user' | 'assistant'; content: ProviderTextContent | null; tool_calls?: ProviderToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ProviderTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionOptions {
  messages: ProviderMessage[];
  stream?: boolean;
  tools?: ProviderTool[];
}

interface StreamReadResult {
  content: string;
  toolCalls: ProviderToolCall[];
}

async function postChatCompletion(
  provider: AiProviderConfig,
  options: ChatCompletionOptions,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`
    },
    signal,
    body: JSON.stringify({
      model: provider.model,
      temperature: provider.temperature,
      stream: options.stream || undefined,
      messages: options.messages,
      tools: options.tools
    })
  });
}

async function describeProviderError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const detail = summarizeProviderErrorBody(body, response.headers.get('content-type'));
  return detail
    ? `AI provider returned ${response.status} ${response.statusText}: ${detail}`
    : `AI provider returned ${response.status} ${response.statusText}.`;
}

function summarizeProviderErrorBody(body: string, contentType: string | null): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return '';
  }

  const parsed = parseProviderJsonError(trimmed);
  if (parsed) {
    return limitErrorDetail(parsed);
  }

  if (isHtmlError(trimmed, contentType)) {
    return limitErrorDetail(extractHtmlErrorSummary(trimmed));
  }

  return limitErrorDetail(trimmed.replace(/\s+/g, ' '));
}

function parseProviderJsonError(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as {
      error?: string | { message?: string; type?: string; code?: string | number };
      message?: string;
      detail?: string;
    };

    if (typeof json.error === 'string') {
      return json.error;
    }

    if (json.error?.message) {
      return [json.error.message, json.error.type, json.error.code].filter(Boolean).join(' ');
    }

    return json.message ?? json.detail;
  } catch {
    return undefined;
  }
}

function isHtmlError(body: string, contentType: string | null): boolean {
  return Boolean(contentType?.toLowerCase().includes('text/html')) || /^<!doctype html/i.test(body) || /^<html[\s>]/i.test(body);
}

function extractHtmlErrorSummary(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const summary = stripHtml(title ?? heading ?? html);
  return summary || 'The provider returned an HTML error page.';
}

function stripHtml(value: string): string {
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

function limitErrorDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, ' ').trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function buildProviderMessages(request: AiCompletionRequest): ProviderMessage[] {
  const history = request.messages
    ?.filter((message): message is typeof message & { role: 'user' | 'assistant' } =>
      message.role === 'user' || message.role === 'assistant'
    )
    .map((message) => ({
      role: message.role,
      content: message.attachments?.length
        ? contentWithImages(message.content, message.attachments)
        : message.content
    }));

  const context = [
    request.documentTitle ? `Document: ${request.documentTitle}` : undefined,
    request.conversationContext ? `Current conversation context:\n${request.conversationContext}` : undefined,
    request.contextText ? `Selected context:\n${request.contextText}` : undefined,
    `Reader request:\n${request.prompt}`
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    { role: 'system', content: systemPrompt(request) },
    ...(history ?? []),
    {
      role: 'user',
      content: request.attachments?.length ? contentWithImages(context, request.attachments) : context
    }
  ];
}

function contentWithImages(text: string, attachments: ConversationAttachment[]): ProviderTextContent {
  return [
    { type: 'text', text },
    ...attachments
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => ({
        type: 'image_url' as const,
        image_url: { url: attachment.dataUrl }
      }))
  ];
}

function providerToolsForRequest(request: AiCompletionRequest): ProviderTool[] | undefined {
  if (!request.toolContext?.documentId) {
    return undefined;
  }

  return [
    {
      type: 'function',
      function: {
        name: 'view_current_pdf',
        description: 'Read extracted text from the currently open PDF. Use this when the user asks about PDF content or when you need more page text. Returns text for a bounded page range, not a screenshot.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page_start: {
              type: 'integer',
              description: 'First 1-based page number to inspect. Defaults to the current page or requested note range.'
            },
            page_end: {
              type: 'integer',
              description: 'Last 1-based page number to inspect. Defaults to page_start. Large ranges are capped.'
            },
            max_chars: {
              type: 'integer',
              description: 'Maximum characters of extracted text to return. Defaults to 24000 and is capped.'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'view_pdf_outline',
        description: 'Return the table of contents / outline of the currently open PDF, including page numbers when available.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            max_items: {
              type: 'integer',
              description: 'Maximum outline items to return. Defaults to 120.'
            }
          }
        }
      }
    }
  ];
}

async function resolveToolCalls(
  provider: AiProviderConfig,
  request: AiCompletionRequest,
  messages: ProviderMessage[],
  pdfTools?: AiPdfToolRuntime
): Promise<{ messages: ProviderMessage[]; directContent?: string }> {
  const tools = providerToolsForRequest(request);
  if (!tools) {
    return { messages };
  }

  let currentMessages = messages;
  for (let round = 0; round < 4; round += 1) {
    const response = await postChatCompletion(provider, { messages: currentMessages, tools });
    if (!response.ok) {
      return { messages: currentMessages };
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ProviderToolCall[] } }>;
    };
    const message = json.choices?.[0]?.message;
    const toolCalls = normalizeToolCalls(message?.tool_calls ?? []);
    if (toolCalls.length === 0) {
      return {
        messages: currentMessages,
        directContent: message?.content?.trim() || 'No response content was returned.'
      };
    }

    currentMessages = [
      ...currentMessages,
      {
        role: 'assistant',
        content: message?.content ?? null,
        tool_calls: toolCalls
      },
      ...(await executeToolCalls(toolCalls, request, pdfTools))
    ];
  }

  return { messages: currentMessages };
}

async function executeToolCalls(
  toolCalls: ProviderToolCall[],
  request: AiCompletionRequest,
  pdfTools?: AiPdfToolRuntime,
  onToolCall?: (event: AiToolCallEvent) => void
): Promise<ProviderMessage[]> {
  return Promise.all(
    normalizeToolCalls(toolCalls).map(async (toolCall) => {
      onToolCall?.(toolCallEvent(toolCall, 'started'));
      try {
        const content = await runPdfTool(toolCall, request, pdfTools);
        onToolCall?.(toolCallEvent(toolCall, 'completed', content));
        return {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const content = JSON.stringify({ error: message });
        onToolCall?.(toolCallEvent(toolCall, 'error', content));
        return {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content
        };
      }
    })
  );
}

function toolCallEvent(
  toolCall: ProviderToolCall,
  status: AiToolCallEvent['status'],
  resultContent?: string
): AiToolCallEvent {
  const args = parseToolArguments(toolCall.function.arguments);
  const pageStart = integerOrUndefined(args.page_start);
  const pageEnd = integerOrUndefined(args.page_end) ?? pageStart;
  const maxItems = integerOrUndefined(args.max_items);
  const maxChars = integerOrUndefined(args.max_chars);
  const parsedResult = resultContent ? parseToolResult(resultContent) : undefined;
  const returnedPages = Array.isArray(parsedResult?.returned_pages) ? parsedResult.returned_pages : undefined;
  const resultPageStart = integerOrUndefined(returnedPages?.[0]) ?? pageStart;
  const resultPageEnd = integerOrUndefined(returnedPages?.[1]) ?? pageEnd;

  return {
    id: toolCall.id,
    name: toolCall.function.name,
    status,
    pageStart: resultPageStart,
    pageEnd: resultPageEnd,
    maxItems,
    maxChars,
    resultSummary: resultContent && status === 'completed' ? summarizeToolResult(toolCall.function.name, parsedResult) : undefined,
    error: status === 'error' ? summarizeToolError(parsedResult) : undefined,
    updatedAt: new Date().toISOString()
  };
}

function parseToolResult(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function summarizeToolResult(name: string, result: Record<string, unknown> | undefined): string | undefined {
  if (!result) {
    return undefined;
  }

  if (name === 'view_current_pdf') {
    const pages = Array.isArray(result.pages) ? result.pages : [];
    const charCount = pages.reduce((total, page) => {
      const text = typeof (page as { text?: unknown }).text === 'string' ? (page as { text: string }).text : '';
      return total + text.length;
    }, 0);
    const returned = Array.isArray(result.returned_pages) ? result.returned_pages.map((item) => Number(item)).filter(Number.isFinite) : [];
    const range = returned.length ? formatPageRange(returned[0], returned[1] ?? returned[0]) : 'PDF pages';
    return `${range} · ${charCount.toLocaleString()} chars`;
  }

  if (name === 'view_pdf_outline') {
    const outline = Array.isArray(result.outline) ? result.outline : [];
    return `${outline.length} outline items`;
  }

  return undefined;
}

function summarizeToolError(result: Record<string, unknown> | undefined): string | undefined {
  return typeof result?.error === 'string' ? result.error : undefined;
}

function integerOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function formatPageRange(pageStart: number, pageEnd: number): string {
  return pageStart === pageEnd ? `p.${pageStart}` : `p.${pageStart}-${pageEnd}`;
}

async function runPdfTool(
  toolCall: ProviderToolCall,
  request: AiCompletionRequest,
  pdfTools?: AiPdfToolRuntime
): Promise<string> {
  const context = request.toolContext;
  if (!context?.documentId) {
    return JSON.stringify({ error: 'No current PDF is available.' });
  }

  const args = parseToolArguments(toolCall.function.arguments);
  if (toolCall.function.name === 'view_pdf_outline') {
    const maxItems = clampInteger(args.max_items, 1, 240, 120);
    const result = pdfTools
      ? await pdfTools.readOutline(context.documentId, maxItems)
      : { outline: context.outline ?? [], pageCount: context.totalPages ?? 0 };
    return JSON.stringify({
      tool: 'view_pdf_outline',
      document: context.documentTitle,
      total_pages: result.pageCount || context.totalPages,
      outline: (result.outline ?? []).slice(0, maxItems)
    });
  }

  if (toolCall.function.name === 'view_current_pdf') {
    const defaultStart = context.pageStart ?? context.currentPage ?? 1;
    const defaultEnd = context.pageEnd ?? defaultStart;
    const pageStart = clampInteger(args.page_start, 1, context.totalPages ?? Number.MAX_SAFE_INTEGER, defaultStart);
    const pageEnd = clampInteger(args.page_end, pageStart, context.totalPages ?? Number.MAX_SAFE_INTEGER, defaultEnd);
    const maxChars = clampInteger(args.max_chars, 1000, 40000, 24000);
    const pageResult = pdfTools
      ? await pdfTools.readPages(context.documentId, pageStart, pageEnd, maxChars)
      : {
          pageCount: context.totalPages ?? 0,
          pageStart,
          pageEnd,
          pages: [{ pageNumber: pageStart, text: context.pdfText ?? context.selectedText ?? '' }]
        };

    return JSON.stringify({
      tool: 'view_current_pdf',
      document: context.documentTitle,
      file_name: context.fileName,
      requested_pages: [pageStart, pageEnd],
      returned_pages: [pageResult.pageStart, pageResult.pageEnd],
      total_pages: pageResult.pageCount || context.totalPages,
      selected_text: context.selectedText?.slice(0, 4000),
      highlights: context.highlights?.slice(0, 24),
      related_conversations: context.conversations?.slice(0, 8),
      pages: pageResult.pages
    });
  }

  return JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` });
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.max(min, Math.min(max, fallback));
  }

  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeToolCalls(toolCalls: ProviderToolCall[]): ProviderToolCall[] {
  return toolCalls
    .filter((toolCall) => toolCall?.type === 'function' && toolCall.id && toolCall.function?.name)
    .map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || '{}'
      }
    }));
}

function systemPrompt(request: AiCompletionRequest): string {
  const mode = request.mode;
  const preferredLanguage = request.preferredLanguage ?? 'Simplified Chinese';
  const toolLine = request.toolContext?.documentId
    ? 'You may call tools to inspect the current PDF by page range and to inspect the PDF outline. Prefer tools when the answer depends on text that is not already visible in the chat context. Tool results are extracted text, not screenshots.'
    : 'Use only the PDF context provided in the conversation.';
  const documentLine = [
    request.documentTitle ? `Current document: ${request.documentTitle}.` : undefined,
    request.toolContext?.currentPage ? `Current reader page: ${request.toolContext.currentPage}.` : undefined,
    request.toolContext?.totalPages ? `Total pages: ${request.toolContext.totalPages}.` : undefined
  ].filter(Boolean).join(' ');
  const base = [
    'You are Sidelight, a precise reading companion embedded in a local PDF reading workspace.',
    documentLine,
    'The user is discussing the currently open PDF. Previous user/assistant messages, selected anchors, highlights, notes, images, and generated context may be included below.',
    toolLine,
    `Answer in ${preferredLanguage} unless the user explicitly asks otherwise.`,
    'Ground claims in the PDF or the conversation. If the PDF text available to you is insufficient, say what page/range you need instead of inventing details.',
    'Preserve important English terms when translating or explaining technical material. Render math with LaTeX when needed.'
  ].filter(Boolean).join(' ');

  if (mode === 'translate') {
    return `${base} Translate into fluent ${preferredLanguage} while keeping key technical terms in English in parentheses.`;
  }

  if (mode === 'lesson') {
    return `${base} Produce structured Markdown notes that a teacher could use to explain the selected range.`;
  }

  if (mode === 'summarize') {
    return `${base} Summarize the passage with a short outline and list of key concepts.`;
  }

  return base;
}

function buildLocalDraft(request: AiCompletionRequest): string {
  const quote = request.contextText?.trim();
  const attachmentLine = request.attachments?.length
    ? `\n\nAttached images: ${request.attachments.map((attachment) => attachment.name).join(', ')}`
    : '';
  const heading = modeHeading(request.mode);
  const contextLine = quote
    ? `I found this selected context:\n\n> ${quote.slice(0, 800)}${quote.length > 800 ? '...' : ''}`
    : 'No selected PDF context was attached to this chat.';

  return [
    `### ${heading}`,
    '',
    `${contextLine}${attachmentLine}`,
    '',
    'This is a local draft because no AI provider key is configured yet. Once you add an OpenAI-compatible endpoint in Settings, this same interface will call your own model.',
    '',
    'A useful next prompt here is:',
    '',
    `> ${request.prompt}`
  ].join('\n');
}

async function streamLocalDraft(
  request: AiCompletionRequest,
  onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void,
  signal?: AbortSignal
): Promise<void> {
  const draft = buildLocalDraft(request);
  for (const chunk of draft.match(/.{1,42}(\s|$)/gs) ?? [draft]) {
    if (signal?.aborted) {
      return;
    }

    onEvent({ delta: chunk });
    await new Promise((resolve) => setTimeout(resolve, 18));
  }

  if (!signal?.aborted) {
    onEvent({ done: true, usedProvider: 'local-draft' });
  }
}

async function readOpenAiStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void,
  signal?: AbortSignal
): Promise<StreamReadResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCallParts = new Map<number, ProviderToolCall>();

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (signal?.aborted) {
          return {
            content,
            toolCalls: normalizeToolCalls(Array.from(toolCallParts.values()))
          };
        }

        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') {
          continue;
        }

        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: 'function';
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onEvent({ delta });
        }

        for (const toolCallDelta of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
          const index = toolCallDelta.index ?? toolCallParts.size;
          const current = toolCallParts.get(index) ?? {
            id: toolCallDelta.id ?? `tool_${index}`,
            type: 'function' as const,
            function: {
              name: '',
              arguments: ''
            }
          };
          current.id = toolCallDelta.id ?? current.id;
          current.function.name += toolCallDelta.function?.name ?? '';
          current.function.arguments += toolCallDelta.function?.arguments ?? '';
          toolCallParts.set(index, current);
        }
      }
    }
  } finally {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
    }

    reader.releaseLock();
  }

  return {
    content,
    toolCalls: normalizeToolCalls(Array.from(toolCallParts.values()))
  };
}

function modeHeading(mode: AiMode): string {
  switch (mode) {
    case 'translate':
      return 'Translation draft';
    case 'summarize':
      return 'Quick meaning map';
    case 'lesson':
      return 'Lesson note draft';
    case 'explain':
      return 'Concept explanation draft';
    default:
      return 'Reading chat draft';
  }
}
