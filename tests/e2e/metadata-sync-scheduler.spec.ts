import { expect, test } from '@playwright/test';
import { MetadataSyncScheduler, type SerializedTaskRunner } from '../../src/main/metadataSyncScheduler';

test('coalesces metadata sync requests and uses the serialized mutation queue', async () => {
  let mutationTail = Promise.resolve();
  let activeMutations = 0;
  const syncCalls: string[] = [];
  const runSerialized: SerializedTaskRunner = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutationTail.then(async () => {
      activeMutations += 1;
      expect(activeMutations).toBe(1);
      try {
        return await operation();
      } finally {
        activeMutations -= 1;
      }
    });
    mutationTail = next.then(() => undefined, () => undefined);
    return next;
  };
  const scheduler = new MetadataSyncScheduler(
    runSerialized,
    async (documentId) => {
      syncCalls.push(documentId);
    },
    { delayMs: 60_000 }
  );

  scheduler.schedule('pdf-one');
  scheduler.schedule('pdf-one');
  scheduler.schedule('pdf-two');
  await scheduler.flush();

  expect(syncCalls).toEqual(['pdf-one', 'pdf-two']);
  scheduler.dispose();
});
