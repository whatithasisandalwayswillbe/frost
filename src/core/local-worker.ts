// Worker thread for local drive storage, started by local.ts. The native filesystem calls are synchronous, so
// they run here, where a slow drive or network share can't hold up the main thread. Each request opens the
// folder again through retained handles, so a drive that was unplugged and plugged back in is found afresh,
// and nothing below the folder is ever reached by path.

import { parentPort } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { existing, openRootSync, type RootDirectory } from '../platform/fs-root.js';
import { validObjectKey } from './storage.js';

export interface LocalRequest {
  id: number;
  op: 'put' | 'get' | 'list' | 'delete' | 'prepare' | 'space' | 'identity';
  root: string;
  key?: string;
  data?: Uint8Array;
  exclusive?: boolean;
  limit?: number;
  prefix?: string;
}

// What a failure means to the backend. `missing` names the folder that isn't there.
export type LocalFailureKind = 'notfound' | 'exists' | 'missing' | 'unsupported' | 'other';

class Failure extends Error {
  constructor(
    public kind: LocalFailureKind,
    message = '',
  ) {
    super(message);
  }
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';

// A drive that isn't there: a missing folder on the way, or on Windows a drive that isn't ready (21) or a share
// that can't be reached (53 and 67).
function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(code(error)) || [21, 53, 67].includes((error as { errno?: number }).errno ?? 0);
}

function open(folder: string): RootDirectory {
  try {
    return openRootSync(folder);
  } catch (error) {
    if (isMissing(error)) throw new Failure('missing', folder);
    throw error;
  }
}

// Unsupported directory flushes are tolerated, but a disk or I/O failure must fail the upload.
function syncDirectory(dir: RootDirectory): void {
  if (process.platform === 'win32') return;
  try {
    dir.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code(error))) throw error;
  }
}

// Runs fn in the folder that `segments` lead to below root, creating them when asked. Every folder on the way is
// closed afterwards, except root itself.
function within<T>(root: RootDirectory, segments: string[], create: boolean, fn: (dir: RootDirectory) => T): T {
  let dir = root;
  try {
    for (const segment of segments) {
      const created = create && !existing(dir, segment);
      const next = dir.openDirectory(segment, { create, mode: 0o755 });
      if (created) {
        try {
          syncDirectory(dir);
        } catch (error) {
          next.close();
          throw error;
        }
      }
      if (dir !== root) dir.close();
      dir = next;
    }
    return fn(dir);
  } finally {
    if (dir !== root) dir.close();
  }
}

const split = (key: string) => {
  const segments = key.split('/');
  return { segments, name: segments.pop()! };
};

function removeQuietly(dir: RootDirectory, name: string): void {
  try {
    dir.remove(name);
  } catch {
    // A leftover temporary file is skipped by listings and harmless.
  }
}

