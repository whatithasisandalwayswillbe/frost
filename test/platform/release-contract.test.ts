// Checks the values that the release script, CI, the installer and the updater each keep a copy of, because they run
// apart from one another. A copy that can come from tools/runtime-lock.json does, and the rest are compared here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { run } from '../../src/platform/command.js';
import { repo, valid, archiveName, supportedRuntime } from '../../src/platform/update.js';

// Tests run from dist/test/platform, so the project is three folders up.
const project = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string) => readFile(path.join(project, file), 'utf8');
const lock = async () => JSON.parse(await read('tools/runtime-lock.json')) as { version: string; artifacts: object };

// update.ts owns the release version pattern. The installer, its shell and PowerShell scripts, the launcher and the
// release script check versions without importing it.
test('every copy of the release version pattern matches the updater', async () => {
  const pattern = '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$';
  const expression = new RegExp(pattern);
  for (const version of [
    'v0.1.0',
    'v10.20.30',
    'v1.2.3-rc.1',
    'v1.2.3-0.alpha-1',
    'dev',
    'v01.2.3',
    '1.2.3',
    'v1.2',
    'v1.2.3+meta',
  ])
    assert.equal(expression.test(version), valid(version), version);

  for (const file of [
    'src/platform/update.ts',
    'install/install.sh',
    'install/install.ps1',
    'install/install.mjs',
    'install/launch.mjs',
    'scripts/release.sh',
  ])
    assert.ok((await read(file)).includes(pattern), file);
});

test('the repository and archive names agree across the script, installers and updater', async () => {
  const installer = await read('install/install.sh');
  const powershell = await read('install/install.ps1');
  const release = await read('scripts/release.sh');
  assert.equal(/^REPO="([^"]+)"$/m.exec(installer)?.[1], repo);
  assert.equal(/^ {2}\$Repo = '([^']+)'$/m.exec(powershell)?.[1], repo);
  assert.equal(/^repo='([^']+)'$/m.exec(release)?.[1], repo);

  assert.ok(installer.includes('archive="frost_${num}_${os}_${arch}.${ext}"'));
  assert.ok(installer.includes('ext=tar.gz') && installer.includes('ext=zip'));
  assert.ok(powershell.includes('$archive = "frost_${num}_windows_${arch}.zip"'));
  assert.equal(archiveName('v1.2.3', 'linux', 'amd64'), 'frost_1.2.3_linux_amd64.tar.gz');
  assert.equal(archiveName('v1.2.3', 'windows', 'arm64'), 'frost_1.2.3_windows_arm64.zip');
  assert.ok(release.includes('"$out"/frost_*'));
});

// The install line, badges and issue links name the repository by hand, so a move must update every one of them.
test('every repository link in the docs and installer names the updater repository', async () => {
  for (const file of [
    'README.md',
    'docs/CLI.md',
    'docs/CONTRIBUTING.md',
    'install/install.sh',
    'install/install.ps1',
    'tools/npm-package.mjs',
  ]) {
    const owners = [...(await read(file)).matchAll(/github[^\s"'()]*?\/([\w.-]+)\/frost\b/g)].map(m => m[1]);
    assert.ok(owners.length > 0, file);
    for (const owner of owners) assert.equal(owner + '/frost', repo, file);
  }
});

// The release script and CI build a package for each target the lock reviews a runtime for, and nothing else.
test('release targets come from the runtime lock', async () => {
  const targets = Object.keys((await lock()).artifacts);
  assert.equal(targets.length, 6);
  for (const target of targets) assert.match(target, /^(darwin|linux|windows)\/(amd64|arm64)$/);

  const result = await run(process.execPath, [path.join(project, 'tools/targets.mjs')]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), targets.join(' '));

  for (const file of ['scripts/release.sh', '.github/workflows/ci.yml']) {
    const text = await read(file);
    assert.ok(text.includes('tools/targets.mjs'), file);
    assert.ok(!/\b(darwin|linux|windows)\/(amd64|arm64)\b/.test(text), file + ' lists a target itself');
  }
});

// The lock pins the runtime exactly. Everything else that names it follows, apart from what the updater accepts, which
// only has to include it.
test('the pinned runtime is the one the project, CI and the docs name', async () => {
  const { version } = await lock();
  const bare = version.replace(/^v/, '');
  assert.ok(supportedRuntime(version));

  const engines = `>=${bare} <${Number(bare.split('.')[0]) + 1}`;
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.engines.node, engines);
  const npmLock = JSON.parse(await read('package-lock.json'));
  assert.equal(npmLock.packages[''].engines.node, engines);
  assert.equal(npmLock.packages[''].version, manifest.version);

  // The one exception is the job that tests the getfrost npm package on the oldest Node.js it supports.
  const { nodeFloor } = await import(pathToFileURL(path.join(project, 'tools/npm-package.mjs')).href);
  const versions = [...(await read('.github/workflows/ci.yml')).matchAll(/node-version: (\S+)/g)].map(m => m[1]);
  assert.ok(versions.length > 0);
  assert.deepEqual(
    versions.filter(v => v !== bare),
    [`${nodeFloor}.0.0`],
  );
  assert.ok((await read('README.md')).includes(`Node.js ${bare}`));
});
