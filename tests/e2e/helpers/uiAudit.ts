import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Keep screenshots outside Playwright's transient output so before/after audits
// survive subsequent regression runs. All state belongs to the isolated fixture.
export async function auditInterfaces(app: ElectronApplication, reader: Page, root: string, selectText: () => Promise<void>): Promise<void> {
  const directory = join(root, 'tmp/ui-audit', process.env.TESSEL_UI_AUDIT_PHASE ?? 'current');
  await mkdir(directory, { recursive: true });
  const report: Record<string, unknown> = process.env.TESSEL_UI_AUDIT_SURFACES === '1' || process.env.TESSEL_UI_AUDIT_SETTINGS_ONLY === '1'
    ? JSON.parse(await readFile(join(directory, 'overflow.json'), 'utf8').catch(() => '{}'))
    : {};
  const capture = async (page: Page, name: string): Promise<void> => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled', scale: 'css' });
    report[name] = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((node) => node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 2
        && !['SCRIPT', 'STYLE', 'SVG', 'INPUT', 'TEXTAREA', 'PRE'].includes(node.tagName)
        && getComputedStyle(node).whiteSpace !== 'nowrap'
        && !node.closest('.pdfViewer, .workspace-drawing__surface, .remote-canvas__paper'))
      .map((node) => ({ tag: node.tagName, class: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth })));
    await writeFile(join(directory, 'overflow.json'), JSON.stringify(report, null, 2));
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Tessel UI audit</title><style>body{margin:32px;background:#f3f4f1;color:#252a26;font:14px system-ui}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}figure{margin:0;padding:12px;background:white;border:1px solid #dde1dc;border-radius:16px}img{width:100%;height:260px;object-fit:contain}figcaption{margin-top:10px}a{color:inherit}</style><h1>Tessel UI audit</h1><p>${Object.keys(report).length} screenshots · click to inspect at full size</p><main>${Object.keys(report).map((name) => `<figure><a href="${name}.png"><img loading="lazy" src="${name}.png" alt="${name}"><figcaption>${name}</figcaption></a></figure>`).join('')}</main></html>`);
    if (!(process.env.TESSEL_UI_AUDIT_PHASE ?? '').startsWith('before')) {
      const expectedScrollers = ['pdf-viewport', 'p-splitter-gutter', 'remote-canvas__viewport', 'remote-canvas__space', 'cm-scroller'];
      const unexpected = (report[name] as Array<{ class: string }>).filter((item) => !expectedScrollers.some((className) => item.class.split(' ').includes(className)));
      expect.soft(unexpected, `${name}: unexpected horizontal overflow`).toEqual([]);
      const clippedPanels = await page.locator('.dock-chat-panel, .dock-note-editor-panel, .transient-aid-panel, .remote-brush-panel.is-open').evaluateAll((panels) => panels.filter((panel) => {
        const box = panel.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1);
      }).map((panel) => {
        const box = panel.getBoundingClientRect();
        const viewport = document.querySelector('.pdf-viewport');
        const stage = document.querySelector('.pdf-stage');
        const dock = document.querySelector('.reader-float-dock');
        return { class: panel.className, x: box.x, y: box.y, width: box.width, height: box.height, scrollLeft: viewport?.scrollLeft, stageStyle: stage?.getAttribute('style'), dockTransform: dock && getComputedStyle(dock).transform };
      }));
      expect.soft(clippedPanels, `${name}: panels must remain inside the window`).toEqual([]);
      if (['chat-empty', 'chat-narrow-empty', 'chat-large-type'].includes(name)) {
        const input = page.locator('.chat-composer textarea');
        const buttons = page.locator('.chat-composer__row > button');
        const inputBox = (await input.boundingBox())!;
        for (const button of await buttons.all()) {
          const box = (await button.boundingBox())!;
          expect.soft(Math.abs(box.y + box.height / 2 - inputBox.y - inputBox.height / 2), `${name}: input and button centers`).toBeLessThanOrEqual(2);
        }
      }
    }
  };
  const resize = async (page: Page, width: number, height: number): Promise<void> => {
    const window = await app.browserWindow(page);
    await window.evaluate((window, size) => {
      const minimum = window.getMinimumSize();
      window.setMinimumSize(Math.min(minimum[0], size.width), Math.min(minimum[1], size.height));
      window.setContentSize(size.width, size.height);
    }, { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    await expect.poll(() => page.evaluate(() => innerHeight)).toBe(height);
  };
  const captureSettings = async (settings: Page, suffix: string): Promise<void> => {
    const nav = settings.locator('.reader-settings__nav button');
    await expect(nav).toHaveCount(8);
    for (let index = 0; index < await nav.count(); index++) {
      await nav.nth(index).click();
      await expect(settings.locator('#settings-title')).toHaveText(await nav.nth(index).innerText());
      const body = settings.locator('.reader-settings__body');
      await body.evaluate((node) => { node.scrollTop = 0; });
      if (index === 3) {
        await expect(settings.locator('.reader-settings__lan-qr img')).toBeVisible();
        const address = settings.locator('.reader-settings__lan-primary-address code');
        expect(await address.innerText()).toMatch(/^[\d.]+:\d+$/);
        const link = new URL((await address.getAttribute('title'))!);
        expect(link.searchParams.get('token')).toBeTruthy();
        const smallText = await settings.locator('.reader-settings__lan :is(code, small, p, button, summary)').evaluateAll((nodes) =>
          nodes.filter((node) => node.getBoundingClientRect().width > 0 && Number.parseFloat(getComputedStyle(node).fontSize) < 12).map((node) => node.className));
        expect.soft(smallText, 'Connection settings must not use tiny labels').toEqual([]);
        const addresses = settings.locator('.reader-settings__lan-addresses');
        if (await addresses.count()) await addresses.locator('summary').click();
      }
      if (index === 4) {
        await expect(settings.locator('.reader-settings__book')).not.toHaveCount(0);
        await settings.locator('.reader-settings__book summary').first().click();
        const smallText = await settings.locator('.reader-settings__storage-summary span, .reader-settings__storage-path code, .reader-settings__book :is(small, dt, dd)').evaluateAll((nodes) =>
          nodes.filter((node) => node.getBoundingClientRect().width > 0 && Number.parseFloat(getComputedStyle(node).fontSize) < 12).map((node) => node.className));
        expect.soft(smallText, 'Storage metadata must follow the readable caption scale').toEqual([]);
      }
      await body.evaluate((node) => { node.scrollTop = 0; });
      await capture(settings, `settings-${index}-${suffix}-top`);
      const scrollHeight = await body.evaluate((node) => node.scrollHeight - node.clientHeight);
      if (scrollHeight > 2) {
        // Capture overlapping viewports to inspect every option, not just the fold.
        const height = await body.evaluate((node) => node.clientHeight);
        for (let offset = Math.min(height - 60, scrollHeight); ; offset = Math.min(offset + height - 60, scrollHeight)) {
          await body.evaluate((node, top) => { node.scrollTop = top; }, offset);
          await capture(settings, `settings-${index}-${suffix}-${offset}`);
          if (offset === scrollHeight) break;
        }
      }
    }
  };

  await expect(reader.locator('.pdf-state')).toBeVisible();
  await capture(reader, 'reader-loading');
  await expect(reader.locator('.textLayer').first()).toContainText('Reader fixture');
  await resize(reader, 1440, 920);
  await capture(reader, 'reader-default');
  await reader.getByPlaceholder('Search in PDF').fill('Alpha');
  await reader.getByPlaceholder('Search in PDF').press('Enter');
  await expect(reader.locator('.textLayer .highlight').first()).toBeVisible();
  await capture(reader, 'reader-search');
  await reader.getByPlaceholder('Search in PDF').fill('');
  await expect(reader.locator('.textLayer .highlight')).toHaveCount(0);
  await reader.getByTitle('Bookmark page', { exact: true }).click();
  await reader.locator('.panel-breadcrumb').getByRole('button', { name: /^Bookmarks/ }).click();
  await capture(reader, 'reader-bookmarks');
  await reader.getByRole('button', { name: 'Outline', exact: true }).click();
  if (process.env.TESSEL_UI_AUDIT_SURFACES !== '1') {
    const settingsPromise = app.waitForEvent('window');
    await reader.getByTitle('Settings', { exact: true }).click();
    const settings = await settingsPromise;
    await resize(settings, 1040, 760);
    await captureSettings(settings, 'en-default');
    await resize(settings, 820, 600);
    await captureSettings(settings, 'en-narrow');
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
    await settings.getByLabel('Interface size', { exact: true }).fill('20');
    await settings.getByLabel('Composer size', { exact: true }).fill('20');
    await settings.getByLabel('Response size', { exact: true }).fill('20');
    await settings.locator('.reader-settings__nav').getByRole('button', { name: 'Language', exact: true }).click();
    await settings.getByLabel('UI language').selectOption('zh-CN');
    await captureSettings(settings, 'zh-large-narrow');
    const settingsWindow = await app.browserWindow(settings);
    await settingsWindow.evaluate((window) => window.webContents.send('app:update:state', {
      status: 'ready', currentVersion: '1.4.1', availableVersion: '1.4.2',
      releaseNotes: '## UI refinements\n\n- Stable settings and toolbars\n- More readable controls\n\n| Area | Change |\n| --- | --- |\n| Appearance | Responsive font controls |\n\n```text\nA long command remains inside its own code block instead of widening the settings window.\n```'
    }));
    await expect(settings.locator('.reader-settings__release-notes')).toBeVisible();
    await settings.locator('.reader-settings__body').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await capture(settings, 'settings-update-release-notes');
    await settings.getByRole('button', { name: '取消', exact: true }).click();
  }
  if (process.env.TESSEL_UI_AUDIT_SETTINGS_ONLY === '1') return;

  await reader.evaluate(async () => {
    const preferences = await window.sidelight.getAppPreferences();
    await window.sidelight.saveAppPreferences({ ...preferences, translationBackend: 'codex', experimentalCodexAgent: { ...preferences.experimentalCodexAgent, enabled: true } });
  });

  await reader.getByRole('button', { name: 'New page chat', exact: true }).click();
  await capture(reader, 'chat-empty');
  // Exercise the real dock resize handler, not an injected CSS width. Both the
  // draft and config must stop growing; wide model menus remain content-sized.
  await resize(reader, 2000, 1000);
  const resizeHandle = reader.locator('.dock-resize-handle');
  await expect.poll(() => resizeHandle.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth;
  })).toBe(true);
  const resizeBox = (await resizeHandle.boundingBox())!;
  await reader.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 20);
  await reader.mouse.down();
  await reader.mouse.move(resizeBox.x + 620, resizeBox.y + 20, { steps: 8 });
  await reader.mouse.up();
  await expect.poll(() => reader.locator('.dock-chat-panel').evaluate((node) => node.clientWidth)).toBeGreaterThan(800);
  const wideGeometry = await reader.locator('.chat-composer').evaluate((node) => {
    const form = node.getBoundingClientRect();
    const row = node.querySelector('.chat-composer__row')!.getBoundingClientRect();
    const config = node.querySelector('.chat-config-shell')!.getBoundingClientRect();
    const model = node.querySelector('.chat-config-trigger--model')!.getBoundingClientRect();
    return { width: row.width, center: Math.abs(row.left + row.width / 2 - form.left - form.width / 2), configWidth: config.width, modelWidth: model.width };
  });
  expect(wideGeometry.width).toBe(720);
  expect(wideGeometry.center).toBeLessThanOrEqual(1);
  expect(wideGeometry.configWidth).toBe(wideGeometry.width);
  expect(wideGeometry.modelWidth).toBeLessThan(360);
  await capture(reader, 'chat-wide-empty');
  await reader.getByRole('button', { name: 'Current chat model', exact: true }).click();
  await expect(reader.locator('.chat-model-menu')).toBeVisible();
  expect(await reader.locator('.chat-model-menu').evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(420);
  await capture(reader, 'chat-wide-model-menu');
  await reader.keyboard.press('Escape');
  const composer = reader.locator('.chat-composer textarea');
  await composer.fill('A long question about the current page, including typography, paragraph spacing, and how the explanation relates to this document.');
  await resize(reader, 1080, 720);
  await capture(reader, 'chat-narrow-multiline');
  await composer.fill('');
  await capture(reader, 'chat-narrow-empty');
  const moveDock = reader.getByRole('button', { name: 'Move reading dock', exact: true });
  const moveBox = await moveDock.boundingBox();
  await reader.mouse.move(moveBox!.x + moveBox!.width / 2, moveBox!.y + moveBox!.height / 2);
  await reader.mouse.down();
  await reader.mouse.move(moveBox!.x, 700, { steps: 8 });
  await reader.mouse.up();
  expect((await moveDock.boundingBox())!.x - moveBox!.x, 'Auto-alignment must not fight a deliberate dock drag').toBeLessThan(-5);
  await capture(reader, 'chat-dragged-to-bottom');
  await resize(reader, 1080, 600);
  await capture(reader, 'chat-dragged-window-resized');
  const movedBox = await moveDock.boundingBox();
  await reader.mouse.move(movedBox!.x + movedBox!.width / 2, movedBox!.y + movedBox!.height / 2);
  await reader.mouse.down();
  await reader.mouse.move(movedBox!.x, 42, { steps: 8 });
  await reader.mouse.up();
  await resize(reader, 1080, 720);
  await reader.getByRole('button', { name: 'Current chat model', exact: true }).click();
  await expect(reader.locator('.chat-model-menu')).toBeVisible();
  await capture(reader, 'chat-model-menu');
  await reader.keyboard.press('Escape');
  await reader.getByRole('button', { name: 'Permissions', exact: true }).click();
  await capture(reader, 'chat-permissions-menu');
  await reader.keyboard.press('Escape');
  await composer.fill('/');
  await capture(reader, 'chat-slash-menu');
  await composer.fill('');
  await resize(reader, 1440, 920);
  await reader.locator('.dock-chat-panel .panel-close-button').click();
  await reader.getByRole('button', { name: 'Translations', exact: true }).click();
  await capture(reader, 'translations-empty');
  await resize(reader, 1440, 920);
  await selectText();
  await capture(reader, 'selection-actions');
  await reader.locator('.selection-toolbar').getByRole('button', { name: 'Notes', exact: true }).click();
  await capture(reader, 'note-editor');
  await resize(reader, 1080, 720);
  await capture(reader, 'note-editor-narrow');
  await reader.locator('.dock-note-editor-panel .panel-close-button').click();
  await resize(reader, 1440, 920);
  await reader.getByRole('button', { name: 'Handwritten notes', exact: true }).click();
  await capture(reader, 'notebook-menu');
  await reader.getByRole('button', { name: 'Create handwritten notes', exact: true }).click();
  const board = reader.locator('.workspace-block-card--drawing');
  await expect(board).toBeVisible();
  await capture(reader, 'notebook-collapsed');
  await board.getByRole('button', { name: 'Show drawing tools', exact: true }).click();
  await capture(reader, 'notebook-tools');
  await board.getByRole('button', { name: 'Pen tool', exact: true }).click();
  await capture(reader, 'notebook-brush-settings');

  const info = await reader.evaluate(() => window.sidelight.getLanWhiteboardInfo());
  const url = info.urls.find((url) => url.includes('127.0.0.1')) ?? info.urls[0];
  const tabletPromise = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const tablet = new BrowserWindow({ width: 1024, height: 768, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    void tablet.loadURL(url);
  }, url);
  const tablet = await tabletPromise;
  await expect(tablet.locator('.remote-canvas__paper')).toBeVisible();
  await capture(tablet, 'tablet-landscape');
  await tablet.getByRole('button', { name: '画笔设置', exact: true }).click();
  await capture(tablet, 'tablet-brush-settings');
  await resize(tablet, 768, 1024);
  await capture(tablet, 'tablet-portrait-brush-settings');
  await tablet.getByRole('button', { name: '画笔设置', exact: true }).click();
  await capture(tablet, 'tablet-portrait');
  await tablet.getByRole('button', { name: '缩小纸张列表', exact: true }).click();
  await capture(tablet, 'tablet-compact-sidebar');
  await tablet.getByRole('button', { name: '隐藏纸张列表', exact: true }).click();
  await capture(tablet, 'tablet-hidden-sidebar');
  await tablet.getByRole('button', { name: '显示纸张列表', exact: true }).click();
  await tablet.getByRole('button', { name: '展开纸张列表', exact: true }).click();
  await tablet.getByRole('button', { name: '删除纸张', exact: true }).first().click();
  await capture(tablet, 'tablet-delete-confirmation');
  await tablet.getByRole('button', { name: '取消', exact: true }).click();
  await tablet.getByRole('button', { name: '隐藏纸张列表', exact: true }).click();
  await resize(tablet, 600, 900);
  await tablet.getByRole('button', { name: '画笔设置', exact: true }).click();
  await capture(tablet, 'tablet-small-brush-settings');

  // Rich/long content and maximum font sizes exercise the non-empty surfaces.
  await reader.evaluate(async () => {
    const documentId = new URLSearchParams(location.search).get('documentId')!;
    const now = new Date().toISOString();
    const preferences = await window.sidelight.getAppPreferences();
    await window.sidelight.saveAppPreferences({ ...preferences, appearance: { ...preferences.appearance, uiFontSize: 20, sidebarFontSize: 20, agentFontSize: 20, composerFontSize: 20 } });
    await window.sidelight.saveTranslation({ translation: { id: 'audit-translation', documentId, pageNumber: 1, backend: 'codex', status: 'completed', quote: 'A long selected passage for checking translation header and content layout.', content: '## Translation\n\nThis passage discusses **layout stability** and typography.\n\n- First observation\n- Second observation', createdAt: now, updatedAt: now } });
    await window.sidelight.saveGeneratedPdfOutline({ outline: { documentId, source: 'ai', items: [{ id: 'audit-outline', title: 'A deliberately long chapter title that must remain readable without covering nearby controls', level: 1, pageNumber: 1 }], createdAt: now, updatedAt: now } });
  });
  await reader.reload();
  await expect(reader.locator('.textLayer').first()).toContainText('Reader fixture');
  await resize(reader, 1080, 720);
  await reader.getByRole('button', { name: 'Translations', exact: true }).click();
  await reader.locator('.trace-card').filter({ hasText: 'A long selected passage' }).click();
  await capture(reader, 'translation-large-type');
  await reader.locator('.transient-aid-panel .panel-close-button').click();
  await reader.getByRole('button', { name: 'New page chat', exact: true }).click();
  await capture(reader, 'chat-large-type');
  await reader.getByRole('button', { name: 'Rename conversation participants', exact: true }).click();
  await capture(reader, 'chat-participant-names');
  await reader.getByRole('button', { name: 'Rename conversation participants', exact: true }).click();
  await reader.locator('.chat-composer textarea').fill('Explain this page.');
  await reader.locator('.chat-composer textarea').press('Enter');
  await expect(reader.locator('.chat-message--assistant')).toBeVisible();
  await capture(reader, 'chat-streaming');
  await reader.locator('.chat-composer textarea').fill('Finish the explanation.');
  await reader.locator('.chat-composer textarea').press('Enter');
  await expect(reader.locator('.chat-send-button')).toBeDisabled();
  await capture(reader, 'chat-transcript');
  await reader.locator('.dock-chat-panel .panel-close-button').click();
  await capture(reader, 'chat-history');
  await reader.getByRole('button', { name: 'Notes', exact: true }).click();
  await capture(reader, 'notes-history');

  // Use a real rendered PDF excerpt to inspect image-card controls and sizing.
  const excerpt = await reader.locator<HTMLCanvasElement>('.pdfViewer .page canvas').first().evaluate((canvas) => canvas.toDataURL('image/png'));
  await reader.evaluate(async (dataUrl) => {
    const documentId = new URLSearchParams(location.search).get('documentId')!;
    const now = new Date().toISOString();
    await window.sidelight.saveWorkspaceBlock({ block: {
      id: 'audit-image', documentId, pageNumber: 1, kind: 'image',
      anchor: 'page', sourceKind: 'manual', contentKind: 'image',
      title: 'PDF excerpt', payload: { dataUrl, name: 'excerpt.png', mimeType: 'image/png' }, x: -360, y: 120,
      width: 340, height: 240, createdAt: now, updatedAt: now
    } });
  }, excerpt);
  await reader.reload();
  await expect(reader.locator('.textLayer').first()).toContainText('Reader fixture');
  const restoredChat = reader.locator('.dock-chat-panel .panel-close-button');
  if (await restoredChat.count()) await restoredChat.click();
  const imageCard = reader.locator('.workspace-block-card--image');
  await imageCard.scrollIntoViewIfNeeded();
  await imageCard.hover();
  await capture(reader, 'image-card');

  const homeUrl = new URL(reader.url());
  homeUrl.search = '';
  await reader.goto(homeUrl.toString());
  const homeWindow = await app.browserWindow(reader);
  await homeWindow.evaluate((window) => window.setMinimumSize(620, 460));
  await resize(reader, 720, 520);
  await expect(reader.locator('.reader-home')).toBeVisible();
  await capture(reader, 'home-recent-history');
  await resize(reader, 620, 460);
  await capture(reader, 'home-narrow');
}
