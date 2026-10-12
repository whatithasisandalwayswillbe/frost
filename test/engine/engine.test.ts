// Tests for the backup, restore and verification engine against an in-memory backend: change
// detection, chunk sync, busy files, restore safety, resumable restores and cancellation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, symlinkSync, statSync, writeFileSync, utimesSync, linkSync, type BigIntStats } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, rm, utimes, symlink, stat, link } from 'node:fs/promises';
import path from 'node:path';
import { fixture, random } from '../support.js';
import { Engine, RestoreError, newRestoreFolder, partialName, isPartial } from '../../src/engine/index.js';
import { chunkKey } from '../../src/core/repo.js';
import { newTable, split } from '../../src/core/chunker.js';
import { emptyStats, newID, timeValue, compare, type FileEntry } from '../../src/core/snapshot.js';
import { Excluder } from '../../src/engine/exclude.js';
import { mtime } from '../../src/engine/backup.js';
import { openRoot } from '../../src/platform/fs-root.js';
import { countChanges } from '../../src/engine/changes.js';
import { loadFFI } from '../../src/platform/ffi-loader.js';

// Change lists are base64 runs of 16-byte entries: an 8-byte path key and an 8-byte content
// hash. Identical lists must be recognised without decoding a single entry.
test('identical change lists avoid per-entry decoding while different lists still count changes', t => {
  const raw = Buffer.alloc(16 * 1024);
  for (let i = 0; i < 1024; i++) {
    raw.writeBigUInt64BE(BigInt(i), i * 16);
    raw.writeBigUInt64BE(1n, i * 16 + 8);
  }
  const entries = raw.toString('base64');
  const changed = Buffer.from(raw);
  changed.writeBigUInt64BE(2n, 8);

  // Count every 64-bit read to prove the equal case never decodes.
  let reads = 0;
  const original = Buffer.prototype.readBigUInt64BE;
  t.mock.method(Buffer.prototype, 'readBigUInt64BE', function (this: Buffer, ...args: Parameters<typeof original>) {
    reads++;
    return Reflect.apply(original, this, args) as bigint;
  });

  assert.deepEqual(countChanges(entries, entries), {
    files: { added: 0, changed: 0, removed: 0 },
    folders: { added: 0, changed: 0, removed: 0 },
  });
  assert.equal(reads, 0);
  assert.equal(countChanges(entries, changed.toString('base64')).files.changed, 1);
  assert.ok(reads > 0);
});

// The restore uses a repository-only engine, as the browser does, so it can't lean on the manifest.
test('backup restores exact regular files, empty files, directory metadata and progress without a manifest', async t => {
  const f = await fixture(t);
  const bytes = random(5 << 20);
  await f.write('docs/small', 'hello');
  await f.write('docs/big', bytes);
  await f.write('empty', '');
  const result = await f.engine.backup({ paths: [f.src], host: 'laptop' });
  assert.equal(result.snapshot.stats.files, 3);
  assert.equal(result.snapshot.host, 'laptop');

  // File progress may only move forward.
  const target = path.join(f.root, 'target');
  let last = 0;
  const out = await new Engine(f.repo).restore(result.snapshot.id, {
    target,
    base: f.src.replaceAll('\\', '/'),
    progress: p => {
      if (!p.checking) {
        assert.ok(p.files >= last);
        last = p.files;
      }
    },
  });

  assert.equal(out.files, 3);
  assert.equal(last, 3);
  assert.deepEqual(await readFile(path.join(target, 'docs', 'big')), bytes);
  assert.equal((await readFile(path.join(target, 'docs', 'small'))).toString(), 'hello');
  assert.equal((await readFile(path.join(target, 'empty'))).length, 0);
});

test('unchanged skips all writes, directory mtime, and rereads; file mtime remains a change', async t => {
  const f = await fixture(t);
  const p = await f.write('dir/a', 'one');
  const first = await f.engine.backup({ paths: [f.src] });
  const puts = f.memory.puts;

  // A folder's mtime alone doesn't make a new snapshot.
  await utimes(path.dirname(p), new Date('2030-01-01'), new Date('2030-01-01'));
  const second = await f.engine.backup({ paths: [f.src] });
  assert.equal(second.unchanged, true);
  assert.equal(second.snapshot.id, first.snapshot.id);
  assert.equal(f.memory.puts, puts);

  // A file's mtime does, even though its content and chunks are the same.
  await utimes(p, new Date('2030-01-01'), new Date('2030-01-01'));
  const third = await f.engine.backup({ paths: [f.src] });
  assert.equal(third.unchanged, false);
  assert.equal(third.snapshot.stats.new_chunks, 0);
  assert.equal(third.changes.files.changed, 1);
});

