import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AgentActivityEvent,
  AiDocumentToolContext,
  AiStreamEvent,
  CodexPermissionMode,
  CodexModelInfo,
  CodexStreamRequest,
  ConversationAttachment,
  PdfDocumentMeta
} from '../shared/domain';

interface PdfRuntime {
  document: PdfDocumentMeta;
  readOutline(maxItems?: number): Promise<{ outline: AiDocumentToolContext['outline']; pageCount: number }>;
  readPages(pageStart: number, pageEnd: number, maxChars?: number): Promise<{
    pageCount: number;
    pageStart: number;
    pageEnd: number;
    pages: Array<{ pageNumber: number; text: string }>;
  }>;
}

interface ThreadContext {
  input: CodexStreamRequest;
  onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  workspaceDirectory: string;
  workspaceImages: Map<string, string>;
  onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void;
  pendingGuidance: PendingSteer[];
  resolve(): void;
  reject(error: Error): void;
}

interface ActiveExecTurn {
  child: ChildProcessWithoutNullStreams;
  workspaceDirectory: string;
  workspaceImages: Map<string, string>;
  onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void;
  threadId?: string;
  pendingGuidance: PendingSteer[];
  checkpointing: boolean;
  resolve(): void;
  reject(error: Error): void;
  cancelled: boolean;
  settled: boolean;
  stderr: string;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

interface PendingSteer {
  id: string;
  prompt: string;
}

class ExecSteerCheckpointError extends Error {
  constructor(
    readonly guidance: string,
    readonly threadId?: string
  ) {
    super('Codex guidance is ready for the next checkpoint.');
    this.name = 'ExecSteerCheckpointError';
  }
}

/**
 * Experimental adapter for Codex app-server. The protocol is isolated here so
 * renderer code only sees normalized final-message and activity events.
 */
export class CodexAgent {
  private child?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private stdoutBuffer = '';
  private initializePromise?: Promise<void>;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  private readonly threadContexts = new Map<string, ThreadContext>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeExecTurns = new Map<string, ActiveExecTurn>();
  private readonly queuedSteers = new Map<string, PendingSteer[]>();
  private preferredTransport?: 'app-server' | 'exec';
  private transportDetectionPromise?: Promise<'app-server' | 'exec'>;

  constructor(
    private readonly resolvePdf: (documentId: string) => Promise<PdfRuntime>,
    private readonly inputDirectory: string,
    private readonly workspaceDirectory: string
  ) {}

  static async availability(): Promise<{ available: boolean; version?: string; reason?: string }> {
    try {
      const { stdout } = await promisify(execFile)('codex', ['--version'], { timeout: 4_000 });
      const version = stdout.trim();
      if (!version) {
        return { available: false, reason: 'Codex did not report a version.' };
      }
      await promisify(execFile)('codex', ['login', 'status'], { timeout: 4_000 });
      return { available: true, version };
    } catch {
      return { available: false, reason: 'Codex CLI is missing or not signed in. Install and sign in to Codex before enabling this experiment.' };
    }
  }

