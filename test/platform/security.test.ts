// Tests for the update chain's checks: release signatures, the pinned release key, version
// ordering, archive extraction safety and package manifest validation.

import { signingKey, tar } from './fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifySSHSig, releaseKey } from '../../src/platform/signature.js';
import { extractArchive, safeArchiveName } from '../../src/platform/archive.js';
import { newer, valid, archiveName, lookup, validatePackage } from '../../src/platform/update.js';

// Each bad case must fail with the same message: a changed message, another key, the "git"
// namespace instead of "file", and truncated or corrupted armour.
test('release signatures reject tampering, wrong key, namespace, and malformed data', () => {
  const key = signingKey();
  const msg = Buffer.from('release bytes\n');
  const armor = key.sign(msg);
  verifySSHSig(key.authorized, msg, armor);
  assert.throws(() => verifySSHSig(key.authorized, Buffer.from('wrong'), armor), /isn't signed/);
  assert.throws(() => verifySSHSig(signingKey().authorized, msg, armor), /isn't signed/);
  assert.throws(() => verifySSHSig(key.authorized, msg, key.sign(msg, 'git')), /isn't signed/);
  for (const bad of ['', armor.slice(0, -20), armor.replace('SS', 'AB')])
    assert.throws(() => verifySSHSig(key.authorized, msg, bad), /isn't signed/);
});

// The updater's key, install/release-signing.pub and both installers' keys must be the same.
test('release key stays aligned with installed and existing verification paths', async () => {
  const pub = await readFile(new URL('../../../install/release-signing.pub', import.meta.url), 'utf8');
  assert.equal(pub.trim(), releaseKey);
  const script = await readFile(new URL('../../../install/install.sh', import.meta.url), 'utf8');
  assert.ok(script.includes('RELEASE_KEY="' + releaseKey + '"'));
  const powershell = await readFile(new URL('../../../install/install.ps1', import.meta.url), 'utf8');
  assert.ok(powershell.includes("\n  $ReleaseKey = '" + releaseKey + "'\n"));
});

// A release beats its prereleases, and numeric identifiers compare as numbers and sort before
// alphanumeric ones. Anything that isn't a valid version, like `dev` or a leading zero, compares false.
test('versions compare arbitrarily large numeric components and prereleases', () => {
  for (const [a, b, expected] of [
    ['v0.2.0', 'v0.1.0', true],
    ['v0.1.0', 'v0.1.0', false],
    ['v0.1.0', 'v0.1.0-rc1', true],
    ['v0.1.0-rc.10', 'v0.1.0-rc.9', true],
    ['v0.1.0-alpha', 'v0.1.0-1', true],
    ['v0.2.0', 'dev', false],
    ['v01.2.0', 'v0.1.0', false],
    ['v18446744073709551617.0.0', 'v18446744073709551616.0.0', true],
    ['v0.1.0-01', 'v0.1.0-1', false],
  ] as const)
    assert.equal(newer(a, b), expected, `${a} > ${b}`);

  assert.equal(valid('v1.2.3-rc.1'), true);
  assert.equal(valid('v1.2.3;evil'), false);
  assert.equal(archiveName('v1.2.3', 'windows', 'amd64'), 'frost_1.2.3_windows_amd64.zip');
  assert.equal(archiveName('v1.2.3', 'linux', 'armv7'), 'frost_1.2.3_linux_armv7.tar.gz');

  // The name matches, but `bad` isn't a SHA-256 hash, so there's no checksum to return.
  assert.equal(lookup(Buffer.from('bad file.zip'), 'file.zip'), undefined);
});

// Type 50 is a tar symlink. Names differing only in case count as duplicates, since they'd clash
// on case-insensitive filesystems.
test('archive extraction refuses traversal, symlinks, duplicates, truncation, and corrupt headers', () => {
  for (const name of ['../evil', '/evil', 'C:/evil', 'a/../evil', 'a\\evil', 'a//evil', 'a\0evil'])
    assert.throws(() => safeArchiveName(name));

  assert.equal(
    extractArchive('good.tar.gz', tar([{ name: 'src/main.js', data: Buffer.from('hello') }]))[0].data.toString(),
    'hello',
  );
  assert.throws(() => extractArchive('bad.tar.gz', tar([{ name: '../evil', data: Buffer.from('hello') }])));
  assert.throws(() => extractArchive('bad.tar.gz', tar([{ name: 'link', type: 50, data: Buffer.alloc(0) }])));
  assert.throws(() =>
    extractArchive(
      'bad.tar.gz',
      tar([
        { name: 'a', data: Buffer.alloc(0) },
        { name: 'A', data: Buffer.alloc(0) },
      ]),
    ),
  );
  assert.throws(() => extractArchive('bad.tar.gz', Buffer.from('bad')));
  assert.throws(() => extractArchive('bad.zip', Buffer.alloc(10)));
});
// A valid package passes. A different version, an unexpected native addon or an edited runtime
// is refused.
test('package manifest binds the runtime, version, and platform', () => {
  const node = Buffer.from('runtime');
  const version = 'v1.2.3';
  const target = { os: 'windows', arch: 'amd64' };
  const manifest = {
    version,
    nodeVersion: 'v26.10.0',
    os: target.os,
    arch: target.arch,
    nodeSha256: createHash('sha256').update(node).digest('hex'),
  };
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)), mode: 0o644 },
    { name: 'runtime/bin/node.exe', data: node, mode: 0o755 },
    { name: `versions/${version}/src/cli/main.js`, data: Buffer.from('hello'), mode: 0o644 },
  ];

  assert.equal(validatePackage(entries, version, target).version, version);
  assert.throws(() => validatePackage(entries, 'v9.9.9', target));
  assert.throws(() =>
    validatePackage(
      [...entries, { name: `versions/${version}/evil.node`, data: Buffer.alloc(0), mode: 0o644 }],
      version,
      target,
    ),
  );
  assert.throws(() =>
    validatePackage(
      entries.map(e => (e.name.endsWith('.exe') ? { ...e, data: Buffer.from('modified') } : e)),
      version,
      target,
    ),
  );
});

// Device names (including LPT with a superscript digit), alternate data streams, trailing dots
// and spaces, control characters and wildcards are all refused, on every platform.
test('archives refuse Windows aliases and alternate streams before creating files', () => {
  for (const name of [
    'src/main.js:payload.js',
    'src/name./main.js',
    'src/name /main.js',
    'src/NUL.js',
    'src/COM1.js',
    'src/LPT².js',
    'src/CONIN$.js',
    'src/line\nfeed.js',
    'src/wild*.js',
  ]) {
    assert.throws(() => safeArchiveName(name), /unsafe archive path/);
    assert.throws(
      () => extractArchive('aliases.tar.gz', tar([{ name, data: Buffer.from('payload') }])),
      /unsafe archive path/,
    );
  }
  assert.equal(safeArchiveName('versions/v1.2.3/src/console.js'), 'versions/v1.2.3/src/console.js');
});
