import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const rootDir = resolve(__dirname, '../..');
const mainEntry = join(rootDir, 'out/main/index.js');

test('opens a focused start page and launches settings in its own window', async ({}, testInfo) => {
  const runDir = testInfo.outputPath(randomUUID());
  const userDataDir = join(runDir, 'user-data');
  await mkdir(userDataDir, { recursive: true });
  let app: ElectronApplication | undefined;
  let page: Page | undefined;

  try {
    app = await electron.launch({
      args: [mainEntry],
      cwd: rootDir,
      env: {
        ...process.env,
        SIDELIGHT_USER_DATA_DIR: userDataDir,
        SIDELIGHT_E2E_HIDE_WINDOWS: '1'
      }
    });
    page = await app.firstWindow();

    await expect(page).toHaveTitle('Tessel');
    await expect(page.getByRole('heading', { name: 'Tessel' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(viewport.width).toBeLessThanOrEqual(720);
    expect(viewport.height).toBeLessThanOrEqual(520);
    await expect.poll(async () => page!.locator('.reader-home').evaluate((home) => {
      const content = home.querySelector<HTMLElement>('.reader-home__content');
      if (!content) {
        return Number.POSITIVE_INFINITY;
      }
      const homeBox = home.getBoundingClientRect();
      const contentBox = content.getBoundingClientRect();
      const horizontalOffset = Math.abs((contentBox.left + contentBox.width / 2) - (homeBox.left + homeBox.width / 2));
      const verticalOffset = Math.abs((contentBox.top + contentBox.height / 2) - (homeBox.top + homeBox.height / 2));
      return Math.max(horizontalOffset, verticalOffset);
    })).toBeLessThan(3);

    const settingsWindowPromise = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Settings' }).click();
    const settingsPage = await settingsWindowPromise;
    await expect(settingsPage).toHaveTitle('Tessel Settings');
    await expect(page.locator('.reader-settings')).toHaveCount(0);
    await expect(settingsPage.locator('.reader-settings--window')).toBeVisible();

    await settingsPage.getByRole('button', { name: 'Tablet whiteboard' }).click();
    const qrCode = settingsPage.locator('.reader-settings__lan-qr img');
    await expect(qrCode).toBeVisible();
    await expect(qrCode).toHaveAttribute('src', /^data:image\/png;base64,/);
    const address = settingsPage.locator('.reader-settings__lan-primary-address code');
    const fullLink = new URL((await address.getAttribute('title'))!);
    expect(fullLink.protocol).toBe('http:');
    expect(fullLink.searchParams.get('token')).toBeTruthy();
    await expect(address).toHaveText(fullLink.host);
    // Verify the display simplification never drops the access key on copy,
    // without writing to the developer's real clipboard.
    await settingsPage.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (value: string) => { document.documentElement.dataset.copiedLanUrl = value; }
      });
    });
    await settingsPage.locator('.reader-settings__lan-primary-address').getByTitle('Copy address').click();
    await expect(settingsPage.locator('html')).toHaveAttribute('data-copied-lan-url', fullLink.href);
    await expect(settingsPage.locator('.reader-settings__lan-primary-address')).toContainText('Copied');

    await settingsPage.getByRole('button', { name: 'Codex' }).click();
    await expect(settingsPage.getByLabel('Chat model')).toBeVisible();
    await expect(settingsPage.getByLabel('Chat reasoning')).toBeVisible();
    await settingsPage.getByRole('button', { name: 'Appearance' }).click();
    await expect(settingsPage.locator('.reader-settings__fields').first()).toHaveCSS('border-radius', '16px');
    await settingsPage.getByLabel('Interface size', { exact: true }).fill('20');
    await expect(settingsPage.locator('.reader-settings__section-heading span').first()).toHaveCSS('font-size', '19px');
    await settingsPage.getByLabel('Sidebar size').fill('16');
    await settingsPage.getByLabel('Composer size').fill('17');
    await expect.poll(() => settingsPage.locator('.reader-settings').evaluate((element) => ({
      sidebar: getComputedStyle(element).getPropertyValue('--tessel-sidebar-font-size').trim(),
      composer: getComputedStyle(element).getPropertyValue('--tessel-composer-font-size').trim()
    }))).toEqual({ sidebar: '16px', composer: '17px' });
    await settingsPage.locator('.reader-settings').getByRole('button', { name: 'Language' }).click();
    await settingsPage.getByLabel('UI language').selectOption('zh-CN');
    await expect(settingsPage.getByLabel('AI 首选语言').locator('option:checked')).toHaveText('简体中文');
    await settingsPage.locator('.reader-settings').getByRole('button', { name: '更新' }).click();
    await expect(settingsPage.getByLabel('更新状态')).toHaveText('更新仅在已安装的正式版中可用。');
    await expect(settingsPage.getByRole('button', { name: '下载更新' })).toHaveCount(0);
    await expect(settingsPage.getByRole('button', { name: '重启并更新' })).toHaveCount(0);

    if (process.platform === 'win32') {
      const maximize = settingsPage.getByRole('button', { name: 'Maximize window' });
      await expect(maximize).toBeVisible();
      await expect(settingsPage.getByRole('button', { name: 'Close window' })).toBeVisible();
      await maximize.click();
      await expect(settingsPage.getByRole('button', { name: 'Restore window' })).toBeVisible();
      await settingsPage.getByRole('button', { name: 'Restore window' }).click();
      await expect(settingsPage.getByRole('button', { name: 'Maximize window' })).toBeVisible();
      const settingsClosed = settingsPage.waitForEvent('close');
      await settingsPage.getByRole('button', { name: 'Close window' }).click();
      await settingsClosed;
    }
  } finally {
    await app?.close();
    await rm(runDir, { recursive: true, force: true });
  }
});