  async listModels(): Promise<CodexModelInfo[]> {
    try {
      await this.initialize();
      const models: CodexModelInfo[] = [];
      let cursor: string | undefined;
      do {
        const response = await this.request('model/list', {
          limit: 100,
          ...(cursor ? { cursor } : {})
        }) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null };
        for (const model of response.data ?? []) {
          const id = typeof model.model === 'string' ? model.model : typeof model.id === 'string' ? model.id : '';
          if (!id) {
            continue;
          }
          models.push({
            id,
            displayName: typeof model.displayName === 'string' ? model.displayName : id,
            ...(typeof model.description === 'string' && model.description ? { description: model.description } : {}),
            supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
                .map((entry) => entry && typeof entry === 'object' ? (entry as { reasoningEffort?: unknown }).reasoningEffort : undefined)
                .filter((effort): effort is string => typeof effort === 'string')
              : [],
            ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {})
          });
        }
        cursor = typeof response.nextCursor === 'string' ? response.nextCursor : undefined;
      } while (cursor);
      return models.length ? models : fallbackCodexModels;
    } catch {
      return fallbackCodexModels;
    }
  }

  async stream(
    input: CodexStreamRequest,
    onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void
  ): Promise<void> {
    if (!this.preferredTransport) {
      this.preferredTransport = await this.initialTransport();
    }
    if (this.preferredTransport === 'exec') {
      onEvent({ activity: activity('transport:exec', 'reading', 'Starting a local Codex session', 'started') });
      await this.streamWithExecOrRestore(input, onEvent);
      return;
    }

    try {
      await this.streamWithAppServer(input, onEvent);
      this.preferredTransport = 'app-server';
    } catch (error) {
      if (!isAppServerClientForbidden(error)) {
        throw error;
      }
      this.preferredTransport = 'exec';
      onEvent({ activity: activity('transport:exec', 'reading', 'Starting a local Codex session', 'started') });
      await this.streamWithExecOrRestore(input, onEvent);
    }
  }

  async steer(streamId: string, prompt: string): Promise<void> {
    const guidance = prompt.trim();
    if (!guidance) {
      throw new Error('Guidance cannot be empty.');
    }
    const pending: PendingSteer = {
      id: `guidance:${randomUUID()}`,
      prompt: guidance
    };
    const appTurn = this.activeTurns.get(streamId);
    if (appTurn) {
      appTurn.onEvent({ activity: guidanceActivity(pending, 'started') });
      if (!appTurn.turnId) {
        appTurn.pendingGuidance.push(pending);
        return;
      }
      await this.deliverAppServerSteer(appTurn, pending);
      return;
    }
    const execTurn = this.activeExecTurns.get(streamId);
    if (execTurn) {
      execTurn.pendingGuidance.push(pending);
      execTurn.onEvent({ activity: guidanceActivity(pending, 'started') });
      return;
    }
    this.queuedSteers.set(streamId, [...(this.queuedSteers.get(streamId) ?? []), pending]);
  }

  private async initialTransport(): Promise<'app-server' | 'exec'> {
    if (!this.transportDetectionPromise) {
      this.transportDetectionPromise = promisify(execFile)('codex', ['login', 'status'], { timeout: 4_000 })
        .then(({ stdout }) => /api key/i.test(stdout) ? 'exec' : 'app-server')
        .catch(() => 'app-server');
    }
    return this.transportDetectionPromise;
  }

  private async streamWithAppServer(
    input: CodexStreamRequest,
    onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void
  ): Promise<void> {
    await this.initialize();
    const runtime = await this.resolvePdf(input.documentId);
    const documentWorkspace = await this.documentWorkspace(runtime.document);
    const threadId = await this.resolveThread(input, documentWorkspace, onEvent);
    const workspaceImages = await this.workspaceImageVersions(documentWorkspace);
    this.threadContexts.set(threadId, { input, onEvent });
    onEvent({ agentThreadId: threadId, usedProvider: 'Codex' });
    onEvent({ activity: activity(`session:${threadId}`, 'reading', 'Preparing PDF context', 'started') });

    await new Promise<void>((resolve, reject) => {
      const active: ActiveTurn = {
        threadId,
        turnId: '',
        workspaceDirectory: documentWorkspace,
        workspaceImages,
        onEvent,
        pendingGuidance: this.takeQueuedSteers(input.streamId),
        resolve,
        reject
      };
      for (const pending of active.pendingGuidance) {
        onEvent({ activity: guidanceActivity(pending, 'started') });
      }
      this.activeTurns.set(input.streamId, active);
      void this.startTurn(input, runtime, active)
        .catch((error: unknown) => {
          this.activeTurns.delete(input.streamId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async cancel(streamId: string): Promise<void> {
    this.queuedSteers.delete(streamId);
    const execTurn = this.activeExecTurns.get(streamId);
    if (execTurn) {
      execTurn.cancelled = true;
      execTurn.child.kill('SIGINT');
      return;
    }
    const active = this.activeTurns.get(streamId);
    if (!active || !active.turnId) {
      return;
    }
    await this.request('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId
    }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.initializePromise = undefined;
    if (child && !child.killed) {
      child.kill();
    }
    for (const execTurn of this.activeExecTurns.values()) {
      execTurn.cancelled = true;
      execTurn.child.kill('SIGINT');
    }
    this.activeExecTurns.clear();
    this.queuedSteers.clear();
  }

  private async resolveThread(
    input: CodexStreamRequest,
    documentWorkspace: string,
    onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void
  ): Promise<string> {
    if (input.codexThreadId && this.threadContexts.has(input.codexThreadId)) {
      return input.codexThreadId;
    }
    if (input.codexThreadId) {
      onEvent({ activity: activity('session:restore', 'reading', 'Restoring this chat from its synced reading context', 'completed') });
    }

    const started = await this.request('thread/start', {
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      cwd: documentWorkspace,
      runtimeWorkspaceRoots: [documentWorkspace],
      sandbox: codexSandboxMode(input.permissionMode),
      approvalPolicy: 'never',
      config: {
        web_search: 'live'
      },
      ...(input.transient ? { ephemeral: true } : {}),
      developerInstructions: [
        'You are Tessel Codex, an experimental PDF reading agent.',
        'Use sidelight_pdf_* tools to inspect the open PDF. You may search, inspect local files, and run analysis commands inside the private workspace only. Do not modify the PDF or files outside that workspace, and do not expose private reasoning.',
        'When a visual analysis helps, save a PNG, JPEG, WebP, GIF, or SVG file in the workspace root. Sidelight will attach newly generated images to the final response.',
        'Return a concise, well-cited reading answer in Markdown. Mention page numbers when PDF evidence supports a claim.',
        'The host renders only your final answer and a separate tool activity timeline.'
      ].join(' '),
      dynamicTools: dynamicPdfTools()
    }) as { thread?: { id?: string } };
    if (!started.thread?.id) {
      throw new Error('Codex app-server did not return a thread id.');
    }
    return started.thread.id;
  }

  private async turnInput(input: CodexStreamRequest, runtime: PdfRuntime): Promise<Array<Record<string, unknown>>> {
    const context = input.context;
    const documentHash = runtime.document.fingerprint?.hash ?? runtime.document.sha256;
    const contextEnvelope = {
      document: {
        id: runtime.document.id,
        hash: documentHash,
        filePath: runtime.document.filePath,
        title: runtime.document.title,
        pageCount: context.totalPages
      },
      selection: context.selectedText
        ? {
            page: context.pageStart ?? context.currentPage,
            text: context.selectedText,
            bounds: selectionBounds(context.selectionRects),
            note: 'Use sidelight_pdf_read_pages when surrounding context is needed.'
          }
        : undefined,
      currentPage: context.currentPage,
      responseLanguage: input.preferredLanguage,
      conversationContext: context.conversations?.slice(-4).map((conversation) => ({
        title: conversation.title.slice(0, 240),
        brief: conversation.brief?.slice(0, 700),
        pageNumber: conversation.pageNumber,
        anchorQuote: conversation.anchorQuote?.slice(0, 700)
      }))
    };
    // A resumed Codex thread already contains its transcript. Synced app
    // history is only needed when creating or reconstructing a local thread.
    const history = !input.codexThreadId ? input.history?.slice(-8).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 2000),
      attachments: message.attachments?.map((attachment) => attachment.name)
    })) : undefined;
    const text = [
      'PDF session context:',
      JSON.stringify(contextEnvelope, null, 2),
      history?.length ? `Conversation history:\n${JSON.stringify(history, null, 2)}` : undefined,
      '',
      'User request:',
      input.prompt
    ].filter((part): part is string => Boolean(part)).join('\n');
    const attachments = await Promise.all((input.attachments ?? []).map((attachment) => this.writeInputImage(input.streamId, attachment)));
    return [
      { type: 'text', text, text_elements: [] },
      ...attachments
    ];
  }

  private async writeInputImage(streamId: string, attachment: ConversationAttachment): Promise<Record<string, unknown>> {
    const match = attachment.dataUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (!match) {
      throw new Error(`Unsupported image attachment: ${attachment.name}`);
    }
    const mimeType = match[1] ?? attachment.mimeType;
    const data = Buffer.from(match[2], 'base64');
    const directory = join(this.inputDirectory, streamId);
    await mkdir(directory, { recursive: true });
    const fileName = `${randomUUID()}${extensionForAttachment(attachment.name, mimeType)}`;
    const filePath = join(directory, fileName);
    await writeFile(filePath, data);
    return { type: 'localImage', path: filePath };
  }

  private async startTurn(input: CodexStreamRequest, runtime: PdfRuntime, active: ActiveTurn): Promise<void> {
    const turnInput = await this.turnInput(input, runtime);
    const result = await this.request('turn/start', {
      threadId: active.threadId,
      input: turnInput,
      cwd: active.workspaceDirectory,
      runtimeWorkspaceRoots: [active.workspaceDirectory],
      sandboxPolicy: codexSandboxPolicy(input.permissionMode, active.workspaceDirectory),
      approvalPolicy: 'never',
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.effort?.trim() ? { effort: input.effort.trim() } : {})
    });
    const turn = result as { turn?: { id?: string } };
    if (!turn.turn?.id) {
      throw new Error('Codex app-server did not return a turn id.');
    }
    active.turnId = turn.turn.id;
    active.onEvent({ activity: activity(`session:${active.threadId}`, 'reading', 'Preparing PDF context', 'completed') });
    const pendingGuidance = active.pendingGuidance.splice(0);
    for (const pending of pendingGuidance) {
      await this.deliverAppServerSteer(active, pending);
    }
  }

  private async deliverAppServerSteer(active: ActiveTurn, pending: PendingSteer): Promise<void> {
    try {
      await this.request('turn/steer', {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: [{ type: 'text', text: pending.prompt, text_elements: [] }]
      });
      active.onEvent({ activity: guidanceActivity(pending, 'completed') });
    } catch (error) {
      active.onEvent({
        activity: guidanceActivity(
          pending,
          'error',
          error instanceof Error ? error.message : String(error)
        )
      });
      throw error;
    }
  }

  private takeQueuedSteers(streamId: string): PendingSteer[] {
    const pending = this.queuedSteers.get(streamId) ?? [];
    this.queuedSteers.delete(streamId);
    return pending;
  }

  private async documentWorkspace(document: PdfDocumentMeta): Promise<string> {
    const identifier = document.fingerprint?.hash ?? document.sha256;
    const safeIdentifier = identifier.replace(/[^a-f0-9]/gi, '').slice(0, 96) || document.id;
    const directory = join(this.workspaceDirectory, safeIdentifier);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async workspaceImageVersions(directory: string): Promise<Map<string, string>> {
    const files = await listWorkspaceImages(directory);
    const versions = new Map<string, string>();
    await Promise.all(files.map(async (filePath) => {
      const details = await stat(filePath);
      versions.set(filePath, imageVersion(details));
    }));
    return versions;
  }

  private async collectArtifacts(active: Pick<ActiveTurn, 'workspaceDirectory' | 'workspaceImages'>): Promise<ConversationAttachment[]> {
    const images = await listWorkspaceImages(active.workspaceDirectory);
    const attachments = await Promise.all(images.map(async (filePath) => {
      const details = await stat(filePath);
      const previousVersion = active.workspaceImages.get(filePath);
      if (previousVersion === imageVersion(details)) {
        return undefined;
      }
      const content = await readFile(filePath);
      if (content.byteLength > 12 * 1024 * 1024) {
        return undefined;
      }
      const mimeType = imageMimeType(filePath);
      if (!mimeType) {
        return undefined;
      }
      const localName = relative(active.workspaceDirectory, filePath);
      return {
        id: `artifact_${randomUUID()}`,
        kind: 'image' as const,
        name: localName,
        mimeType,
        dataUrl: `data:${mimeType};base64,${content.toString('base64')}`,
        createdAt: new Date().toISOString()
      } satisfies ConversationAttachment;
    }));
    return attachments.filter((attachment): attachment is ConversationAttachment => Boolean(attachment));
  }

  private async streamWithExec(
    input: CodexStreamRequest,
    onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void
  ): Promise<void> {
    const runtime = await this.resolvePdf(input.documentId);
    const workspaceDirectory = await this.documentWorkspace(runtime.document);
    const workspaceImages = await this.workspaceImageVersions(workspaceDirectory);
    const turnInput = await this.turnInput(input, runtime);
    const prompt = turnInput.find((item) => item.type === 'text')?.text;
    if (typeof prompt !== 'string') {
      throw new Error('Could not prepare the Codex reader prompt.');
    }
    const imagePaths = turnInput
      .filter((item) => item.type === 'localImage' && typeof item.path === 'string')
      .map((item) => item.path as string);
    const args = execArgs(input, workspaceDirectory, prompt, imagePaths);
    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    await new Promise<void>((resolve, reject) => {
      const active: ActiveExecTurn = {
        child,
        workspaceDirectory,
        workspaceImages,
        onEvent,
        pendingGuidance: this.takeQueuedSteers(input.streamId),
        checkpointing: false,
        resolve,
        reject,
        cancelled: false,
        settled: false,
        stderr: ''
      };
      this.activeExecTurns.set(input.streamId, active);
      for (const pending of active.pendingGuidance) {
        onEvent({ activity: guidanceActivity(pending, 'started') });
      }
      let buffer = '';
      let receivedOutput = false;
      const startupTimeout = setTimeout(() => {
        if (active.settled || receivedOutput) {
          return;
        }
        child.kill('SIGTERM');
        void this.finishExecTurn(
          input.streamId,
          active,
          new Error('Codex did not start streaming within 45 seconds. Check the local Codex connection and try again.')
        );
      }, 45_000);
      child.stdout.on('data', (chunk: string) => {
        if (!receivedOutput && chunk.trim()) {
          receivedOutput = true;
          clearTimeout(startupTimeout);
        }
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            this.handleExecEvent(input.streamId, JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // CLI diagnostics can occasionally share stdout; only JSON events are protocol data.
          }
        }
      });
      child.stderr.on('data', (chunk: string) => {
        active.stderr = `${active.stderr}${chunk}`.slice(-1600);
      });
      child.once('error', (error) => {
        clearTimeout(startupTimeout);
        void this.finishExecTurn(input.streamId, active, error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        if (!active.settled) {
          const detail = active.stderr.trim() || `Codex exec exited (${code ?? signal ?? 'unknown'}).`;
          void this.finishExecTurn(input.streamId, active, new Error(detail));
        }
      });
      // Codex treats a piped stdin as additional prompt input and waits for EOF.
      // No stdin payload is needed because the prompt is passed as an argument.
      child.stdin.end();
    });
  }

  private async streamWithExecOrRestore(
    input: CodexStreamRequest,
    onEvent: (event: Omit<AiStreamEvent, 'streamId'>) => void
  ): Promise<void> {
    let currentInput = input;
    let restoredMissingSession = false;
    for (;;) {
      try {
        await this.streamWithExec(currentInput, onEvent);
        return;
      } catch (error) {
        if (error instanceof ExecSteerCheckpointError) {
          currentInput = {
            ...currentInput,
            codexThreadId: error.threadId ?? currentInput.codexThreadId,
            prompt: steerContinuationPrompt(error.guidance),
            attachments: undefined,
            history: undefined
          };
          continue;
        }
        if (
          restoredMissingSession
          || !currentInput.codexThreadId
          || currentInput.transient
          || !isMissingExecSession(error)
        ) {
          throw error;
        }
        restoredMissingSession = true;
        onEvent({ activity: activity('session:restore', 'reading', 'Starting a local Codex session from synced chat history', 'completed') });
        currentInput = { ...currentInput, codexThreadId: undefined };
      }
    }
  }

  private handleExecEvent(streamId: string, event: Record<string, unknown>): void {
    const active = this.activeExecTurns.get(streamId);
    if (!active || active.settled) {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'thread.started' && typeof event.thread_id === 'string') {
      active.threadId = event.thread_id;
      active.onEvent({ activity: activity('transport:exec', 'reading', 'Local Codex session started', 'completed') });
      active.onEvent({ agentThreadId: event.thread_id, usedProvider: 'Codex' });
      return;
    }
    if (type === 'item.started' || type === 'item.completed') {
      const item = event.item as { id?: unknown; type?: unknown; text?: unknown } | undefined;
      if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
        active.onEvent({ delta: item.text, usedProvider: 'Codex' });
      }
      const activityEvent = activityFromExecItem(item, type === 'item.started' ? 'started' : 'completed');
      if (activityEvent) {
        active.onEvent({ activity: activityEvent });
      }
      if (type === 'item.completed' && execItemIsSteerCheckpoint(item)) {
        this.checkpointExecSteer(streamId, active, true);
      }
      return;
    }
    if (type === 'turn.completed') {
      if (active.pendingGuidance.length) {
        this.checkpointExecSteer(streamId, active, false);
        return;
      }
      void this.finishExecTurn(streamId, active);
    }
  }

  private checkpointExecSteer(streamId: string, active: ActiveExecTurn, interrupt: boolean): void {
    if (active.settled || active.checkpointing || active.pendingGuidance.length === 0) {
      return;
    }
    active.checkpointing = true;
    const pending = active.pendingGuidance.splice(0);
    for (const guidance of pending) {
      active.onEvent({ activity: guidanceActivity(guidance, 'completed') });
    }
    void this.finishExecTurn(
      streamId,
      active,
      new ExecSteerCheckpointError(pending.map((guidance) => guidance.prompt).join('\n\n'), active.threadId)
    );
    if (interrupt && !active.child.killed) {
      active.child.kill('SIGINT');
    }
  }

  private async finishExecTurn(streamId: string, active: ActiveExecTurn, error?: Error): Promise<void> {
    if (active.settled) {
      return;
    }
    active.settled = true;
    this.activeExecTurns.delete(streamId);
    if (error) {
      if (active.cancelled) {
        active.onEvent({ done: true, cancelled: true, usedProvider: 'Codex' });
        active.resolve();
      } else {
        active.reject(error);
      }
      return;
    }
    if (active.cancelled) {
      active.onEvent({ done: true, cancelled: true, usedProvider: 'Codex' });
      active.resolve();
      return;
    }
    try {
      const artifacts = await this.collectArtifacts(active);
      if (artifacts.length) {
        active.onEvent({ artifacts });
        active.onEvent({ activity: activity(`artifact:${streamId}`, 'artifact', 'Generated visual analysis', 'completed') });
      }
      active.onEvent({ done: true, usedProvider: 'Codex' });
      active.resolve();
    } catch (artifactError) {
      const detail = artifactError instanceof Error ? artifactError.message : String(artifactError);
      active.onEvent({ activity: activity(`artifact:${streamId}`, 'artifact', 'Could not load generated visual analysis', 'error', detail) });
      active.onEvent({ done: true, usedProvider: 'Codex' });
      active.resolve();
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.start().catch((error) => {
        this.initializePromise = undefined;
        throw error;
      });
    }
    return this.initializePromise;
  }

  private async start(): Promise<void> {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.readStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      if (chunk.trim()) {
        console.warn(`[codex-app-server] ${chunk.trim()}`);
      }
    });
    child.once('error', (error) => this.failConnection(error));
    child.once('exit', (code, signal) => {
      this.failConnection(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'}).`));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'sidelight-reader',
        title: 'Tessel Reader',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify('initialized', {});
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        this.handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
      } catch (error) {
        console.warn('Could not parse Codex app-server output', error);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(Number(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message || 'Codex app-server request failed.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method === 'item/tool/call') {
      void this.handleDynamicToolCall(message);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.replyError(message.id, `Unsupported Codex server request: ${message.method}`);
      return;
    }
    this.handleNotification(message.method, message.params ?? {});
  }

  private handleNotification(method: string | undefined, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const active = threadId ? this.activeTurnForThread(threadId) : undefined;
    if (!active) {
      return;
    }

    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      active.onEvent({ delta: params.delta, usedProvider: 'Codex' });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as { id?: unknown; type?: unknown; tool?: unknown; command?: unknown } | undefined;
      const event = activityFromCodexItem(item, method === 'item/started' ? 'started' : 'completed');
      if (event) {
        active.onEvent({ activity: event });
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn as { id?: unknown; status?: unknown; error?: { message?: unknown } } | undefined;
      void this.finishTurn(active, turn);
    }
  }

  private async finishTurn(
    active: ActiveTurn & { streamId: string },
    turn: { id?: unknown; status?: unknown; error?: { message?: unknown } } | undefined
  ): Promise<void> {
    if (!this.activeTurns.delete(active.streamId)) {
      return;
    }

    const failed = turn?.status === 'failed';
    if (failed) {
      const message = typeof turn?.error?.message === 'string' ? turn.error.message : 'Codex could not complete this turn.';
      if (isAppServerClientForbidden(message)) {
        active.reject(new Error(message));
        return;
      }
      active.onEvent({ error: message, done: true });
      active.reject(new Error(message));
      return;
    }

    if (turn?.status === 'interrupted') {
      active.onEvent({ done: true, cancelled: true, usedProvider: 'Codex' });
      active.resolve();
      return;
    }

    try {
      const artifacts = await this.collectArtifacts(active);
      if (artifacts.length > 0) {
        active.onEvent({ artifacts });
        active.onEvent({ activity: activity(`artifact:${active.streamId}`, 'artifact', 'Generated visual analysis', 'completed') });
      }
      active.onEvent({ done: true, usedProvider: 'Codex' });
      active.resolve();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      active.onEvent({ activity: activity(`artifact:${active.streamId}`, 'artifact', 'Could not load generated visual analysis', 'error', message) });
      active.onEvent({ done: true, usedProvider: 'Codex' });
      active.resolve();
    }
  }

  private async handleDynamicToolCall(message: JsonRpcMessage): Promise<void> {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const callId = typeof params.callId === 'string' ? params.callId : 'tool';
    const tool = typeof params.tool === 'string' ? params.tool : '';
    const context = threadId ? this.threadContexts.get(threadId) : undefined;
    if (!context || message.id === undefined) {
      if (message.id !== undefined) {
        this.replyError(message.id, 'No active Sidelight PDF context is available.');
      }
      return;
    }

    const label = dynamicToolLabel(tool);
    context.onEvent({ activity: activity(callId, 'tool', label, 'started') });
    try {
      const result = await this.runPdfTool(tool, params.arguments, context.input);
      this.reply(message.id, {
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
        success: true
      });
      context.onEvent({ activity: activity(callId, 'tool', label, 'completed') });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.reply(message.id, {
        contentItems: [{ type: 'inputText', text: JSON.stringify({ error: detail }) }],
        success: false
      });
      context.onEvent({ activity: activity(callId, 'tool', label, 'error', detail) });
    }
  }

  private async runPdfTool(tool: string, rawArguments: unknown, input: CodexStreamRequest): Promise<unknown> {
    const runtime = await this.resolvePdf(input.documentId);
    const args = rawArguments && typeof rawArguments === 'object' ? rawArguments as Record<string, unknown> : {};
    if (tool === 'sidelight_pdf_describe') {
      return {
        document_id: runtime.document.id,
        hash: runtime.document.fingerprint?.hash ?? runtime.document.sha256,
        file_path: runtime.document.filePath,
        title: runtime.document.title,
        file_name: runtime.document.fileName,
        page_count: input.context.totalPages
      };
    }
    if (tool === 'sidelight_pdf_read_pages') {
      const start = boundedInteger(args.page_start, 1, input.context.totalPages ?? Number.MAX_SAFE_INTEGER, input.context.currentPage ?? 1);
      const end = boundedInteger(args.page_end, start, input.context.totalPages ?? Number.MAX_SAFE_INTEGER, start);
      const maxChars = boundedInteger(args.max_chars, 1000, 40000, 24000);
      return runtime.readPages(start, end, maxChars);
    }
    if (tool === 'sidelight_pdf_read_outline') {
      const maxItems = boundedInteger(args.max_items, 1, 240, 120);
      return runtime.readOutline(maxItems);
    }
    if (tool === 'sidelight_pdf_read_selection') {
      return {
        page: input.context.pageStart ?? input.context.currentPage,
        text: input.context.selectedText ?? input.context.pdfText ?? '',
        document_id: runtime.document.id
      };
    }
    throw new Error(`Unknown Sidelight PDF tool: ${tool}`);
  }

  private activeTurnForThread(threadId: string): (ActiveTurn & { streamId: string }) | undefined {
    for (const [streamId, active] of this.activeTurns) {
      if (active.threadId === threadId) {
        return { ...active, streamId };
      }
    }
    return undefined;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private reply(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  private replyError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32000, message } });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex app-server is not running.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failConnection(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const [streamId, active] of this.activeTurns) {
      active.onEvent({ error: error.message, done: true });
      active.reject(error);
      this.activeTurns.delete(streamId);
    }
    this.child = undefined;
    this.initializePromise = undefined;
    this.threadContexts.clear();
  }
}

