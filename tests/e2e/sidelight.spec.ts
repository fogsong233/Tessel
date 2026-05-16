import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const rootDir = resolve(__dirname, '../..');
const mainEntry = join(rootDir, 'out/main/index.js');

test.describe('Sidelight Electron reading flow', () => {
  let userDataDir: string;
  let pdfPath: string;
  let app: ElectronApplication;

  test.beforeEach(async ({}, testInfo) => {
    const runDir = testInfo.outputPath(randomUUID());
    userDataDir = join(runDir, 'user-data');
    pdfPath = join(runDir, 'fixture.pdf');
    await mkdir(userDataDir, { recursive: true });
    await createFixturePdf(pdfPath);

    app = await electron.launch({
      args: [mainEntry],
      cwd: rootDir,
      env: launchEnv(userDataDir, pdfPath)
    });
  });

  test.afterEach(async () => {
    await app?.close();
    await rm(dirname(userDataDir), { recursive: true, force: true });
  });

  test('opens a PDF from the library into a reader window and renders the page', async () => {
    const library = await app.firstWindow();
    await attachDiagnostics(library);

    await expect(library.getByRole('heading', { name: 'Library' })).toBeVisible();

    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.getByText('fixture')).toBeVisible();
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    await expect(reader.locator('.textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await expect(reader.locator('.pdfViewer .page canvas').first()).toBeVisible();
    await expect
      .poll(async () => reader.locator('.pdfViewer .page canvas').first().evaluate((canvas) => {
        const element = canvas as HTMLCanvasElement;
        return element.width > 0 && element.height > 0;
      }))
      .toBe(true);

    await reader.getByTitle('Hide sidebar').click();
    await expect(reader.locator('.reader-splitter')).toHaveClass(/is-left-collapsed/);
    await expect(reader.getByTitle('Show sidebar')).toBeVisible();
    await expect(reader.locator('.floating-reader-controls')).toHaveCount(0);
    const pageWidthBefore = await firstPageWidth(reader);
    await reader.locator('.pdf-viewport').dispatchEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -400
    });
    await expect.poll(async () => firstPageWidth(reader)).toBeGreaterThan(pageWidthBefore);
    await expect(reader.locator('.textLayer')).toContainText('Sidelight integration passage Alpha Beta');

    await reader.getByTitle('Show sidebar').click();
    await expect(reader.locator('.reader-splitter')).not.toHaveClass(/is-left-collapsed/);
    await expect(reader.getByRole('button', { name: /Outline/i })).toBeVisible();

    await reader.close();

    const secondReaderPromise = waitForNextWindow(app);
    await library.locator('.library-row').filter({ hasText: 'fixture.pdf' }).click();
    const secondReader = await secondReaderPromise;
    await attachDiagnostics(secondReader);
    await expect(secondReader.locator('.textLayer')).toContainText('Sidelight integration passage Alpha Beta');
  });

  test('keeps summary and translation temporary while chat is persisted', async () => {
    const library = await app.firstWindow();
    await attachDiagnostics(library);
    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.textLayer')).toContainText('Sidelight integration passage Alpha Beta');

    await selectFirstPdfText(reader);
    await reader.getByRole('button', { name: /Summary/i }).click();
    await expect(reader.locator('.transient-aid-panel')).toBeVisible();
    await expect(reader.locator('.transient-aid-panel')).toContainText('Summary');
    await expect(reader.locator('.transient-aid-panel')).toContainText('local draft');
    await expect(reader.locator('.pdf-stage')).toHaveClass(/has-open-dock/);
    await expectPanelInsideDock(reader, '.transient-aid-panel');
    await expectPdfPageBeforeDock(reader);
    await reader.locator('.transient-aid-panel').getByTitle('Close').click();
    await expect(reader.locator('.transient-aid-panel')).toHaveCount(0);
    await expect.poll(async () => persistedConversationCount(userDataDir)).toBe(0);

    await selectFirstPdfText(reader);
    await reader.getByRole('button', { name: /Translate/i }).click();
    await expect(reader.locator('.transient-aid-panel')).toContainText('Translation');
    await expect(reader.locator('.transient-aid-panel')).toContainText('local draft');
    await reader.locator('.transient-aid-panel').getByTitle('Close').click();
    await expect.poll(async () => persistedConversationCount(userDataDir)).toBe(0);

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();
    await expectPanelInsideDock(reader, '.dock-chat-panel');
    await expectPdfPageBeforeDock(reader);
    await reader.getByPlaceholder('Message Sidelight').fill('What is \\(x^2 + y^2\\) and \\[E=mc^2\\]?');
    await reader.getByPlaceholder('Message Sidelight').press('Enter');
    await expect.poll(async () => reader.locator('.dock-chat-panel .katex').count()).toBeGreaterThanOrEqual(2);
    await expect(reader.locator('.dock-chat-panel')).toContainText('local draft');
    await expect.poll(async () => persistedConversationCount(userDataDir)).toBe(1);
  });

  test('stops an AI stream cleanly when the reader window closes', async () => {
    const stderr: string[] = [];
    app.process().stderr?.on('data', (chunk) => stderr.push(String(chunk)));

    const library = await app.firstWindow();
    await attachDiagnostics(library);
    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();
    await reader
      .getByPlaceholder('Message Sidelight')
      .fill(`Keep streaming after close. ${'More detail please. '.repeat(160)}`);
    await reader.getByPlaceholder('Message Sidelight').press('Enter');
    await expect(reader.locator('.dock-chat-panel')).toContainText('Keep streaming after close');

    await reader.close();
    await expect(library.getByRole('heading', { name: 'Library' })).toBeVisible();
    await library.waitForTimeout(700);

    expect(stderr.join('')).not.toContain('Render frame was disposed');
  });
});