test('incremental changes, dry run and exclusion preserve the last backup', async t => {
  const f = await fixture(t);
  await f.write('edit', 'old');
  await f.write('gone', 'bye');
  await f.write('junk.tmp', 'skip');
  const first = await f.engine.backup({ paths: [f.src], exclude: ['*.tmp'] });
  assert.equal(first.snapshot.stats.files, 2);

  await f.write('edit', 'newer');
  await f.write('new', 'hello');
  await rm(path.join(f.src, 'gone'));

  // A dry run reports the changes but uploads nothing and doesn't record a backup.
  const puts = f.memory.puts;
  const last = f.engine.lastBackup();
  const dry = await f.engine.backup({ paths: [f.src], exclude: ['*.tmp'], dryRun: true });
  assert.deepEqual(dry.changes.files, { added: 1, changed: 1, removed: 1 });
  assert.equal(dry.planned.length, 2);
  assert.equal(f.memory.puts, puts);
  assert.deepEqual(f.engine.lastBackup(), last);

  const real = await f.engine.backup({ paths: [f.src], exclude: ['*.tmp'] });
  assert.deepEqual(real.changes, dry.changes);
  assert.equal(real.unchanged, false);
});

// `lists` counts full chunk listings. The manifest's chunk list is trusted for a week at the same
// location, so a listing should only happen on the first backup, after a failed verify, after
// the location changes, or when a full verify asks for one.
test('weekly sync is bound to location and missing chunks are repaired', async t => {
  const f = await fixture(t);
  await f.write('a', 'save me');
  const first = await f.engine.backup({ paths: [f.src] });
  await f.engine.backup({ paths: [f.src] });
  await f.engine.verify(100);
  assert.equal(f.memory.lists, 1);

  // Delete a chunk behind frost's back. Verify notices, and the next backup re-syncs and re-uploads it.
  const tree = await f.repo.loadTree(first.snapshot.id);
  const id = tree.files.find(v => v.type === 'file')!.chunks![0];
  f.memory.objects.delete(chunkKey(id));
  assert.ok((await f.engine.verify(100)).failures!.length);
  assert.equal(f.engine.verifyDue(), true);
  await f.engine.backup({ paths: [f.src] });
  assert.deepEqual(await f.repo.getChunk(id), Buffer.from('save me'));
  assert.equal(f.memory.lists, 2);

  f.memory.place = 'copy';
  await f.engine.backup({ paths: [f.src] });
  assert.equal(f.memory.lists, 3);
  await f.engine.verify(5, true);
  assert.equal(f.memory.lists, 4);
});

test('verification is due when its saved time is invalid or outside the daily window', async t => {
  const f = await fixture(t);
  for (const time of ['invalid', '', new Date(Date.now() + 3600_000).toISOString(), '2000-01-01T00:00:00Z']) {
    await f.manifest.putMeta('verify', { time, checked: 0, total: 0, failures: [] });
    assert.equal(f.engine.verifyDue(), true);
  }
  await f.manifest.putMeta('verify', { time: new Date().toISOString(), checked: 0, total: 0, failures: [] });
  assert.equal(f.engine.verifyDue(), false);
});

test('missing roots warn when another exists and fail when all are gone', async t => {
  const f = await fixture(t);
  await f.write('a', 'a');
  const missing = path.join(f.root, 'missing');
  const result = await f.engine.backup({ paths: [f.src, missing] });
  assert.deepEqual(result.snapshot.missing, [missing.replaceAll('\\', '/')]);
  assert.equal(result.snapshot.paths.length, 1);

  // A failed backup is still recorded, with an error and no snapshot.
  await assert.rejects(f.engine.backup({ paths: [missing] }), /none of the folders/);
  assert.ok(f.engine.lastBackup()!.error);
  assert.equal(f.engine.lastBackup()!.snapshot_id, undefined);
  await assert.rejects(f.engine.backup({ paths: [] }), /no paths/);
  await assert.rejects(f.engine.backup({ paths: [' '] }), /empty entry/);
  await assert.rejects(f.engine.backup({ paths: [f.src], exclude: ['['] }), /invalid exclude/);
});

// chunkRead runs after each chunk is read. Bumping the file's mtime there makes it look like it's
// still being written, so the engine retries once and then falls back.
test('busy files retry once, keep a clean earlier copy, and skip without one', async t => {
  const f = await fixture(t);
  const p = await f.write('db', 'clean');
  await f.engine.backup({ paths: [f.src] });

  // With an earlier clean copy, the busy file keeps that copy.
  await f.write('db', 'torn');
  let bump = 0;
  f.engine.chunkRead = async name => {
    if (name === p) {
      const d = new Date(Date.now() + ++bump * 1000);
      await utimes(p, d, d);
    }
  };
  const kept = await f.engine.backup({ paths: [f.src] });
  assert.equal(kept.snapshot.stats.kept, 1);
  const out = path.join(f.root, 'out');
  await f.engine.restore(kept.snapshot.id, { target: out, base: f.src.replaceAll('\\', '/') });
  assert.equal((await readFile(path.join(out, 'db'))).toString(), 'clean');

  // Once the file settles, its new content is saved.
  f.engine.chunkRead = undefined;
  const settled = await f.engine.backup({ paths: [f.src] });
  assert.equal(settled.snapshot.stats.kept ?? 0, 0);
  await f.engine.restore(settled.snapshot.id, { target: out, base: f.src.replaceAll('\\', '/') });
  assert.equal((await readFile(path.join(out, 'db'))).toString(), 'torn');

  // A busy file with no earlier copy is skipped with a warning.
  const p2 = await f.write('busy', 'never clean');
  f.engine.chunkRead = async name => {
    if (name === p2) {
      const d = new Date(Date.now() + ++bump * 1000);
      await utimes(p2, d, d);
    }
  };
  const skipped = await f.engine.backup({ paths: [f.src] });
  assert.equal(skipped.snapshot.stats.skipped, 1);
  assert.match(skipped.snapshot.warnings![0], /no earlier copy/);
});

