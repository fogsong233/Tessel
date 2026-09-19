import { expect, test } from '@playwright/test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexAgent } from '../../src/main/codexAgent';
import { PdfDocumentCache, type CachedPdfSource } from '../../src/main/pdfDocumentCache';
import { PdfToolBridge } from '../../src/main/pdfToolBridge';
import { localPathFromMarkdownUrl, normalizeMarkdownText } from '../../src/shared/markdownText';
import { reconcileStreamText } from '../../src/renderer/src/streamText';
import type { AiStreamEvent, CodexStreamRequest, PdfDocumentMeta } from '../../src/shared/domain';

test('PDF cache coalesces concurrent page extraction and invalidates changed documents without destroying active reads', async () => {
  let loads = 0;
  let extractions = 0;
  let destroyed = 0;
  const cache = new PdfDocumentCache(async () => {
    loads++;
    return {
      numPages: 2,
      destroy: async () => { destroyed++; },
      getPage: async () => ({ getTextContent: async () => { extractions++; return { items: [{ str: 'Cached text' }] }; } }),
      getOutline: async () => [], getDestination: async () => null, getPageIndex: async () => 0
    } satisfies CachedPdfSource;
  }, 1);
  const [a, b] = await Promise.all([cache.acquire('book.pdf', 'v1'), cache.acquire('book.pdf', 'v1')]);
  const [first, second] = await Promise.all([(await a.getPage(1)).getTextContent(), (await b.getPage(1)).getTextContent()]);
  expect(first).toEqual(second);
  expect({ loads, extractions }).toEqual({ loads: 1, extractions: 1 });
  const updated = await cache.acquire('book.pdf', 'v2');
  expect(loads).toBe(2);
  expect(destroyed).toBe(0);
  await a.destroy(); await b.destroy();
  expect(destroyed).toBe(1);
  await updated.destroy();
  const next = await cache.acquire('next.pdf', 'v1');
  await expect.poll(() => destroyed).toBe(2);
  cache.clear();
  expect(destroyed).toBe(2);
  await next.destroy();
  expect(destroyed).toBe(3);
});

test('renders Codex file citations and image directives without altering code or double-encoding paths', () => {
  const directive = ':codex-file-citation{path="D:\\paper\\Book 100%.pdf" purpose="source"}';
  expect(normalizeMarkdownText(`Answer.\n${directive}`)).toBe('Answer.\n[Book 100%.pdf](<file:///D:/paper/Book%20100%25.pdf>)');
  expect(normalizeMarkdownText('Text\n:codex-file-citation{path="D:')).toBe('Text\n');
  const code = `~~~markdown\n${directive}\n![Image](sandbox:D:\\folder\\a b.png)\n\\(code\\)\nconst fence = "~~~";\n~~~\n`;
  expect(normalizeMarkdownText(code)).toBe(code);
  const nested = '``a ` tick [file](sandbox:/a b)``\n    [indented](sandbox:/a b)\n';
  expect(normalizeMarkdownText(nested)).toBe(nested);
  expect(normalizeMarkdownText('[File](sandbox:/tmp/a%20b.png)')).toBe('[File](<file:///tmp/a%20b.png>)');
  expect(normalizeMarkdownText('![Plot](sandbox:/tmp/chart (1).png)')).toBe('![Plot](<file:///tmp/chart%20(1).png>)');
  expect(normalizeMarkdownText('[File](<file:///D:/Book%20(2).pdf>)')).toBe('[File](<file:///D:/Book%20(2).pdf>)');
  expect(normalizeMarkdownText(':codex-image{path="/tmp/image.png"}')).toBe('![image.png](<file:///tmp/image.png>)');
  expect(localPathFromMarkdownUrl('/tmp/100%.png')).toBe('/tmp/100%.png');
  expect(normalizeMarkdownText('\\(x^2\\)')).toBe('$x^2$');
});

