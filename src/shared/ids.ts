export function createId(prefix: string): string {
  const entropy = cryptoRandom();
  return `${prefix}_${Date.now().toString(36)}_${entropy}`;
}

function cryptoRandom(): string {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return Math.random().toString(36).slice(2, 10);
}
