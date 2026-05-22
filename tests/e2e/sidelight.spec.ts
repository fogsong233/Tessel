import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const rootDir = resolve(__dirname, '../..');
const mainEntry = join(rootDir, 'out/main/index.js');

test.describe('Sidelight Electron reading flow', () => {
  let userDataDir: string;
  let pdfPath: string;
  let imagePath: string;
  let app: ElectronApplication;

  test.beforeEach(async ({}, testInfo) => {
    const runDir = testInfo.outputPath(randomUUID());
    userDataDir = join(runDir, 'user-data');
    pdfPath = join(runDir, 'fixture.pdf');
    imagePath = join(runDir, 'fixture.png');
    await mkdir(userDataDir, { recursive: true });
    await createFixturePdf(pdfPath);
    await createFixturePng(imagePath);

    app = await electron.launch({
      args: shouldOpenPdfFromLaunchArgs(testInfo) ? [mainEntry, pdfPath] : [mainEntry],
      cwd: rootDir,
      env: launchEnv(userDataDir, pdfPath, shouldOpenPdfFromLaunchArgs(testInfo))
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
    await expect(reader.getByText('Opened temporarily, not in library')).toBeVisible();
    await reader.getByRole('button', { name: 'Add to library' }).click();
    await expect(reader.getByText('Opened temporarily, not in library')).toHaveCount(0);
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await expect(reader.locator('.pdfViewer .page canvas').first()).toBeVisible();
    await expect
      .poll(async () => reader.locator('.pdfViewer .page canvas').first().evaluate((canvas) => {
        const element = canvas as HTMLCanvasElement;
        return element.width > 0 && element.height > 0;
      }))
      .toBe(true);
    await expect.poll(async () => readerControlOverflowSnapshot(reader)).toMatchObject({
      controlsOverflow: false,
      pageControlOverflow: false,
      separatorVisible: true,
      zoomControlOverflow: false
    });

    await reader.getByTitle('Hide sidebar').click();
    await expect(reader.locator('.reader-splitter')).toHaveClass(/is-left-collapsed/);
    await expect(reader.getByTitle('Show sidebar')).toBeVisible();
    await expect(reader.locator('.floating-reader-controls')).toHaveCount(0);
    await expect.poll(async () => pdfPageLeftGutter(reader)).toBeGreaterThan(20);
    const ignoredBlankZoomWidth = await firstPageWidth(reader);
    const blankZoomPoint = await viewportBlankZoomPoint(reader);
    await reader.locator('.pdf-viewport').dispatchEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: blankZoomPoint.clientX,
      clientY: blankZoomPoint.clientY,
      ctrlKey: true,
      deltaY: -400
    });
    await reader.waitForTimeout(120);
    expect(Math.abs((await firstPageWidth(reader)) - ignoredBlankZoomWidth)).toBeLessThan(1);
    const pageWidthBefore = await firstPageWidth(reader);
    const zoomAnchor = await firstPageZoomAnchor(reader);
    await reader.locator('.pdf-viewport').dispatchEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: zoomAnchor.clientX,
      clientY: zoomAnchor.clientY,
      ctrlKey: true,
      deltaY: -400
    });
    await expect.poll(async () => firstPageWidth(reader)).toBeGreaterThan(pageWidthBefore);
    await expect
      .poll(async () => firstPageAnchorDrift(reader, zoomAnchor))
      .toBeLessThan(0.04);
    await expect
      .poll(async () => viewportHorizontalScrollInfo(reader))
      .toMatchObject({ canScroll: true });
    const postZoomHorizontalDrift = await zoomThenNudgeHorizontalScroll(reader, await firstPageZoomAnchor(reader));
    expect(postZoomHorizontalDrift).toBeLessThan(2);
    await expect.poll(async () => pdfPageToDockGap(reader)).toBeLessThan(90);
    await reader.locator('.pdf-viewport').evaluate((element) => {
      (element as HTMLElement).scrollLeft = 0;
    });
    await expect.poll(async () => pdfPageLeftGutter(reader)).toBeGreaterThan(20);
    const horizontalScroll = await reader.locator('.pdf-viewport').evaluate((element) => {
      const viewport = element as HTMLElement;
      viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
      return viewport.scrollLeft;
    });
    expect(horizontalScroll).toBeGreaterThan(0);
    await assertDockPinsVerticallyAndMovesHorizontally(reader);
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');

    await reader.getByTitle('Show sidebar').click();
    await expect(reader.locator('.reader-splitter')).not.toHaveClass(/is-left-collapsed/);
    await expect(reader.getByRole('button', { name: 'Outline', exact: true })).toBeVisible();

    const pageInput = reader.locator('.page-control .p-inputtext');
    await pageInput.fill('2');
    await expect(pageInput).toHaveValue('2');
    await pageInput.press('Enter');
    await expect(reader.locator('.pdfViewer .page[data-page-number="2"]')).toBeVisible();
    await expect.poll(async () => persistedReadingState(userDataDir)).toMatchObject({ lastPage: 2 });
    await expect.poll(async () => pageControlValue(reader)).toBe(2);
    const pageTwoWidthBefore = await pdfPageWidth(reader, 2);
    const pageTwoZoomAnchor = await pdfPageZoomAnchor(reader, 2);
    await reader.locator('.pdf-viewport').dispatchEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: pageTwoZoomAnchor.clientX,
      clientY: pageTwoZoomAnchor.clientY,
      ctrlKey: true,
      deltaY: -400
    });
    await expect.poll(async () => pdfPageWidth(reader, 2)).toBeGreaterThan(pageTwoWidthBefore);
    await expect.poll(async () => persistedReadingState(userDataDir)).toMatchObject({ lastPage: 2 });
    await revealDockMoveButton(reader);
    const dockBeforeDragOffset = await dockOffset(reader);
    await dragDockMoveButton(reader, -150, 42);
    const dockAfterDragOffset = await dockOffset(reader);
    expect(dockAfterDragOffset.x).toBeLessThan(dockBeforeDragOffset.x - 80);
    expect(dockAfterDragOffset.y).toBeGreaterThan(dockBeforeDragOffset.y + 20);
    await reader.close();
    await library.bringToFront();
    const fixtureRow = library.locator('.library-row').filter({ hasText: 'fixture.pdf' });
    await expect(fixtureRow).toContainText('Page 2');
    await library.getByRole('button', { name: 'Cover grid' }).click();
    const fixtureCover = library.locator('.library-cover-card').filter({ hasText: 'fixture.pdf' });
    await expect(fixtureCover).toContainText('Page 2');
    await expect.poll(async () => libraryCoverGridSnapshot(library)).toMatchObject({
      cardCount: 1,
      cardOverflow: false,
      gridOverflowX: false
    });
    await library.getByRole('button', { name: 'List view' }).click();
    await expect(fixtureRow).toContainText('Page 2');

    await library.locator('.library-home__new-group input').fill('Research');
    await library.locator('.library-home__new-group button').click();
    await library.getByRole('button', { name: 'Hold this group' }).click();
    await library.locator('.library-filterbar').getByRole('button', { name: 'All documents' }).click();
    await library.getByLabel('Group: fixture').selectOption({ label: 'Research' });
    await expect.poll(async () => persistedStore(userDataDir)).toMatchObject({
      libraryGroups: [
        expect.objectContaining({
          name: 'Research',
          cloudHeld: true
        })
      ],
      documents: [
        expect.objectContaining({
          fileName: 'fixture.pdf',
          inLibrary: true,
          groupIds: [expect.any(String)]
        })
      ]
    });
    await expect.poll(async () => persistedSyncManifest(userDataDir)).toMatchObject({
      documents: [
        expect.objectContaining({
          fileName: 'fixture.pdf',
          inLibrary: true,
          cloudHeld: true,
          pdfPath: expect.stringMatching(/^pdfs\/.+\.pdf$/)
        })
      ]
    });

    const secondReaderPromise = waitForNextWindow(app);
    await fixtureRow.getByRole('button', { name: /fixture/i }).click();
    const secondReader = await secondReaderPromise;
    await attachDiagnostics(secondReader);
    await expect(secondReader.locator('.pdfViewer .page[data-page-number="2"]')).toBeVisible();
    await expect(secondReader.locator('.pdfViewer .page[data-page-number="2"] .textLayer')).toContainText('Second page remembers its own reading state');
  });

  test('opens a PDF path passed by the operating system launch arguments', async () => {
    const reader = await waitForReaderWindow(app);
    await attachDiagnostics(reader);
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await expect(reader.getByText('Opened temporarily, not in library')).toBeVisible();
    await expect.poll(async () => persistedStore(userDataDir).then((store) => (store.documents as unknown[] | undefined)?.length ?? 0)).toBe(1);
  });

  test('saves centered settings sections, fetches models, and stores GitHub upload target', async () => {
    const provider = await startModelListProvider();
    const library = await app.firstWindow();
    await attachDiagnostics(library);

    try {
      await expect(library.getByRole('heading', { name: 'Library' })).toBeVisible();
      await library.getByTitle('Settings').click();

      const settings = library.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible();
      await expect(settings.locator('#settings-ai')).toContainText('AI Provider');
      await expect(settings.locator('#settings-language')).toContainText('AI preferred language');
      await expect(settings.locator('#settings-github')).toContainText('GitHub Upload');
      await expect(settings.getByRole('button', { name: 'Sync now' })).toBeDisabled();
      await expect(settings.getByRole('button', { name: 'Upload now' })).toBeDisabled();
      await expect
        .poll(async () => centeredDialogDelta(library, '.floating-settings'))
        .toBeLessThan(4);

      await settings.getByLabel('Base URL').fill(provider.url);
      await settings.getByLabel('API key').fill('model-list-key');
      await settings.getByRole('button', { name: 'Fetch models' }).click();
      await expect(settings.getByLabel('Available models')).toContainText('sidelight-large');
      await settings.getByLabel('Available models').selectOption('sidelight-large');
      await settings.getByLabel('Owner').fill('kacent');
      await settings.getByLabel('Repo').fill('notetaker-data');
      await settings.getByLabel('Branch').fill('main');
      await settings.getByLabel('Path').fill('/uploads/sidelight/');
      await settings.getByLabel('Token').fill('github_pat_secret_for_test');
      await settings.getByLabel('Enabled').check();
      await expect(settings.getByRole('button', { name: 'Sync now' })).toBeEnabled();
      await expect(settings.getByRole('button', { name: 'Upload now' })).toBeEnabled();
      await settings.getByLabel('AI preferred language').selectOption('English');
      await setColorInput(settings.getByLabel('Note selection'), '#f6dda0');
      await settings.getByLabel('UI language').selectOption('zh-CN');
      await library.locator('.floating-settings button[type="submit"]').click();
      await expect(settings).toHaveCount(0);

      await expect.poll(async () => persistedAiProvider(userDataDir)).toMatchObject({
        baseUrl: provider.url,
        model: 'sidelight-large'
      });
      await expect.poll(async () => persistedGitHubUpload(userDataDir)).toMatchObject({
        enabled: true,
        owner: 'kacent',
        repo: 'notetaker-data',
        branch: 'main',
        basePath: 'uploads/sidelight'
      });
      await expect.poll(async () => persistedAppPreferences(userDataDir)).toMatchObject({
        uiLanguage: 'zh-CN',
        aiLanguage: 'English',
        selectionColors: expect.objectContaining({
          note: '#f6dda0'
        })
      });
      const persisted = JSON.stringify(await persistedStore(userDataDir));
      expect(persisted).not.toContain('github_pat_secret_for_test');
      expect(persisted).not.toContain('model-list-key');
    } finally {
      await closeServer(provider.server);
    }
  });

  test('recovers a malformed workspace store before opening a PDF', async () => {
    const library = await app.firstWindow();
    await attachDiagnostics(library);
    await expect(library.getByRole('heading', { name: 'Library' })).toBeVisible();
    await expect(library.getByText(/Local draft mode|AI ready/)).toBeVisible();
    await expect.poll(async () => persistedStore(userDataDir)).toMatchObject({
      aiProvider: expect.any(Object),
      githubUpload: expect.any(Object)
    });

    const storePath = join(userDataDir, 'workspace/library.json');
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, '{"documents": [');

    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await expect.poll(async () => corruptStoreBackupCount(userDataDir)).toBeGreaterThan(0);
  });

  test('keeps summary and translation temporary while chat is persisted', async () => {
    test.setTimeout(120_000);

    const library = await app.firstWindow();
    await attachDiagnostics(library);
    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    const initialPageWidth = await firstPageWidth(reader);

    await selectFirstPdfText(reader);
    await expect.poll(async () => selectionToolbarDesignSnapshot(reader)).toMatchObject({
      actionBackgroundTransparent: true,
      actionBorderless: true,
      flexDirection: 'column',
      iconCircular: true
    });
    await expect(reader.locator('.selection-toolbar').getByRole('button', { name: /^Quote$/i })).toHaveCount(0);
    await reader.getByRole('button', { name: /Summary/i }).click();
    await expect(reader.locator('.transient-aid-panel')).toBeVisible();
    await expect(reader.locator('.transient-aid-panel')).toContainText('Summary');
    await expect(reader.locator('.transient-aid-panel')).toContainText('local draft');
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - initialPageWidth)).toBeLessThan(1);
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
    const widthBeforeChat = await firstPageWidth(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();
    await expect(reader.locator('.pdf-mark-visual[data-color-role="chat"]').first()).toBeVisible();
    await expect(reader.locator('.pdf-mark-hit')).toHaveCount(0);
    await expect.poll(async () => pdfMarkVisualSnapshot(reader, 'chat')).toMatchObject({
      boxShadow: 'none',
      hasPaint: true,
      layerOpacity: '0.48',
      mixBlendMode: 'normal',
      opacity: '1',
      visualZIndex: '5'
    });
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - widthBeforeChat)).toBeLessThan(1);
    await expectPanelInsideDock(reader, '.dock-chat-panel');
    await expectPdfPageBeforeDock(reader);
    await expect.poll(async () => dockRightEdgeDelta(reader)).toBeLessThan(2);
    await expect.poll(async () => dockChromeGap(reader)).toBeGreaterThanOrEqual(10);
    await expect.poll(async () => dockChromeGap(reader)).toBeLessThanOrEqual(18);
    await expect.poll(async () => headerActionCenterDelta(reader, '.dock-chat-panel')).toBeLessThan(1.5);

    await selectFirstPdfText(reader);
    await expect(reader.locator('.selection-toolbar').getByRole('button', { name: /^Quote$/i })).toBeVisible();
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Quote$/i }).click();
    await expect(reader.locator('.dock-chat-panel .chat-message--user').filter({ hasText: /Quoted p\.1|引用 p\.1/ })).toContainText(
      'Sidelight integration passage Alpha Beta'
    );
    await expect(reader.locator('.dock-chat-panel')).toContainText('local draft');
    await expect(reader.locator('.dock-chat-panel .typing-dot')).toHaveCount(0);

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /Underline/i }).click();
    await expect(reader.locator('.pdf-mark-visual--underline').first()).toBeVisible();
    await expect.poll(async () => pdfUnderlineSnapshot(reader)).toMatchObject({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderBottomStyle: 'none',
      hasDashedPaint: true,
      height: '1.5px',
      layerOpacity: '1',
      layerZIndex: '6',
      transform: 'matrix(1, 0, 0, 1, 0, 2.5)'
    });

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /Highlight/i }).click();
    await expect(reader.locator('.pdf-mark-visual[data-color-role="highlight"]').first()).toBeVisible();
    await expect.poll(async () => markCenterTopElement(reader, 'highlight')).not.toContain('pdf-mark-hit');
    await reader.locator('.dock-iconbar').getByRole('button', { name: 'Highlights' }).click();
    await clickMarkVisualCenter(reader, 'highlight');
    await expect(reader.locator('.mark-popover')).toBeVisible();
    await expect.poll(async () => markPopoverDesignSnapshot(reader)).toMatchObject({
      actionsDisplay: 'flex',
      actionFontSize: '0px',
      borderRadius: '10px',
      quoteUserSelect: 'text'
    });
    await reader.locator('.mark-popover').getByTitle('Close').click();
    await reader.locator('.dock-iconbar').getByRole('button', { name: 'Chats' }).click();

    await selectFirstPdfText(reader);
    const widthBeforeForegroundTranslate = await firstPageWidth(reader);
    await reader.getByRole('button', { name: /Translate/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toHaveCount(0);
    await expect(reader.locator('.transient-aid-panel')).toBeVisible();
    await expect(reader.locator('.transient-aid-panel')).toContainText('Translation');
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - widthBeforeForegroundTranslate)).toBeLessThan(1);
    await reader.locator('.transient-aid-panel').getByTitle('Close').click();
    await expect(reader.locator('.transient-aid-panel')).toHaveCount(0);
    await reader.locator('.trace-card').first().click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();

    await reader.locator('.dock-iconbar').getByRole('button', { name: 'Notes' }).click();
    await expect(reader.locator('.dock-chat-panel')).toHaveCount(0);
    await expect(reader.locator('.notes-panel')).toBeVisible();
    await expect(reader.locator('.dock-iconbar').getByRole('button', { name: 'Notes' })).toHaveClass(/is-active/);
    await expect(reader.locator('.dock-iconbar').getByRole('button', { name: 'Chats' })).not.toHaveClass(/is-active/);
    await reader.locator('.dock-iconbar').getByRole('button', { name: 'Chats' }).click();
    await expect(reader.locator('.trace-card').first()).toBeVisible();
    await expect(reader.locator('.dock-iconbar').getByRole('button', { name: 'Chats' })).toHaveClass(/is-active/);
    await expect(reader.locator('.dock-iconbar__actions').getByRole('button', { name: 'New page chat' })).toHaveAttribute('aria-label', 'New page chat');
    await expect.poll(async () => dockListDesignSnapshot(reader)).toMatchObject({
      cardShadow: 'none',
      cardTransform: 'none',
      cardWithinList: true,
      listOverflow: 'visible',
      searchInputMinWidth: '0px'
    });
    await expect.poll(async () => (await dockListDesignSnapshot(reader)).cardRightInset).toBeGreaterThan(3);
    await reader.locator('.trace-card').first().click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();
    const chatScrollTopBeforePin = await setViewportScrollTop(reader, 96);
    await reader.getByRole('button', { name: 'Pin to learning space' }).click();
    await expect(reader.locator('.workspace-block-card')).toBeVisible();
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toHaveLength(1);
    await expect.poll(async () => workspaceBlockVisibilitySnapshot(reader)).toMatchObject({
      coveredByDock: false,
      visibleInViewport: true
    });
    await expect.poll(async () => workspaceBlockPdfSideSnapshot(reader)).toMatchObject({
      isLeftOfPdf: true,
      animationName: expect.stringContaining('workspace-block-pop')
    });
    await expect.poll(async () => viewportScrollTop(reader)).toBeGreaterThanOrEqual(0);
    await revealWorkspaceBlock(reader);
    const blockAnchorBeforeZoom = await workspaceBlockPageAnchorSnapshot(reader);
    await zoomInOnFirstPage(reader);
    await expect.poll(async () => workspaceBlockPageAnchorDrift(reader, blockAnchorBeforeZoom)).toBeLessThan(0.035);
    await revealWorkspaceBlock(reader);
    const blockBeforeMove = await workspaceBlockSnapshot(reader);
    expect(blockBeforeMove.contentOverflow).toBe(false);
    await dragWorkspaceBlock(reader, 36, 28);
    await expect.poll(async () => (await workspaceBlockSnapshot(reader)).canvasLeft).toBeGreaterThan(blockBeforeMove.canvasLeft + 20);
    await expect.poll(async () => (await workspaceBlockSnapshot(reader)).canvasTop).toBeGreaterThan(blockBeforeMove.canvasTop + 12);
    const blockAfterMove = await workspaceBlockSnapshot(reader);
    expect(blockAfterMove.contentOverflow).toBe(false);
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual([
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number)
      })
    ]);
    expect((await persistedWorkspaceBlocks(userDataDir))[0].x).toBeLessThan(0);
    const blockBeforeResize = await workspaceBlockSnapshot(reader);
    await resizeWorkspaceBlock(reader, 58);
    await expect.poll(async () => (await workspaceBlockSnapshot(reader)).width).toBeGreaterThan(blockBeforeResize.width + 32);
    const blockAfterResize = await workspaceBlockSnapshot(reader);
    expect(blockAfterResize.contentOverflow).toBe(false);
    expect((await persistedWorkspaceBlocks(userDataDir))[0].width).toBeGreaterThan(blockBeforeResize.width + 32);
    const handleShape = await dockResizeHandleShape(reader);
    expect(Math.abs(handleShape.centerOffset)).toBeLessThan(2);
    expect(handleShape.handleHeight).toBeLessThanOrEqual(130);
    expect(handleShape.visualHeight).toBeLessThanOrEqual(90);
    expect(handleShape.handleGap).toBeGreaterThanOrEqual(4);
    expect(handleShape.visualGap).toBeGreaterThanOrEqual(12);
    await expect.poll(async () => dockLaneWidth(reader)).toBeGreaterThan(300);
    await expect.poll(async () => composerHeight(reader)).toBeLessThan(110);
    await reader.locator('.dock-chat-panel input[type="file"]').setInputFiles(imagePath);
    await expect(reader.locator('.composer-attachments img')).toHaveCount(1);
    const composer = reader.getByPlaceholder('Message Sidelight');
    const userMessageCountBeforeImeEnter = await reader.locator('.chat-message--user').count();
    await composer.fill('拼音');
    await dispatchComposerComposition(reader, 'compositionstart', 'pin');
    await composer.press('Enter');
    await expect(reader.locator('.chat-message--user')).toHaveCount(userMessageCountBeforeImeEnter);
    await dispatchComposerComposition(reader, 'compositionend', '拼音');
    await composer.fill('你好');
    await composer.press('Enter');
    await expect(reader.locator('.chat-attachments img')).toHaveCount(1);
    await reader.locator('.chat-attachment').first().getByRole('button', { name: 'Pin image to learning space' }).click();
    await expect(reader.locator('.workspace-block-card--image img')).toBeVisible();
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'image',
          contentKind: 'image',
          payload: expect.objectContaining({
            name: 'fixture.png',
            dataUrl: expect.stringContaining('data:image/png;base64,')
          })
        })
      ])
    );
    await pasteImageIntoViewport(reader, imagePath, 'background-fixture.png');
    await expect(reader.locator('.workspace-block-card--image img')).toHaveCount(2);
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'image',
          contentKind: 'image',
          sourceKind: 'manual',
          payload: expect.objectContaining({
            name: 'background-fixture.png',
            dataUrl: expect.stringContaining('data:image/png;base64,')
          })
        })
      ])
    );
    await expect.poll(async () => userBubbleAspect(reader)).toBeGreaterThan(1);
    await expect.poll(async () => composerHeight(reader)).toBeLessThan(110);
    await expect(reader.locator('.dock-chat-panel')).toContainText('Attached images: fixture.png');
    await expect(reader.locator('.dock-chat-panel .typing-dot')).toHaveCount(0);

    await pasteImageIntoComposer(reader, imagePath, 'pasted-fixture.png');
    await expect(reader.locator('.composer-attachments img')).toHaveCount(1);
    await reader.getByPlaceholder('Message Sidelight').fill('这张粘贴的图片是什么？');
    await expect(reader.getByRole('button', { name: 'Send' })).toBeEnabled();
    await reader.getByRole('button', { name: 'Send' }).click();
    await expect(reader.locator('.chat-attachments img')).toHaveCount(2);
    await expect(reader.locator('.dock-chat-panel')).toContainText('Attached images: pasted-fixture.png');
    await expect(reader.locator('.dock-chat-panel .typing-dot')).toHaveCount(0);

    await reader.getByPlaceholder('Message Sidelight').fill('What is \\(x^2 + y^2\\) and \\[E=mc^2\\]?');
    await expect(reader.getByRole('button', { name: 'Send' })).toBeEnabled();
    await reader.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => reader.locator('.dock-chat-panel .katex').count()).toBeGreaterThanOrEqual(2);
    await expect(reader.locator('.dock-chat-panel')).toContainText('local draft');
    await expect.poll(async () => assistantBubbleWidthRatio(reader)).toBeGreaterThan(0.82);
    await expect.poll(async () => chatPanelLayoutSnapshot(reader)).toMatchObject({
      avatarDisplay: 'none',
      composerVisible: true,
      messagesOverflowY: 'auto',
      roleDisplay: 'none',
      typingDotsBoxShadow: 'none',
      typingInlineOverflow: false,
      transcriptDisplay: 'flex'
    });
    await expect.poll(async () => chatBottomGap(reader)).toBeLessThan(36);
    await expect.poll(async () => mathRenderingSnapshot(reader)).toMatchObject({
      displayOverflowY: 'visible',
      htmlOverflow: 'visible'
    });
    await expect.poll(async () => chatTypographySnapshot(reader)).toMatchObject({
      assistantFontSize: 14,
      assistantHeadingSize: 15,
      anchorMaxHeight: 96,
      avatarDisplay: 'none',
      roleDisplay: 'none'
    });
    await expect.poll(async () => persistedConversationCount(userDataDir)).toBe(1);
    await reader.getByRole('button', { name: 'Search' }).click();
    await reader.getByPlaceholder('Search content, titles, or summaries').fill('local draft');
    await expect(reader.locator('.search-result-row')).toHaveCount(1);
    await reader.locator('.search-result-row').first().getByRole('button', { name: 'Pin to learning space' }).click();
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toHaveLength(3);
  });

  test('replaces foreground panels consistently across chat notes and transient AI', async () => {
    const library = await app.firstWindow();
    await attachDiagnostics(library);
    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    const initialPageWidth = await firstPageWidth(reader);

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();
    await expect(reader.locator('.dock-note-editor-panel')).toHaveCount(0);
    await expect(reader.locator('.transient-aid-panel')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - initialPageWidth)).toBeLessThan(1);

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /Notes/i }).click();
    await expect(reader.locator('.dock-note-editor-panel')).toBeVisible();
    await expect(reader.locator('.dock-chat-panel')).toHaveCount(0);
    await expect(reader.locator('.transient-aid-panel')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - initialPageWidth)).toBeLessThan(1);

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /Translate/i }).click();
    await expect(reader.locator('.transient-aid-panel')).toBeVisible();
    await expect(reader.locator('.transient-aid-panel')).toContainText('Translation');
    await expect(reader.locator('.dock-note-editor-panel')).toHaveCount(0);
    await expect(reader.locator('.dock-chat-panel')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - initialPageWidth)).toBeLessThan(1);

    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();
    await expect(reader.locator('.dock-note-editor-panel')).toHaveCount(0);
    await expect(reader.locator('.transient-aid-panel')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await firstPageWidth(reader)) - initialPageWidth)).toBeLessThan(1);
  });

  test('stops an active chat stream from the composer', async () => {
    const provider = await startSlowStreamingAiProvider();
    try {
      const library = await app.firstWindow();
      await attachDiagnostics(library);
      await configurePlainAiProvider(userDataDir, provider.url);

      const readerPromise = waitForNextWindow(app);
      await library.getByRole('button', { name: /Open PDF/i }).first().click();
      const reader = await readerPromise;
      await attachDiagnostics(reader);

      await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
      await selectFirstPdfText(reader);
      await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
      await reader.getByPlaceholder('Message Sidelight').fill('Stream until I stop you.');
      await reader.getByPlaceholder('Message Sidelight').press('Enter');
      await expect.poll(async () => chatUserMessageAlignment(reader)).toMatchObject({
        isRightAligned: true
      });
      await expect(reader.getByRole('button', { name: 'Stop generating' })).toBeVisible();
      await expect(reader.locator('.dock-chat-panel')).toContainText('stream-part-1');
      await expect.poll(async () => chatMessagesOverflow(reader)).toBeGreaterThan(160);
      await setChatMessagesScrollTop(reader, 0);
      const scrollHeightBefore = (await chatMessagesScrollSnapshot(reader)).scrollHeight;
      await expect.poll(async () => (await chatMessagesScrollSnapshot(reader)).scrollHeight).toBeGreaterThan(scrollHeightBefore + 20);
      await expect.poll(async () => (await chatMessagesScrollSnapshot(reader)).scrollTop).toBeLessThan(4);
      await reader.getByRole('button', { name: 'Stop generating' }).click();
      await expect(reader.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
      await expect.poll(provider.closedCount).toBeGreaterThan(0);
      await expect.poll(async () => persistedAssistantText(userDataDir)).toMatch(/stream-part|已停止回答|Response stopped/);
    } finally {
      await closeServer(provider.server);
    }
  });

  test('lets chat tool calls inspect a requested PDF page', async () => {
    const provider = await startToolCallingAiProvider();
    try {
      const library = await app.firstWindow();
      await attachDiagnostics(library);
      await configurePlainAiProvider(userDataDir, provider.url);

      const readerPromise = waitForNextWindow(app);
      await library.getByRole('button', { name: /Open PDF/i }).first().click();
      const reader = await readerPromise;
      await attachDiagnostics(reader);

      await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
      await selectFirstPdfText(reader);
      await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
      await reader.getByPlaceholder('Message Sidelight').fill('请查看第 2 页，然后告诉我它写了什么。');
      await reader.getByPlaceholder('Message Sidelight').press('Enter');

      const assistantMessage = reader.locator('.dock-chat-panel .chat-message--assistant').last();
      const toolCall = assistantMessage.locator('.chat-toolcall').first();
      await expect(toolCall).toContainText('Read PDF');
      await expect(toolCall).toContainText(/Reading|Done/);
      await expect(assistantMessage.locator('.typing-dot')).toHaveCount(0);
      await expect(reader.locator('.dock-chat-panel')).toContainText('tool-read-page-2');
      await expect(reader.locator('.dock-chat-panel')).toContainText('Second page remembers its own reading state');
      await expect(reader.locator('.chat-toolcall.is-completed').first()).toContainText('Read PDF');
      await expect(reader.locator('.chat-toolcall.is-completed').first()).toContainText('p.2');
      await expect.poll(provider.firstRequestHadPdfTools).toBe(true);
      await expect.poll(provider.lastToolResult).toContain('Second page remembers its own reading state');
    } finally {
      await closeServer(provider.server);
    }
  });

  test('generates and persists an AI outline for PDFs without embedded outlines', async () => {
    const provider = await startGeneratedOutlineAiProvider();
    try {
      const library = await app.firstWindow();
      await attachDiagnostics(library);
      await configurePlainAiProvider(userDataDir, provider.url);

      const readerPromise = waitForNextWindow(app);
      await library.getByRole('button', { name: /Open PDF/i }).first().click();
      const reader = await readerPromise;
      await attachDiagnostics(reader);

      await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
      await expect(reader.getByRole('button', { name: 'AI-generate PDF outline' })).toBeVisible();
      await reader.getByRole('button', { name: 'AI-generate PDF outline' }).click();

      await expect(reader.locator('.outline-source')).toContainText('AI-generated outline');
      await expect(reader.locator('.outline-item').filter({ hasText: 'Integration setup' })).toBeVisible();
      await expect(reader.locator('.outline-item').filter({ hasText: 'Reading state' })).toBeVisible();
      await expect.poll(provider.lastToolResult).toContain('Sidelight integration passage Alpha Beta');
      await expect.poll(async () => persistedGeneratedOutlines(userDataDir)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'ai',
            items: expect.arrayContaining([
              expect.objectContaining({
                title: 'Integration setup',
                pageNumber: 1
              }),
              expect.objectContaining({
                title: 'Reading state',
                pageNumber: 2
              })
            ])
          })
        ])
      );
    } finally {
      await closeServer(provider.server);
    }
  });

  test('pins an open off-page chat onto the current PDF page without reloading', async () => {
    const library = await app.firstWindow();
    await attachDiagnostics(library);
    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await selectFirstPdfText(reader);
    await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
    await expect(reader.locator('.dock-chat-panel')).toBeVisible();

    await reader.locator('.page-control .p-inputtext').fill('2');
    await reader.locator('.page-control .p-inputtext').press('Enter');
    await expect(reader.locator('.pdfViewer .page[data-page-number="2"]')).toBeVisible();
    await expect(reader.locator('.pdf-state')).toHaveCount(0);

    await reader.getByRole('button', { name: 'Pin to learning space' }).click();
    await expect(reader.locator('.workspace-block-card')).toBeVisible();
    await reader.waitForTimeout(300);
    await expect(reader.locator('.pdf-state')).toHaveCount(0);
    await expect.poll(async () => workspaceBlockPdfSideSnapshot(reader, 2)).toMatchObject({
      isLeftOfPdf: true
    });
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual([
      expect.objectContaining({
        kind: 'conversation',
        pageNumber: 2,
        x: expect.any(Number),
        y: expect.any(Number)
      })
    ]);
    expect((await persistedWorkspaceBlocks(userDataDir))[0].x).toBeLessThan(0);
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

    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
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

  test('supports scoped CodeMirror notes and AI generated notes', async () => {
    const library = await app.firstWindow();
    await attachDiagnostics(library);
    const readerPromise = waitForNextWindow(app);
    await library.getByRole('button', { name: /Open PDF/i }).first().click();
    const reader = await readerPromise;
    await attachDiagnostics(reader);

    await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
    await reader.locator('.dock-iconbar').getByRole('button', { name: 'Notes' }).click();
    await expect(reader.locator('.notes-panel')).toBeVisible();
    await expect(reader.locator('.markdown-note-editor .cm-content')).toHaveCount(0);
    await expect(reader.locator('.dock-iconbar__actions').getByRole('button', { name: 'New page note' })).toHaveAttribute('aria-label', 'New page note');

    await reader.locator('.dock-iconbar__actions').getByRole('button', { name: 'New page note' }).click();
    await expect(reader.locator('.dock-note-editor-panel')).toBeVisible();
    await expect(reader.locator('.markdown-note-editor .cm-content')).toBeVisible();

    await reader.locator('.dock-note-editor-panel .notes-panel__toggle').click();
    await expect(reader.locator('.markdown-note-editor .cm-content')).toBeVisible();
    await reader.locator('.dock-note-editor-panel .notes-panel__toggle').click();

    const titleInput = reader.locator('.dock-note-editor-panel .notes-panel__meta input').first();
    await titleInput.click();
    await reader.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await reader.keyboard.type('Page 1 note');
    await expect(titleInput).toHaveValue('Page 1 note');
    await setCodeMirrorText(reader, '# Page 1 note\n\nmanual note from test');
    await expect(reader.locator('.note-editor-pane--preview')).toContainText('manual note from test');
    await expect(reader.locator('.note-editor-pane--preview h1')).toContainText('Page 1 note');
    await expect.poll(async () => noteEditorSplitLayout(reader)).toMatchObject({
      hasSideBySidePreview: true,
      panelWideEnough: true,
      previewWideEnough: true
    });
    await reader.locator('.dock-note-editor-panel .notes-panel__actions').getByRole('button', { name: /^Save$/i }).click();
    await expect(reader.locator('.dock-note-editor-panel')).toHaveCount(0);
    await expect(reader.locator('.notes-panel__tabs')).toContainText('Page 1 note');
    const noteScrollTopBeforePin = await setViewportScrollTop(reader, 96);
    await reader.locator('.notes-panel__tab-row').filter({ hasText: 'Page 1 note' }).locator('.notes-panel__pin').click();
    await expect(reader.locator('.workspace-block-card--note')).toBeVisible();
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual([
      expect.objectContaining({
        kind: 'note',
        title: 'Page 1 note',
        width: expect.any(Number),
        x: expect.any(Number),
        y: expect.any(Number)
      })
    ]);
    await expect.poll(async () => workspaceBlockVisibilitySnapshot(reader)).toMatchObject({
      coveredByDock: false,
      visibleInViewport: true
    });
    await expect.poll(async () => workspaceBlockPdfSideSnapshot(reader)).toMatchObject({
      isLeftOfPdf: true,
      animationName: expect.stringContaining('workspace-block-pop')
    });
    await expect.poll(async () => viewportScrollTop(reader)).toBeGreaterThanOrEqual(0);
    await revealWorkspaceBlock(reader);
    const noteBlock = await workspaceBlockSnapshot(reader);
    expect(noteBlock.contentOverflow).toBe(false);
    await reader.locator('.workspace-block-card--note .workspace-block-card__body').click();
    await expect(reader.locator('.dock-note-editor-panel')).toBeVisible();
    await expect(reader.locator('.dock-note-editor-panel')).toContainText('Page 1 note');
    await reader.locator('.dock-note-editor-panel .notes-panel__actions').getByRole('button', { name: /^Save$/i }).click();
    await reader.locator('.page-control .p-inputtext').fill('1');
    await reader.locator('.page-control .p-inputtext').press('Enter');
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    await reader.locator('.notes-ai-box__range input').nth(0).fill('1');
    await reader.locator('.notes-ai-box__range input').nth(1).fill('1');

    await expect.poll(async () => persistedNotes(userDataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Page 1 note',
          pageStart: 1,
          pageEnd: 1,
          source: 'manual',
          markdown: expect.stringContaining('manual note from test')
        })
      ])
    );

    const noteProvider = await startSlowNoteAiProvider();
    try {
      await configurePlainAiProvider(userDataDir, noteProvider.url);
      await reader.getByRole('button', { name: /Generate AI note/i }).click();
      await expect(reader.locator('.notes-panel__tab-row').filter({ hasText: 'AI notes p.1-1' })).toContainText('Generating notes');
      await reader.locator('.notes-panel__tab-row').filter({ hasText: 'AI notes p.1-1' }).locator('.notes-panel__tab-main').click();
      await expect(reader.locator('.dock-note-editor-panel')).toContainText('Generated note after opening the draft');
      await expect(reader.locator('.note-editor-pane--preview')).toContainText('Sidelight integration passage Alpha Beta');
      await expect.poll(async () => persistedNotes(userDataDir)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'AI notes p.1-1',
            pageStart: 1,
            pageEnd: 1,
            source: 'ai',
            markdown: expect.stringContaining('Generated note after opening the draft')
          })
        ])
      );
      await reader.locator('.dock-note-editor-panel .notes-panel__actions').getByRole('button', { name: /^Save$/i }).click();
    } finally {
      await closeServer(noteProvider.server);
    }
    await reader.locator('.page-control .p-inputtext').fill('2');
    await reader.locator('.page-control .p-inputtext').press('Enter');
    await expect(reader.locator('.pdfViewer .page[data-page-number="2"]')).toBeVisible();
    await expect(reader.locator('.page-control .p-inputtext')).toHaveValue('2');

    await reader.getByRole('button', { name: 'Search' }).click();
    await reader.getByPlaceholder('Search content, titles, or summaries').fill('AI notes p.1-1');
    let aiNoteResult = reader.locator('.search-result-row').filter({ hasText: 'AI notes p.1-1' });
    await expect(aiNoteResult).toBeVisible();
    await aiNoteResult.locator('.search-result-card').click();
    await expect(reader.locator('.dock-note-editor-panel')).toContainText('AI notes p.1-1');
    await expect(reader.locator('.page-control .p-inputtext')).toHaveValue('2');
    await reader.locator('.dock-note-editor-panel .notes-panel__actions').getByRole('button', { name: /^Save$/i }).click();
    await expect(reader.locator('.page-control .p-inputtext')).toHaveValue('2');

    await reader.getByRole('button', { name: 'Search' }).click();
    await reader.getByPlaceholder('Search content, titles, or summaries').fill('AI notes p.1-1');
    aiNoteResult = reader.locator('.search-result-row').filter({ hasText: 'AI notes p.1-1' });
    await expect(aiNoteResult).toBeVisible();
    await aiNoteResult.getByRole('button', { name: 'Pin to learning space' }).click();
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toHaveLength(2);
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'note',
          title: 'AI notes p.1-1',
          pageNumber: 2
        })
      ])
    );
    await expect(reader.locator('.workspace-block-card').filter({ hasText: 'AI notes p.1-1' })).toBeVisible();

    await reader.getByPlaceholder('Search content, titles, or summaries').fill('manual note');
    await expect(reader.locator('.search-result-row').filter({ hasText: 'Page 1 note' })).toBeVisible();
    await reader.locator('.search-result-row').filter({ hasText: 'Page 1 note' }).getByRole('button', { name: 'Pin to learning space' }).click();
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toHaveLength(2);
    await expect.poll(async () => persistedWorkspaceBlocks(userDataDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'note',
          title: 'AI notes p.1-1',
          pageNumber: 2
        }),
        expect.objectContaining({
          kind: 'note',
          title: 'Page 1 note',
          pageNumber: 2
        })
      ])
    );
    await expect.poll(async () => workspaceBlocksDoNotOverlap(reader)).toBe(true);

    await reader.locator('.page-control .p-inputtext').fill('1');
    await reader.locator('.page-control .p-inputtext').press('Enter');
    await expect(reader.locator('.pdfViewer .page[data-page-number="1"]')).toBeVisible();
    await reader.locator('.dock-iconbar').getByRole('button', { name: 'Notes' }).click();
    const manualNoteRow = reader.locator('.notes-panel__tab-row').filter({ hasText: 'Page 1 note' });
    if (await manualNoteRow.count()) {
      await manualNoteRow.getByRole('button', { name: 'Delete note' }).click();
      await expect(manualNoteRow).toHaveCount(0);
      await expect.poll(async () => {
        const notes = await persistedNotes(userDataDir);
        return notes.some((note) => note.title === 'Page 1 note');
      }).toBe(false);
      await expect.poll(async () => {
        const blocks = await persistedWorkspaceBlocks(userDataDir);
        return blocks.some((block) => block.title === 'Page 1 note');
      }).toBe(false);
    }
  });

  test('summarizes provider HTML errors instead of saving raw HTML', async () => {
    const provider = await startFailingAiProvider();
    try {
      const library = await app.firstWindow();
      await attachDiagnostics(library);
      const readerPromise = waitForNextWindow(app);
      await library.getByRole('button', { name: /Open PDF/i }).first().click();
      const reader = await readerPromise;
      await attachDiagnostics(reader);

      await expect(reader.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Sidelight integration passage Alpha Beta');
      await configurePlainAiProvider(userDataDir, provider.url);

      await selectFirstPdfText(reader);
      await reader.locator('.selection-toolbar').getByRole('button', { name: /^Chat$/i }).click();
      await reader.getByPlaceholder('Message Sidelight').fill('Why does this matter?');
      await reader.getByPlaceholder('Message Sidelight').press('Enter');

      const assistantBubble = reader.locator('.chat-message--assistant .chat-bubble').last();
      await expect(assistantBubble).toContainText('AI request failed');
      await expect(assistantBubble).toContainText('502 Bad Gateway');
      await expect(assistantBubble).not.toContainText('<!DOCTYPE html>');
      await expect(assistantBubble).not.toContainText('<meta');

      await expect.poll(async () => persistedAssistantText(userDataDir)).toContain('502 Bad Gateway');
      expect(await persistedAssistantText(userDataDir)).not.toContain('<!DOCTYPE html>');
    } finally {
      await closeServer(provider.server);
    }
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

  const secondPage = pdf.addPage([612, 792]);
  secondPage.drawText('Second page remembers its own reading state.', {
    x: 72,
    y: 700,
    size: 18,
    font,
    color: rgb(0.05, 0.05, 0.05)
  });

  const thirdPage = pdf.addPage([612, 792]);
  thirdPage.drawText('Third page keeps the fixture multi-page.', {
    x: 72,
    y: 700,
    size: 18,
    font,
    color: rgb(0.05, 0.05, 0.05)
  });

  await writeFile(filePath, await pdf.save());
}

async function createFixturePng(filePath: string): Promise<void> {
  const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await writeFile(filePath, Buffer.from(onePixelPng, 'base64'));
}

function launchEnv(userDataDir: string, pdfPath: string, openPdfOnStart = false): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env;
  return {
    ...env,
    SIDELIGHT_E2E_HIDE_WINDOWS: process.env.SIDELIGHT_E2E_SHOW_WINDOWS === '1' ? '0' : '1',
    SIDELIGHT_USER_DATA_DIR: userDataDir,
    SIDELIGHT_TEST_OPEN_PDF: pdfPath,
    SIDELIGHT_OPEN_PDF_ON_START: openPdfOnStart ? '1' : '0'
  };
}

function shouldOpenPdfFromLaunchArgs(testInfo: { title: string }): boolean {
  return testInfo.title === 'opens a PDF path passed by the operating system launch arguments';
}

async function waitForNextWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.waitForEvent('window');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function waitForReaderWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      const hasReaderShell = await page.locator('.pdf-viewport').count().catch(() => 0);
      if (hasReaderShell > 0) {
        return page;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Reader window did not open for the requested PDF.');
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
  return pdfPageWidth(page, 1);
}

async function pdfPageWidth(page: Page, pageNumber: number): Promise<number> {
  return page.locator(`.pdfViewer .page[data-page-number="${pageNumber}"]`).evaluate((element) => element.getBoundingClientRect().width);
}

interface ZoomAnchorProbe {
  clientX: number;
  clientY: number;
  ratioX: number;
  ratioY: number;
}

async function firstPageZoomAnchor(page: Page): Promise<ZoomAnchorProbe> {
  return pdfPageZoomAnchor(page, 1);
}

async function pdfPageZoomAnchor(page: Page, pageNumber: number): Promise<ZoomAnchorProbe> {
  return page.locator(`.pdfViewer .page[data-page-number="${pageNumber}"]`).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const ratioX = 0.68;
    const ratioY = 0.38;
    return {
      clientX: rect.left + rect.width * ratioX,
      clientY: rect.top + rect.height * ratioY,
      ratioX,
      ratioY
    };
  });
}

