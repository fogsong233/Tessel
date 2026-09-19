/** Distribute a server correction across responses separated by user guidance. */
export function reconcileStreamText(parts: string[], next: string): string[] {
  const before = parts.join('');
  if (before === next) return parts;
  let prefix = 0;
  while (prefix < before.length && prefix < next.length && before[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < next.length - prefix
    && before[before.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const removeEnd = before.length - suffix;
  const inserted = next.slice(prefix, next.length - suffix);
  let offset = 0;
  let insertedOnce = false;
  return parts.map((part, index) => {
    const start = offset;
    offset += part.length;
    const left = Math.max(0, Math.min(part.length, prefix - start));
    const right = Math.max(left, Math.min(part.length, removeEnd - start));
    const ownsInsertion = !insertedOnce && (prefix < offset || index === parts.length - 1);
    if (ownsInsertion) insertedOnce = true;
    return part.slice(0, left) + (ownsInsertion ? inserted : '') + part.slice(right);
  });
}
