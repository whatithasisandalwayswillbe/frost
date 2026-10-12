// Tests for the TOML config (parsing, settings, private writes and folder checks) and for the
// manifest journal (cached state, crash recovery, batches, compaction, locks and confinement).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile, stat, symlink, readdir, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  defaultConfig,
  parse,
  render,
  interval,
  get,
  set,
  applyEnv,
  writePrivate,
  addPath,
} from '../../src/core/config.js';
import { Manifest, errLocked } from '../../src/core/manifest.js';
import { emptyStats, type Snapshot } from '../../src/core/snapshot.js';
import { openRoot } from '../../src/platform/fs-root.js';

test('config full TOML syntax roundtrips and rejects unknown keys and wrong types', () => {
  const c = defaultConfig();
  c.paths = ['~/Documents', 'C:\\Users\\me "quoted"'];
  c.storage.backend = 's3';
  c.storage.s3.secret_access_key = 'test credential';
  assert.deepEqual(parse(render(c)), c);

  // Literal strings, multi-line basic strings, trailing commas and hex integers all parse.
  const full = parse(
    'paths = [\n \'~/Documents\',\n \'C:\\literal\\path\',\n]\n[schedule]\nevery = """6h"""\n[verify]\nsample = 0x14\n',
  );
  assert.equal(full.paths[1], 'C:\\literal\\path');
  assert.equal(full.schedule.every, '6h');
  assert.equal(full.verify.sample, 20);

  // An explicit empty prefix stays empty; a missing one gets the default.
  assert.equal(parse('[storage.s3]\nprefix=""').storage.s3.prefix, '');
  assert.equal(parse('[storage]\nbackend="s3"').storage.s3.prefix, 'frost');
  for (const raw of [
    'pathz=[]',
    '[storage]\nbakend="s3"',
    'paths=[1]',
    '[verify]\nsample=1.5',
    '[schedule]\nenabled="false"',
  ])
    assert.throws(() => parse(raw));

  set(c, 'paths', ['one', 'two']);
  assert.equal(get(c, 'paths'), 'one\ntwo');
  set(c, 'schedule.enabled', ['False']);
  assert.equal(c.schedule.enabled, false);
  for (const [key, value] of [
    ['schedule.enabled', 'maybe'],
    ['verify.sample', '-1'],
    ['unknown', 'value'],
  ])
    assert.throws(() => set(c, key, [value]));

  // Only listed intervals are accepted, so 5h is refused.
  assert.equal(interval(' 2H '), 7200000);
  assert.throws(() => interval('5h'));

  // The frost variable wins over the AWS fallback, and the original config isn't changed.
  const env = applyEnv(c, { FROST_S3_SECRET_ACCESS_KEY: 'from environment', AWS_SECRET_ACCESS_KEY: 'fallback' });
  assert.equal(env.storage.s3.secret_access_key, 'from environment');
  assert.equal(c.storage.s3.secret_access_key, 'test credential');
});

test('invalid TOML diagnostics omit source lines and credentials', () => {
  for (const raw of [
    '[storage.s3]\nsecret_access_key="private-storage-secret" trailing',
    '[storage.permafrost]\nkey="private-storage-secret',
  ]) {
    assert.throws(
      () => parse(raw),
      error =>
        error instanceof Error &&
        /invalid TOML at line \d+, column \d+$/.test(error.message) &&
        !error.message.includes('private-storage-secret') &&
        !error.cause,
    );
  }
});

test('manifest rejects hardlinked journals before truncating or appending outside the cache', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-hardlink-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cache = path.join(folder, 'cache');
  await mkdir(cache);
  const file = path.join(cache, 'cache.jsonl');
  const outside = path.join(folder, 'outside');
  await writeFile(outside, '{valuable incomplete file');
  await link(outside, file);
  await assert.rejects(Manifest.open(file), /one hardlink/);
  assert.equal(await readFile(outside, 'utf8'), '{valuable incomplete file');

  await rm(file);
  const manifest = await Manifest.open(file);
  try {
    await manifest.putMeta('before', true);
    const original = await readFile(file);
    const alias = path.join(folder, 'late-alias');
    await link(file, alias);
    await assert.rejects(manifest.putMeta('after', true), /one hardlink/);
    assert.deepEqual(await readFile(alias), original);
    assert.equal(manifest.getMeta('after'), undefined);
  } finally {
    await manifest.close();
  }
});