async function viewportBlankZoomPoint(page: Page): Promise<{ clientX: number; clientY: number }> {
  return page.locator('.pdf-viewport').evaluate((viewport) => {
    const viewportRect = viewport.getBoundingClientRect();
    const pageElement = document.querySelector<HTMLElement>('.pdfViewer .page[data-page-number="1"]');
    if (!pageElement) {
      throw new Error('No PDF page is visible.');
    }

    const pageRect = pageElement.getBoundingClientRect();
    return {
      clientX: Math.max(viewportRect.left + 4, pageRect.left - 12),
      clientY: pageRect.top + pageRect.height * 0.42
    };
  });
}

async function pageControlValue(page: Page): Promise<number> {
  const value = await page.locator('.page-control .p-inputtext').inputValue();
  return Number(value);
}

async function firstPageAnchorDrift(page: Page, anchor: ZoomAnchorProbe): Promise<number> {
  return page.locator('.pdfViewer .page').first().evaluate((element, probe) => {
    const rect = element.getBoundingClientRect();
    const ratioX = (probe.clientX - rect.left) / rect.width;
    const ratioY = (probe.clientY - rect.top) / rect.height;
    return Math.max(Math.abs(ratioX - probe.ratioX), Math.abs(ratioY - probe.ratioY));
  }, anchor);
}

