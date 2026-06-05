import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A minimal, file-backed replacement for the Cloudflare KV `STATE` binding,
 * for running the watcher locally as a standalone backup.
 *
 * Only the `get` / `put` subset of `KVNamespace` is exercised by `watcher.ts`,
 * so that is all this implements. Cursors live in their own local JSON file and
 * are independent of the Cloudflare KV namespace used in production.
 *
 * Concurrency safety (e.g. `advanceCursors` updating several networks at once):
 *  - The load is memoized as a single promise, so concurrent callers share one
 *    in-memory object instead of each reading the file into a separate copy.
 *  - Flushes are serialized through a promise chain and use a unique temp
 *    filename each, then atomically rename into place — so concurrent writes
 *    can't race on the same temp file, clobber each other, or corrupt the file.
 */
export class FileStore {
  private data: Promise<Record<string, string>> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(private readonly path: string) {}

  private load(): Promise<Record<string, string>> {
    if (!this.data) {
      this.data = readFile(this.path, "utf8")
        .then((text) => JSON.parse(text) as Record<string, string>)
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return {};
          this.data = null; // allow a retry on transient read errors
          throw err;
        });
    }
    return this.data;
  }

  async get(key: string): Promise<string | null> {
    const data = await this.load();
    return key in data ? data[key] : null;
  }

  async put(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    // Serialize flushes so concurrent puts don't race on the temp file; a
    // failed flush must not poison the chain for later writes.
    const flush = this.writeChain.catch(() => {}).then(() => this.flush(data));
    this.writeChain = flush.catch(() => {});
    return flush;
  }

  private async flush(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${this.seq++}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.path);
  }

  /** Return a shallow snapshot of all stored key/value pairs. */
  async all(): Promise<Record<string, string>> {
    return { ...(await this.load()) };
  }
}
