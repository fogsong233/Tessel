import {
  AiCompletionRequest,
  AiCompletionResponse,
  AiMode,
  AiProviderConfig,
  AiStreamEvent,
  ConversationAttachment
} from '../shared/domain';

export class AiService {
  constructor(private readonly loadProvider: () => Promise<AiProviderConfig>) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const provider = await this.loadProvider();
    if (!provider.apiKey) {
      return {
        content: buildLocalDraft(request),
        usedProvider: 'local-draft'
      };
    }

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: provider.temperature,
        messages: [
          { role: 'system', content: systemPrompt(request.mode) },
          ...toProviderMessages(request)
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`AI provider returned ${response.status}: ${detail.slice(0, 800)}`);
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

    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`
      },
      signal,
      body: JSON.stringify({
        model: provider.model,
        temperature: provider.temperature,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt(request.mode) },
          ...toProviderMessages(request)
        ]
      })
    });

    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw new Error(`AI provider returned ${response.status}: ${detail.slice(0, 800)}`);
    }

    await readOpenAiStream(response.body, onEvent, signal);
    if (!signal?.aborted) {
      onEvent({ done: true, usedProvider: provider.displayName || provider.model });
    }
  }
}

type ProviderTextContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

function toProviderMessages(request: AiCompletionRequest): Array<{ role: 'user' | 'assistant'; content: ProviderTextContent }> {
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
    request.contextText ? `Selected context:\n${request.contextText}` : undefined,
    `Reader request:\n${request.prompt}`
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
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

function systemPrompt(mode: AiMode): string {
  const base =
    'You are Sidelight, a precise reading companion. Keep the answer grounded in the provided PDF context. Preserve important English terms when translating or explaining technical material. Render math with LaTeX when needed.';

  if (mode === 'translate') {
    return `${base} Translate into fluent Chinese while keeping key technical terms in English in parentheses.`;
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
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
          return;
        }

        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') {
          continue;
        }

        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          onEvent({ delta });
        }
      }
    }
  } finally {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
    }

    reader.releaseLock();
  }
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
