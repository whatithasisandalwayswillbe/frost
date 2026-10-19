// Helpers shared by the tests: an in-memory backend with hooks and counters, the checks every storage backend
// must pass, a fixture that builds a repository, manifest and engine in a private temporary folder, and seeded
// random data.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Key } from '../src/core/crypto.js';
import { Repo } from '../src/core/repo.js';
import { Manifest } from '../src/core/manifest.js';
import { errExists, errNotFound, type Backend } from '../src/core/storage.js';
import { Engine } from '../src/engine/index.js';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

// An in-memory backend. `beforePut` and `beforeGet` let tests delay or fail single objects,
// `lists` counts only chunk listings (one per full chunk sync), and `place` is the storage location
// the engine sees, so a test can pretend the repository moved.
export class Memory implements Backend {
  objects = new Map<string, Buffer>();
  puts = 0;
  gets = 0;
  lists = 0;
  place = 'memory';
  beforePut?: (key: string) => Promise<void>;
  beforeGet?: (key: string) => Promise<void>;

  toString(): string {
    return 'memory';
  }

  location(): string {
    return this.place;
  }

  // The storage behind the location, like a drive. Empty means the backend doesn't report one.
  identityValue = '';
  async identity(): Promise<string> {
    return this.identityValue;
  }

  async put(key: string, data: Buffer, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.beforePut?.(key);
    this.objects.set(key, Buffer.from(data));
    this.puts++;
  }

  // The check and the write happen with no await between them, so concurrent creates have one winner,
  // like a real conditional write.
  async putNew(key: string, data: Buffer, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.beforePut?.(key);
    if (this.objects.has(key)) throw errExists;
    this.objects.set(key, Buffer.from(data));
    this.puts++;
  }

  async get(key: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    await this.beforeGet?.(key);
    signal?.throwIfAborted();
    const data = this.objects.get(key);
    if (!data) throw errNotFound;
    this.gets++;
    return Buffer.from(data);
  }

  async list(prefix: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (prefix === 'chunks/') this.lists++;
    return [...this.objects.keys()].filter(k => k.startsWith(prefix));
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

// Checks what every backend must do. Conditional creation has exactly one winner, missing objects
// give errNotFound, owned downloads are independent, listing filters by prefix and deletes repeat safely.
export async function conformance(backend: Backend): Promise<void> {
  await backend.putNew('conditional', Buffer.from('first'));
  await assert.rejects(backend.putNew('conditional', Buffer.from('second')), error => error === errExists);
  assert.equal((await backend.get('conditional')).toString(), 'first');
  await backend.delete('conditional');

  const creations = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => backend.putNew('concurrent-create', Buffer.from('writer ' + i))),
  );
  assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
  await backend.delete('concurrent-create');
  await assert.rejects(backend.get('missing/key'), error => error === errNotFound);

  for (const name of ['chunks/ab/ab01', 'chunks/ab/ab02', 'chunks/cd/cd01', 'snapshots/one'])
    await backend.put(name, Buffer.from('encrypted bytes\0\x01\x02'));

  // Wiping an owned buffer mustn't affect the next download of the same object.
  if (backend.getOwned) {
    const owned = await backend.getOwned('chunks/ab/ab01');
    owned.fill(0);
    assert.equal((await backend.getOwned('chunks/ab/ab01')).toString(), 'encrypted bytes\0\x01\x02');
  }

  assert.deepEqual((await backend.list('chunks/')).sort(), ['chunks/ab/ab01', 'chunks/ab/ab02', 'chunks/cd/cd01']);
  await backend.delete('chunks/ab/ab02');
  await backend.delete('chunks/ab/ab02');
  await assert.rejects(backend.get('chunks/ab/ab02'), error => error === errNotFound);
  assert.equal((await backend.list('')).length, 3);
}

// Builds a fresh repository with a fixed all-zero key, plus a manifest and engine. `write` creates
// a file under `src`, making parent folders as needed, and returns its full path.
export async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frost-engine-test-'));
  const src = path.join(root, 'src');
  await mkdir(src);
  const memory = new Memory();
  const repo = await Repo.init(memory, Key.fromMaster(Buffer.alloc(32)));
  const manifest = await Manifest.open(path.join(root, 'manifest.jsonl'));
  const engine = new Engine(repo, manifest);
  t.after(async () => {
    await manifest.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    src,
    memory,
    repo,
    manifest,
    engine,
    write: async (rel: string, data: Buffer | string) => {
      const p = path.join(src, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, data);
      return p;
    },
  };
}

// Deterministic xorshift bytes, so tests get incompressible data that's the same every run.
export function random(size: number, seed = 123456789): Buffer {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    b[i] = seed & 255;
  }
  return b;
}
