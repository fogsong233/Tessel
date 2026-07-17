import { type ComponentPropsWithoutRef, type ReactNode, type ReactElement, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

interface MarkdownViewProps {
  children: string;
}

export function MarkdownView({ children }: MarkdownViewProps): ReactElement {
  const markdown = normalizeLatexDelimiters(normalizeLocalMarkdownLinks(cleanStoredAiError(children)));
  const showVisualLinkPreviews = messageRequestsVisual(markdown);

  return (
    <div className="markdown-view">
      <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={(url) => {
        const localPath = localPathFromMarkdownUrl(url);
        return localPath ? toFileUrl(localPath) : url;
      }}
      components={{
        a: ({ children: linkChildren, href, ...props }) => (
          <MarkdownLink href={href} showVisualPreview={showVisualLinkPreviews} {...props}>{linkChildren}</MarkdownLink>
        ),
        img: ({ src, alt, ...props }) => <MarkdownImage src={src} alt={alt ?? ''} {...props} />
      }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownLink({
  children,
  href,
  showVisualPreview,
  ...props
}: ComponentPropsWithoutRef<'a'> & { children?: ReactNode; showVisualPreview: boolean }): ReactElement {
  const localPath = localPathFromMarkdownUrl(href);
  const targetUrl = localPath ? toFileUrl(localPath) : href;
  const canPreview = Boolean(showVisualPreview && href && !localPath && /^https?:\/\//i.test(href));
  const [previewUrl, setPreviewUrl] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setPreviewUrl(undefined);
    if (!canPreview || !href) {
      return () => {
        disposed = true;
      };
    }
    void window.sidelight.resolveRemoteImage(href).then((value) => {
      if (!disposed) {
        setPreviewUrl(value);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [canPreview, href]);

  return (
    <>
      <a
        {...props}
        href={targetUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!localPath) {
            return;
          }
          event.preventDefault();
          void window.sidelight.openLocalPath(localPath);
        }}
      >
        {children}
      </a>
      {previewUrl && href ? (
        <a className="markdown-view__visual-link-preview" href={href} target="_blank" rel="noreferrer" aria-label="Open image source">
          <img src={previewUrl} alt="Image from linked source" loading="lazy" />
        </a>
      ) : null}
    </>
  );
}

function MarkdownImage({ src, alt = '', ...props }: ComponentPropsWithoutRef<'img'>): ReactElement {
  const localPath = localPathFromMarkdownUrl(src);
  const localUrl = localPath ? toFileUrl(localPath) : src;
  const shouldResolveRemotely = Boolean(src && !localPath && /^https?:\/\//i.test(src));
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(shouldResolveRemotely ? undefined : localUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    setResolvedUrl(shouldResolveRemotely ? undefined : localUrl);
    setFailed(false);
    if (!shouldResolveRemotely || !src) {
      return () => {
        disposed = true;
      };
    }

    void window.sidelight.resolveRemoteImage(src).then((value) => {
      if (!disposed && value) {
        setResolvedUrl(value);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [localUrl, shouldResolveRemotely, src]);

  if (failed) {
    return src ? <a className="markdown-view__image-source" href={src} target="_blank" rel="noreferrer">{alt || src}</a> : <span />;
  }

  if (!resolvedUrl) {
    return <span className="markdown-view__image-pending">{alt}</span>;
  }

  return <img {...props} src={resolvedUrl} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

function normalizeLocalMarkdownLinks(markdown: string): string {
  return markdown.replace(/(!?\[[^\]]*\]\()((?:sandbox:|file:|\/|[A-Za-z]:[\\/])[^)]+)(\))/g, (_match, prefix: string, url: string, suffix: string) => {
    const trimmed = url.trim();
    if (!trimmed) {
      return _match;
    }
    return `${prefix}${encodeURI(trimmed).replace(/#/g, '%23')}${suffix}`;
  });
}

function localPathFromMarkdownUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^sandbox:/i.test(trimmed)) {
    return absoluteLocalPath(sandboxLocalPath(trimmed));
  }

  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const pathname = decodeURIComponent(url.pathname);
      if (url.hostname) {
        return `\\\\${url.hostname}${pathname.replaceAll('/', '\\')}`;
      }
      return absoluteLocalPath(pathname);
    } catch {
      return undefined;
    }
  }

  return absoluteLocalPath(trimmed);
}

function toFileUrl(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return `file:///${encodeURI(path.replaceAll('\\', '/')).replace(/#/g, '%23')}`;
  }
  if (/^\\\\[^\\]+\\/.test(path)) {
    return `file://${encodeURI(path.replaceAll('\\', '/')).replace(/#/g, '%23')}`;
  }
  return `file://${encodeURI(path).replace(/#/g, '%23')}`;
}

function absoluteLocalPath(value: string): string | undefined {
  const decoded = decodeURIComponent(value);
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) {
    return decoded.slice(1);
  }
  return decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded) || /^\\\\[^\\]+\\/.test(decoded)
    ? decoded
    : undefined;
}

function sandboxLocalPath(value: string): string {
  const path = value.replace(/^sandbox:/i, '');
  return /^\/{1,2}[A-Za-z]:[\\/]/.test(path) ? path.replace(/^\/+/, '') : path;
}

function messageRequestsVisual(markdown: string): boolean {
  return /(?:\b(?:image|photo|portrait|avatar|picture)\b|图片|照片|头像|图像|这张图|这张是|上面这张)/i.test(markdown);
}

function cleanStoredAiError(markdown: string): string {
  if (!/^AI request failed:/i.test(markdown.trim()) || !/<(?:!doctype|html|head|body|script|style|div|meta|title)\b/i.test(markdown)) {
    return markdown;
  }

  const title = markdown.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = markdown.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const summary = stripHtml(title ?? heading ?? markdown);
  return summary ? `AI request failed: ${limitErrorText(summary)}` : 'AI request failed: The provider returned an HTML error page.';
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function limitErrorText(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function normalizeLatexDelimiters(markdown: string): string {
  return transformOutsideCode(markdown, (chunk) =>
    chunk
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => {
        const trimmed = expression.trim();
        return trimmed ? `\n$$\n${trimmed}\n$$\n` : _match;
      })
      .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expression: string) => {
        const trimmed = expression.trim();
        return trimmed ? `$${trimmed}$` : _match;
      })
  );
}

