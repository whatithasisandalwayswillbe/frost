// The local manifest, a checksummed JSONL journal in the cache folder. It remembers uploaded
// chunk IDs, per-file chunk lists, snapshot headers and backup state, and holds a persistent
// OS lock so only one frost process uses it at a time.

import { createHash, randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseID } from './crypto.js';
import type { Snapshot } from './snapshot.js';
import { openRoot, readAll, type RootDirectory, type RootFile } from '../platform/fs-root.js';

export const errLocked = new Error('another frost process is running against this repository');

// Every replay failure gives the same advice: the manifest is only a cache.
const corrupt = 'manifest cache is corrupted; delete it to force rebuilding state from storage';

// What the manifest remembers about a source file. When the size and mtime still match and every
// chunk is known, backup reuses the chunk list without reading the file.
export interface FileEntry {
  size: number;
  mtime: string;
  chunks: string[];
}

type Operation = 'chunks' | 'replaceChunks' | 'files' | 'snapshot' | 'snapshots' | 'meta' | 'state' | 'batch';

// The mutations that batch() collects into a single journal transaction.
interface ManifestTransaction {
  addChunks(chunks: Map<string, number> | Record<string, number>): void;
  replaceChunks(ids: string[]): void;
  putFiles(entries: Map<string, FileEntry> | Record<string, FileEntry>): void;
  putSnapshot(snapshot: Snapshot): void;
  setSnapshots(snapshots: Snapshot[]): void;
  putMeta(name: string, value: unknown): void;
}

// One journal line. `checksum` is the SHA-256 of the line's JSON without the checksum field,
// and sequence numbers count up from 1 with no gaps.
interface Transaction {
  format: 1;
  sequence: number;
  operation: Operation;
  value: unknown;
  checksum: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

export class Manifest {
  #chunks = new Map<string, number>();
  #files = new Map<string, FileEntry>();
  #snapshots = new Map<string, Snapshot>();
  #meta = new Map<string, unknown>();
  #sequence = 0;
  #closed = false;
  // Mutations run one at a time, chained on this promise.
  #tail = Promise.resolve();
  // The first write failure. Once set, every later mutation fails with it.
  #poison: unknown;
  #journalBytes = 0;
  // The journal is compacted once it reaches this size.
  #compactAt = 32 << 20;

  private constructor(
    private name: string,
    private handle: RootFile,
    private lock: { directory: RootDirectory; file: RootFile },
  ) {}

  // Opens or creates the journal at `file`, takes the lock and replays every transaction. Another
  // holder of the lock gets `wait` milliseconds to let go before this fails.
  static async open(file: string, wait = 1000, signal?: AbortSignal): Promise<Manifest> {
    const directory = await openRoot(path.dirname(file), { create: true, mode: 0o700, trustedFinalLink: true });
    let native: RootFile | undefined;
    const release = () => {
      try {
        native?.close();
      } finally {
        directory.close();
      }
    };
    let handle: RootFile | undefined;
    try {
      // The OS lock on `<name>.lock` is held for the manifest's lifetime, and the file's contents
      // mean nothing. It's tried every 25 ms for the first second, then every second.
      native = directory.open(path.basename(file) + '.lock', { read: true, write: true, create: true, mode: 0o600 });
      const start = Date.now();
      for (;;) {
        try {
          native.lock(true);
          break;
        } catch (error) {
          if (!['EAGAIN', 'EBUSY', 'EWOULDBLOCK'].includes(code(error) ?? '')) throw error;
          if (Date.now() - start >= wait) throw errLocked;
          signal?.throwIfAborted();
          await delay(Date.now() - start < 1000 ? 25 : 1000, undefined, { signal });
        }
      }

      // Journals over 1 GiB are refused, and a non-empty journal must start with `{`.
      const name = path.basename(file);
      handle = directory.open(name, { read: true, write: true, create: true, mode: 0o600 });
      const stat = handle.stat();
      if (stat.nlink !== 1) throw new Error('manifest cache must have one hardlink');
      if (stat.size > 1024 * 1024 * 1024) throw new Error('manifest cache exceeds 1 GiB');
      let data = readAll(handle, 1024 * 1024 * 1024);
      if (data.length && data[0] !== 123)
        throw new Error('unsupported manifest cache format; specify an alternate cache path');

      // A crash mid-write can leave a partial last line. Its transaction never took effect, so
      // dropping it is safe.
      const complete = data.lastIndexOf(10) + 1;
      if (complete !== data.length) {
        handle.truncate(complete);
        data = data.subarray(0, complete);
      }

      // Replay in order. A wrong format, sequence or checksum fails closed.
      const manifest = new Manifest(name, handle, { directory, file: native });
      manifest.#journalBytes = data.length;
      for (const line of data.toString('utf8').split('\n').filter(Boolean)) {
        let transaction: Transaction;
        try {
          transaction = JSON.parse(line);
        } catch {
          throw new Error(corrupt);
        }
        if (!transaction || typeof transaction !== 'object') throw new Error(corrupt);
        const { checksum, ...record } = transaction;
        if (
          record.format !== 1 ||
          record.sequence !== manifest.#sequence + 1 ||
          checksum !== hash(JSON.stringify(record))
        )
          throw new Error(corrupt);
        manifest.#apply(record.operation, record.value);
        manifest.#sequence = record.sequence;
      }
      return manifest;
    } catch (error) {
      try {
        handle?.close();
      } finally {
        release();
      }
      throw error;
    }
  }

