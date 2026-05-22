import { rename } from 'node:fs/promises';

export async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);
  const delays = [20, 50, 100, 180, 300];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!retryableCodes.has(code ?? '') || attempt === delays.length) {
        break;
      }
      await delay(delays[attempt]);
    }
  }

  throw lastError;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