test('authoritative corrections preserve replies split by mid-turn guidance', () => {
  expect(reconcileStreamText(['First answer.', '\n\nDraft continuation.'], 'First answer.\n\nFinal continuation.')).toEqual(['First answer.', '\n\nFinal continuation.']);
  expect(reconcileStreamText(['First draft.', '\n\nContinuation.'], 'Corrected answer.\n\nContinuation.')).toEqual(['Corrected answer.', '\n\nContinuation.']);
  expect(reconcileStreamText(['Earlier.', ''], 'Earlier.New output.')).toEqual(['Earlier.', 'New output.']);
  expect(reconcileStreamText(['Text.', 'Tail.'], 'Text.')).toEqual(['Text.', '']);
});

test('exec PDF bridge isolates turns and rejects browser access and expired capabilities', async () => {
  const bridge = new PdfToolBridge([{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }]);
  const a = await bridge.register(async () => 'Book A');
  const b = await bridge.register(async () => 'Book B');
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: {} } };
  try {
    const call = async (url: string) => (await fetch(url, { method: 'POST', body: JSON.stringify(request) })).json();
    expect((await call(a.url)).result.content[0].text).toBe('"Book A"');
    expect((await call(b.url)).result.content[0].text).toBe('"Book B"');
    expect((await fetch(a.url, { method: 'POST', headers: { Origin: 'https://example.com' }, body: JSON.stringify(request) })).status).toBe(403);
    a.dispose();
    expect((await fetch(a.url, { method: 'POST', body: JSON.stringify(request) })).status).toBe(403);
    expect((await call(b.url)).result.content[0].text).toBe('"Book B"');
  } finally { bridge.close(); }
});

test('Codex reuses one process for translations, streams authoritative text, and resumes saved threads', async ({}, info) => {
  const fixture = await createAgentFixture(info.outputPath('codex'));
  const events: Array<Omit<AiStreamEvent, 'streamId'>> = [];
  try {
    await fixture.agent.stream({ ...fixture.input, task: 'translate', transient: true }, (event) => events.push(event));
    await fixture.agent.stream({ ...fixture.input, streamId: 'second', task: 'translate', transient: true }, () => {});
    const requests = await fixture.requests();
    expect(requests.filter((request) => Array.isArray(request) && request[0] === 'app-server')).toHaveLength(1);
    expect(requests.filter((request) => Array.isArray(request) && ['exec', 'login'].includes(request[0]))).toHaveLength(0);
    const threads = requests.filter((request) => request.method === 'thread/start');
    expect(threads).toHaveLength(2);
    expect(threads[0].params).toMatchObject({ config: { web_search: 'disabled' }, dynamicTools: [], ephemeral: true });
    const prompt = requests.find((request) => request.method === 'turn/start').params.input[0].text;
    expect(prompt).toContain('Selected text');
    expect(prompt).not.toContain('filePath');
    expect(prompt).not.toContain('workspace');
    let text = '';
    for (const event of events) { if (event.delta) text += event.delta; if (event.content !== undefined) text = event.content; }
    expect(text).toBe('Final translation.\n\n```js\nconst n = 1;\n```');
    expect(events.some((event) => event.content !== undefined)).toBe(true);
    await fixture.agent.stream({ ...fixture.input, streamId: 'resume', codexThreadId: 'saved-thread' }, () => {});
    expect((await fixture.requests()).some((request) => request.method === 'thread/resume' && request.params.threadId === 'saved-thread')).toBe(true);
    expect(fixture.readCount()).toBe(1);
  } finally { await fixture.agent.shutdown(); }
});

test('Codex exec reads cached PDF tools through MCP and consumes the final JSON event without a newline', async ({}, info) => {
  const previousTransport = process.env.TESSEL_CODEX_TRANSPORT;
  process.env.TESSEL_CODEX_TRANSPORT = 'exec';
  const fixture = await createAgentFixture(info.outputPath('exec'));
  let text = '';
  try {
    await fixture.agent.stream(fixture.input, (event) => { text += event.delta ?? ''; });
    expect(text).toBe('Cached page text');
    expect(fixture.readCount()).toBe(1);
    const args = (await fixture.requests()).find((request) => Array.isArray(request) && request[0] === 'exec');
    expect(args.some((arg: string) => arg.startsWith('mcp_servers.tessel_pdf.url='))).toBe(true);
    expect(args.join(' ')).not.toContain('pdftotext');
  } finally {
    await fixture.agent.shutdown();
    if (previousTransport === undefined) delete process.env.TESSEL_CODEX_TRANSPORT;
    else process.env.TESSEL_CODEX_TRANSPORT = previousTransport;
  }
});

