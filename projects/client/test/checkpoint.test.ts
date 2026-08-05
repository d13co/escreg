import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearCheckpoint, DumpCheckpoint, readCheckpoint, writeCheckpoint } from '../src/checkpoint';

describe('Dump checkpoints', () => {
  let dir: string;
  let path: string;

  const saved: DumpCheckpoint = { appId: '1234', next: 'b64:AAAj1Q==', round: 100, legacy: 2, packed: 3, entries: 9 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'escreg-checkpoint-'));
    path = join(dir, 'dump.state');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readCheckpoint', () => {
    it('should return undefined when there is no file to resume from', () => {
      expect(readCheckpoint(path, '1234')).toBeUndefined();
    });

    it('should read back what was written', () => {
      writeCheckpoint(path, saved);

      expect(readCheckpoint(path, '1234')).toEqual(saved);
    });

    it('should reject a checkpoint for another app', () => {
      writeCheckpoint(path, saved);

      expect(() => readCheckpoint(path, '5678')).toThrow('is a dump of app 1234, not 5678');
    });

    it('should reject a malformed file', () => {
      writeFileSync(path, 'not json');

      expect(() => readCheckpoint(path, '1234')).toThrow('is not valid JSON');
    });

    it('should reject a file with no cursor', () => {
      writeFileSync(path, JSON.stringify({ appId: '1234', legacy: 1 }));

      expect(() => readCheckpoint(path, '1234')).toThrow('holds no cursor');
    });
  });

  describe('writeCheckpoint', () => {
    it('should replace an existing checkpoint and leave no temp file behind', () => {
      writeCheckpoint(path, saved);
      writeCheckpoint(path, { ...saved, next: 'b64:AAA4EA==', legacy: 4 });

      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...saved, next: 'b64:AAA4EA==', legacy: 4 });
      expect(existsSync(`${path}.tmp`)).toBe(false);
    });
  });

  describe('clearCheckpoint', () => {
    it('should remove the checkpoint', () => {
      writeCheckpoint(path, saved);

      clearCheckpoint(path);

      expect(existsSync(path)).toBe(false);
    });

    it('should do nothing when there is no checkpoint', () => {
      expect(() => clearCheckpoint(path)).not.toThrow();
    });
  });
});