async function zoomInOnFirstPage(page: Page): Promise<void> {
  const pageWidthBefore = await firstPageWidth(page);
  const zoomAnchor = await firstPageZoomAnchor(page);
  await page.locator('.pdf-viewport').dispatchEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: zoomAnchor.clientX,
    clientY: zoomAnchor.clientY,
    ctrlKey: true,
    deltaY: -300
  });
  await expect.poll(async () => firstPageWidth(page)).toBeGreaterThan(pageWidthBefore * 1.05);
}

async function zoomThenNudgeHorizontalScroll(page: Page, anchor: ZoomAnchorProbe): Promise<number> {
  return page.locator('.pdf-viewport').evaluate(
    async (element, zoomAnchor) => {
      const node = element as HTMLElement;
      node.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: zoomAnchor.clientX,
          clientY: zoomAnchor.clientY,
          ctrlKey: true,
          deltaY: -300
        })
      );

      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
      const direction = node.scrollLeft > maxScrollLeft / 2 ? -1 : 1;
      let targetScrollLeft = Math.min(maxScrollLeft, Math.max(0, node.scrollLeft + direction * 120));
      if (Math.abs(targetScrollLeft - node.scrollLeft) < 16) {
        targetScrollLeft = Math.min(maxScrollLeft, Math.max(0, node.scrollLeft - direction * 120));
      }

      node.scrollLeft = targetScrollLeft;
      await new Promise((resolve) => window.setTimeout(resolve, 160));
      return Math.abs(node.scrollLeft - targetScrollLeft);
    },
    anchor
  );
}

