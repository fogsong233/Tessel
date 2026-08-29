import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import WebSocket, { WebSocketServer } from 'ws';
import type { PdfDocumentMeta, WorkspaceBlock } from '../shared/domain';
import { createId } from '../shared/ids';
import {
  isLanDrawingPoint,
  isLanDrawingStroke,
  type LanDrawingStroke,
  type LanWhiteboardClientMessage,
  type LanWhiteboardContext,
  type LanWhiteboardRendererEvent,
  type LanWhiteboardServerInfo,
  type LanWhiteboardServerMessage,
  type LanWhiteboardSide,
  type LanWhiteboardSnapshot
} from '../shared/lanWhiteboard';
import type { JsonWorkspaceStore } from './store';

interface LanWhiteboardServerOptions {
  rendererDirectory: string;
  store: JsonWorkspaceStore;
  runMutation<T>(operation: () => Promise<T>): Promise<T>;
  publishToRenderers(event: LanWhiteboardRendererEvent): void;
}

interface DrawingPayload {
  version?: number;
  side: LanWhiteboardSide;
  sheetIndex?: number;
  layoutScale?: number;
  penOnly?: boolean;
  canvasWidth: number;
  canvasHeight: number;
  strokes: LanDrawingStroke[];
}

const defaultPort = 32_187;
const maximumMessageBytes = 2 * 1024 * 1024;
const maximumCanvasPoints = 500_000;

export class LanWhiteboardServer {
  private readonly rendererDirectory: string;
  private readonly store: JsonWorkspaceStore;
  private readonly runMutation: LanWhiteboardServerOptions['runMutation'];
  private readonly publishToRenderers: LanWhiteboardServerOptions['publishToRenderers'];
  private readonly token = randomBytes(24).toString('base64url');
  private readonly canvases = new Map<string, WorkspaceBlock>();
  private readonly pageSizeCache = new Map<string, { width: number; height: number }>();
  private documents: LanWhiteboardSnapshot['documents'] = [];
  private context?: LanWhiteboardContext;
  private revision = 0;
  private server?: Server;
  private webSocketServer?: WebSocketServer;
  private port?: number;

