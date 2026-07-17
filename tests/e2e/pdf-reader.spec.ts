import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
    await createFixturePdf(pdfPath, { largeAttachment: testInfo.title.includes('range-backed') });
    const fakeCodexBin = join(runDir, 'bin');
    const fakeCodexHome = join(runDir, 'codex-home');
    const fakeCodexLog = join(runDir, 'codex-requests.jsonl');
    await createFakeCodex(fakeCodexBin);
    await createFakeCodexModelCache(fakeCodexHome);
    const useExecTransport = testInfo.title.includes('exec checkpoint')
      || testInfo.title.includes('fast translation')
      || testInfo.title.includes('Codex outline');

    app = await electron.launch({
      args: [mainEntry, pdfPath],
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: `${fakeCodexBin}:${process.env.PATH ?? ''}`,
        CODEX_HOME: fakeCodexHome,
        FAKE_CODEX_LOG: fakeCodexLog,
        FAKE_CODEX_AUTH: useExecTransport ? 'api-key' : 'chatgpt',
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

  test('loads a range-backed PDF larger than the initial reader buffer', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await expect(page.locator('.pdf-state')).toHaveCount(0);
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

  test('persists pinned conversations on the PDF canvas', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await page.locator('.dock-chat-panel').getByTitle('Pin to learning space').click();
    await expect(page.locator('.workspace-block-card--conversation')).toBeVisible();

    await page.reload();
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await expect(page.locator('.workspace-block-card--conversation')).toBeVisible();
  });

  test('renders image pins as borderless media with hover controls and zoom', async () => {
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    await page.evaluate(async (documentId) => {
      const now = new Date().toISOString();
      await window.sidelight.saveWorkspaceBlock({
        block: {
          id: 'image_pin_fixture',
          documentId,
          kind: 'image',
          anchor: 'page',
          sourceKind: 'manual',
          contentKind: 'image',
          pageNumber: 1,
          title: 'Fixture image',
          payload: {
            name: 'fixture.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2kQAAAABJRU5ErkJggg=='
          },
          x: -4200,
          y: 120,
          width: 320,
          height: 220,
          createdAt: now,
          updatedAt: now
        }
      });
    }, documentId!);

    await page.reload();
    const card = page.locator('.workspace-block-card--image');
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS('border-top-width', '0px');
    await card.hover();
    await expect(card.getByTitle('Copy image')).toBeVisible();
    const zoom = card.getByLabel('Zoom image');
    await zoom.fill('150');
    await expect(card.locator('img')).toHaveAttribute('style', /width: 150%/);
  });

  test('renders agent local images and local result links without routing through localhost', async () => {
    const imagePath = join(runDir, 'generated chart.png');
    const resultPath = join(runDir, 'analysis result.txt');
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2kQAAAABJRU5ErkJggg==', 'base64'));
    await writeFile(resultPath, 'Local Codex result', 'utf8');
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, imagePath, resultPath, now }) => {
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_local_result_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Local result', brief: 'Agent local output fixture.', keywords: [] },
          messages: [{
            id: 'msg_local_result_fixture',
            role: 'assistant',
            content: `![Generated chart](sandbox:${imagePath})\n\n[Open analysis](${resultPath})`,
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId: documentId!, imagePath, resultPath, now });

    await page.reload();
    const bubble = page.locator('.chat-bubble').last();
    await expect(bubble.locator('img[alt="Generated chart"]')).toHaveAttribute('src', /^file:\/\//);
    await expect(bubble.getByRole('link', { name: 'Open analysis' })).toHaveAttribute('href', /^file:\/\//);
    await expect(bubble.getByRole('link', { name: 'Open analysis' })).not.toHaveAttribute('href', /^https?:\/\/localhost/);
    await expect(bubble.getByRole('link', { name: 'Open analysis' })).not.toHaveAttribute('href', /%25/);
  });

  test('renders Windows sandbox paths as local file URLs', async () => {
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_windows_result_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Windows result', brief: 'Windows local output fixture.', keywords: [] },
          messages: [{
            id: 'msg_windows_result_fixture',
            role: 'assistant',
            content: '[Open Windows analysis](sandbox:C:\\Users\\reader\\analysis.html)',
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId: documentId!, now });

    await page.reload();
    await expect(page.getByRole('link', { name: 'Open Windows analysis' })).toHaveAttribute('href', 'file:///C:/Users/reader/analysis.html');
  });

  test('resolves an agent image that incorrectly points at a public HTML profile page', async () => {
    const resolvedImage = await page.evaluate(() => window.sidelight.resolveRemoteImage('https://cs.fudan.edu.cn/qxp/'));
    expect(resolvedImage).toMatch(/^data:image\//);
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_profile_image_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Profile image', brief: 'Public profile image fixture.', keywords: [] },
          messages: [{
            id: 'msg_profile_image_fixture',
            role: 'assistant',
            content: '![Professor profile](https://cs.fudan.edu.cn/qxp/)',
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId: documentId!, now });

    await page.reload();
    await expect(page.locator('.chat-bubble img[alt="Professor profile"]')).toHaveAttribute('src', /^data:image\//, { timeout: 20_000 });
  });

  test('previews a cited webpage when an agent says it is displaying a photo', async () => {
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_visual_source_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Visual source', brief: 'Public visual source fixture.', keywords: [] },
          messages: [{
            id: 'msg_visual_source_fixture',
            role: 'assistant',
            content: 'This is a public professor photo from [Fudan University](https://cs.fudan.edu.cn/qxp/).',
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId: documentId!, now });

    await page.reload();
    await expect(page.locator('.chat-bubble img[alt="Image from linked source"]')).toHaveAttribute('src', /^data:image\//, { timeout: 20_000 });
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
    await expect(page.locator('.chat-message--user').filter({ hasText: 'Focus on the Alpha Beta wording.' })).toBeVisible();
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

  test('uses the fastest cached Codex model for a fast translation', async () => {
    await enableCodexReader(page);
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Translate$/i }).click();
    await expect(page.locator('.transient-aid-panel')).toContainText('Translated quickly.');
    await page.locator('.transient-aid-panel').getByTitle('Pin to learning space').click();
    await expect(page.locator('.workspace-block-card--translation')).toBeVisible();

    await expect.poll(async () => {
      const requests = await readFakeCodexRequests(join(runDir, 'codex-requests.jsonl'));
      const args = requests.find((request) => request[0] === 'exec' && request.includes('--ephemeral'));
      if (!args) {
        return undefined;
      }
      const modelIndex = args.indexOf('--model');
      return modelIndex >= 0 ? args[modelIndex + 1] : undefined;
    }).toBe('gpt-test-mini');

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        translations?: Array<{ content: string; backend: string; status: string }>;
      };
      return store.translations?.[0];
    }).toMatchObject({ content: 'Translated quickly.', backend: 'codex', status: 'completed' });

    await page.locator('.transient-aid-panel').getByTitle('Close').click();
    await page.locator('.workspace-block-card--translation .workspace-block-card__body').click();
    await expect(page.locator('.transient-aid-panel')).toContainText('Translated quickly.');
    await page.locator('.transient-aid-panel').getByTitle('Close').click();
    await page.getByTitle('Translations').click();
    await expect(page.locator('.trace-card__brief').getByText('Translated quickly.', { exact: true })).toBeVisible();
  });

  test('keeps the ten most recent translations and reopens them from history', async () => {
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    await page.evaluate(async (documentId) => {
      const now = Date.now();
      for (let index = 1; index <= 12; index += 1) {
        await window.sidelight.saveTranslation({
          translation: {
            id: `translation_fixture_${index}`,
            documentId,
            pageNumber: 1,
            quote: `source ${index}`,
            content: `translation ${index}`,
            backend: 'provider',
            status: 'completed',
            createdAt: new Date(now + index).toISOString(),
            updatedAt: new Date(now + index).toISOString()
          }
        });
      }
    }, documentId!);

    await page.reload();
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await page.getByTitle('Translations').click();
    await expect(page.getByText('source 12', { exact: true })).toBeVisible();
    await expect(page.getByText('source 1', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Translations').first()).toBeVisible();
  });

  test('saves the translation backend from the compact settings workspace', async () => {
    await page.getByTitle('Settings').click();
    const settings = page.locator('.reader-settings');
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Codex' }).click();
    await settings.getByLabel('Enabled').check();
    await settings.getByLabel('Translation backend').selectOption('codex');
    await settings.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        appPreferences?: { translationBackend?: string };
      };
      return store.appPreferences?.translationBackend;
    }).toBe('codex');
  });

  test('gives Codex outline generation sampled PDF page evidence', async () => {
    await enableCodexReader(page);
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await page.getByRole('button', { name: 'AI-generate PDF outline' }).click();
    await expect(page.locator('.outline-item').filter({ hasText: 'Fixture introduction' })).toBeVisible();

    await expect.poll(async () => {
      const requests = await readFakeCodexRequests(join(runDir, 'codex-requests.jsonl'));
      const args = requests.find((request) => request[0] === 'exec' && request.includes('--ephemeral'));
      const prompt = args?.at(-1) ?? '';
      return prompt.includes('"pageSamples"') && prompt.includes('Reader fixture quote Alpha Beta');
    }).toBe(true);
  });
});