async function viewportHorizontalScrollInfo(page: Page): Promise<{ canScroll: boolean }> {
  return page.locator('.pdf-viewport').evaluate((element) => {
    const viewport = element as HTMLElement;
    return {
      canScroll: viewport.scrollWidth > viewport.clientWidth + 1
    };
  });
}

async function readerControlOverflowSnapshot(page: Page): Promise<{
  controlsOverflow: boolean;
  pageControlOverflow: boolean;
  separatorVisible: boolean;
  zoomControlOverflow: boolean;
}> {
  return page.evaluate(() => {
    const overflow = (container: HTMLElement | null): boolean => {
      if (!container) {
        return true;
      }

      const containerBox = container.getBoundingClientRect();
      const children = Array.from(container.children) as HTMLElement[];
      return children.some((child) => {
        const childBox = child.getBoundingClientRect();
        return childBox.left < containerBox.left - 0.5 || childBox.right > containerBox.right + 0.5;
      });
    };

    const separator = document.querySelector<HTMLElement>('.page-control__separator');
    const separatorBox = separator?.getBoundingClientRect();

    return {
      controlsOverflow: overflow(document.querySelector<HTMLElement>('.reader-controls')),
      pageControlOverflow: overflow(document.querySelector<HTMLElement>('.page-control')),
      separatorVisible: Boolean(separatorBox && separatorBox.width >= 8 && separatorBox.height >= 8),
      zoomControlOverflow: overflow(document.querySelector<HTMLElement>('.zoom-control'))
    };
  });
}

