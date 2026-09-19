import { type ComponentPropsWithoutRef, type ReactNode, type ReactElement, createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import { localPathFromMarkdownUrl, normalizeMarkdownText, toFileUrl } from '../../shared/markdownText';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

interface MarkdownViewProps {
  children: string;
  visualLinkPreviews?: boolean;
}

const VisualPreviewContext = createContext(false);
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];
const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  img: ({ node: _node, ...props }) => <MarkdownImage {...props} />
};

export const MarkdownView = memo(function MarkdownView({ children, visualLinkPreviews = true }: MarkdownViewProps): ReactElement {
  const markdown = useMemo(() => normalizeMarkdownText(cleanStoredAiError(children)), [children]);
  const showVisualLinkPreviews = visualLinkPreviews && messageRequestsVisual(markdown);
  return (
    <VisualPreviewContext.Provider value={showVisualLinkPreviews}>
      <div className="markdown-view">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
          urlTransform={markdownUrl} components={markdownComponents}>{markdown}</ReactMarkdown>
      </div>
    </VisualPreviewContext.Provider>
  );
});

function markdownUrl(url: string): string {
  const path = localPathFromMarkdownUrl(url);
  return path ? toFileUrl(path) : /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|avif);base64,/i.test(url) ? url : defaultUrlTransform(url);
}

function MarkdownLink({
  children,
  href,
  ...props
}: ComponentPropsWithoutRef<'a'> & { children?: ReactNode }): ReactElement {
  const showVisualPreview = useContext(VisualPreviewContext);
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
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(shouldResolveRemotely || localPath ? undefined : localUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    setResolvedUrl(shouldResolveRemotely || localPath ? undefined : localUrl);
    setFailed(false);
    if ((!shouldResolveRemotely && !localPath) || !src) {
      return () => {
        disposed = true;
      };
    }

    void (localPath ? window.sidelight.resolveLocalImage(localPath) : window.sidelight.resolveRemoteImage(src)).then((value) => {
      if (!disposed) {
        setResolvedUrl(value);
        setFailed(!value);
      }
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
    };
  }, [localPath, localUrl, shouldResolveRemotely, src]);

  if (failed) {
    return src ? <MarkdownLink className="markdown-view__image-source" href={src}>{alt || src}</MarkdownLink> : <span />;
  }

  if (!resolvedUrl) {
    return <span className="markdown-view__image-pending">{alt}</span>;
  }

  return <img {...props} src={resolvedUrl} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
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