async function createFixturePdf(filePath: string, options: { largeAttachment?: boolean } = {}): Promise<void> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Reader fixture quote Alpha Beta', { x: 72, y: 720, size: 18, font });
  page.drawText('Second line for a persistent PDF reader session.', { x: 72, y: 680, size: 14, font });
  if (options.largeAttachment) {
    await document.attach(randomBytes(1024 * 1024), 'range-fixture.bin', { mimeType: 'application/octet-stream' });
  }
  await mkdir(dirname(filePath), { recursive: true });
  await document.save().then((bytes) => import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, bytes)));
}

async function createFakeCodex(binDirectory: string): Promise<void> {
  await mkdir(binDirectory, { recursive: true });
  const executable = join(binDirectory, 'codex');
  await writeFile(executable, `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
  require('node:fs').appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n');
}
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
  if (args.includes('--ephemeral')) {
    const prompt = args[args.length - 1] || '';
    const text = prompt.includes('external PDF table of contents')
      ? '{"items":[{"title":"Fixture introduction","level":0,"pageNumber":1}]}'
      : 'Translated quickly.';
    setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_utility_answer', type: 'agent_message', text } }), 25);
    setTimeout(() => sendExec({ type: 'turn.completed' }), 45);
  } else if (resumed) {
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

async function createFakeCodexModelCache(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: new Date().toISOString(),
    models: [
      {
        slug: 'gpt-test-large',
        display_name: 'GPT Test Large',
        description: 'Test quality model',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        default_reasoning_level: 'high',
        visibility: 'list'
      },
      {
        slug: 'gpt-test-mini',
        display_name: 'GPT Test Mini',
        description: 'Test fast model',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
        default_reasoning_level: 'low',
        visibility: 'list'
      }
    ]
  }), 'utf8');
}

async function enableCodexReader(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const preferences = await window.sidelight.getAppPreferences();
    await window.sidelight.saveAppPreferences({
      ...preferences,
      experimentalCodexAgent: {
        ...preferences.experimentalCodexAgent,
        enabled: true
      },
      translationBackend: 'codex'
    });
  });
}

async function readFakeCodexRequests(filePath: string): Promise<string[][]> {
  try {
    return (await readFile(filePath, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
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
