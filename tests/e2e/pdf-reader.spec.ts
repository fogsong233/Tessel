import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { auditInterfaces } from './helpers/uiAudit';

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
    const fakeAppData = join(runDir, 'app-data');
    const fakeCodexHome = join(runDir, 'codex-home');
    const fakeCodexLog = join(runDir, 'codex-requests.jsonl');
    await createFakeCodex(fakeCodexBin);
    if (process.platform === 'win32') {
      await createFakeCodex(join(fakeAppData, 'npm'));
    }
    await createFakeCodexModelCache(fakeCodexHome);
    const useExecTransport = testInfo.title.includes('exec checkpoint')
      || testInfo.title.includes('fast translation')
      || testInfo.title.includes('Codex outline');

    app = await electron.launch({
      args: [mainEntry, pdfPath],
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: process.platform === 'win32'
          ? `${dirname(process.execPath)}${delimiter}${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`
          : `${fakeCodexBin}${delimiter}${process.env.PATH ?? ''}`,
        ...(process.platform === 'win32' ? { APPDATA: fakeAppData } : {}),
        CODEX_HOME: fakeCodexHome,
        FAKE_CODEX_LOG: fakeCodexLog,
        FAKE_CODEX_AUTH: useExecTransport ? 'api-key' : 'chatgpt',
        TESSEL_CODEX_TRANSPORT: testInfo.title.includes('exec checkpoint') ? 'exec' : '',
        TESSEL_LAN_WHITEBOARD_PORT: '0',
        SIDELIGHT_E2E_PDF_LOAD_DELAY_MS: testInfo.title.includes('stable while loading') ? '900'
          : testInfo.title.includes('visually audits') ? '2500' : '',
        SIDELIGHT_USER_DATA_DIR: userDataDir,
        SIDELIGHT_E2E_HIDE_WINDOWS: '1',
        SIDELIGHT_E2E_ALLOW_LOOPBACK_MEDIA: '1'
      }
    });
    page = await app.firstWindow();
  });

  test.afterEach(async () => {
    await app?.close();
    if (process.env.SIDELIGHT_E2E_KEEP_RUN_DIR !== '1') {
      await rm(runDir, { recursive: true, force: true });
    }
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

  test('visually audits every settings section and reader surface', async () => {
    test.setTimeout(480_000);
    await auditInterfaces(app, page, rootDir, () => selectPdfText(page));
  });

  test('reveals the whole dock when a clipped control receives focus or opens its model menu', async () => {
    await expect(page.locator('.textLayer').first()).toContainText('Reader fixture');
    await page.evaluate(async () => {
      const preferences = await window.sidelight.getAppPreferences();
      await window.sidelight.saveAppPreferences({ ...preferences, translationBackend: 'codex', experimentalCodexAgent: { ...preferences.experimentalCodexAgent, enabled: true } });
    });
    await page.getByRole('button', { name: 'New page chat', exact: true }).click();
    const window = await app.browserWindow(page);
    await window.evaluate((window) => window.setContentSize(1080, 720));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1080);
    const contained = () => page.locator('.reader-float-dock').evaluate((node) => {
      const box = node.getBoundingClientRect();
      const viewport = document.querySelector('.pdf-viewport')!.getBoundingClientRect();
      return box.left >= viewport.left - 1 && box.right + 24 <= viewport.right + 1;
    });
    await expect.poll(contained).toBe(true);
    const model = page.getByRole('button', { name: 'Current chat model', exact: true });
    // Native focus can reveal only a button after the reader was panned. Make
    // that state deterministic instead of depending on platform timing.
    const partiallyReveal = async () => {
      await page.locator('.pdf-viewport').evaluate((node) => { node.scrollLeft -= 160; });
      await expect.poll(contained).toBe(false);
    };
    await model.focus();
    await page.keyboard.press('Shift+Tab');
    await partiallyReveal();
    await page.keyboard.press('Tab');
    await expect(model).toBeFocused();
    await expect.poll(contained).toBe(true);
    await model.evaluate((node) => node.blur());
    await partiallyReveal();
    await model.click();
    await expect(page.locator('.chat-model-menu')).toBeVisible();
    await expect.poll(contained).toBe(true);
    await page.keyboard.press('Escape');
    // Merely panning the PDF is still allowed; alignment is interaction-driven.
    await partiallyReveal();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await contained()).toBe(false);
  });

  test('clears PDF search highlights when the search field is emptied', async () => {
    await expect(page.locator('.textLayer').first()).toContainText('Reader fixture');
    const search = page.getByPlaceholder('Search in PDF');
    await search.fill('Alpha');
    await search.press('Enter');
    await expect(page.locator('.textLayer .highlight').first()).toBeVisible();
    await search.fill('');
    await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
    await expect(page.locator('.textLayer').first()).toContainText('Reader fixture quote Alpha Beta');
  });

  test('keeps the sidebar and PDF anchor stable while loading and zooming', async () => {
    await expect(page.locator('.pdf-state')).toBeVisible();
    const loadingLayout = await readReaderLayout(page);
    expect(loadingLayout.contained).toBe(true);
    expect(loadingLayout.ordered).toBe(true);

    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await expect(page.locator('.pdf-state')).toHaveCount(0);
    const readyLayout = await readReaderLayout(page);
    expect(readyLayout.contained).toBe(true);
    expect(readyLayout.ordered).toBe(true);
    expect(Math.abs(readyLayout.left - loadingLayout.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(readyLayout.width - loadingLayout.width)).toBeLessThanOrEqual(1);

    for (const zoomAction of ['Zoom out', 'Zoom out', 'Zoom in', 'Zoom in']) {
      const anchorBefore = await readPdfViewportAnchor(page);
      expect(anchorBefore.pageNumber).toBe('1');
      await page.getByTitle(zoomAction).click();
      await expect.poll(async () => {
        const anchorAfter = await readPdfViewportAnchor(page, {
          clientX: anchorBefore.clientX,
          clientY: anchorBefore.clientY
        });
        return Boolean(
          anchorAfter.pageNumber === anchorBefore.pageNumber &&
          Math.abs(anchorAfter.xRatio - anchorBefore.xRatio) < 0.035 &&
          Math.abs(anchorAfter.yRatio - anchorBefore.yRatio) < 0.035
        );
      }).toBe(true);
      await expect(page.getByRole('textbox', { name: 'Page' })).toHaveValue('1');
      const zoomedLayout = await readReaderLayout(page);
      expect(zoomedLayout).toMatchObject({ contained: true, ordered: true });
      expect(Math.abs(zoomedLayout.width - readyLayout.width)).toBeLessThanOrEqual(1);
    }
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
    const dockContained = async (): Promise<boolean> => page.locator('.reader-float-dock').evaluate((node) => {
      const dock = node.getBoundingClientRect();
      const viewport = document.querySelector('.pdf-viewport')!.getBoundingClientRect();
      return dock.right + 24 <= viewport.right + 1;
    });
    const clipped = await page.locator('.pdf-viewport').evaluate((node) => {
      const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
      const initial = node.scrollLeft;
      const candidates = [initial - 160, initial + 160, 0, maxScroll];
      for (const candidate of candidates) {
        node.scrollLeft = Math.max(0, Math.min(maxScroll, candidate));
        const dock = node.querySelector<HTMLElement>('.reader-float-dock')?.getBoundingClientRect();
        const viewport = node.getBoundingClientRect();
        if (dock && (dock.left < viewport.left - 1 || dock.right + 24 > viewport.right + 1)) {
          return true;
        }
      }
      return false;
    });
    expect(clipped).toBe(true);
    await expect.poll(dockContained).toBe(false);
    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Quote$/i }).click();
    const composer = page.locator('.dock-chat-panel textarea');
    await expect(composer).toContainText('Reader fixture quote Alpha Beta');
    await expect.poll(dockContained).toBe(true);
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

  test('keeps image pins in a fixed viewport and zooms around the pointer', async () => {
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
    await expect(card).toHaveCSS('height', '220px');
    await card.hover();
    await expect(card.getByTitle('Copy image')).toBeVisible();
    const viewport = card.locator('.workspace-image__viewport');
    await expect(viewport).toHaveCSS('overflow-x', 'auto');
    await expect(viewport).toHaveCSS('scrollbar-width', 'none');
    const box = await viewport.boundingBox();
    expect(box).toBeTruthy();
    await viewport.dispatchEvent('pointerdown', {
      pointerId: 8,
      pointerType: 'mouse',
      button: 2,
      buttons: 2,
      clientX: box!.x + box!.width * 0.7,
      clientY: box!.y + box!.height * 0.4
    });
    await viewport.dispatchEvent('wheel', {
      deltaY: -120,
      clientX: box!.x + box!.width * 0.7,
      clientY: box!.y + box!.height * 0.4
    });
    await page.locator('body').dispatchEvent('pointerup', { pointerId: 8, button: 2, buttons: 0 });
    await expect(card.locator('img')).toHaveAttribute('style', /width: 112%/);
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        workspaceBlocks: Array<{ id: string; payload?: { zoom?: number } }>;
      };
      return saved.workspaceBlocks.find((block) => block.id === 'image_pin_fixture')?.payload?.zoom;
    }).toBe(112);
  });

  test('uses a fixed multi-sheet notebook with stylus-only, editable selections, and AI image sharing', async () => {
    test.setTimeout(120_000);
    await expect(page.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    await page.getByRole('button', { name: 'Handwritten notes', exact: true }).click();
    await page.getByRole('button', { name: 'Create handwritten notes' }).click();

    const board = page.locator('.workspace-block-card--drawing');
    const pdfPage = page.locator('.pdfViewer .page[data-page-number="1"]');
    await expect(board).toBeVisible();
    const boardBox = await board.boundingBox();
    const pageBox = await pdfPage.boundingBox();
    expect(boardBox).toBeTruthy();
    expect(pageBox).toBeTruthy();
    expect(Math.abs(boardBox!.width - pageBox!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(boardBox!.height - pageBox!.height)).toBeLessThanOrEqual(2);
    expect(boardBox!.x + boardBox!.width).toBeLessThanOrEqual(pageBox!.x + 2);

    await board.getByRole('button', { name: 'Move notebook to right' }).click();
    await expect.poll(async () => {
      const [nextBoardBox, nextPageBox] = await Promise.all([board.boundingBox(), pdfPage.boundingBox()]);
      return Boolean(nextBoardBox && nextPageBox && nextBoardBox.x >= nextPageBox.x + nextPageBox.width - 2);
    }).toBe(true);

    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    const dock = page.locator('.reader-dock-lane');
    await expect(dock).toBeVisible();
    await expect.poll(async () => {
      const [nextBoardBox, dockBox] = await Promise.all([board.boundingBox(), dock.boundingBox()]);
      return Boolean(nextBoardBox && dockBox && nextBoardBox.x + nextBoardBox.width <= dockBox.x + 1);
    }).toBe(true);

    for (const zoomAction of [
      'Zoom out', 'Zoom out', 'Zoom out', 'Zoom out',
      'Zoom in', 'Zoom in'
    ]) {
      await page.getByTitle(zoomAction).click();
      await page.waitForTimeout(1_000);
      const [nextBoardBox, nextPageBox, viewport] = await Promise.all([
        board.boundingBox(),
        pdfPage.boundingBox(),
        page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      ]);
      expect(nextBoardBox).toBeTruthy();
      expect(nextPageBox).toBeTruthy();
      expect(nextBoardBox!.x).toBeLessThan(viewport.width);
      expect(nextBoardBox!.x + nextBoardBox!.width).toBeGreaterThan(0);
      expect(nextBoardBox!.y).toBeLessThan(viewport.height);
      expect(nextBoardBox!.y + nextBoardBox!.height).toBeGreaterThan(0);
      expect(Math.abs(nextBoardBox!.height - nextPageBox!.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(nextBoardBox!.width - nextPageBox!.width)).toBeLessThanOrEqual(2);
      await expect(page.getByRole('textbox', { name: 'Page' })).toHaveValue('1');
    }

    const surface = board.locator('.workspace-drawing__surface');
    const drawingToolbar = board.locator('.workspace-drawing__toolbar');
    await expect(drawingToolbar).toHaveClass(/is-collapsed/);
    await board.getByRole('button', { name: 'Show drawing tools' }).click();
    await expect(drawingToolbar).toHaveClass(/is-expanded/);
    expect(await drawingToolbar.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(drawingToolbar.getByRole('button', { name: /^Delete sheet/ })).toHaveCount(0);
    await expect.poll(async () => {
      const [box, viewport] = await Promise.all([
        surface.boundingBox(),
        page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      ]);
      return Boolean(box && box.x < viewport.width && box.x + box.width > 0);
    }).toBe(true);
    const surfaceBox = await surface.boundingBox();
    expect(surfaceBox).toBeTruthy();
    const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const visibleLeft = Math.max(0, surfaceBox!.x);
    const visibleRight = Math.min(viewportSize.width, surfaceBox!.x + surfaceBox!.width);
    const visibleTop = Math.max(0, surfaceBox!.y);
    const visibleBottom = Math.min(viewportSize.height, surfaceBox!.y + surfaceBox!.height);
    const drawingX = visibleLeft + (visibleRight - visibleLeft) * 0.78;
    const drawingY = visibleTop + (visibleBottom - visibleTop) * 0.58;
    const drawingHit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return {
        className: element?.getAttribute('class'),
        tagName: element?.tagName,
        x,
        y,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      };
    }, {
      x: drawingX,
      y: drawingY
    });
    expect(drawingHit.tagName).toBe('svg');
    expect(drawingHit.className).toContain('workspace-drawing__surface');
    await page.mouse.move(drawingX, drawingY);
    await page.mouse.down();
    await page.mouse.move(drawingX - 72, drawingY + 60, { steps: 8 });
    await page.mouse.move(drawingX - 150, drawingY + 15, { steps: 8 });
    await page.mouse.up();
    await expect(surface.locator('path')).toHaveCount(1);
    const surfaceAfterStroke = await surface.boundingBox();
    expect(Math.abs(surfaceAfterStroke!.x - surfaceBox!.x), 'zoom settling must not scroll during handwriting').toBeLessThan(2);
    expect(Math.abs(surfaceAfterStroke!.y - surfaceBox!.y), 'zoom settling must not scroll during handwriting').toBeLessThan(2);
    await board.getByRole('button', { name: 'Undo stroke' }).click();
    await expect(surface.locator('path')).toHaveCount(0);
    await board.getByRole('button', { name: 'Redo stroke' }).click();
    await expect(surface.locator('path')).toHaveCount(1);

    await board.getByRole('button', { name: 'Lasso tool' }).click();
    await page.mouse.move(drawingX + 30, drawingY - 30);
    await page.mouse.down();
    await page.mouse.move(drawingX + 30, drawingY + 90, { steps: 5 });
    await page.mouse.move(drawingX - 185, drawingY + 90, { steps: 7 });
    await page.mouse.move(drawingX - 185, drawingY - 30, { steps: 5 });
    await page.mouse.move(drawingX + 30, drawingY - 30, { steps: 7 });
    await page.mouse.up();
    await expect(surface.locator('path.is-selected')).toHaveCount(1);

    const selectionBox = surface.locator('.workspace-drawing__selection-box');
    const selectionBoxBefore = await selectionBox.boundingBox();
    expect(selectionBoxBefore).toBeTruthy();
    await selectionBox.dispatchEvent('pointerdown', {
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: selectionBoxBefore!.x + selectionBoxBefore!.width / 2,
      clientY: selectionBoxBefore!.y + selectionBoxBefore!.height / 2
    });
    await surface.dispatchEvent('pointermove', {
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: selectionBoxBefore!.x + selectionBoxBefore!.width / 2 - 28,
      clientY: selectionBoxBefore!.y + selectionBoxBefore!.height / 2 + 18
    });
    await surface.dispatchEvent('pointerup', {
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: 0,
      clientX: selectionBoxBefore!.x + selectionBoxBefore!.width / 2 - 28,
      clientY: selectionBoxBefore!.y + selectionBoxBefore!.height / 2 + 18
    });
    await expect.poll(async () => (await selectionBox.boundingBox())?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(selectionBoxBefore!.x - 15);

    const resizeHandle = surface.locator('.workspace-drawing__selection-handle');
    const handleBox = await resizeHandle.boundingBox();
    const movedSelectionBox = await selectionBox.boundingBox();
    expect(handleBox).toBeTruthy();
    expect(movedSelectionBox).toBeTruthy();
    await resizeHandle.dispatchEvent('pointerdown', {
      pointerId: 42,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: handleBox!.x + handleBox!.width / 2,
      clientY: handleBox!.y + handleBox!.height / 2
    });
    await surface.dispatchEvent('pointermove', {
      pointerId: 42,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: handleBox!.x + handleBox!.width / 2 + 45,
      clientY: handleBox!.y + handleBox!.height / 2 + 45
    });
    await surface.dispatchEvent('pointerup', {
      pointerId: 42,
      pointerType: 'mouse',
      button: 0,
      buttons: 0,
      clientX: handleBox!.x + handleBox!.width / 2 + 45,
      clientY: handleBox!.y + handleBox!.height / 2 + 45
    });
    await expect.poll(async () => (await selectionBox.boundingBox())?.width ?? 0).toBeGreaterThan(movedSelectionBox!.width + 20);

    await page.locator('.dock-chat-panel').getByTitle('Collapse chat').click();
    await expect(page.locator('.dock-chat-panel')).toHaveCount(0);
    await board.getByRole('button', { name: 'Send to AI' }).click();
    await expect(page.locator('.dock-chat-panel')).toBeVisible();
    await expect(page.locator('.composer-attachment img')).toHaveAttribute('src', /^data:image\/png;base64,/);

    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        workspaceBlocks: Array<{ kind: string; payload?: { strokes?: Array<{ points?: number[][] }> } }>;
      };
      return saved.workspaceBlocks.find((block) => block.kind === 'drawing')?.payload?.strokes?.[0]?.points?.length;
    }, { timeout: 8_000 }).toBeGreaterThan(3);

    await board.getByRole('button', { name: 'Pen tool' }).click();
    const desktopBrushPanel = page.getByRole('region', { name: 'Pen tool' });
    await expect(desktopBrushPanel).toBeVisible();
    const desktopBrushPanelBox = await desktopBrushPanel.boundingBox();
    const desktopViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(desktopBrushPanelBox).toBeTruthy();
    expect(desktopBrushPanelBox!.x).toBeGreaterThanOrEqual(0);
    expect(desktopBrushPanelBox!.x + desktopBrushPanelBox!.width).toBeLessThanOrEqual(desktopViewport.width);
    await board.getByRole('button', { name: 'Disable touch drawing' }).click();
    await expect(board.getByRole('button', { name: 'Disable touch drawing' })).toHaveAttribute('aria-pressed', 'true');
    await surface.dispatchEvent('pointerdown', {
      pointerId: 30,
      pointerType: 'touch',
      button: 0,
      buttons: 1,
      clientX: drawingX,
      clientY: drawingY - 80
    });
    await surface.dispatchEvent('pointermove', {
      pointerId: 30,
      pointerType: 'touch',
      button: 0,
      buttons: 1,
      clientX: drawingX - 40,
      clientY: drawingY - 60
    });
    await surface.dispatchEvent('pointerup', { pointerId: 30, pointerType: 'touch', button: 0, buttons: 0 });
    await expect(surface.locator('path')).toHaveCount(1);
    await surface.dispatchEvent('pointerdown', {
      pointerId: 31,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: drawingX - 20,
      clientY: drawingY - 40,
      pressure: 0
    });
    for (const [offsetX, offsetY, pressure] of [
      [-40, -28, 0.1],
      [-64, -12, 0.45],
      [-90, 8, 0.9]
    ]) {
      await surface.dispatchEvent('pointermove', {
        pointerId: 31,
        pointerType: 'pen',
        button: 0,
        buttons: 1,
        clientX: drawingX + offsetX,
        clientY: drawingY + offsetY,
        pressure
      });
    }
    await surface.dispatchEvent('pointerup', {
      pointerId: 31,
      pointerType: 'pen',
      button: 0,
      buttons: 0,
      clientX: drawingX - 90,
      clientY: drawingY + 8,
      pressure: 0
    });
    await expect(surface.locator('path')).toHaveCount(2);
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        workspaceBlocks: Array<{
          kind: string;
          payload?: { strokes?: Array<{ points?: number[][]; simulatePressure?: boolean }> };
        }>;
      };
      const penStroke = saved.workspaceBlocks
        .find((block) => block.kind === 'drawing')
        ?.payload?.strokes?.find((stroke) => stroke.simulatePressure === false);
      const pressures = penStroke?.points?.map((point) => point[2]) ?? [];
      return {
        count: pressures.length,
        lightStart: (pressures[0] ?? 1) < 0.1,
        expressiveRange: pressures.length
          ? Math.max(...pressures) - Math.min(...pressures) > 0.5
          : false
      };
    }, { timeout: 8_000 }).toEqual({ count: 4, lightStart: true, expressiveRange: true });

    // Holding a stationary stylus switches the current gesture to a temporary
    // eraser without committing the initial dot.
    await surface.dispatchEvent('pointerdown', {
      pointerId: 32,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: drawingX - 64,
      clientY: drawingY - 12,
      pressure: 0.45
    });
    await page.waitForTimeout(540);
    await expect(surface).toHaveClass(/is-eraser/);
    await surface.dispatchEvent('pointerup', {
      pointerId: 32,
      pointerType: 'pen',
      button: 0,
      buttons: 0,
      clientX: drawingX - 64,
      clientY: drawingY - 12,
      pressure: 0
    });
    await expect(surface.locator('path')).toHaveCount(1);

    // Moving before the hold threshold keeps a normal pressure-aware stroke.
    await surface.dispatchEvent('pointerdown', {
      pointerId: 33,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: drawingX - 20,
      clientY: drawingY - 100,
      pressure: 0.2
    });
    await surface.dispatchEvent('pointermove', {
      pointerId: 33,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: drawingX - 70,
      clientY: drawingY - 75,
      pressure: 0.7
    });
    await surface.dispatchEvent('pointerup', {
      pointerId: 33,
      pointerType: 'pen',
      button: 0,
      buttons: 0,
      clientX: drawingX - 70,
      clientY: drawingY - 75,
      pressure: 0
    });
    await expect(surface.locator('path')).toHaveCount(2);

    const pdfViewport = page.locator('.pdf-viewport');
    const scrollBeforeModifierPan = await pdfViewport.evaluate((node) => ({
      left: node.scrollLeft,
      top: node.scrollTop
    }));
    await page.keyboard.down('Control');
    try {
      await page.mouse.move(drawingX, drawingY);
      await page.mouse.down();
      await page.mouse.move(drawingX - 80, drawingY - 55, { steps: 5 });
      await page.mouse.up();
    } finally {
      await page.keyboard.up('Control');
    }
    const scrollAfterModifierPan = await pdfViewport.evaluate((node) => ({
      left: node.scrollLeft,
      top: node.scrollTop
    }));
    expect(
      Math.abs(scrollAfterModifierPan.left - scrollBeforeModifierPan.left) +
      Math.abs(scrollAfterModifierPan.top - scrollBeforeModifierPan.top)
    ).toBeGreaterThan(20);
    await expect(surface.locator('path')).toHaveCount(2);

    await page.locator('.workspace-notebook__add-sheet').click();
    await expect(page.locator('.workspace-block-card--notebook')).toHaveCount(1);
    await expect(page.locator('.workspace-notebook__sheet')).toHaveCount(2);
    await expect.poll(() => page.locator('.workspace-notebook__pages').evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const secondSheetDelete = page.getByRole('button', { name: 'Delete sheet 2' });
    await expect(secondSheetDelete).toBeVisible();
    await secondSheetDelete.click();
    await expect(page.locator('.workspace-notebook__sheet')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('.workspace-block-card--drawing .workspace-drawing__surface path')).toHaveCount(2);
  });

  test('streams tablet handwriting and manages notebook sheets over the LAN page', async () => {
    test.setTimeout(90_000);
    await expect(page.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    const info = await expect.poll(async () => page.evaluate(() => window.sidelight.getLanWhiteboardInfo())).toMatchObject({
      running: true,
      clientCount: 0
    });
    void info;
    const serverInfo = await page.evaluate(() => window.sidelight.getLanWhiteboardInfo());
    const url = serverInfo.urls.find((candidate) => candidate.includes('127.0.0.1')) ?? serverInfo.urls[0];
    expect(url).toBeTruthy();
    const html = await fetch(url!).then((response) => response.text());
    expect(html).toContain('Tessel 手写板');

    const tabletWindow = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, remoteUrl) => {
      const tablet = new BrowserWindow({
        width: 1024,
        height: 768,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      });
      void tablet.loadURL(remoteUrl);
    }, url!);
    const tablet = await tabletWindow;
    await expect(tablet.locator('.remote-app')).toBeVisible();
    await expect(tablet.locator('.remote-status.is-connected')).toBeVisible();
    await tablet.getByRole('button', { name: '信任此设备' }).click();
    await expect(tablet.getByRole('button', { name: '已信任此设备' })).toBeVisible();
    await expect.poll(() => tablet.evaluate(() => Boolean(localStorage.getItem('tessel.lan-whiteboard.trusted-credential')))).toBe(true);
    const invalidTokenUrl = new URL(url!);
    invalidTokenUrl.searchParams.set('token', 'expired-token-fixture');
    await tablet.goto(invalidTokenUrl.toString());
    await expect(tablet.locator('.remote-app')).toBeVisible();
    await expect(tablet.locator('.remote-status.is-connected')).toBeVisible();
    await expect(tablet.getByRole('button', { name: '已信任此设备' })).toBeVisible();
    await tablet.getByRole('button', { name: '创建笔记' }).click();

    const tabletSurface = tablet.locator('.remote-canvas__paper');
    await expect(tabletSurface).toBeVisible();
    await expect(tablet.locator('.remote-header__context')).toHaveCount(0);
    const [tabletHeaderBox, tabletToolsBox] = await Promise.all([
      tablet.locator('.remote-header').boundingBox(),
      tablet.locator('.remote-tools').boundingBox()
    ]);
    expect(tabletHeaderBox).toBeTruthy();
    expect(tabletToolsBox).toBeTruthy();
    expect(tabletToolsBox!.y).toBeGreaterThanOrEqual(tabletHeaderBox!.y + tabletHeaderBox!.height);
    expect(await tablet.locator('.remote-tools').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect.poll(async () => {
      const [paper, viewport] = await Promise.all([
        tabletSurface.boundingBox(),
        tablet.locator('.remote-canvas__viewport').boundingBox()
      ]);
      return Boolean(paper && viewport
        && Math.abs(paper.x + paper.width / 2 - (viewport.x + viewport.width / 2)) < 10
        && paper.height > viewport.height);
    }).toBe(true);

    await tablet.getByRole('button', { name: '画笔设置', exact: true }).click();
    const brushPanel = tablet.getByRole('region', { name: '画笔设置' });
    await expect(brushPanel).toBeVisible();
    const brushPanelBox = await brushPanel.boundingBox();
    const tabletViewport = await tablet.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(brushPanelBox).toBeTruthy();
    expect(brushPanelBox!.x).toBeGreaterThanOrEqual(0);
    expect(brushPanelBox!.x + brushPanelBox!.width).toBeLessThanOrEqual(tabletViewport.width);
    const brushWidth = tablet.getByRole('slider', { name: '笔刷宽度' });
    await expect(brushWidth).toHaveValue('4');
    await tablet.getByRole('button', { name: '收藏当前笔刷' }).click();
    await expect(tablet.getByRole('button', { name: '取消收藏当前笔刷' })).toBeVisible();
    await tablet.getByRole('button', { name: '增大笔刷宽度' }).click();
    await expect(brushWidth).toHaveValue('5');
    await tablet.getByRole('button', { name: '使用收藏笔刷 #171a16 4 像素' }).click();
    await expect(brushWidth).toHaveValue('4');
    await tablet.locator('.remote-brush-advanced summary').click();
    await tablet.getByRole('slider', { name: '笔触跟手程度' }).fill('100');
    await tablet.getByRole('slider', { name: '笔触平滑程度' }).fill('35');
    await tablet.getByRole('button', { name: '画笔设置', exact: true }).click();
    await expect(page.locator('.workspace-block-card--drawing')).toBeVisible();
    const surfaceBox = await tabletSurface.boundingBox();
    expect(surfaceBox).toBeTruthy();
    const startX = surfaceBox!.x + surfaceBox!.width * 0.35;
    const startY = surfaceBox!.y + surfaceBox!.height * 0.35;
    await tablet.mouse.move(startX, startY);
    await tablet.mouse.down();
    await tablet.mouse.move(startX + 120, startY + 65, { steps: 7 });

    // The desktop receives frame-batched preview points while the pointer is
    // still down; persistence is deliberately deferred until pointerup.
    await expect(page.locator('.workspace-block-card--drawing .workspace-drawing__surface path')).toHaveCount(1);
    const beforePointerUp = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      workspaceBlocks: Array<{ kind: string; payload?: { strokes?: unknown[] } }>;
    };
    expect(beforePointerUp.workspaceBlocks.find((block) => block.kind === 'drawing')?.payload?.strokes ?? []).toHaveLength(0);

    await tablet.mouse.up();
    await expect.poll(async () => {
      const stored = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        workspaceBlocks: Array<{ kind: string; payload?: { strokes?: Array<{ points?: unknown[]; smoothing?: number; streamline?: number }> } }>;
      };
      const stroke = stored.workspaceBlocks.find((block) => block.kind === 'drawing')?.payload?.strokes?.[0];
      return { ready: (stroke?.points?.length ?? 0) > 2, smoothing: stroke?.smoothing, streamline: stroke?.streamline };
    }).toEqual({ ready: true, smoothing: 0.35, streamline: 0 });

    // Fingers scroll by default, while a pen can begin writing over a resting palm.
    await tabletSurface.dispatchEvent('pointerdown', { pointerId: 60, pointerType: 'touch', button: 0, buttons: 1, clientX: startX + 20, clientY: startY + 120 });
    await tabletSurface.dispatchEvent('pointermove', { pointerId: 60, pointerType: 'touch', button: 0, buttons: 1, clientX: startX + 90, clientY: startY + 150 });
    await tabletSurface.dispatchEvent('pointerdown', { pointerId: 62, pointerType: 'pen', button: 0, buttons: 1, clientX: startX + 170, clientY: startY + 120, pressure: 0.35 });
    await tabletSurface.dispatchEvent('pointermove', { pointerId: 62, pointerType: 'pen', button: 0, buttons: 1, clientX: startX + 210, clientY: startY + 145, pressure: 0.65 });
    await tabletSurface.dispatchEvent('pointerup', { pointerId: 62, pointerType: 'pen', button: 0, buttons: 0, clientX: startX + 210, clientY: startY + 145, pressure: 0 });
    await tabletSurface.dispatchEvent('pointerup', { pointerId: 60, pointerType: 'touch', button: 0, buttons: 0, clientX: startX + 90, clientY: startY + 150 });
    await expect(tabletSurface.locator('path')).toHaveCount(2);
    await tablet.getByRole('button', { name: '撤销' }).click();
    await expect(tabletSurface.locator('path')).toHaveCount(1);

    await tabletSurface.dispatchEvent('pointerdown', {
      pointerId: 61,
      pointerType: 'pen',
      button: 0,
      buttons: 1,
      clientX: startX + 60,
      clientY: startY + 32,
      pressure: 0.5
    });
    await tablet.waitForTimeout(540);
    await expect(tabletSurface).toHaveClass(/is-pen/);
    await tabletSurface.dispatchEvent('pointerup', {
      pointerId: 61,
      pointerType: 'pen',
      button: 0,
      buttons: 0,
      clientX: startX + 60,
      clientY: startY + 32,
      pressure: 0
    });
    await expect(tabletSurface.locator('.remote-ink-persisted path')).toHaveCount(2);
    await tablet.getByRole('button', { name: '撤销' }).click();
    await expect(tabletSurface.locator('path')).toHaveCount(1);
    await tablet.getByRole('button', { name: '重做' }).click();
    await expect(tabletSurface.locator('path')).toHaveCount(2);
    await tablet.getByRole('button', { name: '撤销' }).click();
    await expect(tabletSurface.locator('path')).toHaveCount(1);

    await tablet.getByRole('button', { name: '圈选' }).click();
    const lassoBox = await tabletSurface.boundingBox();
    expect(lassoBox).toBeTruthy();
    const lassoLeft = startX - 30;
    const lassoRight = startX + 150;
    const lassoTop = startY - 30;
    const lassoBottom = startY + 100;
    await tablet.mouse.move(lassoLeft, lassoTop);
    await tablet.mouse.down();
    await tablet.mouse.move(lassoRight, lassoTop, { steps: 4 });
    await tablet.mouse.move(lassoRight, lassoBottom, { steps: 4 });
    await tablet.mouse.move(lassoLeft, lassoBottom, { steps: 4 });
    await tablet.mouse.move(lassoLeft, lassoTop, { steps: 4 });
    await tablet.mouse.up();
    await expect(tablet.locator('.remote-canvas__selection-box')).toBeVisible();
    await tablet.locator('.remote-selection-actions').getByRole('button', { name: '发送到 AI' }).click();
    await expect(page.locator('.dock-chat-panel')).toBeVisible();
    await expect(page.locator('.composer-attachment img')).toHaveAttribute('src', /^data:image\/png;base64,/);

    await tablet.getByRole('button', { name: '显示纸张列表' }).click();
    await tablet.getByRole('button', { name: '新增纸张' }).click();
    await expect(tablet.locator('.remote-canvas__identity')).toContainText('纸张 2/2');
    await expect(tablet.locator('.remote-canvas__paper')).toHaveCount(2);
    await tablet.waitForTimeout(1100);
    await tablet.locator('.remote-canvas__viewport').evaluate((node) => {
      const second = node.querySelectorAll('.remote-sheet')[1].getBoundingClientRect();
      node.scrollTop += second.top - node.getBoundingClientRect().top - node.clientHeight / 2;
    });
    const paperPositions = await tablet.locator('.remote-canvas__paper').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const viewport = node.closest('.remote-canvas__viewport')!.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    }));
    expect(paperPositions).toEqual([true, true]);
    await expect(tablet.getByRole('button', { name: '圈选' })).toHaveAttribute('aria-pressed', 'true');
    await tablet.getByRole('button', { name: '画笔设置', exact: true }).click();
    await expect(tablet.getByRole('slider', { name: '笔刷宽度' })).toHaveValue('4');
    await tablet.locator('.remote-brush-advanced summary').click();
    await expect(tablet.getByRole('checkbox', { name: /手指书写/ })).not.toBeChecked();
    await expect(tablet.getByRole('slider', { name: '笔触平滑程度' })).toHaveValue('35');
    await tablet.getByRole('button', { name: '关闭画笔设置' }).click();
    await tablet.getByRole('button', { name: '显示纸张列表' }).click();
    await expect(tablet.locator('.remote-canvas-row')).toHaveCount(2);
    await tablet.getByRole('button', { name: '缩小纸张列表' }).click();
    await expect(tablet.locator('.remote-app')).toHaveClass(/is-sidebar-compact/);
    await expect.poll(async () => (await tablet.locator('.remote-sidebar').boundingBox())?.width ?? 999).toBeLessThan(90);
    await tablet.getByRole('button', { name: '展开纸张列表' }).click();
    await expect(tablet.locator('.remote-app')).not.toHaveClass(/is-sidebar-compact/);

    const firstSheetRow = tablet.locator('.remote-canvas-row').filter({ hasText: '纸张 1' });
    await firstSheetRow.getByRole('button', { name: '删除纸张' }).click();
    const deleteDialog = tablet.getByRole('dialog', { name: '删除这张纸？' });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole('button', { name: '删除纸张' }).click();
    await expect(tablet.locator('.remote-canvas-row')).toHaveCount(1);

    await tablet.getByRole('button', { name: '隐藏纸张列表' }).click();
    await tablet.getByRole('button', { name: '纸张选项' }).click();
    await tablet.getByTitle('把笔记窗口移到右侧').click();
    await expect.poll(async () => {
      const stored = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        workspaceBlocks: Array<{ kind: string; payload?: { side?: string } }>;
      };
      return stored.workspaceBlocks.find((block) => block.kind === 'drawing')?.payload?.side;
    }).toBe('right');
    await tablet.close();
  });

  test('renames both conversation participants and persists their transcript labels', async () => {
    const documentId = `pdf_${createHash('sha256').update(await readFile(pdfPath)).digest('hex')}`;
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_participant_names_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'codex',
          summary: { title: 'Participant names', brief: 'Editable participant name fixture.', keywords: [] },
          messages: [
            { id: 'msg_names_user', role: 'user', content: 'Question', createdAt: now },
            { id: 'msg_names_assistant', role: 'assistant', content: 'Answer', createdAt: now }
          ],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId, now });

    await page.reload();
    await page.getByRole('button', { name: 'Rename conversation participants' }).click();
    const assistantName = page.getByLabel('AI name');
    const userName = page.getByLabel('My name');
    await assistantName.fill('Atlas');
    await assistantName.press('Enter');
    await userName.fill('Lin');
    await userName.press('Enter');
    await expect(page.locator('.chat-message--assistant .chat-message__role')).toHaveText('Atlas');
    await expect(page.locator('.chat-message--user .chat-message__role')).toHaveText('Lin');
    await expect.poll(async () => {
      const saved = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        conversations: Array<{ id: string; participantNames?: { user: string; assistant: string } }>;
      };
      return saved.conversations.find((conversation) => conversation.id === 'chat_participant_names_fixture')?.participantNames;
    }).toEqual({ user: 'Lin', assistant: 'Atlas' });
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
    await expect(bubble.locator('img[alt="Generated chart"]')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => bubble.locator('img[alt="Generated chart"]').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
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
    const media = await startRemoteMediaFixture();
    const resolvedImage = await page.evaluate((url) => window.sidelight.resolveRemoteImage(url), media.pageUrl);
    expect(resolvedImage).toMatch(/^data:image\//);
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now, pageUrl }) => {
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
            content: `![Professor profile](${pageUrl})`,
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId: documentId!, now, pageUrl: media.pageUrl });

    await page.reload();
    await expect(page.locator('.chat-bubble img[alt="Professor profile"]')).toHaveAttribute('src', /^data:image\//, { timeout: 20_000 });
    await media.close();
  });

  test('previews a cited webpage when an agent says it is displaying a photo', async () => {
    const media = await startRemoteMediaFixture();
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    const documentId = store.documents[0]?.id;
    expect(documentId).toBeTruthy();
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now, pageUrl }) => {
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
            content: `This is a public professor photo from [the fixture page](${pageUrl}).`,
            createdAt: now
          }],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId: documentId!, now, pageUrl: media.pageUrl });

    await page.reload();
    await expect(page.locator('.chat-bubble img[alt="Image from linked source"]')).toHaveAttribute('src', /^data:image\//, { timeout: 20_000 });
    await media.close();
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
    await expect(page.getByRole('option').filter({ hasText: 'GPT Test Mini' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Reasoning effort' })).toBeVisible();
    await page.keyboard.press('Escape');
    const permissionButton = page.getByRole('button', { name: 'Permissions' });
    await expect(permissionButton).toContainText('PDF workspace');
    const composer = page.locator('.dock-chat-panel textarea');
    await composer.fill('/');
    await expect(page.locator('.chat-slash-menu button')).toHaveCount(5);
    await expect(page.locator('.chat-slash-menu')).toContainText('/model');
    await expect(page.locator('.chat-slash-menu')).not.toContainText('/help');
    await composer.fill('/model');
    await composer.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Current chat model' })).toBeVisible();
    await page.keyboard.press('Escape');
    await composer.fill('/model gpt-test-mini medium');
    await composer.press('Enter');
    await expect(modelButton).toContainText('GPT Test Mini');
    await expect(modelButton).toContainText('Medium');
    await expect(page.locator('.chat-command-notice')).toContainText('This conversation now uses GPT Test Mini');
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
        conversations: Array<{ id: string; codexSettings?: { permissionMode?: string; model?: string; effort?: string } }>;
      };
      return store.conversations.find((conversation) => conversation.id === 'chat_timeline_fixture')?.codexSettings;
    }).toEqual({ permissionMode: 'full-access', model: 'gpt-test-mini', effort: 'medium' });

    const composerGeometry = await page.locator('.chat-composer__row').evaluate((row) => {
      const textarea = row.querySelector('textarea')!.getBoundingClientRect();
      const buttons = [...row.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
      return {
        textareaLeft: textarea.left,
        textareaRight: textarea.right,
        textareaCenter: textarea.top + textarea.height / 2,
        buttonCenters: buttons.map((button) => button.top + button.height / 2),
        buttonLefts: buttons.map((button) => button.left)
      };
    });
    expect(composerGeometry.buttonLefts[0]).toBeLessThan(composerGeometry.textareaLeft);
    expect(composerGeometry.buttonLefts.at(-1)).toBeGreaterThanOrEqual(composerGeometry.textareaRight);
    for (const center of composerGeometry.buttonCenters) {
      expect(Math.abs(center - composerGeometry.textareaCenter)).toBeLessThanOrEqual(1.5);
    }
  });

  test('restores per-conversation Codex controls for a chat created before Codex was enabled', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    const documentId = `pdf_${createHash('sha256').update(await readFile(pdfPath)).digest('hex')}`;
    const now = new Date().toISOString();
    await page.evaluate(async ({ documentId, now }) => {
      const preferences = await window.sidelight.getAppPreferences();
      await window.sidelight.saveAppPreferences({
        ...preferences,
        experimentalCodexAgent: {
          ...preferences.experimentalCodexAgent,
          enabled: true
        }
      });
      await window.sidelight.saveConversation({
        conversation: {
          id: 'chat_codex_upgrade_fixture',
          documentId,
          pageNumber: 1,
          mode: 'ask',
          agentKind: 'default',
          summary: { title: 'Existing chat', brief: 'Created before enabling Codex.', keywords: [] },
          messages: [],
          createdAt: now,
          updatedAt: now
        }
      });
    }, { documentId, now });

    await page.reload();
    const modelButton = page.getByRole('button', { name: 'Current chat model' });
    await expect(modelButton).toBeVisible();
    await modelButton.click();
    await page.getByRole('option').filter({ hasText: 'GPT Test Mini' }).click();
    await modelButton.click();
    await page.getByRole('group', { name: 'Reasoning effort' }).getByRole('button', { name: 'Medium' }).click();

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        conversations: Array<{ id: string; agentKind?: string; codexSettings?: { model?: string; effort?: string } }>;
      };
      const conversation = store.conversations.find((candidate) => candidate.id === 'chat_codex_upgrade_fixture');
      return {
        agentKind: conversation?.agentKind,
        model: conversation?.codexSettings?.model,
        effort: conversation?.codexSettings?.effort
      };
    }).toEqual({ agentKind: 'codex', model: 'gpt-test-mini', effort: 'medium' });
  });

  test('steers an active Codex turn and persists the guidance in the same chat', async () => {
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await expect.poll(async () => {
      const requests = await readFakeCodexRequests(join(runDir, 'codex-requests.jsonl'));
      const appServerIndex = requests.findIndex((request) => request.includes('app-server'));
      const loginIndex = requests.findIndex((request) => request[0] === 'login' && request[1] === 'status');
      return { appServerIndex, loginIndex };
    }).toEqual({ appServerIndex: 0, loginIndex: -1 });
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
    const translationPanel = page.locator('.transient-aid-panel');
    await expect(translationPanel).toContainText('Translated quickly.');
    const headerAlignment = await translationPanel.locator('> header').evaluate((header) => {
      const title = header.querySelector('.transient-aid-panel__title')?.getBoundingClientRect();
      const closeButton = header.querySelector('.panel-close-button')?.getBoundingClientRect();
      if (!title || !closeButton) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(title.top + title.height / 2 - (closeButton.top + closeButton.height / 2));
    });
    expect(headerAlignment).toBeLessThan(2);
    await translationPanel.getByTitle('Pin to learning space').click();
    await expect(page.locator('.workspace-block-card--translation')).toBeVisible();

    await expect.poll(async () => {
      const requests = await readFakeCodexRequests(join(runDir, 'codex-requests.jsonl'));
      const request = requests.find((request) => request[0] === 'turn/start');
      return request ? JSON.parse(request[1]).model : undefined;
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
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
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
    const settingsPage = await openSettingsWindow(app, page);
    const settings = settingsPage.locator('.reader-settings');
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

  test('uses and persists an explicit Codex executable path', async () => {
    const settingsPage = await openSettingsWindow(app, page);
    const settings = settingsPage.locator('.reader-settings');
    await settings.getByRole('button', { name: 'Codex' }).click();
    const configuredPath = process.platform === 'win32'
      ? join(runDir, 'bin', 'codex.ps1')
      : join(runDir, 'bin', 'codex');
    await settings.getByLabel('Codex executable path (optional)').fill(configuredPath);
    await expect(settings.getByLabel('Enabled')).toBeEnabled();
    await settings.getByLabel('Enabled').check();
    await settings.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        appPreferences?: { experimentalCodexAgent?: { executablePath?: string } };
      };
      return store.appPreferences?.experimentalCodexAgent?.executablePath;
    }).toBe(configuredPath);
  });

  test('persists granular reader typography and keeps the chat composer aligned', async () => {
    const settingsPage = await openSettingsWindow(app, page);
    const settings = settingsPage.locator('.reader-settings');
    await settings.getByRole('button', { name: 'Appearance' }).click();
    await settings.getByLabel('Chat').evaluate((input) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '#b8d6ec');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settings.getByLabel('Interface font').selectOption('rounded');
    await settings.getByLabel('Interface size').fill('16');
    await settings.getByLabel('Sidebar size').fill('13');
    await settings.getByLabel('Agent font').selectOption('serif');
    await settings.getByLabel('Response size').fill('15');
    await settings.getByLabel('Composer size').fill('17');
    await settings.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => {
      const store = JSON.parse(await readFile(join(userDataDir, 'workspace/library.json'), 'utf8')) as {
        appPreferences?: { selectionColors?: { chat?: string }; appearance?: { uiFont?: string; uiFontSize?: number; sidebarFontSize?: number; agentFont?: string; agentFontSize?: number; composerFontSize?: number } };
      };
      return store.appPreferences;
    }).toMatchObject({
      selectionColors: { chat: '#b8d6ec' },
      appearance: { uiFont: 'rounded', uiFontSize: 16, sidebarFontSize: 13, agentFont: 'serif', agentFontSize: 15, composerFontSize: 17 }
    });

    await selectPdfText(page);
    await page.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    const composer = page.locator('.chat-composer textarea');
    await expect(composer).toBeVisible();
    await expect(composer).toHaveCSS('font-family', /Iowan|Charter|Georgia|serif/);
    await expect(composer).toHaveCSS('font-size', '17px');
    expect(await composer.evaluate((textarea) => textarea.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
    const composerGeometry = await page.locator('.chat-composer__row').evaluate((row) => {
      const textareaElement = row.querySelector('textarea')!;
      const textarea = textareaElement.getBoundingClientRect();
      const textareaStyle = getComputedStyle(textareaElement);
      const lineHeight = Number.parseFloat(textareaStyle.lineHeight);
      const placeholderCenterY = textarea.top + Number.parseFloat(textareaStyle.paddingTop) + lineHeight / 2;
      const buttons = Array.from(row.querySelectorAll<HTMLElement>('.p-button')).map((button) => button.getBoundingClientRect());
      return {
        textarea: { left: textarea.left, right: textarea.right, centerY: textarea.top + textarea.height / 2 },
        placeholderCenterY,
        buttons: buttons.map((button) => ({ left: button.left, right: button.right, centerY: button.top + button.height / 2 }))
      };
    });
    expect(composerGeometry.buttons).toHaveLength(2);
    expect(composerGeometry.buttons[0].right).toBeLessThan(composerGeometry.textarea.left);
    expect(composerGeometry.textarea.right).toBeLessThan(composerGeometry.buttons[1].left);
    expect(Math.abs(composerGeometry.buttons[0].centerY - composerGeometry.textarea.centerY)).toBeLessThan(2);
    expect(Math.abs(composerGeometry.buttons[1].centerY - composerGeometry.textarea.centerY)).toBeLessThan(2);
    expect(Math.abs(composerGeometry.buttons[0].centerY - composerGeometry.placeholderCenterY)).toBeLessThan(2);
  });

  test('holds Space to pan the PDF canvas without triggering page navigation', async () => {
    const viewport = page.locator('.pdf-viewport');
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    const before = await viewport.evaluate((element) => {
      element.scrollLeft = Math.min(180, Math.max(0, element.scrollWidth - element.clientWidth));
      element.scrollTop = Math.min(180, Math.max(0, element.scrollHeight - element.clientHeight));
      return { left: element.scrollLeft, top: element.scrollTop };
    });
    await viewport.focus();
    await page.keyboard.down('Space');
    await expect(viewport).toHaveClass(/is-canvas-drag-mode/);

    const box = await viewport.boundingBox();
    if (!box) {
      throw new Error('PDF viewport is not visible.');
    }
    await page.mouse.move(box.x + 70, box.y + 110);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 155, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await expect(viewport).not.toHaveClass(/is-canvas-drag-mode/);

    const after = await viewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
    expect(after.left !== before.left || after.top !== before.top).toBe(true);
  });

  test('rerenders vector PDF content when zooming without breaking text selection', async () => {
    const pageView = page.locator('.pdfViewer .page[data-page-number="1"]');
    const textLayer = pageView.locator('.textLayer');
    const canvas = pageView.locator('canvas').first();
    await expect(textLayer).toContainText('Reader fixture quote Alpha Beta');

    const before = await canvas.evaluate((element) => ({
      width: element.width,
      cssWidth: element.getBoundingClientRect().width
    }));

    await page.getByTitle('Zoom in').click();
    await page.getByTitle('Zoom in').click();
    await expect.poll(() => canvas.evaluate((element) => element.width)).toBeGreaterThan(before.width);

    const after = await canvas.evaluate((element) => ({
      width: element.width,
      cssWidth: element.getBoundingClientRect().width,
      devicePixelRatio: window.devicePixelRatio
    }));
    expect(after.cssWidth).toBeGreaterThan(before.cssWidth);
    expect(after.width / after.cssWidth).toBeGreaterThanOrEqual(after.devicePixelRatio * 0.9);

    // Canvas and text layers complete independently. Wait until the text layer
    // has stopped replacing spans before exercising the real selection flow.
    await textLayer.evaluate((element) => new Promise<void>((resolve) => {
      let quietTimer = window.setTimeout(done, 100);
      const observer = new MutationObserver(() => {
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(done, 100);
      });
      function done(): void {
        observer.disconnect();
        resolve();
      }
      observer.observe(element, { childList: true, subtree: true });
    }));
    await expect(textLayer.locator('span').first()).toBeVisible();
    await selectPdfText(page);
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    await expect(page.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Reader fixture');
  });

  test('keeps a very small PDF in the reading column instead of drifting into the dock', async () => {
    const pageView = page.locator('.pdfViewer .page[data-page-number="1"]');
    const viewport = page.locator('.pdf-viewport');
    const dock = page.locator('.reader-dock-lane');
    await expect(pageView.locator('.textLayer')).toContainText('Reader fixture quote Alpha Beta');

    const zoomOut = page.getByTitle('Zoom out');
    for (let index = 0; index < 20; index += 1) {
      await zoomOut.click();
    }
    await expect(page.locator('.zoom-readout')).toHaveText('25%');

    const geometry = await Promise.all([
      pageView.boundingBox(),
      viewport.boundingBox(),
      dock.boundingBox()
    ]);
    const [pageBox, viewportBox, dockBox] = geometry;
    expect(pageBox).toBeTruthy();
    expect(viewportBox).toBeTruthy();
    expect(dockBox).toBeTruthy();
    expect(pageBox!.x).toBeGreaterThanOrEqual(viewportBox!.x);
    expect(pageBox!.x + pageBox!.width).toBeLessThan(dockBox!.x);
    expect(dockBox!.x - viewportBox!.x).toBeGreaterThan(viewportBox!.width * 0.5);
  });

  test('gives Codex outline generation sampled PDF page evidence', async () => {
    await enableCodexReader(page);
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Reader fixture quote Alpha Beta');
    await page.getByRole('button', { name: 'AI-generate PDF outline' }).click();
    const progress = page.getByRole('progressbar', { name: /PDF context|Starting AI|representative pages|outline/i });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', /[1-9][0-9]?/);
    await expect(page.locator('.outline-item').filter({ hasText: 'Fixture introduction' })).toBeVisible();

    await expect.poll(async () => {
      const requests = await readFakeCodexRequests(join(runDir, 'codex-requests.jsonl'));
      const args = requests.find((request) => request[0] === 'turn/start');
      const prompt = args?.[1] ?? '';
      return prompt.includes('pageSamples') && prompt.includes('Reader fixture quote Alpha Beta');
    }).toBe(true);
  });
});

async function readReaderLayout(page: Page): Promise<{
  contained: boolean;
  left: number;
  ordered: boolean;
  width: number;
}> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.left-panel');
    const rowSelectors = [
      '.left-panel__top',
      '.panel-search',
      '.reader-controls',
      '.canvas-placement-menu',
      '.panel-breadcrumb',
      '.left-panel__body'
    ];
    if (!panel) {
      return { contained: false, left: 0, ordered: false, width: 0 };
    }
    const panelRect = panel.getBoundingClientRect();
    const rows = rowSelectors.flatMap((selector) => {
      const row = panel.querySelector<HTMLElement>(selector);
      return row ? [row.getBoundingClientRect()] : [];
    });
    return {
      contained: rows.length === rowSelectors.length && rows.every((row) => (
        row.left >= panelRect.left - 1 &&
        row.right <= panelRect.right + 1 &&
        row.top >= panelRect.top - 1 &&
        row.bottom <= panelRect.bottom + 1
      )),
      left: panelRect.left,
      ordered: rows.length === rowSelectors.length && rows.every((row, index) => (
        index === 0 || rows[index - 1].bottom <= row.top + 1
      )),
      width: panelRect.width
    };
  });
}