async function libraryCoverGridSnapshot(page: Page): Promise<{
  cardCount: number;
  cardOverflow: boolean;
  gridOverflowX: boolean;
}> {
  return page.locator('.library-cover-grid').evaluate((element) => {
    const grid = element as HTMLElement;
    const gridBox = grid.getBoundingClientRect();
    const cards = Array.from(grid.querySelectorAll<HTMLElement>('.library-cover-card'));
    return {
      cardCount: cards.length,
      cardOverflow: cards.some((card) => {
        const cardBox = card.getBoundingClientRect();
        return cardBox.left < gridBox.left - 0.5 || cardBox.right > gridBox.right + 0.5;
      }),
      gridOverflowX: grid.scrollWidth > grid.clientWidth + 1
    };
  });
}

async function selectionToolbarDesignSnapshot(page: Page): Promise<{
  actionBackgroundTransparent: boolean;
  actionBorderless: boolean;
  flexDirection: string;
  iconCircular: boolean;
}> {
  return page.locator('.selection-toolbar').evaluate((element) => {
    const toolbar = element as HTMLElement;
    const action = toolbar.querySelector<HTMLElement>('.selection-toolbar__action');
    const icon = action?.querySelector<SVGElement>('svg');
    const actionStyle = action ? window.getComputedStyle(action) : undefined;
    const iconStyle = icon ? window.getComputedStyle(icon) : undefined;
    const iconBox = icon?.getBoundingClientRect();

    return {
      actionBackgroundTransparent: actionStyle?.backgroundColor === 'rgba(0, 0, 0, 0)',
      actionBorderless: actionStyle?.borderTopWidth === '0px',
      flexDirection: window.getComputedStyle(toolbar).flexDirection,
      iconCircular: Boolean(
        iconStyle &&
          iconBox &&
          Number.parseFloat(iconStyle.borderTopLeftRadius) >= Math.min(iconBox.width, iconBox.height) / 2 - 1
      )
    };
  });
}

async function pdfPageToDockGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pdfPage = document.querySelector<HTMLElement>('.pdfViewer .page');
    const dock = document.querySelector<HTMLElement>('.reader-dock-lane');
    if (!pdfPage || !dock) {
      return Number.POSITIVE_INFINITY;
    }

    return dock.getBoundingClientRect().left - pdfPage.getBoundingClientRect().right;
  });
}

async function pdfPageLeftGutter(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
    const pdfPage = document.querySelector<HTMLElement>('.pdfViewer .page');
    if (!viewport || !pdfPage) {
      return 0;
    }

    return pdfPage.getBoundingClientRect().left - viewport.getBoundingClientRect().left;
  });
}

async function assertDockPinsVerticallyAndMovesHorizontally(page: Page): Promise<void> {
  const viewport = page.locator('.pdf-viewport');
  await viewport.evaluate((element) => {
    const node = element as HTMLElement;
    node.scrollLeft = 0;
    node.scrollTop = 80;
  });

  const beforeVertical = await dockLaneBox(page);
  await viewport.evaluate((element) => {
    const node = element as HTMLElement;
    node.scrollTop += 160;
  });
  const afterVertical = await dockLaneBox(page);
  expect(Math.abs(afterVertical.top - beforeVertical.top)).toBeLessThan(2);

  await viewport.evaluate((element) => {
    const node = element as HTMLElement;
    node.scrollLeft = 0;
  });
  const beforeHorizontal = await dockLaneBox(page);
  const appliedScrollLeft = await viewport.evaluate((element) => {
    const node = element as HTMLElement;
    node.scrollLeft = Math.min(180, node.scrollWidth - node.clientWidth);
    return node.scrollLeft;
  });
  expect(appliedScrollLeft).toBeGreaterThan(0);
  const afterHorizontal = await dockLaneBox(page);
  expect(afterHorizontal.left).toBeLessThan(beforeHorizontal.left - 10);
}

async function dockLaneBox(page: Page): Promise<{ left: number; top: number }> {
  return page.locator('.reader-dock-lane').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top
    };
  });
}

async function dockPanelBox(page: Page): Promise<{ left: number; top: number }> {
  return page.locator('.reader-float-dock').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top
    };
  });
}

async function dockOffset(page: Page): Promise<{ x: number; y: number }> {
  return page.locator('.pdf-stage').evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      x: Number.parseFloat(style.getPropertyValue('--dock-offset-x')) || 0,
      y: Number.parseFloat(style.getPropertyValue('--dock-offset-y')) || 0
    };
  });
}

