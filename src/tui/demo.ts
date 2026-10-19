// Development demo for the TUI. It builds a fake home folder and backup history in memory and opens the browser
// on it, or runs setup with fake steps. `npm run demo` starts it after a build, and it isn't shipped in releases.

import { mkdir, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Key } from '../core/crypto.js';
import { defaultConfig, expand } from '../core/config.js';
import { Manifest } from '../core/manifest.js';
import { Repo, chunkKey, marshal } from '../core/repo.js';
import { errNotFound, errExists, type Backend } from '../core/storage.js';
import { Engine } from '../engine/index.js';
import { runBrowser } from './browser.js';
import { setup, ConnectError, RepoState, type SetupDeps } from './setup.js';

// A made-up host name for the demo snapshots, so the real machine's name never shows.
export const demoHost = 'John Doe';

// Storage that lives in memory. Buffers are copied in and out, so callers keep their own buffers and can't change
// stored objects.
export class MemoryBackend implements Backend {
  objects = new Map<string, Buffer>();

  async put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(bytes));
  }

  async putNew(key: string, bytes: Buffer): Promise<void> {
    if (this.objects.has(key)) throw errExists;
    await this.put(key, bytes);
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (!bytes) throw errNotFound;
    return Buffer.from(bytes);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  toString(): string {
    return 'demo (in memory)';
  }
}

// Wraps a backend and delays reads and listings by the -latency flag, to show loading states. Writes and deletes
// pass straight through. Aborting a delayed request rejects it at once.
export class SlowBackend implements Backend {
  constructor(
    public backend: Backend,
    public latency: number,
  ) {}

  async put(key: string, bytes: Buffer, signal?: AbortSignal) {
    return this.backend.put(key, bytes, signal);
  }

  async putNew(key: string, bytes: Buffer, signal?: AbortSignal) {
    return this.backend.putNew(key, bytes, signal);
  }

  async get(key: string, signal?: AbortSignal) {
    await delay(Math.max(this.latency, 0), undefined, { signal });
    return this.backend.get(key, signal);
  }

  async list(prefix: string, signal?: AbortSignal) {
    await delay(Math.max(this.latency, 0), undefined, { signal });
    return this.backend.list(prefix, signal);
  }

  async delete(key: string, signal?: AbortSignal) {
    return this.backend.delete(key, signal);
  }

  toString(): string {
    return 'demo (in memory)';
  }
}

// Writes a fake home folder under source and backs it up eight times, changing a few files between backups. The
// snapshots are then backdated so they spread over the last two weeks.
export async function buildHistory(engine: Engine, source: string, now = Date.now()): Promise<void> {
  let seed = 1;
  const text = async (rel: string, value: Buffer | string) => {
    const p = path.join(source, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, value, { mode: 0o644 });
  };

  // Binary files get xorshift noise, so they don't compress or deduplicate. The seed carries over between files,
  // so the order of writes decides every file's bytes.
  const write = async (rel: string, size: number) => {
    const bytes = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      bytes[i] = seed;
    }
    await text(rel, bytes);
  };

  await text('Documents/notes/todo.md', '- renew passport\n- call the bank\n');
  await text('Documents/notes/ideas.md', 'backup tool, but nice\n');
  await write('Documents/taxes/2024/return.pdf', 420_000);
  await write('Documents/taxes/2025/receipts.zip', 1_800_000);
  await write('Documents/cv.pdf', 180_000);
  await write('Pictures/2026/summer/beach-01.jpg', 3_200_000);
  await write('Pictures/2026/summer/beach-02.jpg', 2_900_000);
  await write('Pictures/2026/summer/sunset.jpg', 4_100_000);
  await write('Pictures/avatar.png', 90_000);
  await text('code/frost/README.md', '# frost\n');
  await text('code/frost/main.ts', 'export function main() {}\n');
  for (let i = 0; i < 40; i++) await text(`code/scratch/file-${String(i).padStart(2, '0')}.txt`, `scratch file ${i}\n`);

  // One change before each backup. The first backup takes the files as they are.
  const paths = ['Documents', 'Pictures', 'code'].map(p => path.join(source, p));
  const changes = [
    async () => {},
    () => text('Documents/notes/todo.md', '- renew passport\n- call the bank\n- buy milk\n'),
    () => write('Pictures/2026/autumn/leaves.jpg', 2_500_000),
    () => rm(path.join(source, 'Documents/taxes/2024'), { recursive: true }),
    () => text('code/frost/main.ts', 'export function main() { console.log("hi"); }\n'),
    () => write('Documents/cv.pdf', 185_000),
    () => write('Pictures/2026/autumn/park.jpg', 3_000_000),
    () => text('Documents/notes/ideas.md', 'backup tool, but nice\nsell it? no, keep it free\n'),
  ];
  const snapshots = [];
  for (const change of changes) {
    await change();
    snapshots.push((await engine.backup({ paths, host: demoHost })).snapshot);
  }

  // Backdate each snapshot by its age in hours. An object's key is its AEAD associated data, so each snapshot is
  // sealed again with the same object key, snapshots/<id>, and overwritten in place.
  const ages = [14 * 24, 11 * 24 + 3, 9 * 24, 6 * 24 + 5, 4 * 24, 2 * 24 + 7, 26, 3];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    snap.time = new Date(now - ages[i] * 3600_000).toISOString();
    const object = 'snapshots/' + snap.id;
    await engine.repo.backend.put(object, engine.repo.key.seal(marshal(snap), object));
  }
  await engine.manifest!.setSnapshots(snapshots);
}

