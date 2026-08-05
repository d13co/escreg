import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getApplicationAddress } from 'algosdk';

const scanBucketPages = vi.fn();

vi.mock('@d13co/escreg-sdk', () => ({
  EscregSDK: vi.fn(() => ({ scanBucketPages })),
  boxCursor: (name: Uint8Array) => `b64:${Buffer.from(name).toString('base64')}`,
}));

import { handleDumpCommand } from '../src/commands';
import { DumpCheckpoint } from '../src/checkpoint';

const argv = {
  algodHost: 'localhost',
  algodPort: 4001,
  algodToken: '',
  appId: '1234',
  concurrency: 4,
  pageSize: 2,
};

const key = (last: number) => new Uint8Array([0x7c, 0x3d, 0xeb, last]);

const bucket = (version: 1 | 2, appIds: bigint[], last = 0) => ({
  key: key(last),
  version,
  size: appIds.length * 8 + (version === 1 ? 2 : 0),
  appIds,
});

type Page = { buckets: ReturnType<typeof bucket>[]; next?: string; round?: number };

const pages = (...values: Page[]) =>
  (async function* () {
    for (const page of values) yield page;
  })();

const escrow = (appId: bigint) => getApplicationAddress(appId).toString().slice(0, 8);

describe('handleDumpCommand', () => {
  let stdout: string[];
  let stderr: string[];
  let dir: string;
  let resume: string;
  /** The dump's own SIGINT handler, so a test can interrupt it without signalling the test runner */
  let interrupt: (() => void) | undefined;

  const checkpoint = (): DumpCheckpoint => JSON.parse(readFileSync(resume, 'utf8'));

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    interrupt = undefined;
    dir = mkdtempSync(join(tmpdir(), 'escreg-dump-'));
    resume = join(dir, 'dump.state');
    process.exitCode = undefined;

    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'on').mockImplementation((event: any, handler: any) => {
      if (event === 'SIGINT') interrupt = handler;
      return process;
    });
    vi.spyOn(process, 'off').mockReturnValue(process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdout.removeAllListeners('error');
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('should write one row per box to stdout, header and summary to stderr', async () => {
    scanBucketPages.mockReturnValue(pages({ buckets: [bucket(1, [1001n]), bucket(2, [1002n, 1003n])] }));

    await handleDumpCommand(argv);

    expect(stdout).toEqual([
      `1  fD3rAA== (PQ66WAA)  1x  1001 (${escrow(1001n)})\n`,
      `2  fD3rAA== (PQ66WAA)  2x  1002 (${escrow(1002n)})  1003 (${escrow(1003n)})\n`,
    ]);
    expect(stderr[0]).toBe('v  key b64 (b32)       values\n');
    expect(stderr.at(-1)).toBe('2 boxes (1 v1, 1 v2), 3 app IDs\n');
  });

  it('should pass the scan options through', async () => {
    scanBucketPages.mockReturnValue(pages());

    await handleDumpCommand({ ...argv, debug: true });

    expect(scanBucketPages).toHaveBeenCalledWith({ pageSize: 2, concurrency: 4, next: undefined, debug: true });
  });

  it('should report an empty registry', async () => {
    scanBucketPages.mockReturnValue(pages());

    await handleDumpCommand(argv);

    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe('No registry boxes found.\n');
  });

  it('should checkpoint each page and clear the file once the listing is exhausted', async () => {
    const written: DumpCheckpoint[] = [];
    scanBucketPages.mockReturnValue(
      pages(
        { buckets: [bucket(1, [1001n], 1)], next: 'b64:cursor-1', round: 100 },
        { buckets: [bucket(2, [1002n, 1003n], 2)], round: 101 },
      ),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      if (existsSync(resume)) written.push(checkpoint());
      return true;
    });

    await handleDumpCommand({ ...argv, resume });

    // saved after the first page, and only then: the last page ends the listing
    expect(written).toEqual([{ appId: '1234', next: 'b64:cursor-1', round: 100, legacy: 1, packed: 0, entries: 1 }]);
    expect(existsSync(resume)).toBe(false);
    expect(stderr.at(-1)).toBe('2 boxes (1 v1, 1 v2), 3 app IDs\n');
  });

  it('should resume after the checkpoint cursor and carry its counts into the summary', async () => {
    writeFileSync(
      resume,
      JSON.stringify({ appId: '1234', next: 'b64:cursor-1', round: 100, legacy: 3, packed: 5, entries: 20 }),
    );
    scanBucketPages.mockReturnValue(pages({ buckets: [bucket(2, [1002n])] }));

    await handleDumpCommand({ ...argv, resume });

    expect(scanBucketPages).toHaveBeenCalledWith({ pageSize: 2, concurrency: 4, next: 'b64:cursor-1', debug: undefined });
    expect(stderr[0]).toBe('Resuming after box b64:cursor-1, 8 boxes already dumped\n');
    expect(stderr.at(-1)).toBe('9 boxes (3 v1, 6 v2), 21 app IDs\n');
    expect(existsSync(resume)).toBe(false);
  });

  it('should refuse a checkpoint from another registry', async () => {
    writeFileSync(resume, JSON.stringify({ appId: '9999', next: 'b64:cursor-1', legacy: 0, packed: 0, entries: 0 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await handleDumpCommand({ ...argv, resume });

    expect(error).toHaveBeenCalledWith('Error dumping boxes:', expect.stringContaining('is a dump of app 9999, not 1234'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(scanBucketPages).not.toHaveBeenCalled();
  });

  it('should stop on an interrupt and checkpoint the last row written', async () => {
    scanBucketPages.mockReturnValue(
      pages({ buckets: [bucket(1, [1001n], 1), bucket(2, [1002n], 2), bucket(2, [1003n], 3)], next: 'b64:cursor-1', round: 100 }),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      // interrupt once the second row is out, mid-page
      if (stdout.length === 2) interrupt?.();
      return true;
    });

    await handleDumpCommand({ ...argv, resume });

    expect(stdout).toHaveLength(2);
    expect(checkpoint()).toEqual({ appId: '1234', next: 'b64:fD3rAg==', round: 100, legacy: 1, packed: 1, entries: 2 });
    expect(stderr.at(-1)).toBe('Interrupted after 2 boxes. Re-run the same command to continue.\n');
    expect(process.exitCode).toBe(130);
  });

  it('should point at --resume when an interrupted dump had nowhere to checkpoint', async () => {
    scanBucketPages.mockReturnValue(pages({ buckets: [bucket(1, [1001n], 1), bucket(2, [1002n], 2)], next: 'b64:cursor-1' }));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      interrupt?.();
      return true;
    });

    await handleDumpCommand(argv);

    expect(stdout).toHaveLength(1);
    expect(stderr.at(-1)).toBe('Interrupted after 1 boxes. Pass --resume <file> to make a dump resumable.\n');
    expect(process.exitCode).toBe(130);
  });
});
