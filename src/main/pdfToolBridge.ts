import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/** Stateless, loopback-only MCP transport for CLI exec, scoped to one turn. */
export class PdfToolBridge {
  private server?: Server;
  private starting?: Promise<number>;
  private readonly routes = new Map<string, (name: string, args: unknown) => Promise<unknown>>();

  constructor(private readonly tools: Array<Record<string, unknown>>) {}

  async register(call: (name: string, args: unknown) => Promise<unknown>): Promise<{ url: string; dispose(): void }> {
    const port = await (this.starting ??= this.start());
    const path = `/${randomUUID()}`;
    this.routes.set(path, call);
    return { url: `http://127.0.0.1:${port}${path}`, dispose: () => { this.routes.delete(path); } };
  }

  close(): void {
    this.routes.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
  }

  private start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        const call = this.routes.get(request.url ?? '');
        // Browser origins cannot access document tools. The unpredictable route
        // is a per-turn capability; no global Codex config or PDF copy is needed.
        if (!call || request.headers.origin) {
          response.writeHead(403).end();
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(request.method === 'DELETE' ? 204 : 405).end();
          return;
        }
        let id: string | number | null = null;
        try {
          request.setEncoding('utf8');
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 64 * 1024) {
              response.writeHead(413).end();
              return;
            }
          }
          const message = JSON.parse(body) as { id?: string | number; method: string; params?: Record<string, unknown> };
          id = message.id ?? null;
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          let result: unknown;
          if (message.method === 'initialize') {
            const requested = message.params?.protocolVersion;
            result = {
              protocolVersion: typeof requested === 'string' && ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'tessel-pdf', version: '1.0.0' },
              instructions: 'Read PDF text with these cached tools. Do not run pdftotext or parse the PDF again.'
            };
          } else if (message.method === 'tools/list') {
            result = { tools: this.tools.map(({ type: _type, ...tool }) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false } })) };
          } else if (message.method === 'tools/call') {
            try {
              const value = await call(String(message.params?.name ?? ''), message.params?.arguments);
              result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
            } catch (error) {
              result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
            }
          } else if (message.method === 'ping') {
            result = {};
          } else {
            response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } }));
            return;
          }
          response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch {
          response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Invalid request' } }));
        }
      });
      this.server = server;
      server.once('error', (error) => { this.starting = undefined; reject(error); });
      server.listen(0, '127.0.0.1', () => {
        server.unref();
        const address = server.address();
        if (address && typeof address !== 'string') resolve(address.port);
        else reject(new Error('Could not start the PDF tool bridge.'));
      });
    });
  }
}
