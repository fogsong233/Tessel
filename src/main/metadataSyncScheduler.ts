export type SerializedTaskRunner = <T>(operation: () => Promise<T>) => Promise<T>;

interface MetadataSyncSchedulerOptions {
  delayMs?: number;
  onError?: (documentId: string, error: unknown) => void;
}

/**
 * Coalesces frequent document updates and executes WebDAV synchronization
 * through the same serialized queue as local workspace mutations.
 */
export class MetadataSyncScheduler {
  private readonly pendingDocumentIds = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushPromise?: Promise<void>;

  constructor(
    private readonly runSerialized: SerializedTaskRunner,
    private readonly syncDocument: (documentId: string) => Promise<unknown>,
    private readonly options: MetadataSyncSchedulerOptions = {}
  ) {}

  schedule(documentId: string): void {
    this.pendingDocumentIds.add(documentId);
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.delayMs ?? 350);
    this.timer.unref();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.flushPromise) {
      this.flushPromise = this.flushPending().finally(() => {
        this.flushPromise = undefined;
        if (this.pendingDocumentIds.size > 0) {
          void this.flush();
        }
      });
    }
    return this.flushPromise;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingDocumentIds.clear();
  }

  private async flushPending(): Promise<void> {
    while (this.pendingDocumentIds.size > 0) {
      const documentIds = Array.from(this.pendingDocumentIds);
      this.pendingDocumentIds.clear();
      for (const documentId of documentIds) {
        await this.runSerialized(() => this.syncDocument(documentId)).catch((error: unknown) => {
          this.options.onError?.(documentId, error);
        });
      }
    }
  }
}