  // Applies one transaction to memory. Replay and live writes both use it.
  #apply(operation: Operation, value: unknown): void {
    switch (operation) {
      case 'chunks':
        for (const [id, size] of value as [string, number][]) this.#chunks.set(parseID(id), size);
        break;
      case 'replaceChunks':
        this.#chunks = new Map((value as string[]).map(id => [parseID(id), 0]));
        break;
      case 'files':
        for (const [source, entry] of value as [string, FileEntry][]) this.#files.set(source, entry);
        break;
      case 'snapshot': {
        const snapshot = value as Snapshot;
        this.#snapshots.set(snapshot.id, snapshot);
        break;
      }
      case 'snapshots':
        this.#snapshots = new Map((value as Snapshot[]).map(snapshot => [snapshot.id, snapshot]));
        break;
      case 'meta': {
        const [name, data] = value as [string, unknown];
        this.#meta.set(name, data);
        break;
      }
      case 'batch':
        for (const operation of value as { operation: Operation; value: unknown }[])
          this.#apply(operation.operation, operation.value);
        break;
      // A compacted journal starts with the whole state.
      case 'state': {
        const state = value as {
          chunks: [string, number][];
          files: [string, FileEntry][];
          snapshots: [string, Snapshot][];
          meta: [string, unknown][];
        };
        this.#chunks = new Map(state.chunks);
        this.#files = new Map(state.files);
        this.#snapshots = new Map(state.snapshots);
        this.#meta = new Map(state.meta);
        break;
      }
      default:
        throw new Error('manifest cache has an unknown transaction');
    }
  }

  // Appends one transaction and flushes it before the change becomes visible in memory. The
  // value is copied through JSON at call time, so later changes by the caller can't leak in.
  // A failure poisons the manifest, so memory and journal can't drift apart.
  #mutate(operation: Operation, value: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('manifest is closed'));
    const clean = JSON.parse(JSON.stringify(value)) as unknown;
    const work = this.#tail.then(async () => {
      if (this.#poison) throw this.#poison;
      try {
        if (this.#journalBytes >= this.#compactAt) await this.#compact();
        if (this.handle.stat().nlink !== 1) throw new Error('manifest cache must have one hardlink');
        const record = { format: 1, sequence: this.#sequence + 1, operation, value: clean };
        const raw = JSON.stringify({ ...record, checksum: hash(JSON.stringify(record)) }) + '\n';

        // Positional writes at the end of the journal, then a flush.
        const bytes = Buffer.from(raw);
        let written = 0;
        while (written < bytes.length) {
          const n = this.handle.write(
            bytes,
            written,
            bytes.length - written,
            this.#journalBytes + written,
          ).bytesWritten;
          if (!n) throw new Error('manifest write made no progress');
          written += n;
        }
        this.handle.sync();

        this.#apply(operation, clean);
        this.#sequence++;
        this.#journalBytes += bytes.length;
      } catch (error) {
        this.#poison = error;
        throw error;
      }
    });
    this.#tail = work.catch(() => {});
    return work;
  }

