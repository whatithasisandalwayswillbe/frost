// Smoke-tests a release package with its own runtime. It unpacks the package, checks the version it reports, then runs
// a scheduled and a manual backup, status and a restore against a loopback Permafrost server, and prints a JSON
// summary. CI runs it as `smoke.mjs <archive>` after package.mjs. tools.test.ts imports smokeFixture. Build first.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractArchive } from '../dist/src/platform/archive.js';
import { Key } from '../dist/src/core/crypto.js';
import { Repo } from '../dist/src/core/repo.js';
import { Manifest } from '../dist/src/core/manifest.js';
import { defaultConfig, render, writePrivate } from '../dist/src/core/config.js';
import { errNotFound, errExists, hash, validObjectKey, readBounded } from '../dist/src/core/storage.js';
import { Engine } from '../dist/src/engine/index.js';

const workspace = fileURLToPath(new URL('../', import.meta.url));

// Unpacks a .tar.gz or .zip package into folder with frost's own archive reader. Every entry must land inside the
// folder, with no symlinked folder on the way, and existing files are never overwritten.
export async function unpack(archive, folder) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const top = await lstat(folder);
  if (!top.isDirectory() || top.isSymbolicLink()) throw new Error('Destination must be a real folder');
  for (const entry of extractArchive(archive, await readFile(archive))) {
    const file = path.join(folder, ...entry.name.split('/'));
    const relative = path.relative(folder, file);
    if (!relative || relative.split(path.sep)[0] === '..' || path.isAbsolute(relative))
      throw new Error('Archive path escapes destination');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let dir = path.dirname(file); dir !== folder; dir = path.dirname(dir))
      if ((await lstat(dir)).isSymbolicLink()) throw new Error('Destination contains a symlink');
    const handle = await open(file, 'wx', entry.mode);
    try {
      await handle.writeFile(entry.data);
    } finally {
      await handle.close();
    }
  }
}