async function readPdfViewportAnchor(
  page: Page,
  point?: { clientX: number; clientY: number }
): Promise<{
  clientX: number;
  clientY: number;
  pageNumber?: string;
  xRatio: number;
  yRatio: number;
}> {
  return page.evaluate((requestedPoint) => {
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
    const pageElement = document.querySelector<HTMLElement>('.pdfViewer .page[data-page-number="1"]');
    if (!viewport || !pageElement) {
      return { clientX: 0, clientY: 0, pageNumber: undefined, xRatio: Number.NaN, yRatio: Number.NaN };
    }
    const viewportRect = viewport.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const defaultX = viewportRect.left + viewportRect.width / 2;
    const defaultY = viewportRect.top + viewportRect.height / 2;
    const clientX = requestedPoint?.clientX ?? (
      defaultX >= pageRect.left && defaultX <= pageRect.right
        ? defaultX
        : (Math.max(pageRect.left, viewportRect.left) + Math.min(pageRect.right, viewportRect.right)) / 2
    );
    const clientY = requestedPoint?.clientY ?? (
      defaultY >= pageRect.top && defaultY <= pageRect.bottom
        ? defaultY
        : (Math.max(pageRect.top, viewportRect.top) + Math.min(pageRect.bottom, viewportRect.bottom)) / 2
    );
    return {
      clientX,
      clientY,
      pageNumber: pageElement.dataset.pageNumber,
      xRatio: (clientX - pageRect.left) / pageRect.width,
      yRatio: (clientY - pageRect.top) / pageRect.height
    };
  }, point);
}

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
  const script = `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
const logRequest = (request) => {
  if (process.env.FAKE_CODEX_LOG) {
    require('node:fs').appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(request) + '\\n');
  }
};
if (args[0] !== 'exec') logRequest(args);
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
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => {
    logRequest(args.at(-1) === '-' ? [...args.slice(0, -1), prompt] : args);
    if (args.includes('--ephemeral')) {
      const text = prompt.includes('"pageSamples"')
        ? '{"items":[{"title":"Fixture introduction","level":0,"pageNumber":1}]}'
        : 'Translated quickly.';
      setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_utility_answer', type: 'agent_message', text } }), 25);
      setTimeout(() => sendExec({ type: 'turn.completed' }), 45);
    } else if (resumed) {
      setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_answer_2', type: 'agent_message', text: 'Guided exec result.' } }), 25);
      setTimeout(() => sendExec({ type: 'turn.completed' }), 45);
    } else {
      setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_answer_1', type: 'agent_message', text: 'First exec segment.' } }), 30);
      setTimeout(() => sendExec({ type: 'item.started', item: { id: 'exec_command_1', type: 'command_execution' } }), 6000);
      setTimeout(() => sendExec({ type: 'item.completed', item: { id: 'exec_command_1', type: 'command_execution' } }), 6200);
    }
  });
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
  if (message.method) logRequest([message.method, JSON.stringify(message.params)]);
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
  } else if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_steer_fixture' } } });
  } else if (message.method === 'turn/start') {
    const text = message.params.input.find((item) => item.type === 'text')?.text || '';
    if (message.params.model === 'gpt-test-mini' || text.includes('"pageSamples"')) {
      send({ id: message.id, result: { turn: { id: 'turn_steer_fixture' } } });
      const answer = text.includes('"pageSamples"') ? '{"items":[{"title":"Fixture introduction","level":0,"pageNumber":1}]}' : 'Translated quickly.';
      later(35, () => send({ method: 'item/agentMessage/delta', params: { threadId: 'thread_steer_fixture', itemId: 'utility', delta: answer } }));
      later(55, () => send({ method: 'turn/completed', params: { threadId: 'thread_steer_fixture', turn: { id: 'turn_steer_fixture', status: 'completed' } } }));
      return;
    }
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
`;
  if (process.platform === 'win32') {
    await writeFile(join(binDirectory, 'codex-fake.cjs'), script, 'utf8');
    await writeFile(join(binDirectory, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-fake.cjs" %*\r\n', 'utf8');
    await writeFile(join(binDirectory, 'codex.ps1'), '# This fixture resolves through the sibling codex.cmd launcher.\r\n', 'utf8');
    return;
  }
  await writeFile(executable, script, 'utf8');
  await chmod(executable, 0o755);
}

async function openSettingsWindow(app: ElectronApplication, opener: Page): Promise<Page> {
  const settingsWindowPromise = app.waitForEvent('window');
  await opener.getByTitle('Settings').click();
  const settingsPage = await settingsWindowPromise;
  await expect(settingsPage.locator('.reader-settings--window')).toBeVisible();
  await expect(opener.locator('.reader-settings')).toHaveCount(0);
  return settingsPage;
}

async function startRemoteMediaFixture(): Promise<{ pageUrl: string; close(): Promise<void> }> {
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  let baseUrl = '';
  const server = createServer((request, response) => {
    if (request.url === '/photo.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length });
      response.end(image);
      return;
    }
    const html = `<html><head><meta property="og:image" content="${baseUrl}/photo.png"></head><body>Profile</body></html>`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start the remote media fixture.');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    pageUrl: `${baseUrl}/profile`,
    close: async () => {
      server.close();
      await once(server, 'close');
    }
  };
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