  // Rewrites the journal as one `state` transaction. The new file is flushed before it replaces
  // the old one through the held directory handle, so a crash leaves one complete journal.
  async #compact(): Promise<void> {
    const record = {
      format: 1,
      sequence: 1,
      operation: 'state',
      value: {
        chunks: [...this.#chunks],
        files: [...this.#files],
        snapshots: [...this.#snapshots],
        meta: [...this.#meta],
      },
    };
    const raw = JSON.stringify({ ...record, checksum: hash(JSON.stringify(record)) }) + '\n';
    const temporary = this.name + '.' + randomUUID();
    const directory = this.lock.directory;
    const file = directory.open(temporary, { write: true, create: true, exclusive: true, mode: 0o600 });
    try {
      file.writeFile(raw);
      file.sync();
      file.close();
      this.handle.close();
      try {
        directory.rename(temporary, directory, this.name);
        // Windows can't flush a directory.
        if (process.platform !== 'win32') directory.sync();
      } finally {
        // Reopen the journal by name even if the rename failed, so the handle stays usable.
        this.handle = directory.open(this.name, { read: true, write: true, mode: 0o600 });
      }
      this.#sequence = 1;
      this.#journalBytes = Buffer.byteLength(raw);
      // The next compaction waits until the journal doubles, and never comes before 32 MiB.
      this.#compactAt = Math.max(32 << 20, this.#journalBytes * 2);
    } finally {
      file.close();
      try {
        directory.remove(temporary);
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
    }
  }

  hasChunk(id: string): boolean {
    return !this.#closed && this.#chunks.has(id);
  }

  // True only when every ID is a lowercase chunk ID that the manifest knows.
  hasChunks(ids: string[]): boolean {
    return !this.#closed && ids.every(id => /^[a-f0-9]{64}$/.test(id) && this.#chunks.has(id));
  }

  anyChunks(): boolean {
    return !this.#closed && this.#chunks.size > 0;
  }

  chunkCount(): number {
    return this.#closed ? 0 : this.#chunks.size;
  }

  // Records uploaded chunks and their sizes. Input is checked before anything is queued.
  addChunks(chunks: Map<string, number> | Record<string, number>): Promise<void> {
    const pairs = chunks instanceof Map ? [...chunks] : Object.entries(chunks);
    pairs.forEach(([id, size]) => {
      parseID(id);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid chunk size');
    });
    return pairs.length ? this.#mutate('chunks', pairs) : Promise.resolve();
  }

  // Replaces the whole chunk list, after a storage listing. Sizes aren't known, so they're 0.
  replaceChunks(ids: string[]): Promise<void> {
    ids.forEach(parseID);
    return this.#mutate('replaceChunks', ids);
  }

  // Picks up to n known chunk IDs uniformly at random, with reservoir sampling.
  sampleChunks(n: number): string[] {
    if (this.#closed || n <= 0) return [];
    const result: string[] = [];
    let seen = 0;
    for (const id of this.#chunks.keys()) {
      seen++;
      if (result.length < n) result.push(id);
      else {
        const slot = randomInt(seen);
        if (slot < n) result[slot] = id;
      }
    }
    return result;
  }

  // Readers get copies, so nothing changes state behind the journal's back.
  file(source: string): FileEntry | undefined {
    const file = this.#closed ? undefined : this.#files.get(source);
    return file && { size: file.size, mtime: file.mtime, chunks: file.chunks.slice() };
  }

  putFiles(entries: Map<string, FileEntry> | Record<string, FileEntry>): Promise<void> {
    const pairs = entries instanceof Map ? [...entries] : Object.entries(entries);
    return pairs.length ? this.#mutate('files', pairs) : Promise.resolve();
  }

  snapshots(): Map<string, Snapshot> {
    return this.#closed ? new Map() : structuredClone(this.#snapshots);
  }

  putSnapshot(snapshot: Snapshot): Promise<void> {
    return this.#mutate('snapshot', snapshot);
  }

  setSnapshots(snapshots: Snapshot[]): Promise<void> {
    return this.#mutate('snapshots', snapshots);
  }

  getMeta<T>(name: string): T | undefined {
    return this.#closed ? undefined : (structuredClone(this.#meta.get(name)) as T | undefined);
  }

  putMeta(name: string, value: unknown): Promise<void> {
    return this.#mutate('meta', [name, value]);
  }

  // Collects the mutations `fn` makes and writes them as one transaction, so they apply
  // together or not at all. Nothing is written if `fn` throws.
  async batch(fn: (transaction: ManifestTransaction) => void | Promise<void>): Promise<void> {
    const operations: { operation: Operation; value: unknown }[] = [];
    const add = (operation: Operation, value: unknown) => {
      operations.push({ operation, value });
    };
    await fn({
      addChunks: chunks => {
        const pairs = chunks instanceof Map ? [...chunks] : Object.entries(chunks);
        for (const [id, size] of pairs) {
          parseID(id);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid chunk size');
        }
        if (pairs.length) add('chunks', pairs);
      },
      replaceChunks: ids => {
        ids.forEach(parseID);
        add('replaceChunks', ids);
      },
      putFiles: entries => {
        const pairs = entries instanceof Map ? [...entries] : Object.entries(entries);
        if (pairs.length) add('files', pairs);
      },
      putSnapshot: snapshot => add('snapshot', snapshot),
      setSnapshots: snapshots => add('snapshots', snapshots),
      putMeta: (name, value) => add('meta', [name, value]),
    });
    if (operations.length) await this.#mutate('batch', operations);
  }

  // Waits for queued writes, then closes the journal and releases the lock.
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    try {
      this.handle.close();
    } finally {
      try {
        this.lock.file.close();
      } finally {
        this.lock.directory.close();
      }
    }
  }
}
