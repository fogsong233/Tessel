import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
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

    app = await electron.launch({
      args: [mainEntry, pdfPath],
      cwd: rootDir,
      env: {
        ...process.env,
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