// Gives the temporary file its final name only if nothing has that name yet: a rename that refuses an existing
// name, or where the filesystem can't check that, a hard link, which fails the same way. Neither leaves a
// moment where a reader could see part of an object. A filesystem with neither fails closed.
function createOnly(dir: RootDirectory, temp: string, name: string): void {
  try {
    dir.rename(temp, dir, name, false);
    return;
  } catch (error) {
    if (code(error) === 'EEXIST') throw new Failure('exists');
    if (!['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code(error))) throw error;
  }
  try {
    dir.link(temp, dir, name);
  } catch (error) {
    if (code(error) === 'EEXIST') throw new Failure('exists');
    if (['EPERM', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK'].includes(code(error)))
      throw new Failure('unsupported', (error as Error).message);
    throw error;
  }
  removeQuietly(dir, temp);
}

// Writes the object to a temporary file next to its key and flushes it, then moves it into place. The ~ in the
// temporary name is never part of a valid key, so listings skip it. POSIX folders are flushed too, so the new
// name survives a crash; Windows can't flush a folder this way.
function put(root: RootDirectory, key: string, data: Uint8Array, exclusive: boolean): void {
  const { segments, name } = split(key);
  within(root, segments, true, dir => {
    const temp = '~' + name + '.' + randomBytes(8).toString('hex');
    const file = dir.open(temp, { write: true, create: true, exclusive: true, mode: 0o644 });
    try {
      try {
        file.writeFile(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        file.sync();
      } finally {
        file.close();
      }
      if (exclusive) createOnly(dir, temp, name);
      else dir.rename(temp, dir, name);
    } catch (error) {
      // Every failure leaves the temporary file behind, since moving it into place is the last step.
      removeQuietly(dir, temp);
      throw error;
    }
    syncDirectory(dir);
  });
}

// Reads a whole object into a new ArrayBuffer of its exact size, which goes back to the main thread without a
// copy. An object over the limit is refused before reading.
function get(root: RootDirectory, key: string, limit: number): ArrayBuffer {
  const { segments, name } = split(key);
  try {
    return within(root, segments, false, dir => {
      const file = dir.open(name, { read: true });
      try {
        const size = file.stat().size;
        if (size > limit) throw new Error('storage response exceeds size limit');
        const out = new ArrayBuffer(size);
        const view = Buffer.from(out);
        for (let at = 0; at < size;) {
          const { bytesRead } = file.read(view, at, size - at, at);
          if (!bytesRead) throw new Error('unexpected EOF');
          at += bytesRead;
        }
        return out;
      } finally {
        file.close();
      }
    });
  } catch (error) {
    if (code(error) === 'ENOENT') throw new Failure('notfound');
    throw error;
  }
}

// Walks the folders the prefix can reach and returns the regular files whose keys start with it. Temporary files,
// links and anything that isn't a valid key are left out.
function list(root: RootDirectory, prefix: string): string[] {
  const start = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  const keys: string[] = [];
  const walk = (dir: RootDirectory, folder: string) => {
    for (const entry of dir.list()) {
      const key = folder + entry.name;
      if (!validObjectKey(key)) continue;
      if (entry.kind === 'file' && key.startsWith(prefix)) keys.push(key);
      const sub = key + '/';
      if (entry.kind === 'directory' && (sub.startsWith(prefix) || prefix.startsWith(sub))) {
        const next = dir.openDirectory(entry.name);
        try {
          walk(next, sub);
        } finally {
          next.close();
        }
      }
    }
  };
  try {
    within(root, start.split('/').filter(Boolean), false, dir => walk(dir, start));
  } catch (error) {
    if (code(error) === 'ENOENT') return [];
    throw error;
  }
  return keys;
}

function remove(root: RootDirectory, key: string): void {
  const { segments, name } = split(key);
  try {
    within(root, segments, false, dir => dir.remove(name));
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
}

// Creates the folder's last component when its parent is there. A volume root only has to exist.
function prepare(folder: string): void {
  const name = path.basename(folder);
  if (!name) {
    open(folder).close();
    return;
  }
  const parent = open(path.dirname(folder));
  try {
    parent.openDirectory(name, { create: true, mode: 0o755 }).close();
    syncDirectory(parent);
  } finally {
    parent.close();
  }
}

parentPort!.on('message', (request: LocalRequest) => {
  let root: RootDirectory | undefined;
  try {
    let value: unknown;
    const transfer: ArrayBuffer[] = [];
    if (request.op === 'prepare') prepare(request.root);
    else {
      root = open(request.root);
      if (request.op === 'put') put(root, request.key!, request.data!, request.exclusive!);
      else if (request.op === 'get') transfer.push((value = get(root, request.key!, request.limit!)) as ArrayBuffer);
      else if (request.op === 'list') value = list(root, request.prefix!);
      else if (request.op === 'delete') remove(root, request.key!);
      else if (request.op === 'space') value = root.space();
      else if (request.op === 'identity') {
        const info = root.stat();
        value = `${info.dev}:${info.ino}`;
      }
    }
    parentPort!.postMessage({ id: request.id, value }, transfer);
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error: {
        kind: error instanceof Failure ? error.kind : 'other',
        message: error instanceof Error ? error.message : String(error),
        code: code(error),
      },
    });
  } finally {
    root?.close();
  }
});
