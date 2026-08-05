import { readFileSync, renameSync, rmSync, writeFileSync } from 'fs';

/** Where a dump stopped, so a re-run picks up from there instead of starting over. */
export interface DumpCheckpoint {
  /** Registry the dump was reading. A checkpoint from another app is refused. */
  appId: string;
  /** Box listing cursor to resume after: every box up to it has been written. */
  next: string;
  /** Round the last listed page was read at, when the node reported one. */
  round?: number;
  /** Legacy boxes written so far, so a resumed run's summary covers the whole dump. */
  legacy: number;
  /** Packed boxes written so far. */
  packed: number;
  /** App IDs written so far. */
  entries: number;
}

/**
 * Read a dump checkpoint.
 *
 * @param path - Checkpoint file path.
 * @param appId - App the current dump is reading, which the checkpoint has to match.
 * @returns The checkpoint, or undefined when there is no file to resume from.
 * @throws If the file is unreadable, malformed, or belongs to another registry.
 */
export function readCheckpoint(path: string, appId: string): DumpCheckpoint | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }

  let checkpoint: DumpCheckpoint;
  try {
    checkpoint = JSON.parse(contents);
  } catch {
    throw new Error(`Resume file ${path} is not valid JSON. Delete it to dump from the start.`);
  }

  if (typeof checkpoint?.next !== 'string') {
    throw new Error(`Resume file ${path} holds no cursor to resume from. Delete it to dump from the start.`);
  }

  if (String(checkpoint.appId) !== appId) {
    throw new Error(`Resume file ${path} is a dump of app ${checkpoint.appId}, not ${appId}.`);
  }

  return checkpoint;
}

/** Write a checkpoint, replacing any existing one in a single rename so an interrupt cannot truncate it. */
export function writeCheckpoint(path: string, checkpoint: DumpCheckpoint): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`);
  renameSync(temp, path);
}

/** Remove a checkpoint, if one is there. */
export function clearCheckpoint(path: string): void {
  rmSync(path, { force: true });
}