  constructor(options: LanWhiteboardServerOptions) {
    this.rendererDirectory = resolve(options.rendererDirectory);
    this.store = options.store;
    this.runMutation = options.runMutation;
    this.publishToRenderers = options.publishToRenderers;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await this.refreshSnapshot();

    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const webSocketServer = new WebSocketServer({
      clientTracking: true,
      maxPayload: maximumMessageBytes,
      noServer: true,
      perMessageDeflate: false
    });
    webSocketServer.on('connection', (socket) => this.handleConnection(socket));
    server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));

    const requestedPort = normalizePort(process.env.TESSEL_LAN_WHITEBOARD_PORT);
    try {
      await listen(server, requestedPort);
    } catch (error) {
      if (requestedPort === 0 || !isAddressInUse(error)) {
        throw error;
      }
      await listen(server, 0);
    }

    this.server = server;
    this.webSocketServer = webSocketServer;
    const address = server.address();
    this.port = address && typeof address === 'object' ? address.port : undefined;
    console.info(`[lan-whiteboard] listening on ${this.getInfo().urls[0] ?? 'unavailable'}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = undefined;
    this.webSocketServer = undefined;
    this.port = undefined;
    for (const client of webSocketServer?.clients ?? []) {
      client.close(1001, 'Tessel is closing');
    }
    await Promise.all([
      webSocketServer ? closeWebSocketServer(webSocketServer) : Promise.resolve(),
      server ? closeHttpServer(server) : Promise.resolve()
    ]);
  }

  getInfo(): LanWhiteboardServerInfo {
    const port = this.port;
    const candidates = port ? lanAddressCandidates() : [];
    const recommendedAddress = candidates.find((candidate) => !candidate.loopback)?.address;
    const addresses = candidates.map((candidate) => ({
      ...candidate,
      recommended: candidate.address === recommendedAddress,
      url: `http://${candidate.address}:${port}/remote.html?token=${this.token}`
    }));
    return {
      running: Boolean(this.server?.listening && port),
      port,
      urls: addresses.map((item) => item.url),
      addresses,
      clientCount: this.webSocketServer?.clients.size ?? 0
    };
  }

  getSnapshot(): LanWhiteboardSnapshot {
    return {
      revision: this.revision,
      documents: this.documents,
      canvases: [...this.canvases.values()].sort(compareCanvases),
      context: this.context
    };
  }

  setContext(context: LanWhiteboardContext): void {
    const next = {
      documentId: context.documentId,
      pageNumber: Math.max(1, Math.floor(context.pageNumber))
    };
    if (this.context?.documentId === next.documentId && this.context.pageNumber === next.pageNumber) {
      return;
    }
    this.context = next;
    this.documents = this.documents.map((document) => document.id === next.documentId
      ? { ...document, currentPage: next.pageNumber }
      : document);
    this.publish({ type: 'context', context: next });
  }

  handleDocumentOpened(document: PdfDocumentMeta): void {
    const currentPage = Math.max(1, document.readingState?.lastPage ?? 1);
    const summary = {
      id: document.id,
      title: document.title,
      pageCount: document.pageCount,
      currentPage
    };
    this.documents = [summary, ...this.documents.filter((candidate) => candidate.id !== document.id)];
    this.setContext({ documentId: document.id, pageNumber: currentPage });
    // A tablet can remain connected while the desktop opens another PDF.
    // Refresh its document index without forcing a reconnect.
    this.broadcast({ type: 'snapshot', snapshot: this.getSnapshot() });
  }

  handleWorkspaceBlockUpsert(block: WorkspaceBlock): void {
    if (block.kind !== 'drawing') {
      return;
    }
    this.canvases.set(block.id, block);
    this.revision += 1;
    this.publish({ type: 'canvas-upsert', block, revision: this.revision });
  }

  handleWorkspaceBlockDelete(blockId: string): void {
    if (!this.canvases.delete(blockId)) {
      return;
    }
    this.revision += 1;
    this.publish({ type: 'canvas-delete', blockId, revision: this.revision });
  }

  private async refreshSnapshot(): Promise<void> {
    const [documents, blocks] = await Promise.all([
      this.store.listDocuments(),
      this.store.listAllWorkspaceBlocks()
    ]);
    this.documents = documents.map((document) => ({
      id: document.id,
      title: document.title,
      pageCount: document.pageCount,
      currentPage: Math.max(1, document.readingState?.lastPage ?? 1)
    }));
    this.canvases.clear();
    for (const block of blocks) {
      if (block.kind === 'drawing' && drawingPayload(block)) {
        this.canvases.set(block.id, block);
      }
    }
    const firstDocument = this.documents[0];
    if (firstDocument) {
      this.context = { documentId: firstDocument.id, pageNumber: firstDocument.currentPage };
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestUrl = requestUrlFor(request);
    if (requestUrl.pathname !== '/whiteboard' || requestUrl.searchParams.get('token') !== this.token || !this.webSocketServer) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') {
      socket.setNoDelay(true);
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSocketServer?.emit('connection', webSocket, request);
    });
  }

  private handleConnection(socket: WebSocket): void {
    send(socket, { type: 'snapshot', snapshot: this.getSnapshot() });
    this.publishPresence();
    socket.on('message', (data, isBinary) => {
      if (isBinary || rawDataByteLength(data) > maximumMessageBytes) {
        socket.close(1009, 'Message too large');
        return;
      }
      void this.handleClientMessage(socket, data.toString()).catch((error: unknown) => {
        console.warn('[lan-whiteboard] client message failed', error);
        send(socket, { type: 'error', message: errorMessage(error) });
      });
    });
    socket.on('close', () => this.publishPresence());
    socket.on('error', (error) => console.warn('[lan-whiteboard] socket error', error));
  }

  private async handleClientMessage(socket: WebSocket, source: string): Promise<void> {
    const message = JSON.parse(source) as LanWhiteboardClientMessage;
    switch (message.type) {
      case 'ping':
        send(socket, { type: 'pong', sentAt: finiteNumber(message.sentAt, Date.now()), serverAt: Date.now() });
        return;
      case 'create-canvas': {
        const side = message.side === 'left' ? 'left' : 'right';
        const saved = await this.createCanvas(message.documentId, message.pageNumber, side);
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision, canvasId: saved.id });
        if (!this.canvases.has(saved.id)) {
          this.handleWorkspaceBlockUpsert(saved);
        }
        return;
      }
      case 'delete-canvas': {
        const canvasId = requiredString(message.canvasId, 'canvasId');
        await this.runMutation(() => this.store.deleteWorkspaceBlock(canvasId));
        this.handleWorkspaceBlockDelete(canvasId);
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision });
        return;
      }
      case 'move-canvas': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        const side = message.side === 'left' ? 'left' : 'right';
        const saved = await this.moveCanvas(canvasId, side);
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision, canvasId: saved.id });
        return;
      }
      case 'set-pen-only': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        const saved = await this.setPenOnly(canvasId, message.penOnly === true);
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision, canvasId: saved.id });
        return;
      }
      case 'share-selection': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        const block = this.canvases.get(canvasId)!;
        const payload = drawingPayload(block)!;
        if (!Array.isArray(message.strokes) || !message.strokes.every(isLanDrawingStroke)) {
          throw new Error('Invalid shared selection.');
        }
        enforceCanvasPointLimit(message.strokes);
        const availableIds = new Set(payload.strokes.map((stroke) => stroke.id));
        const strokes = message.strokes.filter((stroke) => availableIds.has(stroke.id));
        if (strokes.length === 0) {
          throw new Error('Select at least one stroke before sharing.');
        }
        this.publishToRenderers({
          type: 'selection-share',
          selection: {
            canvasId,
            documentId: block.documentId,
            pageNumber: block.pageNumber ?? 1,
            strokes
          }
        });
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision, canvasId });
        return;
      }
      case 'stroke-begin': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        if (!isLanDrawingStroke(message.stroke)) {
          throw new Error('Invalid stroke');
        }
        this.publishTransient({ type: 'stroke-begin', canvasId, stroke: message.stroke }, socket);
        return;
      }
      case 'stroke-points': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        const strokeId = requiredString(message.strokeId, 'strokeId');
        if (!Array.isArray(message.points) || message.points.length > 2_048 || !message.points.every(isLanDrawingPoint)) {
          throw new Error('Invalid stroke points');
        }
        this.publishTransient({ type: 'stroke-points', canvasId, strokeId, points: message.points }, socket);
        return;
      }
      case 'stroke-cancel': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        const strokeId = requiredString(message.strokeId, 'strokeId');
        this.publishTransient({ type: 'stroke-cancel', canvasId, strokeId }, socket);
        return;
      }
      case 'stroke-commit': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        if (!isLanDrawingStroke(message.stroke)) {
          throw new Error('Invalid stroke');
        }
        await this.appendStroke(canvasId, message.stroke);
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision });
        return;
      }
      case 'replace-strokes': {
        const canvasId = requiredCanvasId(message.canvasId, this.canvases);
        if (!Array.isArray(message.strokes) || !message.strokes.every(isLanDrawingStroke)) {
          throw new Error('Invalid stroke list');
        }
        enforceCanvasPointLimit(message.strokes);
        await this.replaceStrokes(canvasId, message.strokes);
        send(socket, { type: 'ack', requestId: cleanRequestId(message.requestId), revision: this.revision });
        return;
      }
      default:
        throw new Error('Unsupported whiteboard message');
    }
  }

  private async createCanvas(documentId: unknown, pageNumber: unknown, side: LanWhiteboardSide): Promise<WorkspaceBlock> {
    const selectedDocumentId = typeof documentId === 'string' && this.documents.some((item) => item.id === documentId)
      ? documentId
      : this.context?.documentId;
    if (!selectedDocumentId) {
      throw new Error('Open a PDF in Tessel before creating a canvas.');
    }
    const document = this.documents.find((item) => item.id === selectedDocumentId);
    const selectedPage = clampInteger(
      typeof pageNumber === 'number' ? pageNumber : this.context?.documentId === selectedDocumentId ? this.context.pageNumber : document?.currentPage,
      1,
      Math.max(1, document?.pageCount ?? 100_000)
    );
    const notebookSheets = [...this.canvases.values()].filter((block) => block.documentId === selectedDocumentId
      && block.pageNumber === selectedPage);
    const notebookSide = notebookSheets[0] ? drawingPayload(notebookSheets[0])?.side ?? side : side;
    const sheetIndex = Math.max(
      notebookSheets.length,
      notebookSheets.reduce((maximum, block) => Math.max(maximum, drawingPayload(block)?.sheetIndex ?? 0), 0)
    ) + 1;

    const { width, height } = await this.readPageSize(selectedDocumentId, selectedPage);
    const now = new Date().toISOString();
    const block: WorkspaceBlock = {
      id: createId('drawing'),
      documentId: selectedDocumentId,
      kind: 'drawing',
      anchor: 'page',
      sourceKind: 'manual',
      contentKind: 'custom',
      pageNumber: selectedPage,
      title: `Notebook · p.${selectedPage} · ${sheetIndex}`,
      payload: {
        version: 1,
        side: notebookSide,
        sheetIndex,
        layoutScale: 1,
        canvasWidth: width,
        canvasHeight: height,
        strokes: []
      },
      x: notebookSide === 'left' ? -width - 28 : 28,
      y: 0,
      width,
      height,
      createdAt: now,
      updatedAt: now
    };
    const saved = await this.runMutation(() => this.store.saveWorkspaceBlock(block));
    this.handleWorkspaceBlockUpsert(saved);
    return saved;
  }

  private async appendStroke(canvasId: string, stroke: LanDrawingStroke): Promise<void> {
    const block = this.canvases.get(canvasId);
    const payload = block && drawingPayload(block);
    if (!block || !payload) {
      throw new Error('Canvas not found');
    }
    const strokes = [...payload.strokes.filter((candidate) => candidate.id !== stroke.id), stroke];
    enforceCanvasPointLimit(strokes);
    await this.saveCanvasStrokes(block, payload, strokes);
    this.publishTransient({ type: 'stroke-cancel', canvasId, strokeId: stroke.id });
  }

  private async moveCanvas(canvasId: string, side: LanWhiteboardSide): Promise<WorkspaceBlock> {
    const block = this.canvases.get(canvasId);
    const payload = block && drawingPayload(block);
    if (!block || !payload) {
      throw new Error('Canvas not found');
    }
    const notebookSheets = [...this.canvases.values()].filter((candidate) => candidate.documentId === block.documentId
      && candidate.pageNumber === block.pageNumber);
    if (notebookSheets.every((candidate) => drawingPayload(candidate)?.side === side)) {
      return block;
    }
    const updatedAt = new Date().toISOString();
    const savedSheets = await this.runMutation(async () => {
      const saved: WorkspaceBlock[] = [];
      for (const sheet of notebookSheets) {
        saved.push(await this.store.saveWorkspaceBlock({
          ...sheet,
          payload: { ...sheet.payload, side },
          x: side === 'left' ? -sheet.width - 28 : 28,
          updatedAt
        }));
      }
      return saved;
    });
    for (const saved of savedSheets) {
      this.handleWorkspaceBlockUpsert(saved);
    }
    return savedSheets.find((saved) => saved.id === canvasId) ?? savedSheets[0] ?? block;
  }

  private async setPenOnly(canvasId: string, penOnly: boolean): Promise<WorkspaceBlock> {
    const block = this.canvases.get(canvasId);
    const payload = block && drawingPayload(block);
    if (!block || !payload) {
      throw new Error('Canvas not found');
    }
    const saved = await this.runMutation(() => this.store.saveWorkspaceBlock({
      ...block,
      payload: { ...block.payload, penOnly },
      updatedAt: new Date().toISOString()
    }));
    this.handleWorkspaceBlockUpsert(saved);
    return saved;
  }

  private async replaceStrokes(canvasId: string, strokes: LanDrawingStroke[]): Promise<void> {
    const block = this.canvases.get(canvasId);
    const payload = block && drawingPayload(block);
    if (!block || !payload) {
      throw new Error('Canvas not found');
    }
    await this.saveCanvasStrokes(block, payload, strokes);
  }

  private async saveCanvasStrokes(block: WorkspaceBlock, payload: DrawingPayload, strokes: LanDrawingStroke[]): Promise<void> {
    const saved = await this.runMutation(() => this.store.saveWorkspaceBlock({
      ...block,
      payload: { ...block.payload, ...payload, strokes },
      updatedAt: new Date().toISOString()
    }));
    this.handleWorkspaceBlockUpsert(saved);
  }

  private async readPageSize(documentId: string, pageNumber: number): Promise<{ width: number; height: number }> {
    const cacheKey = `${documentId}:${pageNumber}`;
    const cached = this.pageSizeCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    let size = { width: 612, height: 792 };
    try {
      const document = await this.store.getDocument(documentId);
      if (document) {
        const bytes = await readFile(document.filePath);
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        const page = pdf.getPage(Math.min(pdf.getPageCount() - 1, Math.max(0, pageNumber - 1)));
        const measured = page.getSize();
        if (measured.width > 0 && measured.height > 0) {
          size = { width: Math.round(measured.width), height: Math.round(measured.height) };
        }
      }
    } catch (error) {
      console.warn(`[lan-whiteboard] could not read page size for ${documentId}#${pageNumber}`, error);
    }
    this.pageSizeCache.set(cacheKey, size);
    return size;
  }

  private publish(message: LanWhiteboardRendererEvent): void {
    this.publishToRenderers(message);
    this.broadcast(message);
  }

  private publishTransient(message: LanWhiteboardRendererEvent, except?: WebSocket): void {
    this.publishToRenderers(message);
    this.broadcast(message, except);
  }

  private publishPresence(): void {
    const message: LanWhiteboardRendererEvent = {
      type: 'presence',
      clientCount: this.webSocketServer?.clients.size ?? 0
    };
    this.publish(message);
  }

  private broadcast(message: LanWhiteboardServerMessage, except?: WebSocket): void {
    const encoded = JSON.stringify(message);
    for (const client of this.webSocketServer?.clients ?? []) {
      if (client !== except && client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    }
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = requestUrlFor(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeText(response, 405, 'Method not allowed');
      return;
    }
    const isAsset = requestUrl.pathname.startsWith('/assets/');
    if (!isAsset && requestUrl.searchParams.get('token') !== this.token) {
      writeText(response, 403, 'This Tessel link is invalid or has expired.');
      return;
    }
    const relativePath = requestUrl.pathname === '/' || requestUrl.pathname === '/remote.html'
      ? 'remote.html'
      : requestUrl.pathname.replace(/^\/+/, '');
    const absolutePath = resolve(this.rendererDirectory, relativePath);
    if (absolutePath !== this.rendererDirectory && !absolutePath.startsWith(`${this.rendererDirectory}${sep}`)) {
      writeText(response, 404, 'Not found');
      return;
    }
    try {
      const body = await readFile(absolutePath);
      response.writeHead(200, {
        'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-store',
        'Content-Length': body.byteLength,
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
        'Content-Type': mimeType(absolutePath),
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff'
      });
      if (request.method === 'GET') {
        response.end(body);
      } else {
        response.end();
      }
    } catch {
      writeText(response, 404, 'Not found');
    }
  }
}

