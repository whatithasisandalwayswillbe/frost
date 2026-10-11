// Tests for the self-updater against a loopback release server: signed installs, interrupted
// activations, flush order before the commit, failure cleanup, downloads and saved update state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm, rename, symlink, readdir, realpath } from 'node:fs/promises';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  latest,
  release,
  installRelease,
  download,
  loadState,
  saveState,
  managed,
  validatePackage,
  type UpdateOptions,
} from '../../src/platform/update.js';
import type { ArchiveEntry } from '../../src/platform/archive.js';
import { signingKey, tar } from './fixtures.js';
import { installationLock } from '../../src/platform/install-lock.js';

// One recorded filesystem step. `id` pairs a handle's sync with its close.
type DurabilityEvent =
  | { kind: 'sync' | 'close'; file: string; directory: boolean; id: number }
  | { kind: 'rename'; file: string; destination: string };

// Patches fs/promises open and rename while `action` runs, recording every sync, close and rename
// in order. syncBuiltinESMExports makes named imports in the updater see the patch. `fail` can
// make a sync throw. The originals are always put back.
async function recordDurability(
  action: (events: DurabilityEvent[]) => Promise<void>,
  fail?: (file: string, directory: boolean) => boolean,
): Promise<void> {
  const originalOpen = promises.open;
  const originalRename = promises.rename;
  const events: DurabilityEvent[] = [];
  let id = 0;
  Object.assign(promises, {
    open: async (...args: Parameters<typeof promises.open>) => {
      const handle = await originalOpen(...args);
      const file = String(args[0]);
      const directory = (await handle.stat()).isDirectory();
      const current = ++id;
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        events.push({ kind: 'sync', file, directory, id: current });
        if (fail?.(file, directory)) throw new Error('directory durability refused');
        await sync();
      };
      handle.close = async () => {
        try {
          await close();
        } finally {
          events.push({ kind: 'close', file, directory, id: current });
        }
      };
      return handle;
    },
    rename: async (...args: Parameters<typeof promises.rename>) => {
      await originalRename(...args);
      events.push({ kind: 'rename', file: String(args[0]), destination: String(args[1]) });
    },
  });
  syncBuiltinESMExports();
  try {
    await action(events);
  } finally {
    Object.assign(promises, { open: originalOpen, rename: originalRename });
    syncBuiltinESMExports();
  }
}

// Serves a signed v1.2.3 release on loopback and sets up an installed v1.0.0 to update. `mutate`
// can damage the archive in flight. The server also answers /retry (two 503s, then "ok") and
// /large (a declared length far over the test's limit). The probe is stubbed, as the runtime is fake. `nodeVersion`
// is the runtime version the signed manifest names.
async function fixture(t: test.TestContext, mutate = (b: Buffer): Buffer => b, nodeVersion = 'v26.10.0') {
  const version = 'v1.2.3';
  const target = { os: 'linux', arch: 'amd64' };
  const key = signingKey();
  const node = Buffer.from('fake signed runtime bytes');
  const archiveName = 'frost_1.2.3_linux_amd64.tar.gz';
  const manifest = {
    version,
    os: target.os,
    arch: target.arch,
    nodeVersion,
    nodeSha256: createHash('sha256').update(node).digest('hex'),
  };
  const archive = tar([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'runtime/bin/node', data: node },
    { name: `versions/${version}/src/cli/main.js`, data: Buffer.from('frost scripts') },
  ]);
  const sums = Buffer.from(createHash('sha256').update(archive).digest('hex') + '  ' + archiveName + '\n');

  // /releases/latest redirects to the tag, like GitHub does.
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url === '/releases/latest') {
      res.writeHead(302, { location: '/releases/tag/' + version });
      res.end();
    } else if (req.url?.endsWith('checksums.txt.sig')) res.end(key.sign(sums));
    else if (req.url?.endsWith('checksums.txt')) res.end(sums);
    else if (req.url?.endsWith('.tar.gz')) res.end(mutate(archive));
    else if (req.url === '/retry') {
      attempts++;
      res.statusCode = attempts < 3 ? 503 : 200;
      res.end('ok');
    } else if (req.url === '/large') {
      res.writeHead(200, { 'Content-Length': '99999' });
      res.end('big');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const options: UpdateOptions = {
    baseURL: `http://127.0.0.1:${port}/releases`,
    allowHTTP: true,
    trustedKey: key.authorized,
    platform: target,
    backoff: 1,
    probe: async () => {},
  };

  // macOS keeps its temp folder behind a symlink, and the updater works on the real path, so the
  // paths it reports only match once the root is resolved too.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frost-update-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtime/bin'), { recursive: true });
  await writeFile(path.join(root, 'runtime/bin/node'), 'old runtime');
  await writeFile(path.join(root, 'current.json'), '{"version":"v1.0.0"}\n');
  await writeFile(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      version: 'v1.0.0',
      nodeSha256: createHash('sha256').update('old runtime').digest('hex'),
    }) + '\n',
  );
  return { options, root, version, node, url: `http://127.0.0.1:${port}` };
}

