import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeUpdateReleaseNotes } from '../../src/main/updateReleaseNotes';
import { buildWindowsUpdateHelperScript } from '../../src/main/windowsUpdateHelper';

const rootDir = resolve(__dirname, '../..');
const mainEntry = join(rootDir, 'out/main/index.js');

test('normalizes GitHub HTML release notes into Markdown without losing structure', () => {
  const markdown = normalizeUpdateReleaseNotes([
    {
      version: '1.4.2',
      note: '<h2>Windows</h2><ul><li><strong>Reliable restart</strong> uses <code>D:\\apps\\Tessel</code>.</li></ul><p><a href="https://example.com/details?a=1&amp;b=2">Details</a></p>'
    }
  ]);

  expect(markdown).toContain('## 1.4.2');
  expect(markdown).toContain('## Windows');
  expect(markdown).toContain('- **Reliable restart** uses `D:\\apps\\Tessel`.');
  expect(markdown).toContain('[Details](https://example.com/details?a=1&b=2)');
  expect(markdown).not.toContain('<textarea');
  expect(markdown).not.toContain('<h2>');
});

test('Windows update helper installs silently and relaunches the exact executable path', () => {
  const script = buildWindowsUpdateHelperScript({
    installerPath: "C:\\Users\\O'Brien\\AppData\\Local\\tessel-updater\\Tessel.exe",
    installDirectory: 'D:\\apps\\Tessel',
    targetExecutablePath: 'D:\\apps\\Tessel\\Tessel.exe',
    currentProcessId: 4242,
    logPath: 'C:\\Users\\Erno\\AppData\\Roaming\\Tessel\\logs\\update-restart.log'
  });

  expect(script).toContain("$installerPath = 'C:\\Users\\O''Brien\\AppData\\Local\\tessel-updater\\Tessel.exe'");
  expect(script).toContain("$installerArguments = @('--updated', '/S', (\"/D=\" + $installDirectory))");
  expect(script).toContain('Start-Process -FilePath $targetExecutable -WorkingDirectory $installDirectory');
  expect(script).not.toContain('--force-run');

  if (process.platform === 'win32') {
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const parserCommand = `$source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedScript}')); [void][ScriptBlock]::Create($source)`;
    expect(() => execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parserCommand])).not.toThrow();
  }
});

test('renders release notes as a fixed Markdown document in Settings', async ({}, testInfo) => {
  const runDir = testInfo.outputPath(randomUUID());
  const userDataDir = join(runDir, 'user-data');
  await mkdir(userDataDir, { recursive: true });
  let app: ElectronApplication | undefined;
  let settingsPage: Page | undefined;

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
    const home = await app.firstWindow();
    const settingsWindowPromise = app.waitForEvent('window');
    await home.getByRole('button', { name: 'Settings' }).click();
    settingsPage = await settingsWindowPromise;
    await settingsPage.getByRole('button', { name: 'Updates' }).click();

    await app.evaluate(({ BrowserWindow }) => {
      const settingsWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=settings'));
      settingsWindow?.webContents.send('app:update:state', {
        status: 'ready',
        currentVersion: '1.4.1',
        availableVersion: '1.4.2',
        downloadPercent: 100,
        releaseNotes: [
          '## Tessel 1.4.2',
          '',
          '- **Reliable D-drive restart** from the installed path.',
          '- No stale shortcut fallback.',
          '',
          '[Read the full notes](https://example.com/tessel-1.4.2)',
          '',
          '`D:\\apps\\Tessel`'
        ].join('\n')
      });
    });

    const releaseNotes = settingsPage.locator('.reader-settings__release-notes');
    await expect(releaseNotes).toBeVisible();
    await expect(releaseNotes.getByRole('heading', { name: 'Tessel 1.4.2' })).toBeVisible();
    await expect(releaseNotes.getByRole('listitem').first()).toContainText('Reliable D-drive restart');
    await expect(releaseNotes.getByRole('link', { name: 'Read the full notes' })).toHaveAttribute('href', 'https://example.com/tessel-1.4.2');
    await expect(releaseNotes.locator('textarea')).toHaveCount(0);
    await expect(settingsPage.getByRole('button', { name: 'Restart and update' })).toBeVisible();
    expect(await releaseNotes.locator('.reader-settings__release-notes-body').evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      resize: getComputedStyle(element).resize
    }))).toEqual({ overflowY: 'auto', resize: 'none' });
    await app.evaluate(({ BrowserWindow }) => {
      const settingsWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=settings'));
      settingsWindow?.webContents.send('app:update:state', {
        status: 'installing',
        currentVersion: '1.4.1',
        availableVersion: '1.4.2',
        downloadPercent: 100
      });
    });
    await expect(settingsPage.locator('.reader-settings__installing')).toContainText('Tessel will close');
  } finally {
    await app?.close();
    await rm(runDir, { recursive: true, force: true });
  }
});