async function revealDockMoveButton(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Move reading dock' });
  await button.evaluate((element) => {
    element.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
  await expect(button).toBeVisible();
}

async function composerHeight(page: Page): Promise<number> {
  return page.locator('.chat-composer').evaluate((element) => element.getBoundingClientRect().height);
}

async function chatUserMessageAlignment(page: Page): Promise<{
  gapToRight: number;
  isRightAligned: boolean;
  userWidth: number;
}> {
  return page.locator('.chat-message--user .chat-bubble').first().evaluate((element) => {
    const bubble = element as HTMLElement;
    const message = bubble.closest<HTMLElement>('.chat-message--user');
    const transcript = message.closest<HTMLElement>('.dock-chat-transcript');
    const bubbleBox = bubble.getBoundingClientRect();
    const transcriptBox = transcript?.getBoundingClientRect();
    const transcriptStyle = transcript ? window.getComputedStyle(transcript) : undefined;
    const transcriptContentRight = transcriptBox && transcriptStyle
      ? transcriptBox.right - (Number.parseFloat(transcriptStyle.paddingRight) || 0)
      : Number.NaN;
    const gapToRight = transcriptContentRight - bubbleBox.right;

    return {
      gapToRight,
      isRightAligned: Number.isFinite(gapToRight) && Math.abs(gapToRight) < 1.5,
      userWidth: bubbleBox.width
    };
  });
}

async function dispatchComposerComposition(page: Page, type: 'compositionstart' | 'compositionend', data: string): Promise<void> {
  await page.getByPlaceholder('Message Sidelight').evaluate((textarea, payload) => {
    textarea.dispatchEvent(
      new CompositionEvent(payload.type, {
        bubbles: true,
        cancelable: true,
        data: payload.data
      })
    );
  }, { data, type });
}

async function chatMessagesScrollSnapshot(page: Page): Promise<{
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}> {
  return page.locator('.dock-chat-messages').evaluate((element) => {
    const node = element as HTMLElement;
    return {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop
    };
  });
}

async function chatMessagesOverflow(page: Page): Promise<number> {
  const snapshot = await chatMessagesScrollSnapshot(page);
  return snapshot.scrollHeight - snapshot.clientHeight;
}

async function setChatMessagesScrollTop(page: Page, scrollTop: number): Promise<number> {
  return page.locator('.dock-chat-messages').evaluate((element, nextScrollTop) => {
    const node = element as HTMLElement;
    node.scrollTop = nextScrollTop;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
    return node.scrollTop;
  }, scrollTop);
}

async function pasteImageIntoComposer(page: Page, imagePath: string, fileName: string): Promise<void> {
  const base64 = await readFile(imagePath, 'base64');
  const composer = page.getByPlaceholder('Message Sidelight');
  await composer.focus();
  await composer.evaluate(
    (textarea, payload) => {
      const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], payload.fileName, { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textarea.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer
        })
      );
    },
    { base64, fileName }
  );
}

async function pasteImageIntoViewport(page: Page, imagePath: string, fileName: string): Promise<void> {
  const base64 = await readFile(imagePath, 'base64');
  const viewport = page.locator('.pdf-viewport');
  await viewport.focus();
  await viewport.evaluate(
    (element, payload) => {
      const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], payload.fileName, { type: 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer
        })
      );
    },
    { base64, fileName }
  );
}

async function setColorInput(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function userBubbleAspect(page: Page): Promise<number> {
  return page.locator('.chat-message--user .chat-bubble').first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width / Math.max(1, rect.height);
  });
}

async function assistantBubbleWidthRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>('.dock-chat-transcript');
    const bubble = document.querySelector<HTMLElement>('.chat-message--assistant .chat-bubble');
    if (!transcript || !bubble) {
      return 0;
    }

    return bubble.getBoundingClientRect().width / Math.max(1, transcript.getBoundingClientRect().width);
  });
}

async function chatPanelLayoutSnapshot(page: Page): Promise<{
  avatarDisplay: string;
  composerVisible: boolean;
  messagesOverflowY: string;
  roleDisplay: string;
  typingDotsBoxShadow: string;
  typingDotsWidth: string;
  typingInlineOverflow: boolean;
  transcriptDisplay: string;
  typingMaxWidth: string;
  typingWhiteSpace: string;
}> {
  return page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>('.dock-chat-messages');
    const transcript = document.querySelector<HTMLElement>('.dock-chat-transcript');
    const composer = document.querySelector<HTMLElement>('.chat-composer');
    const avatar = document.querySelector<HTMLElement>('.chat-message--assistant .chat-avatar');
    const role = document.querySelector<HTMLElement>('.chat-message--assistant .chat-message__role');
    const typing = document.createElement('span');
    typing.className = 'typing-dot';
    typing.textContent = 'Thinking about a very long pending state label';
    transcript?.appendChild(typing);
    const typingStyle = window.getComputedStyle(typing);
    const typingDotsStyle = window.getComputedStyle(typing, '::after');
    const typingBox = typing.getBoundingClientRect();
    const transcriptBox = transcript?.getBoundingClientRect();
    const snapshot = {
      avatarDisplay: avatar ? window.getComputedStyle(avatar).display : 'missing',
      composerVisible: Boolean(composer && composer.getBoundingClientRect().height > 0),
      messagesOverflowY: messages ? window.getComputedStyle(messages).overflowY : 'missing',
      roleDisplay: role ? window.getComputedStyle(role).display : 'missing',
      typingDotsBoxShadow: typingDotsStyle.boxShadow,
      typingDotsWidth: typingDotsStyle.width,
      typingInlineOverflow: Boolean(transcriptBox && typingBox.right > transcriptBox.right + 0.5),
      transcriptDisplay: transcript ? window.getComputedStyle(transcript).display : 'missing',
      typingMaxWidth: typingStyle.maxWidth,
      typingWhiteSpace: typingStyle.whiteSpace
    };
    typing.remove();
    return snapshot;
  });
}

async function mathRenderingSnapshot(page: Page): Promise<{
  displayOverflowY: string;
  htmlOverflow: string;
}> {
  return page.evaluate(() => {
    const display = document.querySelector<HTMLElement>('.dock-chat-panel .katex-display');
    const html = document.querySelector<HTMLElement>('.dock-chat-panel .katex-html');
    return {
      displayOverflowY: display ? window.getComputedStyle(display).overflowY : 'missing',
      htmlOverflow: html ? window.getComputedStyle(html).overflow : 'missing'
    };
  });
}

async function chatBottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>('.dock-chat-messages');
    const lastMessage = document.querySelector<HTMLElement>('.dock-chat-transcript .chat-message:last-child');
    if (!messages || !lastMessage) {
      return Number.POSITIVE_INFINITY;
    }

    messages.scrollTop = messages.scrollHeight;
    const messageRect = lastMessage.getBoundingClientRect();
    const messagesRect = messages.getBoundingClientRect();
    return Math.max(0, messagesRect.bottom - messageRect.bottom);
  });
}

async function pdfMarkVisualSnapshot(page: Page, colorRole: string): Promise<{
  backgroundColor: string;
  boxShadow: string;
  hasPaint: boolean;
  layerOpacity: string;
  mixBlendMode: string;
  opacity: string;
  visualZIndex: string;
}> {
  return page.locator(`.pdf-mark-visual[data-color-role="${colorRole}"]`).first().evaluate((element) => {
    const style = window.getComputedStyle(element);
    const backgroundColor = style.backgroundColor;
    return {
      backgroundColor,
      boxShadow: style.boxShadow,
      hasPaint: backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent',
      layerOpacity: window.getComputedStyle(element.parentElement as Element).opacity,
      mixBlendMode: style.mixBlendMode,
      opacity: style.opacity,
      visualZIndex: window.getComputedStyle(element.parentElement as Element).zIndex
    };
  });
}

async function pdfUnderlineSnapshot(page: Page): Promise<{
  backgroundColor: string;
  borderBottomStyle: string;
  hasDashedPaint: boolean;
  height: string;
  layerOpacity: string;
  layerZIndex: string;
  transform: string;
}> {
  return page.locator('.pdf-mark-visual--underline').first().evaluate((element) => {
    const style = window.getComputedStyle(element);
    const layerStyle = window.getComputedStyle(element.parentElement as Element);
    return {
      backgroundColor: style.backgroundColor,
      borderBottomStyle: style.borderBottomStyle,
      hasDashedPaint: style.backgroundImage.includes('repeating-linear-gradient'),
      height: style.height,
      layerOpacity: layerStyle.opacity,
      layerZIndex: layerStyle.zIndex,
      transform: style.transform
    };
  });
}

async function clickMarkVisualCenter(page: Page, colorRole: string): Promise<void> {
  const point = await markVisiblePoint(page, colorRole);
  await page.mouse.click(point.x, point.y);
}

async function markCenterTopElement(page: Page, colorRole: string): Promise<string> {
  const point = await markVisiblePoint(page, colorRole);
  return page.evaluate(({ x, y }) => {
    const topElement = document.elementFromPoint(x, y);
    return topElement instanceof HTMLElement ? topElement.className : '';
  }, point);
}

async function markVisiblePoint(page: Page, colorRole: string): Promise<{ x: number; y: number }> {
  return page.locator(`.pdf-mark-visual[data-color-role="${colorRole}"]`).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport')?.getBoundingClientRect();
    if (!viewport) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    const left = Math.max(rect.left, viewport.left + 2);
    const right = Math.min(rect.right, viewport.right - 2);
    const top = Math.max(rect.top, viewport.top + 2);
    const bottom = Math.min(rect.bottom, viewport.bottom - 2);
    if (right <= left || bottom <= top) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    return {
      x: left + (right - left) / 2,
      y: top + (bottom - top) / 2
    };
  });
}

async function markPopoverDesignSnapshot(page: Page): Promise<{
  actionFontSize: string;
  actionsDisplay: string;
  borderRadius: string;
  quoteUserSelect: string;
}> {
  return page.locator('.mark-popover').evaluate((element) => {
    const style = window.getComputedStyle(element);
    const actions = element.querySelector<HTMLElement>('.mark-popover__actions');
    const action = element.querySelector<HTMLElement>('.mark-popover__actions button');
    const quote = element.querySelector<HTMLElement>('p');
    return {
      actionFontSize: action ? window.getComputedStyle(action).fontSize : '',
      actionsDisplay: actions ? window.getComputedStyle(actions).display : '',
      borderRadius: style.borderRadius,
      quoteUserSelect: quote ? window.getComputedStyle(quote).userSelect : ''
    };
  });
}

async function headerActionCenterDelta(page: Page, panelSelector: string): Promise<number> {
  return page.evaluate((selector) => {
    const panel = document.querySelector<HTMLElement>(selector);
    const badge = panel?.querySelector<HTMLElement>('header .p-badge');
    const close = panel?.querySelector<HTMLElement>('header .panel-close-button');
    if (!badge || !close) {
      return Number.POSITIVE_INFINITY;
    }

    const badgeBox = badge.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    return Math.abs((badgeBox.top + badgeBox.height / 2) - (closeBox.top + closeBox.height / 2));
  }, panelSelector);
}

async function setCodeMirrorText(page: Page, text: string): Promise<void> {
  const editor = page.locator('.markdown-note-editor .cm-content').first();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(text);
}

async function noteEditorSplitLayout(page: Page): Promise<{
  hasSideBySidePreview: boolean;
  panelWideEnough: boolean;
  previewWideEnough: boolean;
}> {
  return page.locator('.dock-note-editor-panel').evaluate((panel) => {
    const panelBox = (panel as HTMLElement).getBoundingClientRect();
    const sourceBox = panel.querySelector<HTMLElement>('.note-editor-pane--source')?.getBoundingClientRect();
    const previewBox = panel.querySelector<HTMLElement>('.note-editor-pane--preview')?.getBoundingClientRect();

    return {
      hasSideBySidePreview: Boolean(sourceBox && previewBox && previewBox.left > sourceBox.right - 1),
      panelWideEnough: panelBox.width >= 760,
      previewWideEnough: Boolean(previewBox && previewBox.width >= 280)
    };
  });
}