// On macOS, backup refuses to download files that are only in iCloud, so reading one fails with EDEADLK
// (errno 11), which Node can't name. The warning names the file instead. Elsewhere errno 11 means something
// else and keeps its own message.
test('files only in iCloud are skipped with a warning that names them', async t => {
  const f = await fixture(t);
  await f.write('local', 'on this Mac');
  const remote = await f.write('remote', 'only in iCloud');
  f.engine.chunkRead = async name => {
    if (name === remote)
      throw Object.assign(new Error('Unknown system error -11: Unknown system error -11, read'), { errno: -11 });
  };
  const result = await f.engine.backup({ paths: [f.src] });
  assert.equal(result.snapshot.stats.files, 1);
  assert.equal(result.snapshot.stats.skipped, 1);
  assert.equal(
    result.snapshot.warnings![0],
    process.platform === 'darwin'
      ? remote + " is only in iCloud, so frost didn't download it"
      : 'Unknown system error -11: Unknown system error -11, read',
  );

  // The policy is the process's own, so turning it on is the only change.
  if (process.platform === 'darwin') {
    const { lib } = loadFFI().dlopen('/usr/lib/libSystem.B.dylib');
    t.after(() => lib.close());
    const policy = lib.getFunction('getiopolicy_np', { return: 'int32', arguments: ['int32', 'int32'] });
    assert.equal(policy(3, 0), 1);
  }
});

// Skipping a backup needs the recorded snapshot to still exist and to be the newest known one.
test('new snapshot requires certainty: rebuilt manifest, missing header, and newer known snapshot', async t => {
  const f = await fixture(t);
  await f.write('a', 'a');
  const one = await f.engine.backup({ paths: [f.src] });
  f.memory.objects.delete('snapshots/' + one.snapshot.id);
  assert.equal((await f.engine.backup({ paths: [f.src] })).unchanged, false);

  const newer = { id: newID(), time: '2040-01-01T00:00:00Z', host: 'other', paths: [], stats: emptyStats() };
  await f.repo.saveSnapshot(newer, { files: [] });
  await f.engine.refreshSnapshots();
  assert.equal((await f.engine.backup({ paths: [f.src] })).unchanged, false);
});

test('verification detects tampering and cancellation leaves no finished result', async t => {
  const f = await fixture(t);
  await f.write('a', random(1 << 20));
  await f.engine.backup({ paths: [f.src] });
  assert.equal((await f.engine.verify(100)).failures!.length, 0);

  const key = [...f.memory.objects.keys()].find(k => k.startsWith('chunks/'))!;
  const blob = f.memory.objects.get(key)!;
  blob[blob.length - 1] ^= 1;
  assert.ok((await f.engine.verify(100)).failures!.length);

  // A cancelled verify doesn't replace the last recorded result.
  const before = f.engine.lastVerify();
  const c = new AbortController();
  c.abort(new Error('cancelled'));
  await assert.rejects(f.engine.verify(100, false, c.signal), /cancelled/);
  assert.deepEqual(f.engine.lastVerify(), before);
});

test('verification bounds download workers', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) await f.write(String(i), String(i));
  await f.engine.backup({ paths: [f.src] });
  f.engine.downloaders = 3;

  // Hold each chunk download for a moment so the peak shows how many ran at once.
  let active = 0;
  let peak = 0;
  f.memory.beforeGet = async k => {
    if (k.startsWith('chunks/')) {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 1));
      active--;
    }
  };
  assert.equal((await f.engine.verify(100)).failures!.length, 0);
  assert.equal(peak, 3);
});

