import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const rootDir = resolve(__dirname, '../..');
const mainEntry = join(rootDir, 'out/main/index.js');

test.describe('PDF reader flow', () => {
  let app: ElectronApplication;
  let page: Page;
  let runDir: string;
  let userDataDir: string;
  let pdfPath: string;

  test.beforeEach(async ({}, testInfo) => {
    runDir = testInfo.outputPath(randomUUID());
    userDataDir = join(runDir, 'user-data');
    pdfPath = join(runDir, 'reader-fixture.pdf');
    await mkdir(userDataDir, { recursive: true });
    await createFixturePdf(pdfPath);
    const fakeCodexBin = join(runDir, 'bin');
    await createFakeCodex(fakeCodexBin);

    app = await electron.launch({
      args: [mainEntry, pdfPath],
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: `${fakeCodexBin}:${process.env.PATH ?? ''}`,
        FAKE_CODEX_AUTH: testInfo.title.includes('exec checkpoint') ? 'api-key' : 'chatgpt',
        SIDELIGHT_USER_DATA_DIR: userDataDir,
        SIDELIGHT_E2E_HIDE_WINDOWS: '1'
      }
    });
    page = await app.firstWindow();
  });

  test.afterEach(async () => {
    await app?.close();
    await rm(runDir, { recursive: true, force: true });
  });

  test('opens directly into the PDF reader and persists a full-hash session', async () => {
    await expect(page.getByRole('heading', { name: 'Library' })).toHaveCount(0);
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');

    const expectedHash = createHash('sha256').update(await readFile(pdfPath)).digest('hex');
    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        documents: Array<{ id: string; fingerprint?: { hash?: string } }>;
      };
      return store.documents[0];
    }).toMatchObject({ id: `pdf_${expectedHash}`, fingerprint: { hash: expectedHash } });
  });

  test('quotes a selected passage into the active chat without sending it', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(page.locator('.dock-chat-panel')).toBeVisible();

    await page.waitForTimeout(350);
    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Quote$/i }).click();
    const composer = page.locator('.dock-chat-panel textarea');
    await expect(composer).toContainText('Reader fixture quote Alpha Beta');
    await expect(page.locator('.chat-message')).toHaveCount(0);
  });

  test('renders Codex output and activity in a collapsible timeline', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    const documentId = `pdf_${createHash('sha256').update(await readFile(pdfPath)).digest('hex')}`;
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_timeline_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Timeline fixture', brief: 'Codex activity timeline fixture.', keywords: [] },
          messages: [{
            id: 'msg_timeline_fixture',
            role: 'assistant',
            content: 'I will inspect the passage. The passage is about a persistent PDF reader session.',
            agentTimeline: [
              { id: 'output_1', type: 'output', content: 'I will inspect the passage.', createdAt: now },
              {
                id: 'activity_1',
                type: 'activity',
                createdAt: now,
                activities: [
                  { id: 'read_1', kind: 'reading', label: 'Reading selected passage', status: 'completed', updatedAt: now },
                  { id: 'command_1', kind: 'command', label: 'Running local analysis', status: 'completed', updatedAt: now }
                ]
              },
              { id: 'output_2', type: 'output', content: 'The passage is about a persistent PDF reader session.', createdAt: now }
            ],
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId, now });

    await page.reload();
    await expect(page.locator('.codex-timeline__output')).toHaveCount(2);
    const activity = page.locator('.codex-timeline__activity');
    await expect(activity).not.toHaveAttribute('open', '');
    await activity.locator('summary').click();
    await expect(activity).toHaveAttribute('open', '');
    await expect(activity.locator('.codex-timeline__activity-item')).toHaveCount(2);
    await expect(activity.locator('.codex-timeline__line')).toHaveCount(1);
    const commandNode = activity.locator('.codex-timeline__node.is-command');
    await expect(commandNode.locator('svg')).toBeVisible();
    await expect(commandNode).toHaveCSS('border-radius', '0px');

    const modelButton = page.getByRole('button', { name: 'Current chat model' });
    await expect(modelButton).toBeVisible();
    await modelButton.click();
    await expect(page.getByRole('dialog', { name: 'Current chat model' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Reasoning effort' })).toBeVisible();
    await page.keyboard.press('Escape');
    const permissionButton = page.getByRole('button', { name: 'Permissions' });
    await expect(permissionButton).toContainText('PDF workspace');
    const composer = page.locator('.dock-chat-panel textarea');
    await composer.fill('/');
    await expect(page.locator('.chat-slash-menu button')).toHaveCount(4);
    await expect(page.locator('.chat-slash-menu')).not.toContainText('/model');
    await expect(page.locator('.chat-slash-menu')).not.toContainText('/help');
    await composer.fill('/status');
    await composer.press('Enter');
    await expect(page.locator('.chat-command-notice')).toContainText('PDF workspace');
    await composer.fill('/permissions full-access');
    await composer.press('Enter');
    await expect(permissionButton).toContainText('Full access');
    await expect(page.locator('.chat-permission-warning')).toBeVisible();
    await expect(page.locator('.chat-message')).toHaveCount(1);
    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        conversations: Array<{ id: string; codexSettings?: { permissionMode?: string } }>;
      };
      return store.conversations.find((conversation) => conversation.id === 'chat_timeline_fixture')?.codexSettings?.permissionMode;
    }).toBe('full-access');
  });

  test('steers an active Codex turn and persists the guidance in the same chat', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    const documentId = `pdf_${createHash('sha256').update(await readFile(pdfPath)).digest('hex')}`;
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      const preferences = await window.sidelight.getAppPreferences();
      await window.sidelight.saveAppPreferences({
        ...preferences,
        experimentalCodexAgent: {
          ...preferences.experimentalCodexAgent,
          enabled: true,
          chatReasoningEffort: 'low'
        }
      });
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_steer_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Steer fixture', brief: 'Active Codex steer fixture.', keywords: [] },
          messages: [],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId, now });

    await page.reload();
    const composer = page.locator('.dock-chat-panel textarea');
    await composer.fill('Inspect the selected passage.');
    await composer.press('Enter');
    await expect(page.getByText('First segment.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

    await composer.fill('Focus on the Alpha Beta wording.');
    await page.getByRole('button', { name: 'Send guidance' }).click();
    await expect(page.getByText('Focus on the Alpha Beta wording.')).toBeVisible();
    await expect(page.getByText('Guided result.')).toBeVisible();
    await expect(page.getByText('Guidance delivered to Codex')).toHaveCount(1);

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        conversations: Array<{ id: string; messages: Array<{ role: string; content: string }> }>;
      };
      return store.conversations.find((conversation) => conversation.id === 'chat_steer_fixture')?.messages
        .map((message) => `${message.role}:${message.content}`);
    }).toEqual([
      'user:Inspect the selected passage.',
      'assistant:First segment.',
      'user:Focus on the Alpha Beta wording.',
      'assistant:Guided result.'
    ]);
  });

  test('steers the API-key exec transport at the next exec checkpoint', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    const documentId = `pdf_${createHash('sha256').update(await readFile(pdfPath)).digest('hex')}`;
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      const preferences = await window.sidelight.getAppPreferences();
      await window.sidelight.saveAppPreferences({
        ...preferences,
        experimentalCodexAgent: {
          ...preferences.experimentalCodexAgent,
          enabled: true,
          chatReasoningEffort: 'low'
        }
      });
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_exec_steer_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Exec steer fixture', brief: 'Exec checkpoint steer fixture.', keywords: [] },
          messages: [],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId, now });

    await page.reload();
    const composer = page.locator('.dock-chat-panel textarea');
    await composer.fill('Inspect with the exec transport.');
    await composer.press('Enter');
    await expect(page.getByText('First exec segment.')).toBeVisible();

    await composer.fill('Use the checkpoint guidance.');
    await page.getByRole('button', { name: 'Send guidance' }).click();
    await expect(page.getByText('Guided exec result.')).toBeVisible();
    await expect(page.getByText('Guidance delivered to Codex')).toHaveCount(1);

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        conversations: Array<{ id: string; messages: Array<{ role: string; content: string }> }>;
      };
      return store.conversations.find((conversation) => conversation.id === 'chat_exec_steer_fixture')?.messages
        .map((message) => `${message.role}:${message.content}`);
    }).toEqual([
      'user:Inspect with the exec transport.',
      'assistant:First exec segment.',
      'user:Use the checkpoint guidance.',
      'assistant:Guided exec result.'
    ]);
  });
});