test('signed release installs staged scripts and runtime, then commits current version', async t => {
  const f = await fixture(t);
  const rel = await latest(f.options);
  assert.equal(rel.version, f.version);
  await installRelease(rel, f.root, f.options);

  assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, f.version);
  assert.deepEqual(await readFile(path.join(f.root, 'runtime/bin/node')), f.node);
  assert.equal(await readFile(path.join(f.root, 'versions', f.version, 'src/cli/main.js'), 'utf8'), 'frost scripts');
  const manifest = JSON.parse(await readFile(path.join(f.root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, f.version);
  assert.equal(manifest.nodeSha256, createHash('sha256').update(f.node).digest('hex'));
  assert.equal(manifest.nodeVersion, 'v26.10.0');

  // Installing the same release again is harmless.
  await installRelease(rel, f.root, f.options);
});

// release() checks one named release the way latest() checks the newest, and installRelease takes
// what it returns. A tag without a build for this platform, or one that isn't a version, is refused.
test('a named release is checked like the latest one', async t => {
  const f = await fixture(t);
  const rel = await release(f.version, f.options);
  assert.equal(rel.archive, 'frost_1.2.3_linux_amd64.tar.gz');
  await installRelease(rel, f.root, f.options);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, f.version);

  await assert.rejects(release('v9.9.9', f.options), /v9\.9\.9 has no build for linux\/amd64/);
  await assert.rejects(release('latest', f.options), /isn't a release version/);
  await assert.rejects(release(f.version, { ...f.options, trustedKey: signingKey().authorized }), /isn't signed/);
});

// A version folder already on disk, as if an earlier update stopped before its commit, is reused
// when its files match the signed package and refused when they don't.
test('an interrupted activation reuses only the exact signed version tree', async t => {
  const f = await fixture(t);
  const versionDir = path.join(f.root, 'versions', f.version, 'src/cli');
  await mkdir(versionDir, { recursive: true });
  await writeFile(path.join(versionDir, 'main.js'), 'frost scripts');
  await installRelease(await latest(f.options), f.root, f.options);
  await writeFile(path.join(versionDir, 'main.js'), 'different scripts');
  await assert.rejects(installRelease(await latest(f.options), f.root, f.options), /differ from the signed package/);
});

// The first run checks the order of a fresh install. Staged script folders are synced from the
// deepest up before the version folder is renamed into place, and every installation folder is
// synced before current.json is renamed. The second run reuses the installed version folder,
// so it isn't renamed again, but it's still synced before the commit.
test(
  'POSIX update makes version and runtime directories durable before committing the pointer',
  { skip: process.platform === 'win32' },
  async t => {
    const f = await fixture(t);
    const rel = await latest(f.options);
    const destination = path.join(f.root, 'versions', f.version);
    await recordDurability(async events => {
      await installRelease(rel, f.root, f.options);

      const versionIndex = events.findIndex(e => e.kind === 'rename' && e.destination === destination);
      const version = events[versionIndex];
      assert.equal(version?.kind, 'rename');
      if (version.kind !== 'rename') return;
      const commit = events.findIndex(e => e.kind === 'rename' && e.destination === path.join(f.root, 'current.json'));
      assert.ok(commit > versionIndex);

      let previous = -1;
      for (const folder of [path.join(version.file, 'src/cli'), path.join(version.file, 'src'), version.file]) {
        const synced = events.findIndex(e => e.kind === 'sync' && e.directory && e.file === folder);
        assert.ok(synced > previous && synced < versionIndex, folder);
        previous = synced;
      }

      for (const folder of [
        path.join(f.root, 'versions'),
        path.join(f.root, 'runtime/bin'),
        path.join(f.root, 'runtime'),
        f.root,
      ]) {
        assert.ok(
          events.some(
            (e, index) =>
              index > versionIndex && index < commit && e.kind === 'sync' && e.directory && e.file === folder,
          ),
          folder,
        );
      }

      // Every folder handle that was synced was also closed.
      for (const event of events)
        if (event.kind === 'sync' && event.directory)
          assert.ok(events.some(e => e.kind === 'close' && e.id === event.id));
    });

    await recordDurability(async events => {
      await installRelease(rel, f.root, f.options);
      const commit = events.findIndex(e => e.kind === 'rename' && e.destination === path.join(f.root, 'current.json'));
      assert.ok(commit >= 0);
      assert.ok(!events.some(e => e.kind === 'rename' && e.destination === destination));
      for (const folder of [path.join(destination, 'src/cli'), path.join(destination, 'src'), destination])
        assert.ok(
          events.some((e, index) => index < commit && e.kind === 'sync' && e.directory && e.file === folder),
          folder,
        );
    });
  },
);

// Fails the first directory sync at each boundary in turn. The old current.json must survive,
// every synced handle must be closed, no staging folder may be left and the lock must be free.
test(
  'POSIX update directory-sync failures preserve the pointer and release every directory and lock',
  { skip: process.platform === 'win32' },
  async t => {
    for (const boundary of ['scripts', 'versions', 'runtime/bin', 'runtime', 'root'])
      await t.test(boundary, async t => {
        const f = await fixture(t);
        const rel = await latest(f.options);

        // Refuses only the first directory sync that matches this boundary.
        let failed = false;
        const refuses = (file: string, directory: boolean) => {
          if (!directory) return false;
          const matches =
            boundary === 'scripts'
              ? file.endsWith(path.join('src', 'cli'))
              : file === (boundary === 'root' ? f.root : path.join(f.root, boundary));
          if (matches && !failed) {
            failed = true;
            return true;
          }
          return false;
        };

        await recordDurability(async events => {
          await assert.rejects(installRelease(rel, f.root, f.options), /directory durability refused/);
          assert.equal(failed, true);
          assert.ok(!events.some(e => e.kind === 'rename' && e.destination === path.join(f.root, 'current.json')));
          for (const event of events)
            if (event.kind === 'sync' && event.directory)
              assert.ok(events.some(e => e.kind === 'close' && e.id === event.id));
        }, refuses);

        assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, 'v1.0.0');
        assert.ok(!(await promises.readdir(f.root)).some(name => name.startsWith('.frost-update-')));
        const unlock = await installationLock(f.root);
        await unlock();
      });
  },
);

// Extra bytes after the archive break its signed checksum.
test('tampered archive or failed probe leaves the installed version untouched', async t => {
  const f = await fixture(t, b => Buffer.concat([b, Buffer.from('tamper')]));
  const oldManifest = await readFile(path.join(f.root, 'manifest.json'));
  await assert.rejects(installRelease(await latest(f.options), f.root, f.options), /signed checksum/);
  assert.equal(await readFile(path.join(f.root, 'runtime/bin/node'), 'utf8'), 'old runtime');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, 'v1.0.0');
  assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), oldManifest);

  const good = await fixture(t);
  const goodManifest = await readFile(path.join(good.root, 'manifest.json'));
  await assert.rejects(
    installRelease(await latest(good.options), good.root, {
      ...good.options,
      probe: async () => {
        throw new Error('probe failed');
      },
    }),
    /probe failed/,
  );
  assert.equal(await readFile(path.join(good.root, 'runtime/bin/node'), 'utf8'), 'old runtime');
  assert.deepEqual(await readFile(path.join(good.root, 'manifest.json')), goodManifest);
});

