// Tests for the getfrost npm package: what tools/npm-package.mjs puts in it, and how its Frost command installs the
// signed release for its version from a loopback server and hands commands to the installed Frost.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { signingKey, tar } from './fixtures.js';
import { runtimePath } from '../../src/platform/runtime.js';

// Tests run from dist/test/platform, so the project is three folders up.
const project = fileURLToPath(new URL('../../../', import.meta.url));

async function workspace(t: test.TestContext) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'frost-npm-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  return work;
}

// Builds the package into a fresh folder with the real tool, from the compiled modules the tests run.
async function built(t: test.TestContext, version = 'v0.1.0') {
  const out = path.join(await workspace(t), 'getfrost');
  const { buildPackage } = await import(pathToFileURL(path.join(project, 'tools/npm-package.mjs')).href);
  const manifest = await buildPackage(version, out);
  return { out, manifest };
}

test('the npm package holds the frost command, its updater modules and nothing else', async t => {
  const { out, manifest } = await built(t);
  const { modules } = await import(pathToFileURL(path.join(project, 'tools/npm-package.mjs')).href);
  assert.deepEqual((await readdir(out)).sort(), ['LICENSE', 'README.md', 'frost.mjs', 'lib', 'package.json']);
  assert.deepEqual((await readdir(path.join(out, 'lib'))).sort(), ['npm.mjs', ...modules].sort());
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'package.json'), 'utf8')), manifest);
  assert.equal(manifest.name, 'getfrost');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.bin, { frost: 'frost.mjs' });
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.ok((await readFile(path.join(out, 'frost.mjs'), 'utf8')).startsWith('#!/usr/bin/env node\n'));

  // Every copied module imports, which also proves nothing loads the native bindings up front.
  const npm = await import(pathToFileURL(path.join(out, 'lib/npm.mjs')).href);
  assert.equal(typeof npm.main, 'function');

  const { buildPackage } = await import(pathToFileURL(path.join(project, 'tools/npm-package.mjs')).href);
  await assert.rejects(buildPackage('v0.2.0-rc.1', path.join(out, '..', 'pre')), /stable release version/);
  await assert.rejects(buildPackage('v0.1.0', out), /must be empty/);
});