test('unsafe trees preflight every entry before touching destinations', async t => {
  const f = await fixture(t);
  const snap = { id: newID(), time: new Date().toISOString(), host: 'test', paths: [], stats: emptyStats() };
  const target = path.join(f.root, 'unsafe');
  await f.repo.saveSnapshot(snap, {
    files: [
      { path: '/good', type: 'file', mode: 0o600, mtime: snap.time },
      { path: '/../bad', type: 'file', mode: 0o600, mtime: snap.time },
    ],
  });
  await assert.rejects(f.engine.restore(snap.id, { target, newTarget: true }), /unsafe/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

// The chunk holds 8 bytes, so recorded sizes of 2 and 20 are both wrong.
test('invalid recorded sizes preserve the destination and discard unusable partials', async t => {
  const f = await fixture(t);
  const data = Buffer.from('new data');
  const id = f.repo.key.chunkID(data);
  await f.repo.putChunk(id, data);
  const target = path.join(f.root, 'invalid');
  await mkdir(target);
  await writeFile(path.join(target, 'file'), 'original');

  for (const size of [2, 20]) {
    const snap = { id: newID(), time: new Date().toISOString(), host: 'test', paths: [], stats: emptyStats() };
    await f.repo.saveSnapshot(snap, {
      files: [{ path: '/file', type: 'file', mode: 0o600, mtime: snap.time, size, chunks: [id] }],
    });
    await assert.rejects(f.engine.restore(snap.id, { target }), /size|exceeds/);
    assert.equal((await readFile(path.join(target, 'file'))).toString(), 'original');
    assert.deepEqual(await readdir(target), ['file']);
  }
});

test('interrupted restore resumes matching prefixes and finished files with exact output', async t => {
  const f = await fixture(t);
  await f.write('a', 'first');
  const data = random(15 << 20);
  await f.write('big', data);
  await f.write('z', 'last');
  const backup = await f.engine.backup({ paths: [f.src] });
  const include = [f.src.replaceAll('\\', '/')];
  const { dir } = await newRestoreFolder(f.root, backup.snapshot.id, include);

  // One downloader and a dropped connection after six chunks leaves `big` part-written.
  let gets = 0;
  f.engine.downloaders = 1;
  f.memory.beforeGet = async key => {
    if (key.startsWith('chunks/') && ++gets > 6) throw new Error('connection lost');
  };
  await assert.rejects(
    f.engine.restore(backup.snapshot.id, { target: dir, newTarget: true, base: include[0], include }),
    e => e instanceof RestoreError && e.result.unfinished,
  );
  assert.equal((await newRestoreFolder(f.root, backup.snapshot.id, include)).resume, true);
  const partial = path.join(dir, partialName(backup.snapshot.id, include[0] + '/big'));
  assert.ok((await stat(partial)).size > 0);

  // The second run finishes from the partial file and cleans up every `.frost-` helper file.
  f.memory.beforeGet = undefined;
  await f.engine.restore(backup.snapshot.id, { target: dir, newTarget: true, base: include[0], include });
  assert.deepEqual(await readFile(path.join(dir, 'big')), data);
  assert.equal((await readFile(path.join(dir, 'a'))).toString(), 'first');
  assert.ok(!(await readdir(dir)).some(n => n.startsWith('.frost-')));
});

// `link` inside the target points outside it. A junction stands in for a symlink on Windows.
test('restore refuses a symlink parent and never writes outside the target', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'links');
  const outside = path.join(f.root, 'outside');
  await mkdir(target);
  await mkdir(outside);
  try {
    await symlink(outside, path.join(target, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlinks unavailable');
    return;
  }

  const snap = { id: newID(), time: new Date().toISOString(), host: 'test', paths: [], stats: emptyStats() };
  await f.repo.saveSnapshot(snap, { files: [{ path: '/link/file', type: 'file', mode: 0o600, mtime: snap.time }] });
  await assert.rejects(f.engine.restore(snap.id, { target }), /real directory/);
  assert.deepEqual(await readdir(outside), []);
});

// Cancelling as soon as `a` finishes must leave the old `b` in place.
test('restore cancellation after a file leaves untouched files and reports progress', async t => {
  const f = await fixture(t);
  await f.write('a', '');
  await f.write('b', '');
  const snap = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'cancel');
  const controller = new AbortController();
  await mkdir(target);
  await writeFile(path.join(target, 'b'), 'old');

  await assert.rejects(
    f.engine.restore(
      snap.snapshot.id,
      {
        target,
        base: f.src.replaceAll('\\', '/'),
        progress: p => {
          if (!p.checking && p.files === 1) controller.abort(new Error('cancelled'));
        },
      },
      controller.signal,
    ),
    e => e instanceof RestoreError && e.result.files === 1,
  );
  assert.equal((await readFile(path.join(target, 'b'))).toString(), 'old');
});

test('partial filtering and exclude names and ancestor patterns match recorded rules', () => {
  assert.ok(isPartial(partialName('x', '/a')));
  assert.ok(!isPartial('.frost-partial-ABCDEF0123456789'));
  const ex = new Excluder(['*.tmp', 'node_modules', '/home/*/.cache']);
  assert.ok(ex.match('/x/a.tmp'));
  assert.ok(ex.match('/home/me/.cache/deep/file'));
  assert.ok(!ex.match('/a/node_modules-file'));
});

test('exclude matching preserves Unicode, classes, escapes and slash boundaries without backtracking', () => {
  for (const [pattern, name, matches] of [
    ['a?b', 'a😀b', true],
    ['a??b', 'a😀b', false],
    ['[😀-🙏].txt', '😁.txt', true],
    ['[^a-z]*', '1😀', true],
    ['[^a-z]*', 'ab', false],
    ['a*b*c', 'abbc', true],
    ['a*b*c', 'ac', false],
    ['a**b', 'a😀b', true],
    ['a*b', 'a/b', false],
    ['file[.]txt', 'file.txt', true],
    ['*.txt', 'file.txt\n', false],
  ] as const)
    assert.equal(new Excluder([pattern]).match(name), matches, `${pattern}: ${name}`);
  if (process.platform !== 'win32') {
    assert.equal(new Excluder(['a\\*b']).match('a*b'), true);
    assert.equal(new Excluder(['a\\*b']).match('axxb'), false);
  }
  for (const pattern of ['[]', '[z-a]', '[', '[a--b]'])
    assert.throws(() => new Excluder([pattern]), /invalid exclude pattern/);

  // This failed match explores exponentially many paths in a backtracking glob regex.
  const hostile = new Excluder(['*a'.repeat(24) + 'b']);
  for (let i = 0; i < 100; i++) assert.equal(hostile.match('a'.repeat(200)), false);
});

test('restore rejects destinations changed after verification even with their old modification time', async t => {
  const f = await fixture(t);
  await f.write('a', 'saved');
  await f.write('b', 'saved');
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  const options = { target, base: f.src.replaceAll('\\', '/') };
  await f.engine.restore(saved.snapshot.id, options);
  const first = path.join(target, 'a');
  const before = statSync(first);
  let changed = false;
  await assert.rejects(
    f.engine.restore(saved.snapshot.id, {
      ...options,
      progress: p => {
        if (changed || !p.checking || !p.path.endsWith('/b')) return;
        changed = true;
        writeFileSync(first, 'wrong');
        utimesSync(first, before.atime, before.mtime);
      },
    }),
    /destination changed after it was checked/,
  );
  assert.equal(changed, true);
  assert.equal(await readFile(first, 'utf8'), 'wrong');
  await f.engine.restore(saved.snapshot.id, options);
  assert.equal(await readFile(first, 'utf8'), 'saved');
});

test('restore updates matching hardlinked destinations without treating its own metadata as outside writes', async t => {
  const f = await fixture(t);
  const first = await f.write('a', 'saved');
  const second = path.join(f.src, 'b');
  await link(first, second);
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  await mkdir(target);
  const a = path.join(target, 'a');
  const b = path.join(target, 'b');
  await writeFile(a, 'saved');
  await link(a, b);
  await utimes(a, new Date('2001-01-01'), new Date('2001-01-01'));
  const restored = await f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') });
  assert.equal(restored.files, 2);
  assert.equal(await readFile(a, 'utf8'), 'saved');
  assert.equal(await readFile(b, 'utf8'), 'saved');
  assert.equal((await stat(a, { bigint: true })).mtimeNs, (await stat(first, { bigint: true })).mtimeNs);
  assert.equal((await stat(b, { bigint: true })).mtimeNs, (await stat(second, { bigint: true })).mtimeNs);
});

test('restore separates matching hardlinked destinations when their saved metadata differs', async t => {
  const f = await fixture(t);
  const first = await f.write('a', 'saved');
  const second = await f.write('b', 'saved');
  await utimes(first, new Date('2001-01-01'), new Date('2001-01-01'));
  await utimes(second, new Date('2002-01-01'), new Date('2002-01-01'));
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  await mkdir(target);
  const a = path.join(target, 'a');
  const b = path.join(target, 'b');
  await writeFile(a, 'saved');
  await link(a, b);
  const restored = await f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') });
  assert.equal(restored.files, 2);
  const aStat = await stat(a, { bigint: true });
  const bStat = await stat(b, { bigint: true });
  assert.equal(aStat.mtimeNs, (await stat(first, { bigint: true })).mtimeNs);
  assert.equal(bStat.mtimeNs, (await stat(second, { bigint: true })).mtimeNs);
  assert.notEqual(aStat.ino, bStat.ino);
  assert.equal(await readFile(a, 'utf8'), 'saved');
  assert.equal(await readFile(b, 'utf8'), 'saved');
});

test('restore never changes an outside file through a pre-existing hardlinked partial', async t => {
  const f = await fixture(t);
  const source = await f.write('a', 'newdata');
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  const outside = path.join(f.root, 'outside');
  await mkdir(target);
  await writeFile(outside, 'valuable-old-data');
  await link(outside, path.join(target, partialName(saved.snapshot.id, source.replaceAll('\\', '/'))));
  await assert.rejects(
    f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') }),
    /more than one link/,
  );
  assert.equal(await readFile(outside, 'utf8'), 'valuable-old-data');
  await assert.rejects(stat(path.join(target, 'a')), { code: 'ENOENT' });
});

test('restore replaces a matching hardlinked destination before changing metadata outside the target', async t => {
  const f = await fixture(t);
  const source = await f.write('a', 'saved');
  await utimes(source, new Date('2001-01-01'), new Date('2001-01-01'));
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  const outside = path.join(f.root, 'outside');
  await mkdir(target);
  await writeFile(outside, 'saved');
  await utimes(outside, new Date('2002-01-01'), new Date('2002-01-01'));
  const before = await stat(outside, { bigint: true });
  await link(outside, path.join(target, 'a'));
  const restored = await f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') });
  assert.equal(restored.files, 1);
  const outsideAfter = await stat(outside, { bigint: true });
  const insideAfter = await stat(path.join(target, 'a'), { bigint: true });
  assert.equal(outsideAfter.mtimeNs, before.mtimeNs);
  assert.equal(outsideAfter.mode, before.mode);
  assert.equal(await readFile(outside, 'utf8'), 'saved');
  assert.equal(insideAfter.mtimeNs, (await stat(source, { bigint: true })).mtimeNs);
  assert.notEqual(insideAfter.ino, outsideAfter.ino);
});

test('restore stops before writing again when an active partial gains an outside hardlink', async t => {
  const f = await fixture(t);
  const bytes = random(3 << 20);
  const source = await f.write('a', bytes);
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  const outside = path.join(f.root, 'outside');
  const partial = path.join(target, partialName(saved.snapshot.id, source.replaceAll('\\', '/')));
  let length = 0;
  await assert.rejects(
    f.engine.restore(saved.snapshot.id, {
      target,
      base: f.src.replaceAll('\\', '/'),
      progress: p => {
        if (length || p.checking || !p.bytes || p.files) return;
        linkSync(partial, outside);
        length = statSync(outside).size;
      },
    }),
    /partial file changed|more than one link/,
  );
  assert.ok(length > 0);
  assert.deepEqual(await readFile(outside), bytes.subarray(0, length));
  await assert.rejects(stat(path.join(target, 'a')), { code: 'ENOENT' });
});

test('restore detects changes to a partial file during download and resumes safely', async t => {
  const f = await fixture(t);
  const bytes = random(3 << 20);
  await f.write('a', bytes);
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'target');
  await mkdir(target);
  await writeFile(path.join(target, 'a'), 'original');
  const partial = path.join(target, partialName(saved.snapshot.id, f.src.replaceAll('\\', '/') + '/a'));
  const options = { target, base: f.src.replaceAll('\\', '/') };
  let changed = false;
  await assert.rejects(
    f.engine.restore(saved.snapshot.id, {
      ...options,
      progress: p => {
        if (changed || p.checking || !p.bytes || p.files) return;
        changed = true;
        const before = statSync(partial);
        // Windows locks reject writes to the open partial, but the directory entry can be replaced.
        if (process.platform === 'win32') renameSync(partial, partial + '.moved');
        writeFileSync(partial, Buffer.alloc(before.size, 255));
        if (process.platform !== 'win32') utimesSync(partial, before.atime, before.mtime);
      },
    }),
    /partial file changed while it was restored/,
  );
  assert.equal(changed, true);
  assert.equal(await readFile(path.join(target, 'a'), 'utf8'), 'original');
  await f.engine.restore(saved.snapshot.id, options);
  assert.deepEqual(await readFile(path.join(target, 'a')), bytes);
});

// Uploading the snapshot header fails after the file and tree chunks are stored. Those chunks
// stay recorded so the retry uploads nothing new, but no snapshot or file entry is published.
test('partial metadata upload failures keep successful chunks durable and never publish a snapshot', async t => {
  const f = await fixture(t);
  await f.write('a', 'keep successful uploads');
  f.memory.beforePut = async key => {
    if (key.startsWith('snapshots/')) throw new Error('header upload stopped');
  };
  await assert.rejects(f.engine.backup({ paths: [f.src] }), /header upload stopped/);
  assert.equal(f.engine.manifest!.snapshots().size, 0);
  assert.ok(f.engine.manifest!.chunkCount() >= 2);
  assert.ok(f.engine.lastBackup()!.error);
  assert.equal(f.engine.manifest!.file(path.join(f.src, 'a').replaceAll('\\', '/')), undefined);
  const chunksBefore = [...f.memory.objects.keys()].filter(k => k.startsWith('chunks/'));

  f.memory.beforePut = undefined;
  const saved = await f.engine.backup({ paths: [f.src] });
  assert.equal(saved.snapshot.stats.new_chunks, 0);
  assert.equal(f.engine.lastBackup()!.error, undefined);
  for (const key of chunksBefore) assert.ok(f.memory.objects.has(key));
});

test('restore refuses a live partial lock and preserves directory destinations', async t => {
  const f = await fixture(t);
  await f.write('a', 'backup');
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'locked');
  await mkdir(target);

  // Holding the lock on the partial file stands in for another restore that's still running.
  const partial = path.join(target, partialName(saved.snapshot.id, f.src.replaceAll('\\', '/') + '/a'));
  await writeFile(partial, 'old partial');
  const root = await openRoot(target);
  const held = root.open(path.basename(partial), { read: true, write: true });
  held.lock(true);
  try {
    await assert.rejects(
      f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') }),
      /another restore/,
    );
  } finally {
    held.close();
    root.close();
  }
  assert.equal(await readFile(partial, 'utf8'), 'old partial');

  // A folder where the file should go is never replaced.
  await rm(partial);
  await mkdir(path.join(target, 'a'));
  await writeFile(path.join(target, 'a', 'keep'), 'original');
  await assert.rejects(
    f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') }),
    /destination is a directory/,
  );
  assert.equal(await readFile(path.join(target, 'a', 'keep'), 'utf8'), 'original');
});