function drawingPayload(block: WorkspaceBlock): DrawingPayload | undefined {
  const value = block.payload;
  const side = value?.side;
  const canvasWidth = Number(value?.canvasWidth ?? block.width);
  const canvasHeight = Number(value?.canvasHeight ?? block.height);
  const strokes = value?.strokes;
  if ((side !== 'left' && side !== 'right')
    || !Number.isFinite(canvasWidth)
    || !Number.isFinite(canvasHeight)
    || !Array.isArray(strokes)
    || !strokes.every(isLanDrawingStroke)) {
    return undefined;
  }
  return {
    version: Number(value?.version ?? 1),
    side,
    sheetIndex: Number.isFinite(Number(value?.sheetIndex)) ? Math.max(1, Math.floor(Number(value?.sheetIndex))) : undefined,
    layoutScale: Number(value?.layoutScale ?? 1),
    penOnly: value?.penOnly === true,
    canvasWidth,
    canvasHeight,
    strokes
  };
}

function enforceCanvasPointLimit(strokes: LanDrawingStroke[]): void {
  const pointCount = strokes.reduce((total, stroke) => total + stroke.points.length, 0);
  if (pointCount > maximumCanvasPoints) {
    throw new Error('This canvas has reached its point limit.');
  }
}

function requestUrlFor(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
}