// Sets up the -broken view. It flips a byte in three chunks of the newest snapshot, records the failed
// verification, then records a failed backup of a path that doesn't exist.
export async function breakThings(engine: Engine, memory: MemoryBackend): Promise<void> {
  const snaps = await engine.repo.snapshots();
  const newest = snaps.sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
  const chunks = new Set<string>();
  if (newest)
    for (const file of (await engine.repo.loadTree(newest.id)).files)
      for (const id of file.chunks ?? []) chunks.add(chunkKey(id));
  for (const object of [...chunks].slice(0, 3)) {
    const bytes = memory.objects.get(object)!;
    bytes[Math.trunc(bytes.length / 2)] ^= 255;
  }
  await engine.verify(engine.manifest!.chunkCount(), true);
  await engine.backup({ paths: ['/does/not/exist'], host: demoHost }).catch(() => {});
}

// Fake setup steps. Connecting, unlocking and finishing each wait at least 600 ms so spinners show. The Permafrost
// access key is 'demo', and nothing is saved.
function demoSetupDeps(latency: number): SetupDeps {
  const wait = (signal?: AbortSignal) => delay(Math.max(latency, 600), undefined, { signal });
  // A self-hosted server refuses frost's SSH key until one of the ways of adding it has run.
  let keyAdded = false;
  return {
    connect: async (storage, signal, options) => {
      await wait(signal);
      if (storage.backend === 'permafrost' && storage.permafrost.token !== 'demo')
        throw new Error("that access key wasn't accepted, check you copied all of it (the demo key is: demo)");
      if (storage.backend === 'sftp' && !keyAdded && !options?.acceptNewHostKey)
        throw new ConnectError('login', storage.sftp.host + " didn't accept frost's SSH key.");
      return RepoState.New;
    },
    addKey: async () => {
      keyAdded = true;
    },
    keyFile: () => '~/.config/frost/ssh/frost_ed25519.pub',
    reveal: () => {},
    newKey: () => Key.new(),
    unlock: async (_storage, phrase, signal) => {
      await wait(signal);
      return Key.fromPhrase(phrase);
    },
    finish: async (cfg, _key, _newRepo, signal) => {
      await wait(signal);
      return [
        ['config', 'not saved, this is the demo'],
        ['schedule', cfg.schedule.every],
      ];
    },

    // Two different word positions out of 24 for the recovery phrase check, lowest first.
    pickWords: () => {
      const i = Math.floor(Math.random() * 24);
      const v = Math.floor(Math.random() * 23);
      const j = v >= i ? v + 1 : v;
      return [Math.min(i, j), Math.max(i, j)];
    },
    dirExists: p => {
      try {
        return statSync(expand(p)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

interface DemoOptions {
  latency: number;
  empty: boolean;
  broken: boolean;
  setup: boolean;
}

// Parses the demo's flags. They take one or two dashes, and values go after '=' or in the next argument.
export function parseDemoArgs(args: string[]): DemoOptions {
  const options: DemoOptions = { latency: 0, empty: false, broken: false, setup: false };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].replace(/^--?/, '').split('=', 2);
    if (flag === 'latency') {
      // A Go-style duration such as 400ms or 1m2.5s, with an optional sign. Every number needs a unit unless the
      // whole value is 0.
      const value = inline ?? args[++i] ?? '';
      let total = 0;
      let position = 0;
      const negative = value.startsWith('-');
      const input = value.replace(/^[+-]/, '');
      for (const match of input.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)) {
        if (match.index !== position)
          throw new Error('invalid value ' + JSON.stringify(value) + ' for flag -latency: parse error');
        total +=
          +match[1] * { ns: 1e-6, us: 0.001, µs: 0.001, μs: 0.001, ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]!;
        position += match[0].length;
      }
      if ((position !== input.length || !position) && input !== '0')
        throw new Error('invalid value ' + JSON.stringify(value) + ' for flag -latency: parse error');
      options.latency = negative ? -total : total;
    } else if (['empty', 'broken', 'setup'].includes(flag)) {
      // Switches are on when present, and also accept =true or =false.
      if (inline !== undefined && !['true', 'false'].includes(inline)) throw new Error('invalid boolean flag ' + flag);
      options[flag as 'empty' | 'broken' | 'setup'] = inline !== 'false';
    } else throw new Error('flag provided but not defined: -' + flag);
  }
  return options;
}

// Runs setup on its own with -setup. Otherwise it builds the demo repository in a temporary folder and opens the
// browser on it.
async function runDemo(options: DemoOptions): Promise<void> {
  if (options.setup) {
    const result = await setup(demoSetupDeps(options.latency), defaultConfig());
    console.log('demo setup finished, saved:', result.saved);
    return;
  }

  const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frost-tui-demo-')));
  const source = path.join(work, 'home');
  const memory = new MemoryBackend();
  const repo = await Repo.init(memory, Key.new());
  const manifest = await Manifest.open(path.join(work, 'manifest.jsonl'));
  const engine = new Engine(repo, manifest);
  try {
    if (!options.empty) {
      console.log('Building demo snapshots...');
      await buildHistory(engine, source);
      await engine.verify(10);
      if (options.broken) await breakThings(engine, memory);
    }

    const cfg = defaultConfig();
    cfg.paths = ['Documents', 'Pictures', 'code'].map(p => path.join(source, p));
    cfg.storage.backend = 'demo';
    const state = {
      known: manifest.snapshots(),
      last: engine.lastBackup(),
      hasLast: !!engine.lastBackup(),
      verify: engine.lastVerify(),
      hasVerify: !!engine.lastVerify(),
      version: 'v0.1.0',
      updates: options.broken
        ? "v0.2.0 is out, but the last update failed: can't write to /usr/local/bin. Run frost update"
        : 'automatic, v0.2.0 installs after the next backup',
    };

    // The browser only needs the repository and the state above, so the manifest closes here. Latency starts
    // now, so building the history stays fast.
    await manifest.close();
    repo.backend = new SlowBackend(memory, options.latency);
    await runBrowser(
      {
        label: String(repo.backend),
        fingerprint: repo.key.fingerprint(),
        snapshots: (known, signal) => repo.snapshots(known as Parameters<typeof repo.snapshots>[0], signal),
        loadTree: (id, signal) => repo.loadTree(id, signal),
        restore: (id, opts, signal) => new Engine(repo).restore(id, opts, signal),
      },
      cfg,
      state,
    );
    console.log('Demo files and any restores are in', work);
  } finally {
    // Closing again is harmless, and covers failures before the browser opened.
    await manifest.close();
  }
}

// Runs when started directly, as `npm run demo` does, and not when tests import this module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runDemo(parseDemoArgs(process.argv.slice(2))).catch(error => {
    console.error('demo:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