test('restored timestamp keeps microseconds and paths use UTF-8 byte ordering', async t => {
  const f = await fixture(t);
  const time = '2024-01-02T03:04:05.123456789Z';
  const snap = { id: newID(), time, host: 'test', paths: [], stats: emptyStats() };
  const target = path.join(f.root, 'precise');
  await f.repo.saveSnapshot(snap, { files: [{ path: '/file', type: 'file', mode: 0o600, mtime: time }] });
  await f.engine.restore(snap.id, { target });

  // Allow two microseconds of filesystem rounding either way.
  const got = (await stat(path.join(target, 'file'), { bigint: true })).mtimeNs;
  const difference = got - timeValue(time);
  assert.ok(difference < 2000n && difference > -2000n, 'mtime lost microseconds: ' + difference);

  await f.write('\ue000', 'private');
  await f.write('🚀', 'rocket');
  const saved = await f.engine.backup({ paths: [f.src] });
  const tree = await f.repo.loadTree(saved.snapshot.id);
  assert.deepEqual(
    tree.files.map(v => v.path),
    tree.files.map(v => v.path).sort(compare),
  );
});

// A snapshot from Linux can hold names that differ only in case, or only in Unicode form (é composed, and
// e followed by a combining accent). Windows and macOS treat a case pair as one file, and macOS treats a
// Unicode pair as one file too, so restoring both there would leave one copy holding the other's bytes.
test('restore refuses names this platform stores as one file', async t => {
  const f = await fixture(t);
  const pairs = [
    { name: 'case', names: ['A.txt', 'a.txt'], refused: process.platform === 'win32' || process.platform === 'darwin' },
    { name: 'unicode', names: ['é.txt', 'é.txt'], refused: process.platform === 'darwin' },
    { name: 'separators', names: ['dir/a.txt', 'dir\\a.txt'], refused: process.platform === 'win32' },
  ];
  for (const pair of pairs) {
    const snap = { id: newID(), time: new Date().toISOString(), host: 'linux', paths: [], stats: emptyStats() };
    const files: FileEntry[] = [];
    for (const name of pair.names) {
      const data = Buffer.from(name);
      const id = f.repo.key.chunkID(data);
      await f.repo.putChunk(id, data);
      files.push({ path: '/' + name, type: 'file', mode: 0o600, mtime: snap.time, size: data.length, chunks: [id] });
    }
    await f.repo.saveSnapshot(snap, { files });
    const target = path.join(f.root, pair.name);
    if (pair.refused) {
      await assert.rejects(f.engine.restore(snap.id, { target, newTarget: true }), /duplicate restore destination/);
      await assert.rejects(stat(target), { code: 'ENOENT' });
    } else {
      assert.equal((await f.engine.restore(snap.id, { target, newTarget: true })).files, 2);
      for (const name of pair.names) assert.equal(await readFile(path.join(target, name), 'utf8'), name);
    }
  }
});