// installRelease only accepts the release object latest() returned, so a copy is refused.
test('update refuses unverified release objects and another active updater', async t => {
  const f = await fixture(t);
  const rel = await latest(f.options);
  await assert.rejects(installRelease({ ...rel }, f.root, f.options), /wasn't checked/);

  // Holding the installation lock stands in for another updater.
  const unlock = await installationLock(f.root);
  t.after(unlock);
  await assert.rejects(installRelease(rel, f.root, f.options), /already running/);
});

// The probe cancels the update itself, so cancellation lands just before activation.
test('cancellation after probing leaves installed runtime and pointer intact', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const rel = await latest(f.options);
  await assert.rejects(
    installRelease(rel, f.root, {
      ...f.options,
      signal: controller.signal,
      probe: async () => {
        controller.abort();
      },
    }),
  );
  assert.equal(await readFile(path.join(f.root, 'runtime/bin/node'), 'utf8'), 'old runtime');
});

// The probe moves the installation root away and leaves a symlink to `outside` in its place.
test(
  'update detects a replaced installation root after its probe before activating outside it',
  { skip: process.platform === 'win32' },
  async t => {
    const f = await fixture(t);
    const moved = f.root + '.moved';
    const outside = await mkdtemp(path.join(os.tmpdir(), 'frost-update-outside-'));
    t.after(() => rm(moved, { recursive: true, force: true }));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const rel = await latest(f.options);
    await assert.rejects(
      installRelease(rel, f.root, {
        ...f.options,
        probe: async () => {
          await rename(f.root, moved);
          await symlink(outside, f.root);
        },
      }),
      /installation root changed/,
    );

    assert.deepEqual(await readdir(outside), []);
    assert.equal(JSON.parse(await readFile(path.join(moved, 'current.json'), 'utf8')).version, 'v1.0.0');
    const unlock = await installationLock(moved);
    await unlock();
  },
);

