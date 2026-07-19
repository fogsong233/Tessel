import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { syncPdfSessionToWebDav, type PdfSessionSnapshot } from '../../src/main/webdavSync';

test('creates each missing WebDAV folder before uploading PDF metadata', async () => {
  const collections = new Set<string>(['/']);
  const requests: Array<{ method: string; path: string }> = [];
  let uploaded = '';
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    requests.push({ method, path });

    if (method === 'MKCOL') {
      const normalized = path.endsWith('/') ? path : `${path}/`;
      const segments = normalized.split('/').filter(Boolean);
      segments.pop();
      const parent = segments.length ? `/${segments.join('/')}/` : '/';
      if (!collections.has(parent)) {
        response.writeHead(409).end();
        return;
      }
      if (collections.has(normalized)) {
        response.writeHead(405).end();
        return;
      }
      collections.add(normalized);
      response.writeHead(201).end();
      return;
    }

    if (method === 'GET') {
      response.writeHead(404).end();
      return;
    }

    if (method === 'PUT') {
      for await (const chunk of request) {
        uploaded += String(chunk);
      }
      response.writeHead(201).end();
      return;
    }

    response.writeHead(405).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port.');
  }

  const snapshot: PdfSessionSnapshot = {
    version: 1,
    documentHash: 'fixture-hash',
    updatedAt: '2026-07-18T00:00:00.000Z',
    conversations: [],
    translations: []
  };

  try {
    await syncPdfSessionToWebDav({
      config: {
        enabled: true,
        baseUrl: `http://127.0.0.1:${address.port}`,
        basePath: 'reading/tessel',
        username: 'reader',
        password: 'secret'
      },
      documentHash: snapshot.documentHash,
      local: snapshot
    });
  } finally {
    server.close();
    await once(server, 'close');
  }

  expect(requests).toEqual([
    { method: 'GET', path: '/reading/tessel/pdf-sessions/fixture-hash.json' },
    { method: 'MKCOL', path: '/reading/' },
    { method: 'MKCOL', path: '/reading/tessel/' },
    { method: 'MKCOL', path: '/reading/tessel/pdf-sessions/' },
    { method: 'PUT', path: '/reading/tessel/pdf-sessions/fixture-hash.json' }
  ]);
  expect(JSON.parse(uploaded)).toMatchObject({ documentHash: 'fixture-hash', version: 1 });
});
