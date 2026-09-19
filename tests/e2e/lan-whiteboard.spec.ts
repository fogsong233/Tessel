import { chromium, expect, test, type Browser } from '@playwright/test';
import { once } from 'node:events';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { LanWhiteboardServer } from '../../src/main/lanWhiteboardServer';
import type { JsonWorkspaceStore } from '../../src/main/store';
import type { WorkspaceBlock } from '../../src/shared/domain';
import type { LanDrawingStroke, LanWhiteboardClientMessage, LanWhiteboardServerMessage } from '../../src/shared/lanWhiteboard';
import { preserveInkIdentity, withPendingInk } from '../../src/renderer/src/remote/remoteSync';

const stroke = (id: string): LanDrawingStroke => ({ id, color: '#171a16', size: 4, simulatePressure: false, createdAt: new Date().toISOString(), points: [[20, 20, .4], [45, 50, .7]] });
const sheet = (id: string, index: number): WorkspaceBlock => ({
  id, documentId: 'pdf_fixture', kind: 'drawing', anchor: 'page', pageNumber: 1,
  title: 'Tablet notebook', x: 0, y: 0, width: 612, height: 792,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  payload: { canvasWidth: 612, canvasHeight: 792, side: 'left', sheetIndex: index, strokes: [] }
});

async function fixture(delay: number, count = 2) {
  const saved = new Map(Array.from({ length: count }, (_, i) => [String(i + 1), sheet(String(i + 1), i)]));
  const savedCounts: number[] = [];
  const store = {
    listDocuments: async () => [{ id: 'pdf_fixture', title: 'Calculus · 微积分笔记', pageCount: 10 }],
    listAllWorkspaceBlocks: async () => [...saved.values()],
    getOrCreateLanWhiteboardTrustSecret: async () => 'test-secret',
    saveWorkspaceBlock: async (block: WorkspaceBlock) => {
      await new Promise((done) => setTimeout(done, delay));
      saved.set(block.id, block);
      savedCounts.push((block.payload?.strokes as LanDrawingStroke[]).length);
      return block;
    }
  } as unknown as JsonWorkspaceStore;
  process.env.TESSEL_LAN_WHITEBOARD_PORT = '0';
  const server = new LanWhiteboardServer({ rendererDirectory: resolve('out/renderer'), store, runMutation: (op) => op(), publishToRenderers: () => {} });
  await server.start();
  const url = new URL(server.getInfo().urls[0]);
  url.hostname = '127.0.0.1';
  return { server, saved, savedCounts, url: url.toString() };
}

test('rebases delayed ink acknowledgements without erasing new strokes or undo', () => {
  const a = stroke('a');
  const b = stroke('b');
  const base = sheet('1', 0);
  const commits = [a, b].map((value) => ({ type: 'stroke-commit' as const, canvasId: '1', requestId: value.id, stroke: value }));
  const earlier = { ...base, payload: { ...base.payload, strokes: [a] } };
  expect(withPendingInk(earlier, commits).payload?.strokes).toEqual([a, b]);
  expect(withPendingInk(earlier, [...commits, { type: 'replace-strokes', canvasId: '1', requestId: 'undo', strokes: [a] }]).payload?.strokes).toEqual([a]);
  expect(withPendingInk(sheet('2', 1), commits).payload?.strokes).toEqual([]);
  const echoed = JSON.parse(JSON.stringify(earlier)) as WorkspaceBlock;
  expect((preserveInkIdentity(echoed, earlier).payload!.strokes as LanDrawingStroke[])[0]).toBe(a);
  (echoed.payload!.strokes as LanDrawingStroke[])[0].points[0][0] += 5;
  expect((preserveInkIdentity(echoed, earlier).payload!.strokes as LanDrawingStroke[])[0]).not.toBe(a);
});

