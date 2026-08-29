export interface VersionedReleaseNote {
  version?: string;
  note?: string | null;
}

export function normalizeUpdateReleaseNotes(
  notes: string | VersionedReleaseNote[] | null | undefined
): string | undefined {
  const markdown = typeof notes === 'string'
    ? releaseNoteToMarkdown(notes)
    : Array.isArray(notes)
      ? notes
        .map((entry) => {
          const body = releaseNoteToMarkdown(entry.note ?? '');
          if (!body) {
            return '';
          }
          return entry.version ? `## ${entry.version}\n\n${body}` : body;
        })
        .filter(Boolean)
        .join('\n\n')
      : '';

  return markdown || undefined;
}

function releaseNoteToMarkdown(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  if (!/<\/?(?:a|blockquote|br|code|del|div|em|h[1-6]|li|ol|p|pre|strong|table|tbody|td|th|thead|tr|ul)\b/i.test(normalized)) {
    return normalized;
  }

  return htmlReleaseNoteToMarkdown(normalized);
}

function htmlReleaseNoteToMarkdown(html: string): string {
  const withBlockStructure = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<pre\b[^>]*>\s*(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code\s*>)?\s*<\/pre\s*>/gi, (_match, code: string) => {
      const decoded = decodeHtmlEntities(code.replace(/<[^>]*>/g, '')).trim();
      return decoded ? `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n` : '';
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_match, level: string, content: string) => {
      return `\n\n${'#'.repeat(Number(level))} ${inlineHtmlToMarkdown(content)}\n\n`;
    })
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_match, content: string) => {
      const quote = inlineHtmlToMarkdown(content).replace(/\s*\n\s*/g, '\n').trim();
      return quote ? `\n\n${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : '';
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_match, content: string) => `\n- ${inlineHtmlToMarkdown(content).trim()}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|ul|ol|table|thead|tbody|tr)\s*>/gi, '\n\n')
    .replace(/<\/(?:th|td)\s*>/gi, ' | ')
    .replace(/<(?:p|div|ul|ol|table|thead|tbody|tr|th|td)\b[^>]*>/gi, '');

  return decodeHtmlEntities(inlineHtmlToMarkdown(withBlockStructure, false).replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inlineHtmlToMarkdown(value: string, compact = true): string {
  const converted = value
    .replace(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quote: string, href: string, label: string) => {
      const text = inlineHtmlToMarkdown(label).trim();
      const decodedHref = decodeHtmlEntities(href).trim();
      return text && /^https?:\/\//i.test(decodedHref) ? `[${text}](${decodedHref})` : text;
    })
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, '**$1**')
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, '*$1*')
    .replace(/<(?:del|s)\b[^>]*>([\s\S]*?)<\/(?:del|s)\s*>/gi, '~~$1~~')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return compact ? converted.replace(/\s+/g, ' ') : converted;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function safeCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}
