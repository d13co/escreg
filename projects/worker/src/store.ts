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
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt
 * the cursor file. Reads are served from an in-memory cache loaded on first use.
 */
export class FileStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8"));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  async get(key: string): Promise<string | null> {
    const data = await this.load();
    return key in data ? data[key] : null;
  }

  async put(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.path);
  }

  /** Return a shallow snapshot of all stored key/value pairs. */
  async all(): Promise<Record<string, string>> {
    return { ...(await this.load()) };
  }
}