test('zero worker overrides use default concurrency and uppercase IDs restore correctly', async t => {
  const f = await fixture(t);
  f.engine.uploaders = 0;
  f.engine.downloaders = 0;
  for (let i = 0; i < 12; i++) await f.write(String(i), String(i));
  await f.engine.backup({ paths: [f.src] });

  // Zero means "use the default", which is eight downloaders.
  let active = 0;
  let peak = 0;
  f.memory.beforeGet = async key => {
    if (key.startsWith('chunks/')) {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 1));
      active--;
    }
  };
  assert.equal((await f.engine.verify(100)).failures!.length, 0);
  assert.equal(peak, 8);
  f.memory.beforeGet = undefined;

  // A tree that records its chunk ID in uppercase still restores.
  const data = Buffer.from('uppercase');
  const id = f.repo.key.chunkID(data);
  await f.repo.putChunk(id, data);
  const snap = { id: newID(), time: new Date().toISOString(), host: 'test', paths: [], stats: emptyStats() };
  await f.repo.saveSnapshot(snap, {
    files: [
      { path: '/upper', type: 'file', size: data.length, chunks: [id.toUpperCase()], mode: 0o600, mtime: snap.time },
    ],
  });
  const target = path.join(f.root, 'upper');
  await f.engine.restore(snap.id, { target });
  assert.deepEqual(await readFile(path.join(target, 'upper')), data);
});