test('serializes rapid saves across sockets and keeps previews responsive during disk writes', async () => {
  const { server, saved, url } = await fixture(35, 1);
  const socketUrl = new URL(url); socketUrl.protocol = 'ws:'; socketUrl.pathname = '/whiteboard';
  const a = new WebSocket(socketUrl);
  const b = new WebSocket(socketUrl);
  const messages: LanWhiteboardServerMessage[] = [];
  a.on('message', (data) => messages.push(JSON.parse(data.toString())));
  b.on('message', (data) => messages.push(JSON.parse(data.toString())));
  try {
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    for (let i = 0; i < 24; i++) {
      (i % 2 ? a : b).send(JSON.stringify({ type: 'stroke-commit', canvasId: '1', requestId: `commit_${i}`, stroke: stroke(`stroke_${i}`) } satisfies LanWhiteboardClientMessage));
    }
    a.send(JSON.stringify({ type: 'stroke-begin', canvasId: '1', stroke: stroke('preview') }));
    await expect.poll(() => messages.some((message) => message.type === 'stroke-begin')).toBe(true);
    expect(messages.filter((message) => message.type === 'ack').length).toBeLessThan(24);
    await expect.poll(() => (saved.get('1')!.payload!.strokes as LanDrawingStroke[]).length).toBe(24);
    const ids = (saved.get('1')!.payload!.strokes as LanDrawingStroke[]).map((stroke) => stroke.id);
    expect(new Set(ids).size).toBe(24);
    a.send(JSON.stringify({ type: 'replace-strokes', canvasId: '1', requestId: 'undo_all', strokes: [] }));
    a.send(JSON.stringify({ type: 'stroke-commit', canvasId: '1', requestId: 'after_undo', stroke: stroke('last') }));
    await expect.poll(() => (saved.get('1')!.payload!.strokes as LanDrawingStroke[]).map((stroke) => stroke.id)).toEqual(['last']);
  } finally { a.close(); b.close(); await server.stop(); }
});

test('tablet keeps adjacent pages, tools and rapid ink stable through slow saves', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const { server, saved, url } = await fixture(180);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.TESSEL_TEST_CHROMIUM || undefined });
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('.remote-status.is-connected')).toBeVisible();
    await page.getByRole('button', { name: '隐藏纸张列表' }).click();
    const paper = page.locator('.remote-canvas__paper').first();
    await expect(page.locator('.remote-canvas__paper')).toHaveCount(2);
    await page.getByRole('button', { name: '画笔设置', exact: true }).click();
    await page.getByRole('button', { name: '8 像素笔刷' }).click();
    await page.getByRole('button', { name: '墨水颜色 #2563eb' }).click();
    await page.locator('.remote-brush-advanced summary').click();
    await page.getByRole('checkbox', { name: /手指书写/ }).check();
    await page.getByRole('checkbox', { name: /手指书写/ }).uncheck();
    await page.screenshot({ path: testInfo.outputPath('brush-tablet.png') });
    await page.getByRole('button', { name: '关闭画笔设置' }).click();
    // Real frames between strokes, but no wait for any server acknowledgement.
    await paper.evaluate(async (node) => {
      const box = node.getBoundingClientRect();
      for (let i = 0; i < 18; i++) {
        const x = box.x + 80 + (i % 6) * 60;
        const y = Math.max(box.y, 140) + 80 + Math.floor(i / 6) * 60;
        const pointer = { bubbles: true, pointerId: 1, pointerType: 'pen', button: 0, buttons: 1, clientX: x, clientY: y, pressure: .5 };
        node.dispatchEvent(new PointerEvent('pointerdown', pointer));
        node.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: x + 28, clientY: y + 20, pressure: .8 }));
        node.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: x + 28, clientY: y + 20, buttons: 0, pressure: 0 }));
        await new Promise(requestAnimationFrame);
      }
    });
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(18);
    const paths = await paper.locator('.remote-ink-persisted path').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
    await expect.poll(() => (saved.get('1')!.payload!.strokes as unknown[]).length).toBe(18);
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(18);
    expect(await paper.locator('.remote-ink-persisted path').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')))).toEqual(paths);

    await page.getByRole('button', { name: '橡皮擦' }).click();
    await page.getByRole('button', { name: '显示纸张列表' }).click();
    await page.getByRole('button', { name: 'PDF 第 1 页 · 纸张 2', exact: true }).click();
    await expect(page.locator('.remote-canvas__identity')).toContainText('2/2');
    await expect(page.getByRole('button', { name: '橡皮擦' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '浏览模式' }).click();
    await page.getByRole('button', { name: 'PDF 第 1 页 · 纸张 1', exact: true }).click();
    await expect(page.getByRole('button', { name: '浏览模式' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '隐藏纸张列表' }).click();
    await page.getByRole('button', { name: '画笔设置', exact: true }).click();
    await expect(page.getByRole('slider', { name: '笔刷宽度' })).toHaveValue('8');
    await expect(page.getByRole('button', { name: '墨水颜色 #2563eb' })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.remote-brush-advanced summary').click();
    await expect(page.getByRole('checkbox', { name: /手指书写/ })).not.toBeChecked();
    await page.getByRole('button', { name: '关闭画笔设置' }).click();
    await page.waitForTimeout(1100);
    await page.locator('.remote-canvas__viewport').evaluate((node) => {
      const second = node.querySelectorAll('.remote-sheet')[1].getBoundingClientRect();
      node.scrollTop += second.top - node.getBoundingClientRect().top - node.clientHeight / 2;
    });
    expect(await page.locator('.remote-canvas__paper').evaluateAll((nodes) => nodes.map((node) => {
      const paper = node.getBoundingClientRect();
      const viewport = node.closest('.remote-canvas__viewport')!.getBoundingClientRect();
      return paper.bottom > viewport.top && paper.top < viewport.bottom;
    }))).toEqual([true, true]);
    await page.screenshot({ path: testInfo.outputPath('continuous-tablet.png') });
    // Plain wheel scrolls the same mounted sheets, including both at the seam.
    const viewport = page.locator('.remote-canvas__viewport');
    const before = await viewport.evaluate((node) => node.scrollTop);
    await page.mouse.move(500, 400);
    await page.mouse.wheel(0, 90);
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(before + 30);
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(18);
    const cdp = await context.newCDPSession(page);
    const touchBefore = await viewport.evaluate((node) => node.scrollTop);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 490 }] });
    for (let y = 480; y >= 350; y -= 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(touchBefore + 50);
    await page.waitForTimeout(400);
    const pinchPoint = () => page.locator('.remote-sheet').last().evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { x: (500 - box.x) / box.width, y: (380 - box.y) / box.height };
    });
    const anchorBefore = await pinchPoint();
    const zoomBefore = Number((await page.locator('.remote-zoom__value').innerText()).replace('%', ''));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 420, y: 380, id: 1 }, { x: 580, y: 380, id: 2 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 420 - i * 8, y: 380, id: 1 }, { x: 580 + i * 8, y: 380, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => Number((await page.locator('.remote-zoom__value').innerText()).replace('%', ''))).toBeGreaterThan(zoomBefore + 30);
    const anchorAfter = await pinchPoint();
    expect(Math.abs(anchorAfter.x - anchorBefore.x)).toBeLessThan(.02);
    expect(Math.abs(anchorAfter.y - anchorBefore.y)).toBeLessThan(.02);
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(18);
    await page.getByRole('button', { name: '适合宽度' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '画笔设置', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('brush-phone.png') });
    const panel = await page.getByRole('region', { name: '画笔设置' }).boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
    expect(await page.locator('.remote-tools').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.reload();
    await expect(page.locator('.remote-ink-persisted path')).toHaveCount(18);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await server.stop(); }
});