function dynamicPdfTools(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      name: 'sidelight_pdf_describe',
      description: 'Return metadata and the local file path for the PDF currently open in Sidelight.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    },
    {
      type: 'function',
      name: 'sidelight_pdf_read_pages',
      description: 'Read extracted text from a bounded 1-based PDF page range.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page_start: { type: 'integer' },
          page_end: { type: 'integer' },
          max_chars: { type: 'integer' }
        }
      }
    },
    {
      type: 'function',
      name: 'sidelight_pdf_read_outline',
      description: 'Read the PDF outline with resolved page numbers when available.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { max_items: { type: 'integer' } }
      }
    },
    {
      type: 'function',
      name: 'sidelight_pdf_read_selection',
      description: 'Read the text selection currently attached to this Sidelight conversation.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    }
  ];
}

function activity(
  id: string,
  kind: AgentActivityEvent['kind'],
  label: string,
  status: AgentActivityEvent['status'],
  detail?: string
): AgentActivityEvent {
  return { id, kind, label, status, detail, updatedAt: new Date().toISOString() };
}

function guidanceActivity(
  pending: PendingSteer,
  status: AgentActivityEvent['status'],
  errorDetail?: string
): AgentActivityEvent {
  return activity(
    pending.id,
    'reading',
    status === 'started'
      ? 'Guidance queued for the next checkpoint'
      : status === 'error'
        ? 'Could not deliver guidance to Codex'
        : 'Guidance delivered to Codex',
    status,
    errorDetail ?? pending.prompt.slice(0, 240)
  );
}