async function chatTypographySnapshot(page: Page): Promise<{
  assistantFontSize: number;
  assistantHeadingSize: number;
  anchorMaxHeight: number;
  avatarDisplay: string;
  roleDisplay: string;
}> {
  return page.evaluate(() => {
    const bubble = document.querySelector<HTMLElement>('.chat-message--assistant .chat-bubble');
    const heading = bubble?.querySelector<HTMLElement>('h3');
    const anchor = document.querySelector<HTMLElement>('.dock-chat-anchor');
    const avatar = document.querySelector<HTMLElement>('.chat-message--assistant .chat-avatar');
    const role = document.querySelector<HTMLElement>('.chat-message--assistant .chat-message__role');

    return {
      assistantFontSize: Number.parseFloat(window.getComputedStyle(bubble!).fontSize),
      assistantHeadingSize: Number.parseFloat(window.getComputedStyle(heading!).fontSize),
      anchorMaxHeight: Number.parseFloat(window.getComputedStyle(anchor!).maxHeight),
      avatarDisplay: window.getComputedStyle(avatar!).display,
      roleDisplay: window.getComputedStyle(role!).display
    };
  });
}

async function dockRightEdgeDelta(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
    const dock = document.querySelector<HTMLElement>('.reader-dock-lane');
    if (!viewport || !dock) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.abs(dock.getBoundingClientRect().right - viewport.getBoundingClientRect().right);
  });
}

async function dockRightInset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
    const dock = document.querySelector<HTMLElement>('.reader-dock-lane');
    if (!viewport || !dock) {
      return Number.POSITIVE_INFINITY;
    }

    return viewport.getBoundingClientRect().right - dock.getBoundingClientRect().right;
  });
}

async function dockResizeHandleShape(page: Page): Promise<{
  centerOffset: number;
  handleGap: number;
  handleHeight: number;
  visualGap: number;
  visualHeight: number;
}> {
  return page.locator('.dock-resize-handle').evaluate((element) => {
    const handle = element as HTMLElement;
    const dock = handle.closest<HTMLElement>('.reader-dock-lane');
    const panel = dock?.querySelector<HTMLElement>('.reader-float-dock');
    const handleBox = handle.getBoundingClientRect();
    const dockBox = dock?.getBoundingClientRect();
    const panelBox = panel?.getBoundingClientRect();
    const gripStyle = window.getComputedStyle(handle, '::before');
    const gripRight = Number.parseFloat(gripStyle.right) || 0;
    const gripWidth = Number.parseFloat(gripStyle.width) || 0;
    const gripLeft = handleBox.right - gripRight - gripWidth;

    return {
      centerOffset: dockBox ? (handleBox.top + handleBox.height / 2) - (dockBox.top + dockBox.height / 2) : Number.POSITIVE_INFINITY,
      handleGap: panelBox ? handleBox.left - panelBox.right : Number.NEGATIVE_INFINITY,
      handleHeight: handleBox.height,
      visualGap: panelBox ? gripLeft - panelBox.right : Number.NEGATIVE_INFINITY,
      visualHeight: Number.parseFloat(gripStyle.height) || 0
    };
  });
}

async function dockLaneWidth(page: Page): Promise<number> {
  return page.locator('.reader-dock-lane').evaluate((element) => element.getBoundingClientRect().width);
}

async function dockChromeGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const iconbar = document.querySelector<HTMLElement>('.reader-float-dock .dock-iconbar');
    const panel = document.querySelector<HTMLElement>('.reader-float-dock .dock-chat-panel, .reader-float-dock .transient-aid-panel, .reader-float-dock .dock-section');
    if (!iconbar || !panel) {
      return Number.NaN;
    }

    return panel.getBoundingClientRect().top - iconbar.getBoundingClientRect().bottom;
  });
}

async function dockListDesignSnapshot(page: Page): Promise<{
  cardRightInset: number;
  cardShadow: string;
  cardTransform: string;
  cardWithinList: boolean;
  listOverflow: string;
  searchInputMinWidth: string;
}> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.trace-card');
    const list = document.querySelector<HTMLElement>('.trace-list');
    const searchInput = document.querySelector<HTMLElement>('.panel-search .p-inputtext');
    const cardRect = card?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();

    return {
      cardRightInset: cardRect && listRect ? listRect.right - cardRect.right : Number.NaN,
      cardShadow: card ? window.getComputedStyle(card).boxShadow : '',
      cardTransform: card ? window.getComputedStyle(card).transform : '',
      cardWithinList: Boolean(
        cardRect &&
          listRect &&
          cardRect.left >= listRect.left - 0.5 &&
          cardRect.right <= listRect.right + 0.5
      ),
      listOverflow: list ? window.getComputedStyle(list).overflow : '',
      searchInputMinWidth: searchInput ? window.getComputedStyle(searchInput).minWidth : ''
    };
  });
}

async function workspaceBlockSnapshot(page: Page): Promise<{
  canvasLeft: number;
  canvasTop: number;
  contentOverflow: boolean;
  left: number;
  top: number;
  width: number;
}> {
  return page.locator('.workspace-block-card').first().evaluate((element) => {
    const card = element as HTMLElement;
    const cardBox = card.getBoundingClientRect();
    const measuredChildren = Array.from(card.querySelectorAll<HTMLElement>('.workspace-block-card__body, .workspace-block-card__remove'));
    const contentOverflow = measuredChildren.some((child) => {
      const childBox = child.getBoundingClientRect();
      return (
        childBox.left < cardBox.left - 0.5 ||
        childBox.right > cardBox.right + 0.5 ||
        childBox.top < cardBox.top - 0.5 ||
        childBox.bottom > cardBox.bottom + 0.5
      );
    });

    return {
      canvasLeft: card.offsetLeft,
      canvasTop: card.offsetTop,
      contentOverflow,
      left: cardBox.left,
      top: cardBox.top,
      width: cardBox.width
    };
  });
}

async function workspaceBlockVisibilitySnapshot(page: Page): Promise<{
  blockBottom: number;
  blockLeft: number;
  blockRight: number;
  blockTop: number;
  coveredByDock: boolean;
  viewportBottom: number;
  viewportLeft: number;
  viewportRight: number;
  viewportTop: number;
  visibleInViewport: boolean;
}> {
  return page.locator('.workspace-block-card').first().evaluate((element) => {
    const block = element as HTMLElement;
    const viewport = document.querySelector<HTMLElement>('.pdf-viewport');
    const dock = document.querySelector<HTMLElement>('.reader-dock-lane');
    const blockBox = block.getBoundingClientRect();
    const viewportBox = viewport?.getBoundingClientRect();
    const dockBox = dock?.getBoundingClientRect();
    return {
      blockBottom: blockBox.bottom,
      blockLeft: blockBox.left,
      blockRight: blockBox.right,
      blockTop: blockBox.top,
      coveredByDock: Boolean(dockBox && blockBox.right > dockBox.left + 0.5 && blockBox.left < dockBox.right - 0.5),
      viewportBottom: viewportBox?.bottom ?? Number.NaN,
      viewportLeft: viewportBox?.left ?? Number.NaN,
      viewportRight: viewportBox?.right ?? Number.NaN,
      viewportTop: viewportBox?.top ?? Number.NaN,
      visibleInViewport: Boolean(
        viewportBox &&
        blockBox.right > viewportBox.left + 16 &&
        blockBox.left < viewportBox.right - 16 &&
        blockBox.bottom > viewportBox.top + 16 &&
        blockBox.top < viewportBox.bottom - 16
      )
    };
  });
}

async function workspaceBlockPdfSideSnapshot(page: Page, pageNumber = 1): Promise<{
  animationName: string;
  blockRight: number;
  gap: number;
  isLeftOfPdf: boolean;
  pageLeft: number;
}> {
  return page.locator('.workspace-block-card').first().evaluate((element, targetPageNumber) => {
    const block = element as HTMLElement;
    const pageElement = document.querySelector<HTMLElement>(`.pdfViewer .page[data-page-number="${targetPageNumber}"]`);
    const blockBox = block.getBoundingClientRect();
    const pageBox = pageElement?.getBoundingClientRect();
    const gap = pageBox ? pageBox.left - blockBox.right : Number.NaN;

    return {
      animationName: window.getComputedStyle(block).animationName,
      blockRight: blockBox.right,
      gap,
      isLeftOfPdf: Boolean(pageBox && gap >= 18),
      pageLeft: pageBox?.left ?? Number.NaN
    };
  }, pageNumber);
}

interface WorkspaceBlockPageAnchor {
  pageNumber: string;
  ratioY: number;
}

async function workspaceBlockPageAnchorSnapshot(page: Page): Promise<WorkspaceBlockPageAnchor> {
  return page.locator('.workspace-block-card').first().evaluate((element) => {
    const block = element as HTMLElement;
    const pageNumber = block.dataset.pageNumber;
    const pageElement = pageNumber
      ? document.querySelector<HTMLElement>(`.pdfViewer .page[data-page-number="${pageNumber}"]`)
      : null;
    if (!pageNumber || !pageElement) {
      throw new Error('Workspace block is not attached to a rendered PDF page.');
    }

    const blockBox = block.getBoundingClientRect();
    const pageBox = pageElement.getBoundingClientRect();
    return {
      pageNumber,
      ratioY: (blockBox.top - pageBox.top) / pageBox.height
    };
  });
}

async function workspaceBlockPageAnchorDrift(page: Page, anchor: WorkspaceBlockPageAnchor): Promise<number> {
  const current = await workspaceBlockPageAnchorSnapshot(page);
  if (current.pageNumber !== anchor.pageNumber) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.abs(current.ratioY - anchor.ratioY);
}

async function workspaceBlocksDoNotOverlap(page: Page): Promise<boolean> {
  return page.locator('.workspace-block-card').evaluateAll((elements) => {
    const rects = elements.map((element) => (element as HTMLElement).getBoundingClientRect());
    return rects.every((rect, index) => rects.slice(index + 1).every((other) => (
      rect.right <= other.left ||
      other.right <= rect.left ||
      rect.bottom <= other.top ||
      other.bottom <= rect.top
    )));
  });
}

async function setViewportScrollTop(page: Page, scrollTop: number): Promise<number> {
  return page.locator('.pdf-viewport').evaluate((element, nextScrollTop) => {
    const viewport = element as HTMLElement;
    viewport.scrollTop = nextScrollTop;
    return viewport.scrollTop;
  }, scrollTop);
}

async function viewportScrollTop(page: Page): Promise<number> {
  return page.locator('.pdf-viewport').evaluate((element) => (element as HTMLElement).scrollTop);
}

async function dragWorkspaceBlock(page: Page, deltaX: number, deltaY: number): Promise<void> {
  await revealWorkspaceBlock(page);
  const handle = page.locator('.workspace-block-card__drag').first();
  await handle.scrollIntoViewIfNeeded();
  await expect.poll(async () => workspaceBlockDragHitTarget(page)).toContain('workspace-block-card__drag');
  await dispatchMouseDrag(page, '.workspace-block-card__drag', deltaX, deltaY);
}

