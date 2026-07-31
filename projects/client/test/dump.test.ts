import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getApplicationAddress } from 'algosdk';

const scanBuckets = vi.fn();

vi.mock('@d13co/escreg-sdk', () => ({
  EscregSDK: vi.fn(() => ({ scanBuckets })),
}));

import { handleDumpCommand } from '../src/commands';

const argv = {
  algodHost: 'localhost',
  algodPort: 4001,
  algodToken: '',
  indexerHost: '',
  appId: '1234',
  concurrency: 4,
  source: 'algod',
};

const key = new Uint8Array([0x7c, 0x3d, 0xeb, 0x00]);

const buckets = (...values: { version: 1 | 2; appIds: bigint[] }[]) =>
  (async function* () {
    for (const { version, appIds } of values) {
      yield { key, version, size: appIds.length * 8 + (version === 1 ? 2 : 0), appIds };
    }
  })();

describe('handleDumpCommand', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdout.removeAllListeners('error');
  });

  it('should write one row per box to stdout, header and summary to stderr', async () => {
    scanBuckets.mockReturnValue(buckets({ version: 1, appIds: [1001n] }, { version: 2, appIds: [1002n, 1003n] }));

    await handleDumpCommand(argv);

    const escrow = (appId: bigint) => getApplicationAddress(appId).toString().slice(0, 8);

    expect(stdout).toEqual([
      `1  fD3rAA== (PQ66WAA)  1x  1001 (${escrow(1001n)})\n`,
      `2  fD3rAA== (PQ66WAA)  2x  1002 (${escrow(1002n)})  1003 (${escrow(1003n)})\n`,
    ]);
    expect(stderr[0]).toBe('v  key b64 (b32)       values\n');
    expect(stderr.at(-1)).toBe('2 boxes (1 v1, 1 v2), 3 app IDs\n');
  });

  it('should pass the scan options through', async () => {
    scanBuckets.mockReturnValue(buckets());

    await handleDumpCommand({ ...argv, debug: true });

    expect(scanBuckets).toHaveBeenCalledWith({ concurrency: 4, source: 'algod', debug: true });
  });

  it('should report an empty registry', async () => {
    scanBuckets.mockReturnValue(buckets());

    await handleDumpCommand(argv);

    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe('No registry boxes found.\n');
  });
});
