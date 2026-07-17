import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const rootDir = resolve(__dirname, '../..');
const mainEntry = join(rootDir, 'out/main/index.js');

test('opens a focused start page when no PDF is supplied', async ({}, testInfo) => {
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
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.reader-settings')).toBeVisible();
    await page.locator('.reader-settings').getByRole('button', { name: 'Codex' }).click();
    await expect(page.getByLabel('Chat model')).toBeVisible();
    await expect(page.getByLabel('Chat reasoning')).toBeVisible();
    await page.locator('.reader-settings').getByRole('button', { name: 'Language' }).click();
    await page.getByLabel('UI language').selectOption('zh-CN');
    await expect(page.getByLabel('AI 首选语言').locator('option:checked')).toHaveText('简体中文');
    await page.locator('.reader-settings').getByRole('button', { name: '更新' }).click();
    await expect(page.getByLabel('更新状态')).toHaveText('更新仅在已安装的正式版中可用。');
  } finally {
    await app?.close();
    await rm(runDir, { recursive: true, force: true });
  }
});