async function dispatchMouseDrag(
  page: Page,
  selector: string,
  deltaX: number,
  deltaY: number
): Promise<void> {
  await page.locator(selector).first().evaluate((element, drag) => {
    const target = element as HTMLElement;
    const box = target.getBoundingClientRect();
    const startX = box.left + box.width / 2;
    const startY = box.top + box.height / 2;
    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: startX,
      clientY: startY
    };

    target.dispatchEvent(new MouseEvent('mousedown', eventInit));
    window.dispatchEvent(new MouseEvent('mousemove', {
      ...eventInit,
      clientX: startX + drag.deltaX,
      clientY: startY + drag.deltaY
    }));
    window.dispatchEvent(new MouseEvent('mouseup', {
      ...eventInit,
      buttons: 0,
      clientX: startX + drag.deltaX,
      clientY: startY + drag.deltaY
    }));
  }, { deltaX, deltaY });
}

async function workspaceBlockDragHitTarget(page: Page): Promise<string> {
  const box = await page.locator('.workspace-block-card__drag').first().boundingBox();
  expect(box).toBeTruthy();
  return page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    const parents = [];
    let current = element;
    while (current && parents.length < 4) {
      parents.push(`${current.tagName}.${current.className?.toString() ?? ''}`);
      current = current.parentElement;
    }
    return parents.join(' > ');
  }, {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2
  });
}

async function resizeWorkspaceBlock(page: Page, deltaX: number): Promise<void> {
  await revealWorkspaceBlock(page);
  await dispatchMouseDrag(page, '.workspace-block-card__resize', deltaX, 0);
}

async function revealWorkspaceBlock(page: Page): Promise<void> {
  await page.locator('.workspace-block-card').first().evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  });
}

async function dragDockResizeHandle(page: Page, deltaX: number): Promise<void> {
  const box = await page.locator('.dock-resize-handle').boundingBox();
  expect(box).toBeTruthy();

  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 8 });
  await page.mouse.up();
}

async function dragDockMoveButton(page: Page, deltaX: number, deltaY: number): Promise<void> {
  const button = page.getByRole('button', { name: 'Move reading dock' });
  await expect(button).toBeVisible();
  await dispatchMouseDrag(page, '.dock-move-button', deltaX, deltaY);
  await expect.poll(async () => page.evaluate(() => document.body.classList.contains('is-moving-dock'))).toBe(false);
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

async function persistedAssistantText(userDataDir: string): Promise<string> {
  const raw = await readFile(join(userDataDir, 'workspace/library.json'), 'utf8');
  const store = JSON.parse(raw) as { conversations?: Array<{ messages?: Array<{ role?: string; content?: string }> }> };
  return store.conversations
    ?.flatMap((conversation) => conversation.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content ?? '')
    .join('\n') ?? '';
}

async function persistedNotes(userDataDir: string): Promise<Array<{
  title?: string;
  markdown?: string;
  pageStart?: number;
  pageEnd?: number;
  source?: string;
}>> {
  const raw = await readFile(join(userDataDir, 'workspace/library.json'), 'utf8');
  const store = JSON.parse(raw) as { notes?: Array<{
    title?: string;
    markdown?: string;
    pageStart?: number;
    pageEnd?: number;
    source?: string;
  }> };
  return store.notes ?? [];
}

async function persistedStore(userDataDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(userDataDir, 'workspace/library.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function persistedSyncManifest(userDataDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(userDataDir, 'workspace/sync/manifest.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function persistedReadingState(userDataDir: string): Promise<{ lastPage?: number }> {
  const store = await persistedStore(userDataDir);
  const states = (store.readingStates ?? []) as Array<{ lastPage?: number }>;
  return states[0] ?? {};
}

async function persistedWorkspaceBlocks(userDataDir: string): Promise<Array<{
  contentKind?: string;
  kind?: string;
  pageNumber?: number;
  payload?: Record<string, unknown>;
  sourceKind?: string;
  sourceId?: string;
  title?: string;
  width?: number;
  x?: number;
  y?: number;
}>> {
  const store = await persistedStore(userDataDir);
  return (store.workspaceBlocks ?? []) as Array<{
    contentKind?: string;
    kind?: string;
    pageNumber?: number;
    payload?: Record<string, unknown>;
    sourceKind?: string;
    sourceId?: string;
    title?: string;
    width?: number;
    x?: number;
    y?: number;
  }>;
}

async function persistedGeneratedOutlines(userDataDir: string): Promise<Array<{
  source?: string;
  items?: Array<{ title?: string; pageNumber?: number; level?: number }>;
}>> {
  const store = await persistedStore(userDataDir);
  return (store.generatedOutlines ?? []) as Array<{
    source?: string;
    items?: Array<{ title?: string; pageNumber?: number; level?: number }>;
  }>;
}

async function corruptStoreBackupCount(userDataDir: string): Promise<number> {
  const entries = await readdir(join(userDataDir, 'workspace'));
  return entries.filter((entry) => entry.startsWith('library.corrupt-') && entry.endsWith('.json')).length;
}

async function persistedGitHubUpload(userDataDir: string): Promise<{
  enabled?: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  basePath?: string;
}> {
  const store = await persistedStore(userDataDir);
  return (store.githubUpload ?? {}) as {
    enabled?: boolean;
    owner?: string;
    repo?: string;
    branch?: string;
    basePath?: string;
  };
}

async function persistedAiProvider(userDataDir: string): Promise<{
  baseUrl?: string;
  model?: string;
}> {
  const store = await persistedStore(userDataDir);
  return (store.aiProvider ?? {}) as {
    baseUrl?: string;
    model?: string;
  };
}

async function persistedAppPreferences(userDataDir: string): Promise<{
  uiLanguage?: string;
  aiLanguage?: string;
  selectionColors?: Record<string, string>;
}> {
  const store = await persistedStore(userDataDir);
  return (store.appPreferences ?? {}) as {
    uiLanguage?: string;
    aiLanguage?: string;
    selectionColors?: Record<string, string>;
  };
}

async function centeredDialogDelta(page: Page, selector: string): Promise<number> {
  return page.evaluate((dialogSelector) => {
    const dialog = document.querySelector<HTMLElement>(dialogSelector);
    if (!dialog) {
      return Number.POSITIVE_INFINITY;
    }

    const rect = dialog.getBoundingClientRect();
    return Math.abs((window.innerWidth - rect.width) / 2 - rect.left);
  }, selector);
}

async function configurePlainAiProvider(userDataDir: string, baseUrl: string): Promise<void> {
  const storePath = join(userDataDir, 'workspace/library.json');
  await mkdir(dirname(storePath), { recursive: true });
  let store: Record<string, unknown>;
  try {
    const raw = await readFile(storePath, 'utf8');
    store = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    store = {};
  }
  store.aiProvider = {
    displayName: 'Failing provider',
    baseUrl,
    model: 'broken-model',
    temperature: 0.2,
    encryptedApiKey: Buffer.from('test-key', 'utf8').toString('base64'),
    encryption: 'plain'
  };
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

async function startModelListProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        data: [
          { id: 'sidelight-small', owned_by: 'test' },
          { id: 'sidelight-large', owned_by: 'test' }
        ]
      }));
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Model list provider did not bind to a TCP port.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

async function startSlowStreamingAiProvider(): Promise<{ server: Server; url: string; closedCount(): number }> {
  let closed = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });

    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `stream-part-${index} ` } }] })}\n\n`);
    }, 80);

    request.on('close', () => {
      closed += 1;
      clearInterval(timer);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Slow streaming AI provider did not bind to a TCP port.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    closedCount: () => closed
  };
}

async function startSlowNoteAiProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    request.resume();
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '# AI notes p.1-1\n\nGenerated note after opening the draft. Sidelight integration passage Alpha Beta.'
            }
          }
        ]
      }));
    }, 450);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Slow note AI provider did not bind to a TCP port.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

async function startToolCallingAiProvider(): Promise<{
  server: Server;
  url: string;
  firstRequestHadPdfTools(): boolean;
  lastToolResult(): string;
}> {
  let sawPdfTools = false;
  let toolResult = '';
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(rawBody) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      sawPdfTools = sawPdfTools || Boolean(payload.tools?.some((tool) => tool.function?.name === 'view_current_pdf'));
      const toolMessage = payload.messages?.find((message) => message.role === 'tool');

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      if (toolMessage?.content) {
        toolResult = toolMessage.content;
        const parsedToolResult = JSON.parse(toolMessage.content) as {
          returned_pages?: [number, number];
          pages?: Array<{ text?: string }>;
        };
        const pageNumber = parsedToolResult.returned_pages?.[0] ?? 0;
        const pageText = parsedToolResult.pages?.[0]?.text ?? '';
        const content = `tool-read-page-${pageNumber}: ${pageText.includes('Second page remembers its own reading state') ? 'Second page remembers its own reading state' : pageText}`;
        setTimeout(() => {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
          response.write('data: [DONE]\n\n');
          response.end();
        }, 350);
        return;
      }

      response.write(`data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_pdf_page_2',
                  type: 'function',
                  function: {
                    name: 'view_current_pdf',
                    arguments: JSON.stringify({ page_start: 2, page_end: 2, max_chars: 8000 })
                  }
                }
              ]
            }
          }
        ]
      })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Tool-calling AI provider did not bind to a TCP port.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    firstRequestHadPdfTools: () => sawPdfTools,
    lastToolResult: () => toolResult
  };
}

async function startGeneratedOutlineAiProvider(): Promise<{
  server: Server;
  url: string;
  lastToolResult(): string;
}> {
  let toolResult = '';
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }

    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      const payload = JSON.parse(rawBody) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      const toolMessages = payload.messages?.filter((message) => message.role === 'tool') ?? [];

      response.setHeader('content-type', 'application/json');
      if (toolMessages.length > 0) {
        toolResult = toolMessages.map((message) => message.content ?? '').join('\n');
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  items: [
                    { title: 'Integration setup', level: 0, pageNumber: 1 },
                    { title: 'Reading state', level: 0, pageNumber: 2 },
                    { title: 'Fixture appendix', level: 0, pageNumber: 3 }
                  ]
                })
              }
            }
          ]
        }));
        return;
      }

      const hasPdfTool = payload.tools?.some((tool) => tool.function?.name === 'view_current_pdf');
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: hasPdfTool
                ? [
                    {
                      id: 'call_outline_pages',
                      type: 'function',
                      function: {
                        name: 'view_current_pdf',
                        arguments: JSON.stringify({ page_start: 1, page_end: 3, max_chars: 12000 })
                      }
                    }
                  ]
                : []
            }
          }
        ]
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Generated outline AI provider did not bind to a TCP port.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`,
    lastToolResult: () => toolResult
  };
}

async function startFailingAiProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.statusCode = 502;
    response.statusMessage = 'Bad Gateway';
    response.setHeader('content-type', 'text/html; charset=UTF-8');
    response.end('<!DOCTYPE html><html><head><title>502: Bad gateway</title><meta name="robots" content="noindex"></head><body><h1>Bad gateway</h1></body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failing AI provider did not bind to a TCP port.');
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