function activityFromCodexItem(
  item: { id?: unknown; type?: unknown; tool?: unknown; command?: unknown; changes?: unknown } | undefined,
  status: AgentActivityEvent['status']
): AgentActivityEvent | undefined {
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') {
    return undefined;
  }
  if (item.type === 'reasoning' || item.type === 'agentMessage' || item.type === 'userMessage') {
    return undefined;
  }
  if (item.type === 'commandExecution') {
    return activity(item.id, 'command', 'Running a local analysis command', status);
  }
  if (item.type === 'fileChange' || item.type === 'imageGeneration') {
    return activity(item.id, 'artifact', 'Preparing a reading artifact', status);
  }
  if (item.type === 'webSearch') {
    return activity(item.id, 'tool', 'Searching for supporting information', status);
  }
  if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
    return activity(item.id, 'tool', typeof item.tool === 'string' ? dynamicToolLabel(item.tool) : 'Using a PDF tool', status);
  }
  return undefined;
}

function activityFromExecItem(
  item: { id?: unknown; type?: unknown } | undefined,
  status: AgentActivityEvent['status']
): AgentActivityEvent | undefined {
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') {
    return undefined;
  }
  if (item.type === 'command_execution') {
    return activity(item.id, 'command', 'Running a local analysis command', status);
  }
  if (item.type === 'file_change' || item.type === 'image_generation') {
    return activity(item.id, 'artifact', 'Preparing a reading artifact', status);
  }
  if (item.type === 'web_search') {
    return activity(item.id, 'tool', 'Searching for supporting information', status);
  }
  return undefined;
}