test('private writes replace files and destination symlinks without touching targets', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-config-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'config');
  await writePrivate(file, 'first');
  await writePrivate(file, 'second');
  assert.equal(await readFile(file, 'utf8'), 'second');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Writing to a symlink replaces the link itself and leaves its target alone. Symlinks can need
  // extra privileges on Windows, so the rest is skipped there if one can't be made.
  const target = path.join(folder, 'target');
  await writeFile(target, 'unchanged');
  const link = path.join(folder, 'link');
  try {
    await symlink(target, link);
  } catch (error) {
    if (process.platform === 'win32') return;
    throw error;
  }
  await writePrivate(link, 'replacement');
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert.equal(await readFile(link, 'utf8'), 'replacement');
});

test('adding folders rejects aliases and overlaps and keeps filesystem roots valid', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-path-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const docs = path.join(folder, 'Documents');
  await mkdir(path.join(docs, 'taxes'), { recursive: true });
  await writeFile(path.join(folder, 'note.txt'), 'x');

  // Whitespace and trailing slashes are trimmed. `inside` lists existing entries the new folder contains.
  assert.equal((await addPath(' ' + docs + '/ ', [])).path, docs);
  assert.deepEqual((await addPath(folder, [docs])).inside, [0]);

  // Empty, relative and file paths are refused, as are duplicates and folders already covered.
  for (const value of ['', 'Documents', path.join(folder, 'note.txt')]) await assert.rejects(addPath(value, []));
  await assert.rejects(addPath(docs, [docs]), /already/);
  await assert.rejects(addPath(path.join(docs, 'taxes'), [docs]), /inside/);
  assert.equal((await addPath(path.parse(folder).root, [])).path, path.parse(folder).root);
});

test('manifest caches all state across reopen, samples uniquely and serializes transactions', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cache.jsonl');
  const m = await Manifest.open(file);
  const ids = ['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)];

  assert.equal(m.anyChunks(), false);
  assert.equal(m.hasChunks([]), true);
  await m.addChunks(new Map(ids.map((id, i) => [id, i + 10])));
  assert.equal(m.chunkCount(), 3);
  assert.equal(m.hasChunks(ids), true);
  assert.equal(m.hasChunks(['bad']), false);

  // Samples are clamped to [0, chunk count] and never repeat an ID.
  for (const n of [-1, 0, 1, 2, 10]) {
    const sample = m.sampleChunks(n);
    assert.equal(sample.length, Math.min(Math.max(n, 0), 3));
    assert.equal(new Set(sample).size, sample.length);
  }

  const snapshot: Snapshot = {
    id: 'test-snapshot',
    time: '2026-10-04T00:00:00Z',
    host: 'test',
    paths: ['/data'],
    stats: emptyStats(),
  };
  await m.putFiles(new Map([['/data/a', { size: 1, mtime: snapshot.time, chunks: ids.slice(0, 1) }]]));
  await m.putSnapshot(snapshot);
  await Promise.all(Array.from({ length: 10 }, (_, i) => m.putMeta('meta-' + i, { i })));

  // A second open is locked out while the first is open, and a closed manifest forgets its state.
  await assert.rejects(Manifest.open(file), error => error === errLocked);
  await m.close();
  assert.equal(m.hasChunks(ids), false);

  const reopened = await Manifest.open(file);
  assert.equal(reopened.chunkCount(), 3);
  assert.deepEqual(reopened.file('/data/a')?.chunks, [ids[0]]);
  assert.deepEqual(reopened.snapshots().get(snapshot.id), snapshot);
  assert.deepEqual(reopened.getMeta('meta-9'), { i: 9 });

  // Returned entries are copies, so editing one doesn't change the cache.
  const copied = reopened.file('/data/a')!;
  copied.size = 999;
  copied.chunks.fill('bad');
  assert.equal(reopened.file('/data/a')?.size, 1);
  assert.deepEqual(reopened.file('/data/a')?.chunks, [ids[0]]);

  await reopened.replaceChunks(ids.slice(0, 1));
  assert.equal(reopened.chunkCount(), 1);
  await reopened.setSnapshots([]);
  assert.equal(reopened.snapshots().size, 0);
  await reopened.close();
});