// Serves a signed linux/amd64 release on loopback, the way GitHub lays out release downloads. `signer` and `tamper`
// break the signature or the archive. `requests` counts every request.
async function release(
  t: test.TestContext,
  options: { signer?: ReturnType<typeof signingKey>; tamper?: boolean } = {},
) {
  const key = signingKey();
  const version = 'v0.1.0';
  const node = Buffer.from('fake runtime bytes');
  const archiveName = 'frost_0.1.0_linux_amd64.tar.gz';
  const archive = tar([
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          version,
          os: 'linux',
          arch: 'amd64',
          nodeVersion: 'v26.10.0',
          nodeSha256: createHash('sha256').update(node).digest('hex'),
        }),
      ),
    },
    { name: 'runtime/bin/node', data: node },
    { name: 'install.mjs', data: Buffer.from('// installer') },
    { name: `versions/${version}/src/cli/main.js`, data: Buffer.from('frost scripts') },
  ]);
  const sums = Buffer.from(createHash('sha256').update(archive).digest('hex') + '  ' + archiveName + '\n');
  const counter = { requests: 0 };
  const server = createServer((req, res) => {
    counter.requests++;
    const name = req.url?.split('/').pop();
    if (req.url === `/releases/download/${version}/${archiveName}`)
      res.end(options.tamper ? Buffer.concat([archive, Buffer.from('x')]) : archive);
    else if (name === 'checksums.txt') res.end(sums);
    else if (name === 'checksums.txt.sig') res.end((options.signer ?? key).sign(sums));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return {
    counter,
    version,
    options: {
      baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/releases`,
      allowHTTP: true,
      trustedKey: key.authorized,
      platform: { os: 'linux', arch: 'amd64' },
      backoff: 1,
    },
  };
}

// Runs main() with a fake installer that records its call and lays out an installed version, and a handoff that
// records where it would go.
async function bootstrap(t: test.TestContext, r: Awaited<ReturnType<typeof release>>, version = r.version) {
  const { out } = await built(t);
  const { main } = await import(pathToFileURL(path.join(out, 'lib/npm.mjs')).href);
  const work = await workspace(t);
  const root = path.join(work, 'data', 'frost', 'app');
  const temp = path.join(work, 'temp');
  await mkdir(temp);
  const calls = { log: [] as string[], installs: [] as string[][], handoffs: [] as string[][] };
  const options = {
    ...r.options,
    version,
    root,
    temp,
    log: (line: string) => calls.log.push(line),
    runInstaller: async (node: string, args: string[]) => {
      // The staged package is complete while install.mjs runs.
      assert.equal(
        await readFile(path.join(args[1], 'versions', r.version, 'src/cli/main.js'), 'utf8'),
        'frost scripts',
      );
      calls.installs.push([node, ...args]);
      await mkdir(path.join(root, 'versions', r.version, 'src/cli'), { recursive: true });
      await writeFile(path.join(root, 'versions', r.version, 'src/cli/main.js'), 'frost scripts');
      await mkdir(path.dirname(runtimePath(root)), { recursive: true });
      await writeFile(runtimePath(root), 'runtime');
      await writeFile(path.join(root, 'current.json'), JSON.stringify({ version: r.version }));
      return 0;
    },
    handoff: (node: string, script: string, args: string[]) => calls.handoffs.push([node, script, ...args]),
  };
  return { main, options, calls, root, temp };
}

test('the frost command installs its signed release once, then hands every command to it', async t => {
  const r = await release(t);
  const b = await bootstrap(t, r);
  await b.main(['status', '--verify'], b.options);

  assert.deepEqual(b.calls.log, [`Downloading Frost ${r.version} for linux/amd64`, 'Signature ok', 'Checksum ok']);
  assert.equal(b.calls.installs.length, 1);
  const [node, script, stage, launchers] = b.calls.installs[0];
  assert.equal(node, path.join(stage, 'runtime', 'bin', 'node'));
  assert.equal(script, path.join(stage, 'install.mjs'));
  assert.equal(path.dirname(stage), b.temp);
  assert.equal(launchers, path.join(path.dirname(b.root), 'bin'));
  await assert.rejects(readdir(stage), { code: 'ENOENT' });
  assert.deepEqual(b.calls.handoffs, [[runtimePath(b.root), path.join(b.root, 'launch.mjs'), 'status', '--verify']]);

  // Installed now, so the next command goes straight to Frost without asking the server anything.
  const requests = r.counter.requests;
  await b.main(['backup'], b.options);
  assert.equal(r.counter.requests, requests);
  assert.equal(b.calls.installs.length, 1);
  assert.deepEqual(b.calls.handoffs[1], [runtimePath(b.root), path.join(b.root, 'launch.mjs'), 'backup']);

  // Frost updates itself, so an older package never installs over a newer Frost.
  await b.main(['status'], { ...b.options, version: 'v0.0.9' });
  assert.equal(b.calls.installs.length, 1);
  assert.equal(r.counter.requests, requests);
});

test('the frost command refuses a bad signature, a damaged archive or a failed install', async t => {
  for (const [options, message] of [
    [{ signer: signingKey() }, /isn't signed by the Frost release key/],
    [{ tamper: true }, /checksum mismatch for frost_0\.1\.0_linux_amd64\.tar\.gz/],
  ] as const) {
    const b = await bootstrap(t, await release(t, options));
    await assert.rejects(b.main(['status'], b.options), message);
    assert.deepEqual([b.calls.installs.length, b.calls.handoffs.length], [0, 0]);
  }

  const b = await bootstrap(t, await release(t));
  await assert.rejects(b.main(['status'], { ...b.options, runInstaller: async () => 1 }), /package install failed/);
  assert.deepEqual(await readdir(b.temp), []);
  assert.equal(b.calls.handoffs.length, 0);
});

// Runs the generated bin in a child process with a private data folder. The installed "Frost" there is a launch.mjs
// that prints its arguments and exits with 3, started by the Node.js running the tests.
test('the frost command runs the installed Frost with its arguments and exit code', async t => {
  const { out } = await built(t);
  const work = await workspace(t);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: work, XDG_DATA_HOME: work, LOCALAPPDATA: work };
  delete env.NODE_OPTIONS;
  const root =
    process.platform === 'darwin'
      ? path.join(work, 'Library/Application Support/frost/app')
      : path.join(work, 'frost/app');
  await mkdir(path.join(root, 'versions/v0.1.0/src/cli'), { recursive: true });
  await writeFile(path.join(root, 'versions/v0.1.0/src/cli/main.js'), '');
  await writeFile(path.join(root, 'current.json'), '{"version":"v0.1.0"}\n');
  await writeFile(
    path.join(root, 'launch.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 3;\n',
  );
  await mkdir(path.dirname(runtimePath(root)), { recursive: true });
  if (process.platform === 'win32') await copyFile(process.execPath, runtimePath(root));
  else await symlink(process.execPath, runtimePath(root));

  const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(out, 'frost.mjs'), 'restore', 'a b'], { env, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', bytes => (stdout += bytes));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout }));
  });
  assert.deepEqual([result.code, JSON.parse(result.stdout)], [3, ['restore', 'a b']]);
});

// The bin checks the Node.js version before loading anything, so even a much older Node.js gets a plain message.
test('the frost command says which Node.js it needs', async t => {
  const { out } = await built(t);
  const preload = path.join(await workspace(t), 'old-node.mjs');
  await writeFile(
    preload,
    "Object.defineProperty(process.versions, 'node', { value: '18.20.0' });\nObject.defineProperty(process, 'version', { value: 'v18.20.0' });\n",
  );
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(out, 'frost.mjs')], {
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', bytes => (stderr += bytes));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    'getfrost: installing Frost requires Node.js v22 or newer (detected version: v18.20.0)\n',
  );
});