function execItemIsSteerCheckpoint(item: { type?: unknown } | undefined): boolean {
  return typeof item?.type === 'string' && [
    'command_execution',
    'file_change',
    'image_generation',
    'web_search',
    'mcp_tool_call',
    'dynamic_tool_call'
  ].includes(item.type);
}

function steerContinuationPrompt(guidance: string): string {
  return [
    'The user sent the following guidance while you were working:',
    guidance,
    '',
    'Apply it to the active PDF task now. Continue from the existing thread without repeating completed work.'
  ].join('\n');
}

function execArgs(input: CodexStreamRequest, workspaceDirectory: string, prompt: string, imagePaths: string[]): string[] {
  const modelArgs = input.model?.trim() ? ['--model', input.model.trim()] : [];
  const effortArgs = input.effort?.trim() ? ['--config', `model_reasoning_effort="${input.effort.trim()}"`] : [];
  const sandboxMode = codexSandboxMode(input.permissionMode);
  const resumedPermissionArgs = [
    '--config',
    `sandbox_mode="${sandboxMode}"`,
    '--config',
    'approval_policy="never"',
    '--config',
    'web_search="live"',
    ...(sandboxMode === 'workspace-write'
      ? ['--config', 'sandbox_workspace_write.network_access=true']
      : [])
  ];
  const imageArgs = imagePaths.flatMap((imagePath) => ['--image', imagePath]);
  if (input.codexThreadId && !input.transient) {
    return [
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      ...resumedPermissionArgs,
      ...modelArgs,
      ...effortArgs,
      ...imageArgs,
      input.codexThreadId,
      prompt
    ];
  }
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    sandboxMode,
    '--config',
    'approval_policy="never"',
    '--config',
    'web_search="live"',
    ...(sandboxMode === 'workspace-write'
      ? ['--config', 'sandbox_workspace_write.network_access=true']
      : []),
    '--cd',
    workspaceDirectory,
    ...(input.transient ? ['--ephemeral'] : []),
    ...modelArgs,
    ...effortArgs,
    ...imageArgs,
    prompt
  ];
}