// Drops the probe stub so the real probe runs, with a command runner that reports the wrong Node
// version. The probe must stop after `--version` and change nothing.
test('update rejects a runtime version mismatch before activating signed files', async t => {
  const f = await fixture(t);
  const { probe: _probe, ...options } = f.options;
  const oldManifest = await readFile(path.join(f.root, 'manifest.json'));
  const calls: string[][] = [];
  await assert.rejects(
    installRelease(await latest(options), f.root, {
      ...options,
      runner: async (_program, args) => {
        calls.push(args);
        return { code: 0, stdout: 'v0.0.0\n', stderr: '' };
      },
    }),
    /new runtime says.*expected v26\.10\.0/,
  );

  assert.deepEqual(calls, [['--version']]);
  assert.equal(await readFile(path.join(f.root, 'runtime/bin/node'), 'utf8'), 'old runtime');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, 'v1.0.0');
  assert.deepEqual(await readFile(path.join(f.root, 'manifest.json')), oldManifest);
});

// Installed copies run these checks on every later release, so what they accept sets what a release may contain. The
// runtime has a floor and no ceiling, and the file types include a few that no release uses yet.
const packageTarget = { os: 'linux', arch: 'amd64' };
function packageEntries(nodeVersion: string, files: string[] = []): ArchiveEntry[] {
  const node = Buffer.from('runtime');
  const manifest = {
    version: 'v1.2.3',
    ...packageTarget,
    nodeVersion,
    nodeSha256: createHash('sha256').update(node).digest('hex'),
  };
  return [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
    { name: 'runtime/bin/node', data: node, mode: 0o755 },
    { name: 'versions/v1.2.3/src/cli/main.js', data: Buffer.from('main'), mode: 0o644 },
    ...files.map(name => ({ name: 'versions/v1.2.3/' + name, data: Buffer.from('data'), mode: 0o644 })),
  ];
}