test('long pen strokes update only a bounded live tail and cancelled strokes do not erase ink', async ({}, testInfo) => {
  const { server, saved, url } = await fixture(30, 1);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.TESSEL_TEST_CHROMIUM || undefined });
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.goto(url);
    const surface = page.locator('.remote-canvas__paper');
    await expect(surface).toBeVisible();
    const measured = await surface.evaluate(async (node) => {
      const rect = node.getBoundingClientRect();
      const pointer = { bubbles: true, pointerId: 8, pointerType: 'pen', button: 0, buttons: 1, clientX: rect.x + 70, clientY: rect.y + 100, pressure: .5 };
      let savedMutations = 0;
      const observer = new MutationObserver((changes) => { savedMutations += changes.length; });
      observer.observe(node.querySelector('.remote-ink-persisted')!, { childList: true, subtree: true, attributes: true });
      node.dispatchEvent(new PointerEvent('pointerdown', pointer));
      const frameTimes: number[] = [];
      for (let frame = 0; frame < 36; frame++) {
        const start = performance.now();
        for (let i = 0; i < 50; i++) {
          const p = frame * 50 + i;
          node.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: rect.x + 70 + (p % 450), clientY: rect.y + 100 + Math.sin(p / 30) * 50 + Math.floor(p / 450) * 65 }));
        }
        await new Promise(requestAnimationFrame);
        frameTimes.push(performance.now() - start);
      }
      const chunks = [...node.querySelectorAll('.remote-ink-live path')];
      const maxPathLength = Math.max(...chunks.map((path) => path.getAttribute('d')!.length));
      const livePath = chunks.map((path) => path.getAttribute('d')).join(' ');
      observer.disconnect();
      node.dispatchEvent(new PointerEvent('pointerup', { ...pointer, clientX: rect.x + 70 + 449, clientY: rect.y + 100 + Math.sin(1799 / 30) * 50 + 195, buttons: 0, pressure: 0 }));
      return { livePath, savedMutations, chunks: chunks.length, maxPathLength, frameP95: frameTimes.sort((a, b) => a - b)[Math.floor(frameTimes.length * .95)] };
    });
    expect(measured.savedMutations).toBe(0);
    expect(measured.chunks).toBeGreaterThan(20);
    expect(measured.maxPathLength).toBeLessThan(30_000);
    await testInfo.attach('ink-frame-measurements', { body: JSON.stringify({ ...measured, livePath: undefined }), contentType: 'application/json' });
    await expect.poll(() => (saved.get('1')!.payload!.strokes as LanDrawingStroke[])[0]?.points.length ?? 0).toBeGreaterThanOrEqual(1800);
    await expect(surface.locator('.remote-ink-persisted path')).toHaveCount(1);
    expect(await surface.locator('.remote-ink-persisted path').getAttribute('d')).toBe(measured.livePath);
    const pointsBefore = (saved.get('1')!.payload!.strokes as LanDrawingStroke[])[0].points;
    await surface.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const pointer = { bubbles: true, pointerId: 9, pointerType: 'pen', button: 0, buttons: 1, clientX: rect.x + 100, clientY: rect.y + 100, pressure: .5 };
      node.dispatchEvent(new PointerEvent('pointerdown', pointer));
      node.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: rect.x + 150 }));
      node.dispatchEvent(new PointerEvent('pointercancel', pointer));
    });
    await expect(surface.locator('.remote-ink-live path')).toHaveCount(0);
    await expect(surface.locator('.remote-ink-persisted path')).toHaveCount(1);
    await page.reload();
    await expect(surface.locator('.remote-ink-persisted path')).toHaveCount(1);
    expect((saved.get('1')!.payload!.strokes as LanDrawingStroke[])[0].points).toEqual(pointsBefore);
  } finally { await browser?.close(); await server.stop(); }
});