function selectionBounds(rects: AiDocumentToolContext['selectionRects']): Array<{
  pageNumber: number;
  left: number;
  top: number;
  width: number;
  height: number;
}> | undefined {
  if (!rects?.length) {
    return undefined;
  }
  const boundsByPage = new Map<number, { left: number; top: number; right: number; bottom: number }>();
  for (const rect of rects) {
    if (![rect.pageNumber, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
      continue;
    }
    const right = rect.left + rect.width;
    const bottom = rect.top + rect.height;
    const existing = boundsByPage.get(rect.pageNumber);
    if (existing) {
      existing.left = Math.min(existing.left, rect.left);
      existing.top = Math.min(existing.top, rect.top);
      existing.right = Math.max(existing.right, right);
      existing.bottom = Math.max(existing.bottom, bottom);
    } else {
      boundsByPage.set(rect.pageNumber, { left: rect.left, top: rect.top, right, bottom });
    }
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return [...boundsByPage.entries()]
    .sort(([leftPage], [rightPage]) => leftPage - rightPage)
    .map(([pageNumber, bounds]) => ({
      pageNumber,
      left: round(bounds.left),
      top: round(bounds.top),
      width: round(bounds.right - bounds.left),
      height: round(bounds.bottom - bounds.top)
    }));
}

function isAppServerClientForbidden(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /403\s+forbidden/i.test(message) && /only allows Codex official clients/i.test(message);
}

function isMissingExecSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id|thread\/resume failed/i.test(message);
}

const fallbackCodexModels: CodexModelInfo[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    description: 'Complex reasoning and coding',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'low'
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    description: 'Balanced reasoning and cost',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    description: 'Fast, high-volume reading tasks',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'medium'
  }
];