function requiredCanvasId(value: unknown, canvases: Map<string, WorkspaceBlock>): string {
  const id = requiredString(value, 'canvasId');
  if (!canvases.has(id)) {
    throw new Error('Canvas not found');
  }
  return id;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function cleanRequestId(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInteger(value: unknown, minimum: number, maximum: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : minimum;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function normalizePort(value: string | undefined): number {
  if (value === '0') {
    return 0;
  }
  const numeric = Number(value ?? defaultPort);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65_535 ? numeric : defaultPort;
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE');
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function send(socket: WebSocket, message: LanWhiteboardServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function lanAddressCandidates(): Array<{ address: string; interfaceName: string; loopback: boolean }> {
  const candidates = new Map<string, { address: string; interfaceName: string; loopback: boolean; score: number }>();
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    if (isVirtualInterface(interfaceName)) {
      continue;
    }
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isUsablePrivateAddress(entry.address)) {
        continue;
      }
      const candidate = {
        address: entry.address,
        interfaceName,
        loopback: false,
        score: interfaceScore(interfaceName, entry.address)
      };
      if (!candidates.has(entry.address) || candidates.get(entry.address)!.score < candidate.score) {
        candidates.set(entry.address, candidate);
      }
    }
  }
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return [
    ...sorted.map(({ score: _score, ...candidate }) => candidate),
    { address: '127.0.0.1', interfaceName: 'Localhost', loopback: true }
  ];
}

function isVirtualInterface(name: string): boolean {
  return /(vethernet|wsl|docker|hyper-v|vmware|virtualbox|loopback|clash|mihomo|tun|tap|tailscale|zerotier)/i.test(name);
}

function isUsablePrivateAddress(address: string): boolean {
  if (address.startsWith('169.254.') || address.startsWith('198.18.') || address.startsWith('198.19.')) {
    return false;
  }
  if (address.startsWith('10.') || address.startsWith('192.168.')) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(address);
  const second = Number(match?.[1]);
  return Boolean(match && second >= 16 && second <= 31);
}

function interfaceScore(name: string, address: string): number {
  const namedPhysical = /(wi-?fi|wireless|wlan|ethernet|以太网|无线)/i.test(name) ? 100 : 0;
  const commonHomeRange = address.startsWith('192.168.') ? 40 : address.startsWith('10.') ? 30 : 20;
  return namedPhysical + commonHomeRange;
}

function compareCanvases(a: WorkspaceBlock, b: WorkspaceBlock): number {
  return a.documentId.localeCompare(b.documentId)
    || (a.pageNumber ?? 0) - (b.pageNumber ?? 0)
    || (drawingPayload(a)?.sheetIndex ?? Number.MAX_SAFE_INTEGER) - (drawingPayload(b)?.sheetIndex ?? Number.MAX_SAFE_INTEGER)
    || drawingSideOrder(a) - drawingSideOrder(b)
    || a.createdAt.localeCompare(b.createdAt);
}

function drawingSideOrder(block: WorkspaceBlock): number {
  return drawingPayload(block)?.side === 'left' ? 0 : 1;
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function writeText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Whiteboard request failed';
}

function rawDataByteLength(data: WebSocket.RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}