test('manifest truncates interrupted final transactions and refuses corrupted committed data', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-crash-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cache.jsonl');
  const m = await Manifest.open(file);
  await m.putMeta('good', true);
  await m.close();

  // A half-written last line looks like a crash mid-write. It's dropped and overwritten by the next record.
  await appendFile(file, '{"sequence":2,"unfinished":');
  const resumed = await Manifest.open(file);
  assert.equal(resumed.getMeta('good'), true);
  await resumed.putMeta('next', 2);
  await resumed.close();
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('unfinished'));

  // Editing a complete record breaks its checksum, which is corruption rather than a crash.
  await writeFile(file, raw.replace('"good"', '"evil"'));
  await assert.rejects(Manifest.open(file), /corrupt; remove it to rebuild/);

  // A complete line that isn't a JSON object gets the same advice, not a raw parse error.
  for (const line of ['{not json', 'null', '7']) {
    await writeFile(file, raw + line + '\n');
    await assert.rejects(Manifest.open(file), /corrupt; remove it to rebuild/);
  }
});

test('manifest batches publish state together and callback failures save nothing', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-batch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cache.jsonl');
  const m = await Manifest.open(file);
  const id = '01'.repeat(32);

  // The whole batch lands as a single journal record.
  await m.batch(tx => {
    tx.addChunks(new Map([[id, 10]]));
    tx.putMeta('batch', { complete: true });
  });
  assert.equal(m.hasChunk(id), true);
  assert.deepEqual(m.getMeta('batch'), { complete: true });
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 1);

  // A throwing callback discards everything it staged and leaves the journal byte for byte the same.
  await assert.rejects(
    m.batch(tx => {
      tx.putMeta('discarded', true);
      throw new Error('abort batch');
    }),
    /abort batch/,
  );
  assert.equal(m.getMeta('discarded'), undefined);
  assert.equal(await readFile(file, 'utf8'), raw);
  await m.close();

  const reopened = await Manifest.open(file);
  assert.equal(reopened.hasChunk(id), true);
  assert.deepEqual(reopened.getMeta('batch'), { complete: true });
  await reopened.close();
});

// Five 9 MiB writes pass the 32 MiB compaction threshold, so the journal is rewritten as one state record.
test('manifest compacts bounded journals without losing cached state', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-compact-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cache.jsonl');
  const m = await Manifest.open(file);
  const payload = 'x'.repeat(9 << 20);
  for (let i = 0; i < 5; i++) await m.putMeta('large', payload);
  assert.ok((await stat(file)).size < 32 << 20);
  await m.close();

  const reopened = await Manifest.open(file);
  assert.equal(reopened.getMeta('large'), payload);
  await reopened.close();
});

// The lock file starts with a stale record. Ownership comes from the OS lock, never from that record,
// and frost never rewrites or replaces the lock file.
test('manifest kernel locks survive reopen and release after an unclosed process exits', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-lock-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cache.jsonl');
  const lock = file + '.lock';
  const module = new URL('../../src/core/manifest.js', import.meta.url).href;
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'old-lock-record' }));
  const original = await stat(lock);
  const manifest = await Manifest.open(file);

  // Another process must see errLocked while this one holds the manifest.
  const contend = `const {Manifest,errLocked}=await import(${JSON.stringify(module)}); try { const m=await Manifest.open(${JSON.stringify(file)}); await m.close(); process.exit(2); } catch(error) { if(error!==errLocked) throw error; }`;
  const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', contend], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  await manifest.close();

  // A process that exits without closing still releases the lock, and its last write survives.
  const crash = `const {Manifest}=await import(${JSON.stringify(module)}); const m=await Manifest.open(${JSON.stringify(file)}); await m.putMeta('before-exit',true); process.exit(0);`;
  const exited = spawnSync(process.execPath, ['--input-type=module', '-e', crash], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(exited.status, 0, exited.stderr);
  const reopened = await Manifest.open(file);
  assert.equal(reopened.getMeta('before-exit'), true);
  await reopened.close();

  // The lock file keeps its identity and contents, so it was never recreated or rewritten.
  const current = await stat(lock);
  assert.equal(current.dev, original.dev);
  assert.equal(current.ino, original.ino);
  assert.equal(await readFile(lock, 'utf8'), JSON.stringify({ pid: process.pid, token: 'old-lock-record' }));
});

