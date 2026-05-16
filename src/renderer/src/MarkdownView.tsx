import type { ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

interface MarkdownViewProps {
  children: string;
}

export function MarkdownView({ children }: MarkdownViewProps): ReactElement {
  const markdown = normalizeLatexDelimiters(children);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children: linkChildren, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {linkChildren}
          </a>
        )
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
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
