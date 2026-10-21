// Tests for local drive storage in private temporary folders. FROST_TEST_LOCAL_DIR adds another folder to run
// the storage contract in, such as one on a removable drive or a mounted share.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalBackend } from '../../src/core/local.js';
import { MissingRootError, errExists, errNotFound, maxChunkSize } from '../../src/core/storage.js';
import { conformance } from '../support.js';

function temp(t: TestContext, parent = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(parent), 'frost-local-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function backend(t: TestContext, folder: string): LocalBackend {
  const b = new LocalBackend({ path: folder });
  t.after(() => b.close());
  return b;
}

// Every file under a folder, as relative paths with forward slashes.
function files(folder: string): string[] {
  return fs
    .readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

// A link to a folder: a junction on Windows, which needs no privilege, and a symlink elsewhere.
function folderLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

for (const parent of [os.tmpdir(), ...(process.env.FROST_TEST_LOCAL_DIR ? [process.env.FROST_TEST_LOCAL_DIR] : [])])
  test(`local storage passes the storage contract in ${parent}`, async t => {
    const root = path.join(temp(t, parent), 'frost');
    const b = backend(t, root);
    await b.prepare();
    await conformance(b);
    assert.deepEqual(files(root), ['chunks/ab/ab01', 'chunks/cd/cd01', 'snapshots/one']);

    // Each backend has its own worker, so these creates race on separate threads.
    const racers = Array.from({ length: 8 }, () => backend(t, root));
    const results = await Promise.allSettled(racers.map((r, i) => r.putNew('trees/raced', Buffer.from('writer ' + i))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.every(r => r.status === 'fulfilled' || r.reason === errExists));
    assert.match((await b.get('trees/raced')).toString(), /^writer \d$/);
    assert.deepEqual(files(path.join(root, 'trees')), ['raced']);
  });

test('local storage never creates a missing folder except through prepare', async t => {
  const base = temp(t);
  const root = path.join(base, 'drive', 'frost');
  const b = backend(t, root);
  const missing = (e: Error) => e instanceof MissingRootError && e.code === 'ENOMEDIUM' && /not found/.test(e.message);
  await assert.rejects(b.get('frost.repo'), missing);
  await assert.rejects(b.list(''), missing);
  await assert.rejects(b.put('chunks/ab/ab01', Buffer.from('x')), missing);
  await assert.rejects(b.putNew('frost.repo', Buffer.from('x')), missing);
  await assert.rejects(b.prepare(), (e: Error) => missing(e) && e.message.startsWith(path.join(base, 'drive')));
  assert.equal(fs.existsSync(path.join(base, 'drive')), false);

  fs.mkdirSync(path.join(base, 'drive'));
  await b.prepare();
  await b.prepare();
  assert.ok(fs.statSync(root).isDirectory());
  await assert.rejects(b.get('frost.repo'), error => error === errNotFound);
  assert.deepEqual(await b.list(''), []);
});

test('local storage refuses links inside the folder and skips them in listings', async t => {
  const base = temp(t);
  const root = path.join(base, 'frost');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'not frost');
  folderLink(outside, path.join(root, 'chunks'));
  const b = backend(t, root);

  await assert.rejects(b.put('chunks/ab01', Buffer.from('x')));
  await assert.rejects(b.get('chunks/secret'));
  await assert.rejects(b.delete('chunks/secret'));
  assert.deepEqual(await b.list(''), []);
  assert.deepEqual(fs.readdirSync(outside), ['secret']);
});

test(
  'local storage refuses a folder reached through a link on Windows',
  { skip: process.platform !== 'win32' },
  async t => {
    const base = temp(t);
    fs.mkdirSync(path.join(base, 'real'));
    folderLink(path.join(base, 'real'), path.join(base, 'linked'));
    await assert.rejects(backend(t, path.join(base, 'linked')).list(''), /goes through a link/);
  },
);

test('local listings skip temporary files and invalid names, and big objects are refused', async t => {
  const root = temp(t);
  const b = backend(t, root);
  await b.put('snapshots/one', Buffer.from('x'));
  fs.writeFileSync(path.join(root, 'snapshots', '~one.0123456789abcdef'), 'partial');
  fs.writeFileSync(path.join(root, 'snapshots', 'Upper'), 'x');
  fs.mkdirSync(path.join(root, 'snapshots', 'folder'));
  assert.deepEqual(await b.list('snapshots/'), ['snapshots/one']);
  assert.deepEqual(await b.list('snap'), ['snapshots/one']);
  assert.deepEqual(await b.list('chunks/'), []);
  await assert.rejects(b.list('Snapshots/'), /invalid list prefix/);
  await assert.rejects(b.get('../escape'), /invalid object key/);

  fs.mkdirSync(path.join(root, 'chunks', 'aa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'chunks', 'aa', 'huge'), '');
  fs.truncateSync(path.join(root, 'chunks', 'aa', 'huge'), maxChunkSize + 1);
  await assert.rejects(b.get('chunks/aa/huge'), /storage response exceeds size limit/);
});

test('local downloads are fresh exact buffers and uploads leave the caller buffer alone', async t => {
  const b = backend(t, temp(t));
  const data = Buffer.from('chunk bytes');
  await b.put('chunks/ab/ab01', data);
  assert.equal(data.toString(), 'chunk bytes');
  const owned = await b.getOwned('chunks/ab/ab01');
  assert.equal(owned.byteOffset, 0);
  assert.equal(owned.buffer.byteLength, owned.length);
  owned.fill(0);
  assert.equal((await b.get('chunks/ab/ab01')).toString(), 'chunk bytes');
});

test('local identity changes when a copy of the folder takes its place', async t => {
  const base = temp(t);
  const root = path.join(base, 'frost');
  const b = backend(t, root);
  fs.mkdirSync(root);
  await b.put('frost.repo', Buffer.from('repo'));
  const first = await b.identity();
  assert.equal(await b.identity(), first);
  fs.renameSync(root, root + '-old');
  fs.cpSync(root + '-old', root, { recursive: true });
  assert.notEqual(await b.identity(), first);
  assert.equal((await b.get('frost.repo')).toString(), 'repo');
});

test('closing local storage rejects requests still waiting for its worker', async t => {
  const b = backend(t, temp(t));
  const waiting = b.identity();
  const rejected = assert.rejects(waiting, /local storage was closed/);
  await b.close();
  await rejected;
  // A later operation can start a fresh worker.
  assert.ok(await b.identity());
});

test('local settings need a full path and name the folder', async t => {
  assert.throws(() => new LocalBackend({ path: '' }), /path is required/);
  assert.throws(() => new LocalBackend({ path: 'relative/frost' }), /full path/);
  const folder = path.join(os.tmpdir(), 'frost');
  assert.equal(String(new LocalBackend({ path: folder + path.sep })), folder);
  assert.equal(String(new LocalBackend({ path: '~/frost' })), path.join(os.homedir(), 'frost'));
  const location = new LocalBackend({ path: folder }).location();
  assert.equal(location, 'local:' + (process.platform === 'win32' ? folder.toLowerCase() : folder));

  const b = backend(t, temp(t));
  const usage = await b.usage();
  assert.ok(usage.quota > 0 && usage.used > 0 && usage.used <= usage.quota);
  assert.equal(usage.readOnly, false);
});