async function createFixturePdf(filePath: string): Promise<void> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Reader fixture quote Alpha Beta', { x: 72, y: 720, size: 18, font });
  page.drawText('Second line for a persistent PDF reader session.', { x: 72, y: 680, size: 14, font });
  await mkdir(dirname(filePath), { recursive: true });
  await document.save().then((bytes) => import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, bytes)));
}

async function createFakeCodex(binDirectory: string): Promise<void> {
  await mkdir(binDirectory, { recursive: true });
  const executable = join(binDirectory, 'codex');
  await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-test\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(process.env.FAKE_CODEX_AUTH === 'api-key' ? 'Logged in using an API key\\n' : 'Logged in using ChatGPT\\n');
  process.exit(0);
}
if (args[0] === 'exec') {
  const resumed = args[1] === 'resume';
  const sendExec = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  sendExec({ type: 'thread.started', thread_id: 'thread_exec_steer_fixture' });
  if (resumed) {
    setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_answer_2', type: 'agent_message', text: 'Guided exec result.' } }), 25);
    setTimeout(() => sendExec({ type: 'turn.completed' }), 45);
  } else {
    setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_answer_1', type: 'agent_message', text: 'First exec segment.' } }), 30);
    setTimeout(() => sendExec({ type: 'item.started', item: { id: 'exec_command_1', type: 'command_execution' } }), 2000);
    setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_command_1', type: 'command_execution' } }), 2200);
  }
  process.stdin.resume();
  return;
}
if (!args.includes('app-server')) {
  process.stderr.write('Unsupported fake Codex command\\n');
  process.exit(2);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const timers = new Set();
const later = (delay, callback) => {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
  } else if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_steer_fixture' } } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_steer_fixture' } } });
    later(35, () => send({ method: 'item/agentMessage/delta', params: { threadId: 'thread_steer_fixture', turnId: 'turn_steer_fixture', delta: 'First segment.' } }));
  } else if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId: 'turn_steer_fixture' } });
    later(20, () => send({ method: 'item/started', params: { threadId: 'thread_steer_fixture', item: { id: 'tool_after_steer', type: 'webSearch' } } }));
    later(35, () => send({ method: 'item/completed', params: { threadId: 'thread_steer_fixture', item: { id: 'tool_after_steer', type: 'webSearch' } } }));
    later(50, () => send({ method: 'item/agentMessage/delta', params: { threadId: 'thread_steer_fixture', turnId: 'turn_steer_fixture', delta: 'Guided result.' } }));
    later(70, () => send({ method: 'turn/completed', params: { threadId: 'thread_steer_fixture', turn: { id: 'turn_steer_fixture', status: 'completed' } } }));
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'thread_steer_fixture', turn: { id: 'turn_steer_fixture', status: 'interrupted' } } });
  }
});
process.on('exit', () => { for (const timer of timers) clearTimeout(timer); });
`, 'utf8');
  await chmod(executable, 0o755);
}

async function selectPdfText(page: Page): Promise<void> {
  const textLayer = page.locator('.pdfViewer .page[data-page-number="1"] .textLayer');
  await textLayer.locator('span').first().evaluate((span) => {
    const textNode = span.firstChild;
    if (!textNode) {
      throw new Error('PDF text span was not selectable.');
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const box = span.getBoundingClientRect();
    span.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      clientX: box.left + 2,
      clientY: box.top + box.height / 2
    }));
  });
}