function transformOutsideCode(markdown: string, transform: (chunk: string) => string): string {
  let output = '';
  let index = 0;

  while (index < markdown.length) {
    const fence = findOpeningFence(markdown, index);
    const inlineCode = markdown.indexOf('`', index);
    const nextSpecial = [fence?.index, inlineCode].filter((value): value is number => value !== undefined && value >= 0);

    if (nextSpecial.length === 0) {
      output += transform(markdown.slice(index));
      break;
    }

    const nextIndex = Math.min(...nextSpecial);
    output += transform(markdown.slice(index, nextIndex));

    if (fence && fence.index === nextIndex) {
      const closingIndex = markdown.indexOf(fence.marker, fence.index + fence.marker.length);
      if (closingIndex === -1) {
        output += markdown.slice(fence.index);
        break;
      }

      const endIndex = closingIndex + fence.marker.length;
      output += markdown.slice(fence.index, endIndex);
      index = endIndex;
      continue;
    }

    const marker = readBacktickRun(markdown, inlineCode);
    const closingIndex = markdown.indexOf(marker, inlineCode + marker.length);
    if (closingIndex === -1) {
      output += markdown.slice(inlineCode);
      break;
    }

    const endIndex = closingIndex + marker.length;
    output += markdown.slice(inlineCode, endIndex);
    index = endIndex;
  }

  return output;
}

function findOpeningFence(markdown: string, start: number): { index: number; marker: string } | undefined {
  const fenceMatch = /(^|\n)(`{3,}|~{3,})/.exec(markdown.slice(start));
  if (!fenceMatch || fenceMatch.index === undefined) {
    return undefined;
  }

  const prefixLength = fenceMatch[1]?.length ?? 0;
  const index = start + fenceMatch.index + prefixLength;
  return {
    index,
    marker: fenceMatch[2]
  };
}

function readBacktickRun(markdown: string, start: number): string {
  let end = start;
  while (markdown[end] === '`') {
    end += 1;
  }

  return markdown.slice(start, end);
}
