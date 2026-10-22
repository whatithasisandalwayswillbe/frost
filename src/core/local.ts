// Client for local drive storage: a folder on an internal or external drive, or a mounted share where the
// filesystem passes setup's check. Objects are files under the folder, named by their keys, the same layout as
// an S3 bucket or an SFTP server, so a repository can be copied between them.

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { expand } from './config.js';
import type { LocalFailureKind, LocalRequest } from './local-worker.js';
import {
  MissingRootError,
  UnsafeFolderError,
  abortable,
  errExists,
  errNotFound,
  maxChunkSize,
  maxObjectSize,
  validObjectKey,
  type Backend,
  type Usage,
} from './storage.js';
import type { RootSpace } from '../platform/fs-root-types.js';

// Field names match the [storage.local] settings in config.toml.
export interface LocalConfig {
  path: string;
}

interface Reply {
  id: number;
  value?: unknown;
  error?: { kind: LocalFailureKind; message: string; code: string };
}

// Client for a folder reached through the native filesystem bindings. Their calls are synchronous, so they run
// on a worker thread of the backend's own, started on first use. The folder itself is only ever created by
// prepare, during setup.
export class LocalBackend implements Backend {
  #root: string;
  #worker?: Worker;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #next = 1;

  // The folder must be a full path. ~ means the home folder.
  constructor(config: LocalConfig) {
    const folder = expand(config.path.trim());
    if (!folder) throw new Error('local: path is required');
    if (folder.includes('\0') || !path.isAbsolute(folder))
      throw new Error('local: path must be a full path, like /Volumes/Backup/frost or E:\\frost');
    const normal = path.normalize(folder);
    this.#root = normal === path.parse(normal).root ? normal : normal.replace(/[\\/]+$/, '');
  }

  toString(): string {
    return this.#root;
  }

  // Windows paths don't depend on case.
  location(): string {
    return 'local:' + (process.platform === 'win32' ? this.#root.toLowerCase() : this.#root);
  }

  // Starts the worker. One that fails or exits rejects its waiting requests, and the next request starts another.
  #start(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./local-worker.js', import.meta.url), { execArgv: [] });
    worker.unref();
    worker.on('message', (reply: Reply) => {
      const waiter = this.#pending.get(reply.id);
      if (!waiter) return;
      this.#pending.delete(reply.id);
      // Idle workers don't keep the process alive.
      if (!this.#pending.size) worker.unref();
      if (reply.error) waiter.reject(this.#failure(reply.error));
      else waiter.resolve(reply.value);
    });
    const stopped = (error: Error) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      const waiting = [...this.#pending.values()];
      this.#pending.clear();
      for (const waiter of waiting) waiter.reject(error);
    };
    worker.on('error', stopped);
    worker.on('exit', code => stopped(new Error(`local storage worker exited (${code})`)));
    this.#worker = worker;
    return worker;
  }

  #failure(error: NonNullable<Reply['error']>): Error {
    if (error.kind === 'notfound') return errNotFound;
    if (error.kind === 'exists') return errExists;
    if (error.kind === 'missing')
      return new MissingRootError(`${error.message} not found. Connect the required drive and try again`);
    if (error.kind === 'unsupported')
      return new UnsafeFolderError(
        `${this.#root} resides on an unsupported filesystem. Atomic file creation is required to prevent multi-host backup corruption. Please choose a storage path formatted as NTFS, APFS, ext4, Btrfs, or XFS.`,
      );
    return Object.assign(new Error(error.message), error.code ? { code: error.code } : {});
  }

  #call<T>(request: Omit<LocalRequest, 'id' | 'root'>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const worker = this.#start();
    const id = this.#next++;
    const reply = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: value => resolve(value as T), reject });
    });
    if (this.#pending.size === 1) worker.ref();
    // The data is copied into the message, so the caller's buffer stays its own.
    worker.postMessage({ ...request, id, root: this.#root });
    return abortable(reply, signal);
  }

  #key(key: string): string {
    if (!validObjectKey(key)) throw new Error('local: invalid object key');
    return key;
  }

  async put(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#call({ op: 'put', key: this.#key(key), data, exclusive: false }, signal);
  }

  async putNew(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#call({ op: 'put', key: this.#key(key), data, exclusive: true }, signal);
  }

  // The worker's buffer comes back without a copy, so every download is a fresh buffer of its exact size.
  async get(key: string, signal?: AbortSignal): Promise<Buffer> {
    const limit = key.startsWith('chunks/') ? maxChunkSize : maxObjectSize;
    return Buffer.from(await this.#call<ArrayBuffer>({ op: 'get', key: this.#key(key), limit }, signal));
  }

  async getOwned(key: string, signal?: AbortSignal): Promise<Buffer> {
    return this.get(key, signal);
  }

  async list(prefix: string, signal?: AbortSignal): Promise<string[]> {
    if (!/^[a-z0-9._/-]*$/.test(prefix)) throw new Error('local: invalid list prefix');
    return this.#call<string[]>({ op: 'list', prefix }, signal);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.#call({ op: 'delete', key: this.#key(key) }, signal);
  }

  // How full the drive is.
  async usage(signal?: AbortSignal): Promise<Usage> {
    const space = await this.#call<RootSpace>({ op: 'space' }, signal);
    return {
      used: space.total - space.free,
      quota: space.total,
      readOnly: space.readOnly,
      message: space.readOnly
        ? 'the drive is read-only'
        : space.available < space.total * 0.05
          ? 'the drive is nearly full'
          : '',
    };
  }

  // The folder's device and inode, so a copy of the repository on another drive mounted at the same path is
  // another storage to the manifest.
  async identity(signal?: AbortSignal): Promise<string> {
    return this.#call<string>({ op: 'identity' }, signal);
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    await this.#call({ op: 'prepare' }, signal);
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of waiting) waiter.reject(new Error('local storage was closed'));
    await worker?.terminate();
  }
}