async function createFixturePdf(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Sidelight integration passage Alpha Beta.', {
    x: 72,
    y: 700,
    size: 18,
    font,
    color: rgb(0.05, 0.05, 0.05)
  });
  page.drawText('This line exists so search, selection, and page rendering have stable text.', {
    x: 72,
    y: 668,
    size: 13,
    font,
    color: rgb(0.1, 0.1, 0.1)
  });

  await writeFile(filePath, await pdf.save());
}

function launchEnv(userDataDir: string, pdfPath: string): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env;
  return {
    ...env,
    SIDELIGHT_USER_DATA_DIR: userDataDir,
    SIDELIGHT_TEST_OPEN_PDF: pdfPath
  };
}

async function waitForNextWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.waitForEvent('window');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function attachDiagnostics(page: Page): Promise<void> {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(`[renderer:${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    console.error(`[renderer:pageerror] ${error.message}`);
  });
}

async function selectFirstPdfText(page: Page): Promise<void> {
  await page.locator('.textLayer span').first().waitFor({ state: 'visible' });
  await page.evaluate(() => {
    const span = document.querySelector<HTMLElement>('.textLayer span');
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
    if (!span || !viewport) {
      throw new Error('PDF text layer is not ready.');
    }

    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const rect = span.getBoundingClientRect();
    viewport.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      })
    );
  });
  await expect(page.locator('.selection-toolbar')).toBeVisible();
}

async function firstPageWidth(page: Page): Promise<number> {
  return page.locator('.pdfViewer .page').first().evaluate((element) => element.getBoundingClientRect().width);
}

async function expectPanelInsideDock(page: Page, panelSelector: string): Promise<void> {
  const boxes = await page.evaluate((selector) => {
    const dock = document.querySelector<HTMLElement>('.reader-dock-lane');
    const panel = document.querySelector<HTMLElement>(selector);
    if (!dock || !panel) {
      return undefined;
    }

    const dockBox = dock.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      dockLeft: dockBox.left,
      dockRight: dockBox.right,
      panelLeft: panelBox.left,
      panelRight: panelBox.right
    };
  }, panelSelector);

  expect(boxes).toBeTruthy();
  expect(boxes!.panelLeft).toBeGreaterThanOrEqual(boxes!.dockLeft - 1);
  expect(boxes!.panelRight).toBeLessThanOrEqual(boxes!.dockRight + 1);
}

async function expectPdfPageBeforeDock(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const pdfPage = document.querySelector<HTMLElement>('.pdfViewer .page');
        const dock = document.querySelector<HTMLElement>('.reader-dock-lane');
        if (!pdfPage || !dock) {
          return Number.POSITIVE_INFINITY;
        }

        return pdfPage.getBoundingClientRect().right - dock.getBoundingClientRect().left;
      })
    )
    .toBeLessThanOrEqual(2);
}

async function persistedConversationCount(userDataDir: string): Promise<number> {
  const raw = await readFile(join(userDataDir, 'workspace/library.json'), 'utf8');
  const store = JSON.parse(raw) as { conversations?: unknown[] };
  return store.conversations?.length ?? 0;
}