test('package validation sets a floor for the runtime and no ceiling', () => {
  for (const nodeVersion of ['v26.10.0', 'v26.11.2', 'v26.100.0', 'v27.0.0', 'v30.1.0'])
    assert.doesNotThrow(() => validatePackage(packageEntries(nodeVersion), 'v1.2.3', packageTarget), nodeVersion);
  for (const nodeVersion of [
    'v26.9.9',
    'v25.99.0',
    'v0.0.0',
    'v26.10',
    '26.10.0',
    'v26.10.0-rc.1',
    'v026.10.0',
    'v99999999.0.0',
  ])
    assert.throws(
      () => validatePackage(packageEntries(nodeVersion), 'v1.2.3', packageTarget),
      /package manifest mismatch/,
      nodeVersion,
    );
});

test('package validation accepts scripts, data and sounds and refuses native code', () => {
  const accepted = [
    'package.json',
    'src/extra.mjs',
    'assets/words.txt',
    'assets/ding.wav',
    'assets/ding.ogg',
    'assets/ding.mp3',
    'node_modules/dependency/LICENSE',
    'node_modules/dependency/README.md',
  ];
  assert.doesNotThrow(() => validatePackage(packageEntries('v26.10.0', accepted), 'v1.2.3', packageTarget));
  for (const name of [
    'src/addon.node',
    'src/tool.exe',
    'src/lib.dll',
    'src/lib.so',
    'src/lib.dylib',
    'src/gear.wasm',
    'src/run.sh',
    'assets/data.bin',
  ])
    assert.throws(
      () => validatePackage(packageEntries('v26.10.0', [name]), 'v1.2.3', packageTarget),
      /unexpected package code/,
      name,
    );

  // A new top-level file needs updater code that older installs don't have, so it stays refused.
  const entries = [...packageEntries('v26.10.0'), { name: 'uninstall.mjs', data: Buffer.from('x'), mode: 0o644 }];
  assert.throws(() => validatePackage(entries, 'v1.2.3', packageTarget), /unexpected package path/);
});

// A release the installed frost can't read says how to get past it, and nothing is replaced.
test('a release with a runtime below the floor says to reinstall and changes nothing', async t => {
  const f = await fixture(t, undefined, 'v25.0.0');
  await assert.rejects(
    installRelease(await latest(f.options), f.root, f.options),
    /package manifest mismatch\. This frost may be too old to read v1\.2\.3, so reinstall it: https:\/\/github\.com\/whatithasisandalwayswillbe\/frost#install/,
  );
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, 'v1.0.0');
  assert.equal(await readFile(path.join(f.root, 'runtime/bin/node'), 'utf8'), 'old runtime');
});

// Plain HTTP only works with the fixture's allowHTTP option, so the last call without options fails.
test('downloads bound content, retry server failures, and reject insecure URLs by default', async t => {
  const f = await fixture(t);
  assert.equal((await download(f.url + '/retry', 20, f.options)).toString(), 'ok');
  await assert.rejects(download(f.url + '/large', 20, f.options), /too big/);
  await assert.rejects(download(f.url + '/retry', 20), /https/);
});

// Damaged state reads as empty. managed() names the package manager that owns an install path.
test('state writes are private and tolerate damaged files', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'state', 'update.json');
  assert.deepEqual(await loadState(file), {});
  await saveState(file, { latest: 'v1.2.3', checked: '2026-10-04T12:00:00Z' });
  assert.equal((await loadState(file)).latest, 'v1.2.3');
  await writeFile(file, '{bad');
  assert.deepEqual(await loadState(file), {});
  assert.equal(managed('/nix/store/hash/frost'), 'Nix');
  assert.equal(managed('/home/me/.local/bin/frost'), '');
});