function dynamicToolLabel(tool: string): string {
  switch (tool) {
    case 'sidelight_pdf_describe': return 'Inspecting PDF metadata';
    case 'sidelight_pdf_read_pages': return 'Reading PDF pages';
    case 'sidelight_pdf_read_outline': return 'Reading PDF outline';
    case 'sidelight_pdf_read_selection': return 'Reading selected passage';
    default: return 'Using a PDF tool';
  }
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.max(min, Math.min(max, fallback));
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function extensionForAttachment(fileName: string, mimeType: string): string {
  const extension = extname(fileName);
  if (/^\.[a-z0-9]{1,8}$/i.test(extension)) {
    return extension;
  }
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.img';
}

function workspaceWriteSandbox(workspaceDirectory: string): Record<string, unknown> {
  return {
    type: 'workspaceWrite',
    writableRoots: [workspaceDirectory],
    // Network access allows Codex's configured search capabilities while the
    // filesystem boundary remains the per-document workspace.
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function codexSandboxMode(permissionMode: CodexPermissionMode | undefined): string {
  if (permissionMode === 'read-only') {
    return 'read-only';
  }
  if (permissionMode === 'full-access') {
    return 'danger-full-access';
  }
  return 'workspace-write';
}

function codexSandboxPolicy(
  permissionMode: CodexPermissionMode | undefined,
  workspaceDirectory: string
): Record<string, unknown> {
  if (permissionMode === 'read-only') {
    return { type: 'readOnly', networkAccess: true };
  }
  if (permissionMode === 'full-access') {
    return { type: 'dangerFullAccess' };
  }
  return workspaceWriteSandbox(workspaceDirectory);
}

async function listWorkspaceImages(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 4) {
      return;
    }
    const entries = await readdir(current, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const filePath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath, depth + 1);
      } else if (entry.isFile() && imageMimeType(filePath)) {
        files.push(filePath);
      }
    }));
  };
  await visit(directory, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

function imageMimeType(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    default: return undefined;
  }
}

function imageVersion(details: { mtimeMs: number; size: number }): string {
  return `${Math.floor(details.mtimeMs)}:${details.size}`;
}
