/** Apply display conversions without rewriting fenced, indented, or inline code. */
export function transformOutsideCode(markdown: string, transform: (text: string) => string): string {
  const tokens = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|^(?: {4}|\t)[^\n]*(?:\n|$)|`+/gm;
  let output = '';
  let position = 0;
  for (let token = tokens.exec(markdown); token; token = tokens.exec(markdown)) {
    output += transform(markdown.slice(position, token.index));
    let end = tokens.lastIndex;
    if (token[1]) {
      const marker = token[1];
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?$`, 'gm');
      closing.lastIndex = end;
      const match = closing.exec(markdown);
      end = match ? closing.lastIndex : markdown.length;
    } else if (token[0].startsWith('`')) {
      const runs = /`+/g;
      runs.lastIndex = end;
      let closing = runs.exec(markdown);
      while (closing && closing[0].length !== token[0].length) closing = runs.exec(markdown);
      end = closing ? runs.lastIndex : markdown.length;
    }
    output += markdown.slice(token.index, end);
    position = end;
    tokens.lastIndex = end;
  }
  return output + transform(markdown.slice(position));
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function localPathFromMarkdownUrl(value: string | undefined): string | undefined {
  let path = value?.trim();
  if (!path) return undefined;
  if (/^sandbox:/i.test(path)) path = path.replace(/^sandbox:/i, '').replace(/^\/{1,2}(?=[A-Za-z]:[\\/])/, '');
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      path = url.hostname ? `//${url.hostname}${url.pathname}` : url.pathname;
    } catch { return undefined; }
  }
  path = decodePath(path);
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\/.test(path) ? path : undefined;
}

export function toFileUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}` : normalized.startsWith('//') ? `file:${encoded}` : `file://${encoded}`;
}

function normalizeLocalLinks(text: string): string {
  const opening = /!?\[[^\]]*\]\((?=<?(?:sandbox:|file:|\/|[A-Za-z]:[\\/]))/g;
  let result = '';
  let cursor = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const start = opening.lastIndex;
    let end = start;
    if (text[start] === '<') {
      end = text.indexOf('>', start + 1) + 1;
      if (!end || text[end] !== ')') continue;
    } else {
      let depth = 1;
      while (end < text.length && text[end] !== '\n') {
        if (text[end] === '(') depth++;
        if (text[end] === ')' && --depth === 0) break;
        end++;
      }
      if (depth !== 0) continue;
    }
    const target = text.slice(start, end).trim();
    const local = localPathFromMarkdownUrl(target.startsWith('<') ? target.slice(1, -1) : target);
    if (!local) continue;
    result += text.slice(cursor, start) + `<${toFileUrl(local)}>)`;
    cursor = end + 1;
    opening.lastIndex = cursor;
  }
  return result + text.slice(cursor);
}

export function normalizeMarkdownText(markdown: string): string {
  return transformOutsideCode(markdown, (text) => {
    const citations = text.replace(/:codex-(file-citation|image)\{([^}]*\bpath="([^"]+)"[^}]*)\}/g, (_match, kind: string, _attributes: string, path: string) => {
      const local = localPathFromMarkdownUrl(path);
      if (!local) return '';
      const label = (local.split(/[\\/]/).pop() || 'Source').replace(/[\[\]]/g, '');
      return `${kind === 'image' ? '!' : ''}[${label}](<${toFileUrl(local)}>)`;
    });
    // An unfinished streaming directive should never flash as raw protocol text.
    const complete = citations.replace(/:codex-(?:file-citation|image)\{[^}]*$/, '');
    return normalizeLocalLinks(complete)
      .replace(/\\\[([\s\S]*?)\\\]/g, (match, expression: string) => expression.trim() ? `\n$$\n${expression.trim()}\n$$\n` : match)
      .replace(/\\\(([\s\S]*?)\\\)/g, (match, expression: string) => expression.trim() ? `$${expression.trim()}$` : match);
  });
}