test('reconnect replays unacknowledged ink and preserves undo order', async () => {
  const { server, saved, savedCounts, url } = await fixture(220, 1);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.TESSEL_TEST_CHROMIUM || undefined });
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.addInitScript(() => {
      const sockets: WebSocket[] = [];
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols); sockets.push(this);
          this.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'ack' && message.requestId.startsWith('replace_')) Object.assign(window, { whiteboardUndoAcknowledged: true });
          });
        }
      };
      Object.assign(window, { closeWhiteboardSocket: () => sockets.at(-1)?.close() });
    });
    await page.goto(url);
    const paper = page.locator('.remote-canvas__paper');
    await expect(paper).toBeVisible();
    await paper.evaluate(async (node) => {
      const box = node.getBoundingClientRect();
      for (let i = 0; i < 3; i++) {
        const pointer = { bubbles: true, pointerId: 4, pointerType: 'pen', button: 0, buttons: 1, clientX: box.x + 50 + i * 40, clientY: box.y + 100, pressure: .6 };
        node.dispatchEvent(new PointerEvent('pointerdown', pointer));
        node.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0, pressure: 0 }));
        await new Promise(requestAnimationFrame);
      }
    });
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(3);
    await page.getByRole('button', { name: '撤销' }).click();
    await page.evaluate(() => (window as unknown as { closeWhiteboardSocket(): void }).closeWhiteboardSocket());
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(2);
    // Replayed commits must not resurrect the third stroke removed by undo.
    await expect.poll(() => (saved.get('1')!.payload!.strokes as LanDrawingStroke[]).length).toBe(2);
    await expect(page.locator('.remote-status.is-connected')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { whiteboardUndoAcknowledged?: boolean }).whiteboardUndoAcknowledged)).toBe(true);
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(2);
    expect((saved.get('1')!.payload!.strokes as LanDrawingStroke[])).toHaveLength(2);
    expect(savedCounts).toEqual([1, 2, 3, 2]);
    await page.reload();
    await expect(paper.locator('.remote-ink-persisted path')).toHaveCount(2);
  } finally { await browser?.close(); await server.stop(); }
});