// An attacker renames the manifest's folder and puts a new one in its place. Writes and compaction must
// follow the open folder handle rather than the path. Windows may refuse the rename while the lock is
// held, which is also safe, so that branch checks the manifest still works in place.
test('manifest writes and compacts stay confined when its folder name is replaced or the lock blocks replacement', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-parent-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const original = path.join(folder, 'cache');
  const moved = path.join(folder, 'moved');
  await mkdir(original);
  const file = path.join(original, 'cache.jsonl');
  const manifest = await Manifest.open(file);
  const payload = 'x'.repeat(9 << 20);
  await manifest.putMeta('before-swap', true);

  const attacker = await openRoot(folder);
  let renamed = true;
  try {
    attacker.rename('cache', attacker, 'moved');
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
    renamed = false;
  } finally {
    attacker.close();
  }

  if (!renamed) {
    for (let i = 0; i < 5; i++) await manifest.putMeta('large', payload);
    await manifest.close();
    assert.deepEqual(await readdir(folder), ['cache']);
    assert.ok((await stat(file)).size < 32 << 20);
    const reopened = await Manifest.open(file);
    assert.equal(reopened.getMeta('before-swap'), true);
    assert.equal(reopened.getMeta('large'), payload);
    await reopened.close();
    return;
  }

  // Plant a decoy journal at the old path, then write enough to force compaction.
  await mkdir(original);
  const outside = path.join(original, 'cache.jsonl');
  await writeFile(outside, 'untouched replacement');
  for (let i = 0; i < 5; i++) await manifest.putMeta('large', payload);
  await manifest.close();

  assert.equal(await readFile(outside, 'utf8'), 'untouched replacement');
  assert.deepEqual(await readdir(original), ['cache.jsonl']);
  assert.ok((await stat(path.join(moved, 'cache.jsonl'))).size < 32 << 20);
  const reopened = await Manifest.open(path.join(moved, 'cache.jsonl'));
  assert.equal(reopened.getMeta('before-swap'), true);
  assert.equal(reopened.getMeta('large'), payload);
  await reopened.close();
});

// Four 9 MiB writes reach the compaction threshold, so the next write compacts. The journal name is
// swapped for a directory first, so compaction fails. That failure must stick for every later write.
test('manifest compaction failure poisons further writes and leaves a replaced journal target intact', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-manifest-failure-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cache.jsonl');
  const manifest = await Manifest.open(file);
  const payload = 'x'.repeat(9 << 20);
  for (let i = 0; i < 4; i++) await manifest.putMeta('large', payload);

  const attacker = await openRoot(folder);
  try {
    attacker.remove('cache.jsonl');
    const replacement = attacker.openDirectory('cache.jsonl', { create: true, exclusive: true });
    try {
      const sentinel = replacement.open('sentinel', { write: true, create: true });
      try {
        sentinel.writeFile('unchanged');
      } finally {
        sentinel.close();
      }
    } finally {
      replacement.close();
    }
  } finally {
    attacker.close();
  }

  let failure: unknown;
  await assert.rejects(manifest.putMeta('failed', true), error => {
    failure = error;
    return true;
  });
  await assert.rejects(manifest.putMeta('later', true), error => error === failure);
  assert.equal(manifest.getMeta('failed'), undefined);
  assert.equal(manifest.getMeta('later'), undefined);
  await manifest.close();
  assert.equal(await readFile(path.join(file, 'sentinel'), 'utf8'), 'unchanged');
});