async function createAgentFixture(directory: string) {
  await mkdir(directory, { recursive: true });
  const executable = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const script = join(directory, 'fake.cjs');
  await writeFile(script, `(${fakeCodex.toString()})();`);
  await writeFile(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  let reads = 0;
  const agent = new CodexAgent(async () => ({
    document: { id: 'book', sha256: 'abcdef', filePath: join(directory, 'book.pdf'), title: 'Book', pageCount: 2 } as PdfDocumentMeta,
    readPages: async () => { reads++; return { pageCount: 2, pageStart: 1, pageEnd: 1, pages: [{ pageNumber: 1, text: 'Cached page text' }] }; },
    readOutline: async () => ({ pageCount: 2, outline: [] })
  }), join(directory, 'inputs'), join(directory, 'workspace'), async () => executable);
  return {
    agent,
    input: { streamId: 'one', conversationId: 'chat', documentId: 'book', prompt: 'Translate this.', context: { currentPage: 1, selectedText: 'Selected text', totalPages: 2 } } as CodexStreamRequest,
    readCount: () => reads,
    requests: async (): Promise<any[]> => (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  };
}

// This function is serialized into a child process: do not capture test scope.
function fakeCodex() {
  const fs = require('node:fs');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const log = (value: unknown) => fs.appendFileSync(path.join(__dirname, 'requests.jsonl'), JSON.stringify(value) + '\n');
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  log(args);
  if (args[0] === 'exec') {
    process.stdin.resume();
    process.stdin.on('end', async () => {
      const config = args.find((arg) => arg.startsWith('mcp_servers.tessel_pdf.url='));
      const url = JSON.parse(config!.slice(config!.indexOf('=') + 1));
      const call = async (method: string, params: object) => (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
      await call('initialize', { protocolVersion: '2025-03-26' });
      const tools = await call('tools/list', {});
      if (!tools.result.tools.some((tool: { name: string }) => tool.name === 'sidelight_pdf_read_pages')) process.exit(2);
      const read = await call('tools/call', { name: 'sidelight_pdf_read_pages', arguments: { page_start: 1 } });
      send({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.parse(read.result.content[0].text).pages[0].text } });
      process.stdout.write(JSON.stringify({ type: 'turn.completed' }));
      process.exitCode = 0;
    });
    return;
  }
  let nextThread = 1;
  let toolThread = '';
  const toolsByThread = new Map();
  const finish = (threadId: string) => {
    send({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'answer', delta: 'Draft translation.' } });
    send({ method: 'item/completed', params: { threadId, item: { id: 'answer', type: 'agentMessage', text: 'Final translation.' } } });
    send({ method: 'item/completed', params: { threadId, item: { id: 'code', type: 'agentMessage', text: '```js\nconst n = 1;\n```' } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
  };
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line: string) => {
    const message = JSON.parse(line);
    log(message);
    if (message.id === 900 && !message.method) { finish(toolThread); return; }
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method === 'model/list') send({ id: message.id, result: { data: [], nextCursor: null } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const id = message.params.threadId || `thread-${nextThread++}`;
      toolsByThread.set(id, message.params.dynamicTools);
      send({ id: message.id, result: { thread: { id } } });
    } else if (message.method === 'turn/start') {
      const threadId = message.params.threadId;
      send({ id: message.id, result: { turn: { id: 'turn' } } });
      if (toolsByThread.get(threadId)?.length) {
        toolThread = threadId;
        send({ id: 900, method: 'item/tool/call', params: { threadId, callId: 'read', tool: 'sidelight_pdf_read_pages', arguments: '{"page_start":1}' } });
      } else finish(threadId);
    }
  });
}