test('reopens a recently viewed book and shows its stored information in settings', async ({}, testInfo) => {
  const runDir = testInfo.outputPath(randomUUID());
  const userDataDir = join(runDir, 'user-data');
  const pdfPath = join(runDir, 'recent-history-fixture.pdf');
  await mkdir(userDataDir, { recursive: true });
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Recent browsing history fixture', { x: 72, y: 720, size: 18, font });
  await writeFile(pdfPath, await document.save());
  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({
      args: [mainEntry],
      cwd: rootDir,
      env: {
        ...process.env,
        SIDELIGHT_USER_DATA_DIR: userDataDir,
        SIDELIGHT_TEST_OPEN_PDF: pdfPath,
        SIDELIGHT_E2E_HIDE_WINDOWS: '1'
      }
    });
    // SIDELIGHT_TEST_OPEN_PDF opens the fixture directly in the first reader
    // window. Waiting for another Open PDF action races the initial PDF load and
    // can match both the reader toolbar and its temporary empty-state button.
    const firstReader = await app.firstWindow();
    await expect(firstReader.locator('.textLayer')).toContainText('Recent browsing history fixture');
    await app.close();

    app = await electron.launch({
      args: [mainEntry],
      cwd: rootDir,
      env: {
        ...process.env,
        SIDELIGHT_USER_DATA_DIR: userDataDir,
        SIDELIGHT_E2E_HIDE_WINDOWS: '1'
      }
    });
    const home = await app.firstWindow();
    await expect(home.getByRole('region', { name: 'Recently viewed' })).toBeVisible();
    const recentBook = home.getByRole('button', { name: /recent-history-fixture/i });
    await expect(recentBook).toBeVisible();

    const recentReaderPromise = app.waitForEvent('window');
    await recentBook.click();
    const recentReader = await recentReaderPromise;
    await expect(recentReader.locator('.textLayer')).toContainText('Recent browsing history fixture');

    const settingsWindowPromise = app.waitForEvent('window');
    await recentReader.getByTitle('Settings').click();
    const settings = await settingsWindowPromise;
    await settings.getByRole('button', { name: 'Storage' }).click();
    await expect(settings.getByText('Local storage overview')).toBeVisible();
    await expect(settings.getByText('recent-history-fixture', { exact: true })).toBeVisible();
    await settings.locator('.reader-settings__book summary').click();
    await expect(settings.getByText(pdfPath, { exact: true })).toBeVisible();
    await expect(settings.getByText('Available', { exact: true })).toBeVisible();
    await expect(settings.getByLabel('Stored content').getByText('Conversations')).toBeVisible();
  } finally {
    await app?.close();
    await rm(runDir, { recursive: true, force: true });
  }
});
