// Tests for the PowerShell installer, install/install.ps1. Its embedded signature check runs with node on every OS.
// On Windows, the whole script installs a signed fixture release from a loopback server into private folders, with
// the release key swapped for a test key the way release.sh swaps it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { signingKey } from './fixtures.js';

// Tests run from dist/test/platform, so the project is three folders up.
const project = fileURLToPath(new URL('../../../', import.meta.url));
const scriptFile = path.join(project, 'install/install.ps1');

// Runs a program without a shell and collects its output. It's killed after two minutes.
function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(program, args, { env, windowsHide: true, signal: AbortSignal.timeout(120000) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', bytes => (stdout += bytes));
    child.stderr.on('data', bytes => (stderr += bytes));
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function workspace(t: test.TestContext) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'frost-install-ps1-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  return work;
}

// The verifier is the single-quoted here-string assigned to $Verifier, so PowerShell passes it to node unchanged.
test('the embedded verifier accepts only the release key signing checksums.txt in the file namespace', async t => {
  const script = await readFile(scriptFile, 'utf8');
  const verifier = /\n {2}\$Verifier = @'\n([\s\S]*?)\n'@\n/.exec(script)?.[1];
  assert.ok(verifier, 'install.ps1 has no $Verifier here-string');
  const work = await workspace(t);
  const file = path.join(work, 'verify.cjs');
  await writeFile(file, verifier);

  const key = signingKey();
  const sums = Buffer.from('0'.repeat(64) + '  frost_1.2.3_windows_amd64.zip\n');
  const check = async (authorized: string, list: Buffer, signature: string) => {
    await writeFile(path.join(work, 'checksums.txt'), list);
    await writeFile(path.join(work, 'checksums.txt.sig'), signature);
    return run(process.execPath, [
      file,
      authorized,
      path.join(work, 'checksums.txt'),
      path.join(work, 'checksums.txt.sig'),
    ]);
  };

  const good = await check(key.authorized, sums, key.sign(sums));
  assert.deepEqual([good.code, good.stdout.trim()], [0, 'ok']);
  // CRLF armor, as a Windows download might save it, still verifies.
  assert.equal((await check(key.authorized, sums, key.sign(sums).replaceAll('\n', '\r\n'))).code, 0);

  for (const [authorized, list, signature] of [
    [signingKey().authorized, sums, key.sign(sums)],
    [key.authorized, Buffer.from(sums.toString().replace('0', '1')), key.sign(sums)],
    [key.authorized, sums, key.sign(sums, 'git')],
    [key.authorized, sums, key.sign(sums).slice(0, -40)],
    ['ssh-rsa AAAA', sums, key.sign(sums)],
  ] as const) {
    const bad = await check(authorized, list, signature);
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '');
  }
});

// Builds a package for this Windows machine around the real, OpenJS-signed node.exe running the tests, with a stub
// CLI that reports the fixture version. Serves it, signed by `signer`, and returns the installer's environment.
async function release(
  t: test.TestContext,
  options: { signer?: ReturnType<typeof signingKey>; tamper?: boolean } = {},
) {
  const work = await workspace(t);
  const key = signingKey();
  const version = 'v1.2.3';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const archive = `frost_1.2.3_windows_${arch}.zip`;
  const node = await readFile(process.execPath);
  const scripts = `versions/${version}/src`;
  const entries = [
    {
      name: 'manifest.json',
      data: JSON.stringify({
        version,
        os: 'windows',
        arch,
        nodeVersion: process.version,
        nodeSha256: createHash('sha256').update(node).digest('hex'),
      }),
    },
    { name: 'current.json', data: JSON.stringify({ version }) + '\n' },
    { name: 'runtime/bin/node.exe', data: node },
    { name: 'runtime/LICENSE', data: 'fixture license' },
    { name: 'install.mjs', data: await readFile(path.join(project, 'install/install.mjs')) },
    { name: 'launch.mjs', data: await readFile(path.join(project, 'install/launch.mjs')) },
    { name: 'frost.cmd', data: '@echo off\r\n' },
    { name: `versions/${version}/package.json`, data: '{"type":"module"}\n' },
    { name: `${scripts}/cli/main.js`, data: `console.log(${JSON.stringify('frost ' + version)});\n` },
  ];
  for (const name of ['install-lock', 'fs-root', 'fs-root-types', 'fs-root-windows', 'fs-root-posix', 'ffi-loader'])
    entries.push({
      name: `${scripts}/platform/${name}.js`,
      data: await readFile(fileURLToPath(new URL(`../../src/platform/${name}.js`, import.meta.url))),
    });
  const { writeZip } = await import(pathToFileURL(path.join(project, 'tools/archives.mjs')).href);
  const zip: Buffer = writeZip(entries.map(e => ({ ...e, data: Buffer.from(e.data), mode: 0o644 })));
  const sums = Buffer.from(createHash('sha256').update(zip).digest('hex') + '  ' + archive + '\n');
  const served = options.tamper ? Buffer.concat([zip, Buffer.from('tampered')]) : zip;

  const server = createServer((req, res) => {
    const name = req.url?.split('/').pop();
    if (name === archive) res.end(served);
    else if (name === 'checksums.txt') res.end(sums);
    else if (name === 'checksums.txt.sig') res.end((options.signer ?? key).sign(sums));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  // The script under test is install.ps1 with the test key in place of the release key.
  const script = path.join(work, 'install.ps1');
  await writeFile(
    script,
    (await readFile(scriptFile, 'utf8')).replace(
      /^ {2}\$ReleaseKey = '.*'$/m,
      () => `  $ReleaseKey = '${key.authorized}'`,
    ),
  );
  const data = path.join(work, 'local app data');
  const bin = path.join(work, 'launchers');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: data,
    FROST_INSTALL_DIR: bin,
    FROST_VERSION: version,
    FROST_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/download/${version}`,
  };
  delete env.PSModulePath;
  delete env.NODE_OPTIONS;
  const install = () =>
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], env);
  return { install, version, root: path.join(data, 'frost', 'app'), bin };
}

const windows = { skip: process.platform !== 'win32' && 'needs Windows PowerShell' };

// FROST_INSTALL_DIR keeps the launcher out of the default folder, so the script only prints a PATH hint and never
// changes the user's PATH.
test('install.ps1 installs a signed release with its bundled runtime', windows, async t => {
  const f = await release(t);
  const result = await f.install();
  assert.equal(result.code, 0, result.stderr);
  for (const line of [
    `Downloading frost ${f.version} for windows/`,
    'Signature ok',
    'Checksum ok',
    'Installed ' + path.join(f.bin, 'frost.cmd'),
    `${f.bin} isn't on your PATH yet.`,
    "Next: run 'frost init' to set up your first backup.",
  ])
    assert.ok(result.stdout.includes(line), line);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'current.json'), 'utf8')).version, f.version);
  await stat(path.join(f.bin, 'frost.cmd'));
});

test('install.ps1 refuses a release signed by another key or a damaged download', windows, async t => {
  for (const [options, message] of [
    [{ signer: signingKey() }, "checksums.txt isn't signed by the frost release key. Don't install this."],
    [{ tamper: true }, 'checksum mismatch for frost_1.2.3_windows_'],
  ] as const) {
    const f = await release(t, options);
    const result = await f.install();
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('install.ps1: ' + message), result.stderr);
    await assert.rejects(stat(f.root), { code: 'ENOENT' });
  }
});
