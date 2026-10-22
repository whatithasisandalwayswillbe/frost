// Benchmarks fresh backup, unchanged backup, restore and verify on four generated datasets, with in-memory storage,
// and prints the medians. `npm run benchmark` runs it after a build; an optional argument sets the runs per dataset,
// 3 to 20 (default 5). Each run is a fresh process, this file with `--run <dataset>`, so peak memory is per run.
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);

if (process.argv[2] === '--run') await runOnce(path.resolve(process.argv[3]));
else await benchmark(Number(process.argv[2] || 5));

async function benchmark(runs) {
  if (!Number.isInteger(runs) || runs < 3 || runs > 20) throw new Error('Benchmark runs must be between 3 and 20');
  await mkdir(path.join(root, '.work'), { recursive: true });
  const work = await mkdtemp(path.join(root, '.work/benchmark-'));
  try {
    // Benchmark a frozen copy of the build, so a rebuild mid-run can't change the code being measured.
    const frozen = path.join(work, 'application');
    await cp(path.join(root, 'dist/src'), path.join(frozen, 'src'), { recursive: true });
    await cp(path.join(root, 'dist/assets'), path.join(frozen, 'assets'), { recursive: true });
    await cp(path.join(root, 'node_modules/@iarna'), path.join(frozen, 'node_modules/@iarna'), { recursive: true });
    await writeFile(path.join(frozen, 'package.json'), '{"type":"module"}\n');

    // Each dataset is [name, file count, file size, compressible]. Random data comes from an xorshift32 generator,
    // so every run sees the same bytes.
    for (const [name, count, size, compressible] of [
      ['small', 64, 16, false],
      ['many-small', 1024, 1024, false],
      ['large-random', 4, 16 << 20, false],
      ['large-compressible', 4, 16 << 20, true],
    ]) {
      const dataset = path.join(work, name);
      await mkdir(dataset);
      for (let i = 0; i < count; i++) {
        const data = Buffer.alloc(size, 97 + i);
        if (!compressible) {
          let state = i + 1;
          for (let j = 0; j < size; j++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            data[j] = state & 255;
          }
        }
        await writeFile(path.join(dataset, String(i)), data);
      }

      const measurements = [];
      for (let run = 0; run < runs; run++) {
        const result = spawnSync(process.execPath, [self, '--run', dataset], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120000,
          env: { ...process.env, FROST_BENCH_CODE: frozen },
        });
        if (result.error || result.status !== 0)
          throw new Error(result.error?.message || result.stderr || 'Benchmark failed');
        measurements.push(JSON.parse(result.stdout));
      }

      const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      };
      const milliseconds = Object.fromEntries(
        ['fresh_backup', 'unchanged_backup', 'restore', 'verify'].map(op => [
          op,
          +median(measurements.map(m => m.milliseconds[op])).toFixed(2),
        ]),
      );
      const peakMiB = +(median(measurements.map(m => m.peakRSS)) / (1 << 20)).toFixed(1);
      console.log(name.padEnd(20), JSON.stringify({ milliseconds, peakMiB }));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// One pass over a dataset: a fresh backup, 32 unchanged backups, a restore and a full verification, printed as JSON.
async function runOnce(dataset) {
  const code = pathToFileURL(path.resolve(process.env.FROST_BENCH_CODE || path.join(root, 'dist')) + path.sep);
  const load = file => import(new URL(file, code).href);
  const { Key } = await load('src/core/crypto.js');
  const { Repo } = await load('src/core/repo.js');
  const { Manifest } = await load('src/core/manifest.js');
  const { Engine } = await load('src/engine/index.js');
  const { errNotFound, errExists } = await load('src/core/storage.js');

  // In-memory storage, so the timings measure Frost rather than a disk or network. getOwned returns a fresh copy,
  // which Frost may erase or detach.
  const objects = new Map();
  const backend = {
    async put(key, data) {
      objects.set(key, Buffer.from(data));
    },
    async putNew(key, data) {
      if (objects.has(key)) throw errExists;
      objects.set(key, Buffer.from(data));
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw errNotFound;
      return Buffer.from(value);
    },
    async getOwned(key) {
      return this.get(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
    },
    async delete(key) {
      objects.delete(key);
    },
    toString: () => 'memory:benchmark',
    location: () => 'memory:benchmark',
  };

  // An all-zero key is fine, because this repository only ever lives in memory.
  const work = await mkdtemp(path.join(os.tmpdir(), 'frost-benchmark-'));
  const key = Key.fromMaster(Buffer.alloc(32));
  const repo = await Repo.init(backend, key);
  const manifest = await Manifest.open(path.join(work, 'cache.jsonl'));
  const engine = new Engine(repo, manifest);
  const milliseconds = {};
  const time = async (name, operation) => {
    const start = performance.now();
    const result = await operation();
    milliseconds[name] = performance.now() - start;
    return result;
  };

  try {
    const first = await time('fresh_backup', () => engine.backup({ paths: [dataset], host: 'benchmark' }));

    // The unchanged time is the average of 32 backups, each of which must skip saving a snapshot.
    await time('unchanged_backup', async () => {
      for (let i = 0; i < 32; i++)
        if (!(await engine.backup({ paths: [dataset], host: 'benchmark' })).unchanged)
          throw new Error('Unchanged backup saved a snapshot');
    });
    milliseconds.unchanged_backup /= 32;

    // Restore runs on a repository-only engine. Snapshot paths use forward slashes.
    const restored = path.join(work, 'restored');
    await time('restore', () =>
      new Engine(repo).restore(first.snapshot.id, {
        target: restored,
        newTarget: true,
        base: dataset.split(path.sep).join('/'),
      }),
    );
    const verify = await time('verify', () => engine.verify(100000, true));
    if (verify.failures?.length) throw new Error('Verification failed');

    // Every restored file must match its original.
    const digest = async file =>
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    for (const file of await readdir(dataset))
      if ((await digest(path.join(dataset, file))) !== (await digest(path.join(restored, file))))
        throw new Error('Restored file differs');

    // maxRSS is in kilobytes.
    console.log(JSON.stringify({ milliseconds, peakRSS: process.resourceUsage().maxRSS * 1024 }));
  } finally {
    await manifest.close();
    key.destroy();
    await rm(work, { recursive: true, force: true });
  }
}