// `..photos` is a legal folder name, not traversal. The second half swaps that folder for a link
// to `outside` after its file is written. Setting folder metadata afterwards must notice the swap
// and refuse, rather than follow the link.
test('restore permits dot-prefixed directory names and rejects a replaced parent before directory metadata', async t => {
  const f = await fixture(t);
  await f.write('..photos/file', 'kept inside the selected target');
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'dot-folder');
  await f.engine.restore(saved.snapshot.id, { target, base: f.src.replaceAll('\\', '/') });
  assert.equal(await readFile(path.join(target, '..photos', 'file'), 'utf8'), 'kept inside the selected target');

  const swappedTarget = path.join(f.root, 'swap');
  const outside = path.join(f.root, 'outside');
  const moved = path.join(swappedTarget, 'moved');
  await mkdir(path.join(swappedTarget, '..photos'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  let swapped = false;
  await assert.rejects(
    f.engine.restore(saved.snapshot.id, {
      target: swappedTarget,
      base: f.src.replaceAll('\\', '/'),
      progress: progress => {
        if (progress.files !== 1 || swapped) return;
        renameSync(path.join(swappedTarget, '..photos'), moved);
        symlinkSync(outside, path.join(swappedTarget, '..photos'), process.platform === 'win32' ? 'junction' : 'dir');
        swapped = true;
      },
    }),
    /real directory/,
  );

  // The file went into the real folder, which now lives at `moved`, and nothing reached `outside`.
  assert.equal(swapped, true);
  assert.equal(await readFile(path.join(moved, 'file'), 'utf8'), 'kept inside the selected target');
  assert.deepEqual(await readdir(outside), ['sentinel']);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});

// A download failure triggers cleanup, and deleting the partial file is made to fail too. The
// restore must still report the download error and release its lock on the `.frost-restore` marker.
test('restore cleanup closes the marker lock when partial deletion fails and preserves the primary failure', async t => {
  const f = await fixture(t);
  await f.write('file', 'saved');
  const saved = await f.engine.backup({ paths: [f.src] });
  const target = path.join(f.root, 'cleanup-failure');

  // Patch `remove` on the native directory class itself, so every handle the restore opens uses it.
  const probe = await openRoot(f.root);
  const prototype = Object.getPrototypeOf(probe) as { remove(name: string, directory?: boolean): void };
  const original = prototype.remove;
  probe.close();
  const tree = await f.repo.loadTree(saved.snapshot.id);
  const entry = tree.files.find(file => file.type === 'file')!;
  const wanted = chunkKey(entry.chunks![0]);
  let attempted = false;
  prototype.remove = function (name, directory) {
    if (isPartial(name)) {
      attempted = true;
      throw Object.assign(new Error('deletion denied'), { code: 'EACCES' });
    }
    return original.call(this, name, directory);
  };
  f.memory.beforeGet = async name => {
    if (name === wanted) throw new Error('download stopped');
  };

  try {
    await assert.rejects(
      f.engine.restore(saved.snapshot.id, { target, newTarget: true, base: f.src.replaceAll('\\', '/') }),
      /download stopped/,
    );
  } finally {
    prototype.remove = original;
  }
  assert.equal(attempted, true);

  // Taking the marker lock ourselves proves the restore let go of it.
  const folder = await openRoot(target);
  const marker = folder.open('.frost-restore', { read: true, write: true });
  try {
    marker.lock(true);
  } finally {
    marker.close();
    folder.close();
  }
});

// Each of the 96 roots is read synchronously, so the abort queued with setImmediate can only land
// if the engine yields to the event loop between roots.
test('bounded synchronous source reads yield to cancellation between configured roots', async t => {
  const f = await fixture(t);
  const paths: string[] = [];
  for (let i = 0; i < 96; i++) paths.push(await f.write(String(i), 'small file'));
  await f.engine.backup({ paths });
  const previous = f.engine.lastBackup();
  const controller = new AbortController();
  setImmediate(() => controller.abort(new Error('cancelled between roots')));
  await assert.rejects(f.engine.backup({ paths, dryRun: true }, controller.signal), /cancelled between roots/);
  assert.deepEqual(f.engine.lastBackup(), previous);
});

// With the crypto workers started, chunk IDs for large chunks are computed off the main thread while
// the reader keeps cutting. The result must be exactly the sequential answer: the same IDs in file
// order, repeated content uploaded once, and a byte-exact restore.
test('worker-computed chunk IDs keep file order and dedupe repeated content', async t => {
  const f = await fixture(t);
  const key = f.repo.key;
  const warm = random(1 << 20, 99);
  await key.sealChunk(warm, key.chunkID(warm), 'chunks/warm');

  const half = random(12 << 20, 7);
  const bytes = Buffer.concat([half, half]);
  const file = await f.write('big', bytes);
  const result = await f.engine.backup({ paths: [f.src] });

  const expected = split(bytes, newTable(key.chunkerSeed())).map(piece => key.chunkID(piece));
  const tree = await f.repo.loadTree(result.snapshot.id);
  const entry = tree.files.find(item => item.path === file.split(path.sep).join('/'))!;
  assert.deepEqual(entry.chunks, expected);
  assert.ok(new Set(expected).size < expected.length);
  assert.equal(result.snapshot.stats.new_chunks, new Set(expected).size);

  const target = path.join(f.root, 'target');
  await new Engine(f.repo).restore(result.snapshot.id, { target, base: f.src.split(path.sep).join('/') });
  assert.deepEqual(await readFile(path.join(target, 'big')), bytes);
});

// Round trips exercise seconds and nanoseconds independently of the formatter's string operations.
test('modification times roundtrip before 1970 and across expanded years without losing precision', () => {
  const values = [0n, 1n, -1n, 999_999_999n, 1_000_000_000n, -1_000_000_000n, -1_500_000_000n];
  for (const base of [1_700_000_000n, 1_700_000_000n, 1_700_000_001n, 253_402_300_845n, -62_198_755_155n])
    for (const nanos of [0n, 1n, 10n, 100_000_000n, 120_000_000n, 123_456_789n, 999_999_999n])
      values.push(base * 1_000_000_000n + nanos);
  for (const ns of values) assert.equal(timeValue(mtime({ mtimeNs: ns } as BigIntStats)), ns, String(ns));
  assert.equal(mtime({ mtimeNs: 253_402_300_845_123_456_789n } as BigIntStats), '+010000-01-01T00:00:45.123456789Z');
  assert.equal(mtime({ mtimeNs: -62_198_755_155_000_000_000n } as BigIntStats), '-000001-01-01T00:00:45Z');
});
