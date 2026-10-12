// The repository in storage: frost.repo, chunks, file-list trees and snapshot headers. Every
// object is sealed with its own object key as associated data, so renaming one breaks it.

import { randomBytes } from 'node:crypto';
import { Key, maxPlaintextSize, parseID } from './crypto.js';
import { maxSize, newTable, split } from './chunker.js';
import type { Snapshot, Tree, FileEntry } from './snapshot.js';
import { validID, emptyStats } from './snapshot.js';
import { errNotFound, type Backend } from './storage.js';

// The repository layout version. A format change needs a bump here and a migration.
const layoutVersion = 2;
export const errNotInitialized = new Error('no frost repository here yet');
export const errWrongKey = new Error("this key doesn't match the repository");
// Same text as the mismatch error from Key, which putChunk maps back to this object.
const errCorrupt = new Error("chunk content doesn't match its ID");

// The contents of frost.repo.
interface Info {
  version: number;
  id: string;
  created: string;
}

// The `trees/<id>` object. It lists the file-list chunks in order with the list's total length.
interface TreeIndex {
  size: number;
  chunks: string[];
}

// Chunks fan out into 256 folders by their first two hex digits. Object keys are AEAD associated
// data, so changing this layout would break every existing chunk.
export function chunkKey(id: string): string {
  id = parseID(id);
  return `chunks/${id.slice(0, 2)}/${id}`;
}

// JSON with <, >, &, U+2028 and U+2029 escaped the way Go's encoding/json escapes them, so
// metadata keeps the exact bytes of the existing repository format.
export function marshal(value: unknown): Buffer {
  return Buffer.from(
    JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
  );
}

// Stored forms of a file entry and a snapshot header. Field order is fixed and empty optional
// fields are left out, so the JSON stays byte-stable.
function fileWire(file: FileEntry): FileEntry {
  return {
    path: file.path,
    type: file.type,
    mode: file.mode,
    mtime: file.mtime,
    ...(file.size ? { size: file.size } : {}),
    ...(file.chunks?.length ? { chunks: file.chunks } : {}),
    ...(file.target ? { target: file.target } : {}),
  };
}

function snapshotWire(snapshot: Snapshot): Snapshot {
  const stats = { ...emptyStats(), ...snapshot.stats };
  if (!stats.skipped) delete stats.skipped;
  if (!stats.kept) delete stats.kept;
  return {
    id: snapshot.id,
    time: snapshot.time,
    host: snapshot.host,
    paths: snapshot.paths,
    stats,
    ...(snapshot.warnings?.length ? { warnings: snapshot.warnings } : {}),
    ...(snapshot.kept?.length ? { kept: snapshot.kept } : {}),
    ...(snapshot.missing?.length ? { missing: snapshot.missing } : {}),
  };
}

// Carries the file-list chunks uploaded before a failure, so the caller can still record them.
export class SaveSnapshotError extends Error {
  constructor(
    message: string,
    cause: unknown,
    public uploaded: Map<string, number>,
  ) {
    super(message, { cause });
  }
}

// Runs fn over jobs with a fixed number of workers and returns results in job order. The first
// failure stops new jobs and is thrown once the running ones finish.
export async function parallel<T, R>(
  jobs: readonly T[],
  workers: number,
  fn: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const result = new Array<R>(jobs.length);
  let next = 0;
  let error: unknown;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, workers), jobs.length) }, async () => {
      while (!failed && next < jobs.length) {
        const index = next++;
        try {
          signal?.throwIfAborted();
          result[index] = await fn(jobs[index], index);
        } catch (failure) {
          if (!failed) {
            failed = true;
            error = failure;
          }
        }
      }
    }),
  );
  if (failed) throw error;
  signal?.throwIfAborted();
  return result;
}

export class Repo {
  constructor(
    public backend: Backend,
    public key: Key,
    public info: Info,
  ) {}

  static async exists(backend: Backend, signal?: AbortSignal): Promise<boolean> {
    try {
      await backend.get('frost.repo', signal);
      return true;
    } catch (error) {
      if (error === errNotFound) return false;
      throw error;
    }
  }

