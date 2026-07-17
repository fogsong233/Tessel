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

    await expect(page.getByRole('heading', { name: 'PDF Reader' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.reader-settings')).toBeVisible();
    await expect(page.getByLabel('Chat model')).toBeVisible();
    await expect(page.getByLabel('Chat reasoning')).toBeVisible();
  } finally {
    await app?.close();
    await rm(runDir, { recursive: true, force: true });
  }
});