// Sets up a private config, a file to back up and a loopback Permafrost server holding a fresh repository, inside
// work. Returns the config and source folders, verify(), which checks the saved snapshots and returns their count,
// and close(), which stops the server.
export async function smokeFixture(work) {
  const config = path.join(work, 'fixture-config');
  const source = path.join(work, 'fixture-source');
  await mkdir(config, { recursive: true, mode: 0o700 });
  await mkdir(source, { recursive: true, mode: 0o700 });
  await writeFile(path.join(source, 'smoke.txt'), 'frost smoke test\n', { mode: 0o600 });

  const stored = new Map();
  const token = randomBytes(32).toString('hex');
  const backend = {
    async put(key, bytes) {
      stored.set(key, Buffer.from(bytes));
    },
    async putNew(key, bytes) {
      if (stored.has(key)) throw errExists;
      stored.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const bytes = stored.get(key);
      if (!bytes) throw errNotFound;
      return Buffer.from(bytes);
    },
    async delete(key) {
      stored.delete(key);
    },
    async list(prefix) {
      return [...stored.keys()].filter(k => k.startsWith(prefix)).sort();
    },
    toString() {
      return 'smoke-fixture';
    },
  };

  // Create the repository and save its recovery phrase as the config's key file.
  const key = Key.new();
  try {
    await Repo.init(backend, key);
    await writePrivate(path.join(config, 'key'), key.phrase() + '\n');
  } finally {
    key.destroy();
  }

  // A minimal Permafrost server (docs/PERMAFROST.md) over the backend. It needs the bearer token, lists keys,
  // checks x-content-sha256 on uploads, sends it on downloads and treats If-None-Match: * as create-only.
  const server = createServer(async (req, res) => {
    const fail = (status, code) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code, message: code } }));
    };
    try {
      if (req.headers.authorization !== 'Bearer ' + token) return fail(401, 'unauthorized');
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = decodeURIComponent(url.pathname.slice('/v1/objects/'.length));
      if (url.pathname === '/v1/objects' && req.method === 'GET')
        return res.end(JSON.stringify({ keys: await backend.list(url.searchParams.get('prefix') || '') }));
      if (!url.pathname.startsWith('/v1/objects/') || !validObjectKey(key)) return fail(400, 'invalid_key');
      if (req.method === 'GET') {
        const bytes = await backend.get(key);
        res.writeHead(200, { 'x-content-sha256': hash(bytes) });
        res.end(bytes);
      } else if (req.method === 'PUT') {
        const bytes = await readBounded(req, 16 << 20, Number(req.headers['content-length'] ?? -1));
        if (hash(bytes) !== req.headers['x-content-sha256']) return fail(400, 'checksum');
        if (req.headers['if-none-match'] === '*') await backend.putNew(key, bytes);
        else await backend.put(key, bytes);
        res.writeHead(204);
        res.end();
      } else if (req.method === 'DELETE') {
        await backend.delete(key);
        res.writeHead(204);
        res.end();
      } else fail(405, 'method');
    } catch (e) {
      // A missing object is 404 and an existing one on a create-only upload is 412. Anything else is 500.
      if (e === errNotFound) fail(404, 'not_found');
      else if (e === errExists) fail(412, 'exists');
      else fail(500, 'fixture_error');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  // Point a default config at the server, with verification sampling and automatic updates off. Automatic
  // backups stay on, because a scheduled run does nothing without them. No job is installed, since frost only
  // touches one it recorded installing.
  const cfg = defaultConfig();
  cfg.paths = [source];
  cfg.exclude = [];
  cfg.verify.sample = 0;
  cfg.update.auto = false;
  cfg.storage.backend = 'permafrost';
  cfg.storage.permafrost = { url: `http://127.0.0.1:${server.address().port}`, token };
  await writePrivate(path.join(config, 'config.toml'), render(cfg));

  return {
    config,
    source,

    // Opens the repository with the saved key and verifies every chunk. Throws if there's no snapshot.
    async verify() {
      const key = Key.fromPhrase(await readFile(path.join(config, 'key'), 'utf8'));
      const manifest = await Manifest.open(path.join(work, 'fixture-verify.jsonl'));
      try {
        const repo = await Repo.open(backend, key);
        const snapshots = await backend.list('snapshots/');
        if (!snapshots.length) throw new Error('No snapshot was saved');
        const result = await new Engine(repo, manifest).verify(100000, true);
        if (result.failures?.length) throw new Error('The saved snapshot failed verification');
        return snapshots.length;
      } finally {
        await manifest.close();
        key.destroy();
      }
    },

    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// Unpacks the archive into a scratch folder under .work/ and runs the packaged CLI against the fixture.
async function smoke(archive) {
  await mkdir(path.join(workspace, '.work'), { recursive: true });
  const work = await mkdtemp(path.join(workspace, '.work/smoke-'));
  let fixture;
  try {
    const app = path.join(work, 'package');
    await unpack(archive, app);
    const runtime = path.join(app, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node');
    fixture = await smokeFixture(work);
    const cache = path.join(work, 'cache');
    const target = path.join(work, 'restore target');
    const log = path.join(work, 'scheduled.log');
    await mkdir(cache);
    await mkdir(target);

    // A recent update check in the cache keeps the CLI from checking online.
    await writeFile(path.join(cache, 'update.json'), JSON.stringify({ checked: new Date().toISOString() }));

    // Runs the packaged CLI with the fixture's config and the private cache, keeps its combined output and returns it.
    const outputs = [];
    async function command(args) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          runtime,
          [path.join(app, 'launch.mjs'), '--config-dir', fixture.config, '--cache-dir', cache, ...args],
          {
            shell: false,
            windowsHide: true,
            signal: AbortSignal.timeout(30000),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FROST_NO_SOUND: '1' },
          },
        );
        let output = '';
        child.stdout.on('data', bytes => (output += bytes));
        child.stderr.on('data', bytes => (output += bytes));
        child.on('error', reject);
        child.on('close', code => resolve({ code, output }));
      });
      if (result.code !== 0) throw new Error(`Packaged command failed: ${args[0]}\n${result.output}`);
      outputs.push(result.output);
      return result.output;
    }

    // The package must report the version it was built for, not the `dev` of a source build.
    const version = JSON.parse(await readFile(path.join(app, 'current.json'), 'utf8')).version;
    const reported = await command(['--version']);
    if (reported.trim() !== `frost version ${version}`)
      throw new Error(`Packaged version is ${JSON.stringify(reported.trim())}, expected ${version}`);

    // The scheduled backup saves the only snapshot. A manual backup of the same files must not save another.
    await command(['backup', '--no-verify', '--scheduled', '--log-file', log]);
    if ((await fixture.verify()) !== 1) throw new Error('Scheduled command saved an unexpected snapshot count');
    await command(['backup', '--no-verify']);
    if ((await fixture.verify()) !== 1) throw new Error('Unchanged backup saved another snapshot');
    await command(['status', '--verify']);
    await command(['restore', 'latest', '--to', target]);

    // Find the restored file anywhere under the target. Its bytes must match the source.
    const find = async folder => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          const found = await find(file);
          if (found) return found;
        } else if (entry.name === 'smoke.txt') return file;
      }
    };
    const restored = await find(target);
    if (!restored || !(await readFile(restored)).equals(await readFile(path.join(fixture.source, 'smoke.txt'))))
      throw new Error('Packaged restore bytes differ');

    // No output or log may contain the recovery phrase, and the scheduled log must record the whole run.
    const savedLog = await readFile(log, 'utf8');
    const phrase = (await readFile(path.join(fixture.config, 'key'), 'utf8')).trim();
    if ([...outputs, savedLog].some(output => output.includes(phrase)))
      throw new Error('Packaged output exposed the fixture key');
    if (!savedLog.includes('scheduled backup starting') || !savedLog.includes('Saved snapshot '))
      throw new Error('Scheduled command log is incomplete');

    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        version,
        versionReported: true,
        scheduledBackup: true,
        unchangedBackup: true,
        statusVerification: true,
        restoredBytesMatch: true,
        scheduledLog: true,
      }),
    );
  } finally {
    try {
      if (fixture) await fixture.close();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

// Run only as a script, not when a test imports this module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('A package archive is required');
  await smoke(path.resolve(process.argv[2]));
}