  // Creates frost.repo in storage that has no repository yet. Backup objects without
  // frost.repo mean something is wrong, so init refuses to write over them.
  static async init(backend: Backend, key: Key, signal?: AbortSignal): Promise<Repo> {
    if (await Repo.exists(backend, signal))
      throw new Error(`${backend} already has a frost repository (use \`frost key import\` to connect to it)`);
    const keys = await backend.list('', signal);
    if (keys.some(value => /^(chunks|snapshots|trees)\//.test(value)))
      throw new Error('backup objects exist without frost.repo; refusing to initialize over them');
    const info: Info = {
      version: layoutVersion,
      id: randomBytes(8).toString('hex'),
      created: new Date().toISOString(),
    };
    const repo = new Repo(backend, key, info);
    await repo.putJSON('frost.repo', info, signal);
    return repo;
  }

  // Opens an existing repository. If frost.repo won't decrypt, the key is wrong.
  static async open(backend: Backend, key: Key, signal?: AbortSignal): Promise<Repo> {
    let blob: Buffer;
    try {
      blob = await backend.get('frost.repo', signal);
    } catch (error) {
      if (error === errNotFound) throw errNotInitialized;
      throw error;
    }
    let data: Buffer;
    try {
      data = key.open(blob, 'frost.repo');
    } catch {
      throw errWrongKey;
    }
    const info = JSON.parse(data.toString()) as Info;
    if (info.version !== layoutVersion)
      throw new Error(`repository format v${info.version} isn't supported by this frost (wants v${layoutVersion})`);
    if (typeof info.id !== 'string' || !/^[a-fA-F0-9]{16}$/.test(info.id)) throw new Error('invalid repository ID');
    return new Repo(backend, key, info);
  }

  // Seals metadata under its object key and creates it conditionally, so concurrent clients
  // can't overwrite repository metadata.
  async putJSON(object: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const data = marshal(value);
    if (data.length > maxPlaintextSize) throw new Error('snapshot metadata exceeds 256 MiB limit');
    await this.backend.putNew(object, this.key.seal(data, object), signal);
  }

  async getJSON<T>(object: string, signal?: AbortSignal): Promise<T> {
    return JSON.parse(this.key.open(await this.backend.get(object, signal), object).toString()) as T;
  }

  // Seals and uploads a chunk, and returns the sealed size. A plain put is fine because the
  // object name is the chunk's keyed ID, so an overwrite holds the same content.
  async putChunk(id: string, plaintext: Buffer, signal?: AbortSignal): Promise<number> {
    return this.#putChunk(id, plaintext, false, signal);
  }

  // Like putChunk, but the caller gives up plaintext, so a large one may be detached instead of copied.
  async putOwnedChunk(id: string, plaintext: Buffer, signal?: AbortSignal): Promise<number> {
    return this.#putChunk(id, plaintext, true, signal);
  }

  async #putChunk(id: string, plaintext: Buffer, owned: boolean, signal?: AbortSignal): Promise<number> {
    id = parseID(id);
    if (plaintext.length > maxSize) throw errCorrupt;
    signal?.throwIfAborted();
    const object = chunkKey(id);
    let blob: Buffer;
    try {
      blob = await (owned ? this.key.sealOwnedChunk(plaintext, id, object) : this.key.sealChunk(plaintext, id, object));
    } catch (error) {
      // A worker's error arrives as a new Error with the same message.
      if ((error as Error).message === errCorrupt.message) throw errCorrupt;
      throw error;
    }
    signal?.throwIfAborted();
    await this.backend.put(object, blob, signal);
    return blob.length;
  }

  // Downloads, opens and verifies a chunk. With getOwned, the downloaded buffer belongs to frost
  // and may be detached while it's opened.
  async getChunk(id: string, signal?: AbortSignal): Promise<Buffer> {
    id = parseID(id);
    const object = chunkKey(id);
    try {
      signal?.throwIfAborted();
      const owned = !!this.backend.getOwned;
      const blob = owned ? await this.backend.getOwned!(object, signal) : await this.backend.get(object, signal);
      const data = owned ? await this.key.openOwnedChunk(blob, id, object) : await this.key.openChunk(blob, id, object);
      signal?.throwIfAborted();
      if (data.length > maxSize) throw errCorrupt;
      return data;
    } catch (cause) {
      throw new Error(`chunk ${id.slice(0, 12)}: ${cause instanceof Error ? cause.message : cause}`, { cause });
    }
  }

  // Lists the chunk IDs in storage, ignoring anything outside the chunks/<ab>/<id> layout.
  async chunkIDs(signal?: AbortSignal): Promise<string[]> {
    const result: string[] = [];
    for (const object of await this.backend.list('chunks/', signal)) {
      try {
        const id = parseID(object.slice(object.lastIndexOf('/') + 1));
        if (chunkKey(id) === object) result.push(id);
      } catch {
        /* Ignore objects outside frost's chunk layout. */
      }
    }
    return result;
  }

  // Saves a snapshot in order: the file-list chunks, then trees/<id>, then snapshots/<id>, so a
  // snapshot can't appear before its data exists. `have` skips chunks storage already holds.
  // Returns the chunks it uploaded, which a SaveSnapshotError also carries.
  async saveSnapshot(
    snapshot: Snapshot,
    tree: Tree,
    have?: (id: string) => boolean,
    signal?: AbortSignal,
  ): Promise<Map<string, number>> {
    if (!validID(snapshot.id)) throw new Error(`invalid snapshot id ${JSON.stringify(snapshot.id)}`);

    // Fail early if the ID is taken. The conditional create below still guards the race.
    try {
      await this.backend.get('snapshots/' + snapshot.id, signal);
      throw new Error(`snapshot ${snapshot.id} already exists`);
    } catch (error) {
      if (error !== errNotFound) throw error;
    }

    // The file list is chunked like file data, so unchanged parts deduplicate.
    const raw = marshal({ files: tree.files.map(fileWire) });
    const index: TreeIndex = { size: raw.length, chunks: [] };
    const todo: { id: string; data: Buffer }[] = [];
    const queued = new Set<string>();
    for (const piece of split(raw, newTable(this.key.chunkerSeed()))) {
      const id = this.key.chunkID(piece);
      index.chunks.push(id);
      if (!queued.has(id) && !have?.(id)) {
        todo.push({ id, data: piece });
        queued.add(id);
      }
    }

    const uploaded = new Map<string, number>();
    try {
      await parallel(
        todo,
        4,
        async job => {
          await this.putChunk(job.id, job.data, signal);
          uploaded.set(job.id, job.data.length);
        },
        signal,
      );
      await this.putJSON('trees/' + snapshot.id, index, signal);
    } catch (error) {
      throw new SaveSnapshotError(
        `saving file list: ${error instanceof Error ? error.message : error}`,
        error,
        uploaded,
      );
    }

    try {
      await this.putJSON('snapshots/' + snapshot.id, snapshotWire(snapshot), signal);
    } catch (error) {
      throw new SaveSnapshotError(
        `saving snapshot: ${error instanceof Error ? error.message : error}`,
        error,
        uploaded,
      );
    }
    return uploaded;
  }

  // Loads a header. Its ID must match the object name it was stored under.
  async loadSnapshot(id: string, signal?: AbortSignal): Promise<Snapshot> {
    if (!validID(id)) throw new Error(`invalid snapshot id ${JSON.stringify(id)}`);
    const snapshot = await this.getJSON<Snapshot>('snapshots/' + id, signal);
    if (snapshot.id !== id) throw new Error("snapshot header ID doesn't match its object name");
    return snapshot;
  }

  // Loads a file list through its tree index. The recorded length is checked as chunks arrive,
  // so a bad index can't make frost hold more than the recorded size.
  async loadTree(id: string, signal?: AbortSignal): Promise<Tree> {
    if (!validID(id)) throw new Error(`invalid snapshot id ${JSON.stringify(id)}`);
    const index = await this.getJSON<TreeIndex>('trees/' + id, signal);
    if (!Array.isArray(index.chunks)) throw new Error('file list has invalid chunks');
    const ids = index.chunks.map(parseID);
    if (!Number.isSafeInteger(index.size) || index.size < 0 || index.size > ids.length * maxSize)
      throw new Error('file list has an invalid size');

    const pieces: Buffer[] = [];
    let size = 0;
    await this.fetch(
      ids,
      8,
      (_, piece) => {
        size += piece.length;
        if (size > index.size) throw new Error('file list is longer than recorded');
        pieces.push(piece);
      },
      signal,
    );
    if (size !== index.size) throw new Error('file list is shorter than recorded');

    // An empty file list may be stored as null.
    const tree = JSON.parse(Buffer.concat(pieces, size).toString()) as Tree;
    if (tree.files === null) tree.files = [];
    if (!Array.isArray(tree.files)) throw new Error('file list has invalid entries');
    return tree;
  }

  async snapshotIDs(signal?: AbortSignal): Promise<string[]> {
    return (await this.backend.list('snapshots/', signal))
      .map(value => value.slice('snapshots/'.length))
      .filter(validID);
  }

  // Loads every snapshot header in storage, reusing the ones in `known`.
  async snapshots(
    known: Map<string, Snapshot> | Record<string, Snapshot> = new Map(),
    signal?: AbortSignal,
  ): Promise<Snapshot[]> {
    return parallel(
      await this.snapshotIDs(signal),
      8,
      id => {
        const cached = known instanceof Map ? known.get(id) : known[id];
        return cached ? Promise.resolve(cached) : this.loadSnapshot(id, signal);
      },
      signal,
    );
  }

  // Downloads chunks with up to `workers` requests at once and calls fn for each ID in order.
  // Downloads run up to twice the worker count ahead, and an ID repeated within that window
  // downloads once, so fn gets the same buffer for each repeat.
  async fetch(
    ids: string[],
    workers: number,
    fn: (index: number, data: Buffer) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!ids.length) return;
    signal?.throwIfAborted();
    workers = Math.min(Math.max(workers, 1), ids.length);

    // Aborting `controller` cancels the downloads still running when fetch stops early.
    const window = Math.min(2 * workers, ids.length);
    const controller = new AbortController();
    const local = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    // `live` maps an ID to its download while the window still needs it, and `refs` counts the
    // window positions that do. `queue` holds the window by position.
    type Result = { data?: Buffer; error?: unknown };
    type Fetch = { id: string; refs: number; result: Promise<Result>; finish: (result: Result) => void };
    const live = new Map<string, Fetch>();
    const queue = new Array<Fetch | undefined>(window);
    const pending: Fetch[] = [];
    let active = 0;
    let next = 0;
    const started = new Set<Promise<void>>();

    // Starts queued downloads while fewer than `workers` are running.
    const pump = () => {
      while (active < workers && pending.length) {
        const job = pending.shift()!;
        active++;
        const work = this.getChunk(job.id, local)
          .then(
            data => ({ data }),
            error => ({ error }),
          )
          .then(result => {
            job.finish(result);
            active--;
            started.delete(work);
            pump();
          });
        started.add(work);
      }
    };

    try {
      for (let i = 0; i < ids.length; i++) {
        local.throwIfAborted();

        // Fill the window ahead of i, sharing one download per ID.
        for (; next < ids.length && next < i + window; next++) {
          let job = live.get(ids[next]);
          if (!job) {
            let finish!: (value: Result) => void;
            const result = new Promise<Result>(resolve => {
              finish = resolve;
            });
            job = { id: ids[next], refs: 0, result, finish };
            live.set(job.id, job);
            pending.push(job);
          }
          job.refs++;
          queue[next % window] = job;
        }
        pump();

        // Wait for position i, hand it to fn, then release its slot.
        const job = queue[i % window]!;
        const result = await job.result;
        local.throwIfAborted();
        if (result.error !== undefined) throw result.error;
        await fn(i, result.data!);
        local.throwIfAborted();
        if (--job.refs === 0) live.delete(job.id);
        queue[i % window] = undefined;
      }
    } finally {
      controller.abort();
      pending.length = 0;
      await Promise.all(started);
    }
  }
}
