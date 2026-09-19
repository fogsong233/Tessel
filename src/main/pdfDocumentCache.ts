/** A bounded cache of parsed PDFs and page text, shared by concurrent AI tools. */
export interface CachedPdfSource {
  numPages: number;
  destroy(): Promise<void>;
  getPage(page: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  getOutline(): Promise<unknown[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

interface Entry {
  key: string;
  source: Promise<CachedPdfSource>;
  pages: Map<number, Promise<{ items: unknown[] }>>;
  outline?: Promise<unknown[] | null>;
  users: number;
  touched: number;
  retired: boolean;
}

export class PdfDocumentCache {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly load: (path: string) => Promise<CachedPdfSource>, private readonly capacity = 3) {}

  async acquire(path: string, version: string): Promise<CachedPdfSource> {
    let entry = this.entries.get(path);
    if (entry?.key !== version) {
      if (entry) this.retire(entry);
      entry = { key: version, source: this.load(path), pages: new Map(), users: 0, touched: Date.now(), retired: false };
      this.entries.set(path, entry);
    }
    const current = entry;
    current.users += 1;
    current.touched = Date.now();
    this.trim();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      current.users -= 1;
      current.touched = Date.now();
      if (current.retired && current.users === 0) await this.destroy(current);
      this.trim();
    };
    try {
      const source = await current.source;
      return {
        numPages: source.numPages,
        destroy: release,
        getDestination: (name) => source.getDestination(name),
        getPageIndex: (ref) => source.getPageIndex(ref),
        getOutline: () => current.outline ??= source.getOutline().catch((error) => {
          current.outline = undefined;
          throw error;
        }),
        getPage: async (page) => ({ getTextContent: () => {
          let text = current.pages.get(page);
          if (!text) {
            text = source.getPage(page).then((value) => value.getTextContent()).catch((error) => {
              current.pages.delete(page);
              throw error;
            });
            current.pages.set(page, text);
            // Retain text only; avoid unbounded memory on very large books.
            if (current.pages.size > 256) current.pages.delete(current.pages.keys().next().value!);
          }
          return text;
        } })
      };
    } catch (error) {
      if (this.entries.get(path) === current) this.entries.delete(path);
      current.retired = true;
      await release();
      throw error;
    }
  }

  clear(): void {
    clearTimeout(this.timer);
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
  }

  private trim(): void {
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.users === 0)
      .sort(([, left], [, right]) => left.touched - right.touched);
    for (const [path, entry] of idle) {
      if (this.entries.size <= this.capacity && Date.now() - entry.touched < 120_000) break;
      this.entries.delete(path);
      this.retire(entry);
    }
    clearTimeout(this.timer);
    if (this.entries.size) {
      this.timer = setTimeout(() => this.trim(), 120_000);
      this.timer.unref();
    }
  }

  private retire(entry: Entry): void {
    entry.retired = true;
    if (entry.users === 0) void this.destroy(entry);
  }

  private async destroy(entry: Entry): Promise<void> {
    await entry.source.then((source) => source.destroy()).catch(() => undefined);
  }
}
