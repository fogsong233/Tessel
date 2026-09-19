import { chromium, expect, test, type Browser } from '@playwright/test';

test('streaming Markdown keeps loaded images mounted, preserves code, and displays citations and failed image links', async ({}, info) => {
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const html = `<!doctype html><html><body><div class="chat-message--assistant"><div class="chat-bubble" id="root" style="width:640px"></div></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MarkdownView} from '/src/renderer/src/MarkdownView.tsx';
    import '/src/renderer/src/styles.css';
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    window.imageReads=0;
    window.sidelight={resolveLocalImage:async()=>{window.imageReads++;return image;},resolveRemoteImage:async()=>undefined,openLocalPath:async()=>{}};
    const root=createRoot(document.getElementById('root'));
    window.renderMarkdown=text=>root.render(React.createElement(MarkdownView,{visualLinkPreviews:false},text));
  </script></body></html>`;
  const server = await createServer({ configFile: false, plugins: [react(), {
    name: 'markdown-test',
    configureServer(server) {
      server.middlewares.use('/markdown-fixture.html', async (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/markdown-fixture.html', html));
      });
    }
  }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    browser = await chromium.launch({ executablePath: process.env.TESSEL_TEST_CHROMIUM || undefined });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/markdown-fixture.html`);
    await page.waitForFunction(() => typeof (window as any).renderMarkdown === 'function');
    const code = 'const source = "![Example](sandbox:/tmp/a b.png)";\nconst math = "\\(x\\)";';
    const markdown = `![Chart](sandbox:/tmp/chart.png)\n\n\`\`\`js\n${code}\n\`\`\`\n\nSource :codex-file-citation{path="D:\\paper\\Book 100%.pdf" purpose="source"}\n\n`;
    await page.evaluate((text) => (window as any).renderMarkdown(text), markdown);
    const image = page.getByAltText('Chart');
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
    await image.evaluate((node) => { (node as any).originalImage = true; });
    for (let index = 0; index < 8; index++) {
      await page.evaluate((text) => (window as any).renderMarkdown(text), markdown + 'Streamed text. '.repeat(index + 1));
      await expect(page.locator('.markdown-view')).toContainText('Streamed text. '.repeat(index + 1).trim());
    }
    expect(await image.evaluate((node) => (node as any).originalImage)).toBe(true);
    expect(await page.evaluate(() => (window as any).imageReads)).toBe(1);
    await expect(page.locator('pre code')).toHaveText(code + '\n');
    await expect(page.getByRole('link', { name: 'Book 100%.pdf' })).toHaveAttribute('href', 'file:///D:/paper/Book%20100%25.pdf');
    await expect(page.locator('.markdown-view')).not.toContainText(':codex-file-citation');
    await page.evaluate((text) => (window as any).renderMarkdown(text), markdown + '![Unavailable](https://example.com/missing.png)');
    await expect(page.getByRole('link', { name: 'Unavailable' })).toBeVisible();
    await expect(page.locator('.markdown-view__image-pending')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('markdown.png') });
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await server.close(); }
});
