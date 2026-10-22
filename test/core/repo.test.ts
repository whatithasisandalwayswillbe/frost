// Tests for the repository layer: opening a captured repository, initialisation races, snapshot
// and tree storage, ordered chunk fetching and the buffer ownership rules for downloads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Key } from '../../src/core/crypto.js';
import { Repo, chunkKey, errWrongKey } from '../../src/core/repo.js';
import { errNotFound, type Backend } from '../../src/core/storage.js';
import { emptyStats, type Snapshot, type Tree } from '../../src/core/snapshot.js';
import { Memory, random } from '../support.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/core/repository.json', import.meta.url), 'utf8'),
);

const header = (id: string): Snapshot => ({
  id,
  time: '2026-10-04T12:00:00Z',
  host: 'test',
  paths: ['/data'],
  stats: emptyStats(),
});

// The fixture holds every object of a small repository written by an earlier Frost, so this
// catches any change that breaks reading existing backups.
test('opens and authenticates a captured repository and its file data', async () => {
  const memory = new Memory();
  for (const [key, data] of Object.entries(fixture.objects))
    memory.objects.set(key, Buffer.from(data as string, 'base64'));
  const repo = await Repo.open(memory, Key.fromMaster(Buffer.alloc(32)));

  assert.deepEqual(await repo.loadSnapshot(fixture.snapshot), fixture.header);
  assert.deepEqual(await repo.loadTree(fixture.snapshot), fixture.tree);
  const pieces: Buffer[] = [];
  for (const file of fixture.tree.files) for (const id of file.chunks ?? []) pieces.push(await repo.getChunk(id));
  assert.deepEqual(Buffer.concat(pieces), Buffer.from('frost compatibility fixture\n'.repeat(120000)));
  await assert.rejects(Repo.open(memory, Key.new()), error => error === errWrongKey);
});

test('conditional initialization admits one winner and refuses orphaned data', async () => {
  const memory = new Memory();
  const key = Key.new();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => Repo.init(memory, key)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);

  // Backup objects without frost.repo might be someone else's data, so init won't write over them.
  const orphans = new Memory();
  await orphans.put('trees/old', Buffer.from('preserve'));
  await assert.rejects(Repo.init(orphans, key), /backup objects/);
});

test('snapshots are immutable, encrypted under canonical keys and deduplicate trees', async () => {
  const memory = new Memory();
  const repo = await Repo.init(memory, Key.new());
  const snapshot = header('snapshot-one');
  const data = Buffer.from('file content');
  const id = repo.key.chunkID(data);
  await repo.putChunk(id, data);
  const tree: Tree = {
    files: [{ path: '/data/a', type: 'file', mode: 0o600, mtime: snapshot.time, size: data.length, chunks: [id] }],
  };

  // The file list is stored as one chunk. A second snapshot with the same list and a `have`
  // callback that knows that chunk uploads only its tree index and header.
  const uploaded = await repo.saveSnapshot(snapshot, tree);
  assert.equal(uploaded.size, 1);
  assert.deepEqual(await repo.loadTree(snapshot.id), tree);
  const before = memory.puts;
  assert.equal((await repo.saveSnapshot(header('snapshot-two'), tree, cid => uploaded.has(cid))).size, 0);
  assert.equal(memory.puts - before, 2);
  await assert.rejects(repo.saveSnapshot(snapshot, { files: [] }), /already exists/);

  // Objects under the wrong folder aren't listed as chunks, so each real chunk appears exactly once.
  memory.objects.set('chunks/wrong/' + id, Buffer.from('x'));
  assert.deepEqual((await repo.chunkIDs()).sort(), [...new Set([id, ...uploaded.keys()])].sort());

  // Flipping one byte of the stored chunk breaks authentication.
  const canonical = memory.objects.get(chunkKey(id))!;
  memory.objects.set(chunkKey(id), Buffer.from(canonical));
  memory.objects.get(chunkKey(id))![canonical.length - 1] ^= 1;
  await assert.rejects(repo.getChunk(id), /decryption failed/);
  await assert.rejects(repo.loadTree('../escape'), /invalid snapshot/);
});

test('fetch preserves order, bounded concurrency and nearby dedupe', async () => {
  const memory = new Memory();
  const repo = await Repo.init(memory, Key.new());
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    const data = Buffer.from('chunk ' + i);
    const id = repo.key.chunkID(data);
    await repo.putChunk(id, data);
    ids.push(id);
  }

  // 40 distinct chunks, then 30 repeats of the first and one late repeat of ids[5]. The run of
  // repeats needs one more download and the late repeat another, so 42 in all.
  const sequence = [...ids, ...Array(30).fill(ids[0]), ids[5]];
  const gets = memory.gets;
  let active = 0;
  let peak = 0;
  const get = memory.get.bind(memory);
  memory.get = async key => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 4)));
    try {
      return await get(key);
    } finally {
      active--;
    }
  };
  const result: string[] = [];
  await repo.fetch(sequence, 4, (index, data) => {
    assert.equal(repo.key.chunkID(data), sequence[index]);
    result.push(data.toString());
  });
  assert.equal(result.length, sequence.length);
  assert.equal(memory.gets - gets, 42);
  assert.ok(peak <= 4);

  // A throwing callback stops the fetch, and no further callbacks run.
  let calls = 0;
  await assert.rejects(
    repo.fetch(sequence, 4, () => {
      if (++calls === 3) throw new Error('stop');
    }),
    /stop/,
  );
  assert.equal(calls, 3);
  assert.equal(active, 0);

  // Aborting from inside the first callback stops before a second one.
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    repo.fetch(
      sequence,
      4,
      () => {
        calls++;
        controller.abort();
      },
      controller.signal,
    ),
  );
  assert.equal(calls, 1);
  assert.equal(active, 0);
});

test('failed tree uploads never commit snapshot metadata', async () => {
  const memory = new Memory();
  const repo = await Repo.init(memory, Key.new());
  let calls = 0;
  memory.put = async key => {
    if (key.startsWith('chunks/')) {
      calls++;
      throw new Error('upload failed');
    }
  };

  // Up to four uploads may already be in flight when the first one fails.
  await assert.rejects(repo.saveSnapshot(header('failed'), { files: [] }), /upload failed/);
  assert.ok(calls >= 1 && calls <= 4);
  assert.deepEqual(await memory.list('snapshots/'), []);
  assert.deepEqual(await memory.list('trees/'), []);
});

// A plain get may return a buffer the backend keeps, like a cache entry, so the repository must
// leave it untouched. getOwned hands over a buffer Frost may consume, and here it's detached.
test('chunk downloads preserve shared backend buffers and consume explicitly owned buffers', async () => {
  const memory = new Memory();
  const key = Key.fromMaster(Buffer.alloc(32));
  const repo = await Repo.init(memory, key);
  const data = random(1 << 20);
  const id = key.chunkID(data);
  await repo.putChunk(id, data);

  // Return the stored buffer itself instead of a copy.
  const object = chunkKey(id);
  const cached = memory.objects.get(object)!;
  const before = Buffer.from(cached);
  memory.get = async name => {
    const value = memory.objects.get(name);
    if (!value) throw errNotFound;
    return value;
  };
  for (const output of await Promise.all(Array.from({ length: 8 }, () => repo.getChunk(id))))
    assert.deepEqual(output, data);
  assert.deepEqual(cached, before);

  let owned: Buffer | undefined;
  const adapter: Backend = memory;
  adapter.getOwned = async name => {
    const value = await memory.get(name);
    owned = Buffer.from(value);
    return owned;
  };
  assert.deepEqual(await repo.getChunk(id), data);
  assert.equal(owned!.byteLength, 0);
  assert.deepEqual(cached, before);
  key.destroy();
});

// putChunk preserves the caller's plaintext. putOwnedChunk may hand a large exclusive buffer to a
// worker, which detaches it, but a view into a bigger buffer or a small chunk is still copied.
test('chunk uploads preserve shared plaintext and consume explicitly owned buffers', async () => {
  const memory = new Memory();
  const key = Key.fromMaster(Buffer.alloc(32));
  const repo = await Repo.init(memory, key);
  const data = random(1 << 20, 987654321);
  const id = key.chunkID(data);

  const shared = Buffer.from(data);
  await repo.putChunk(id, shared);
  assert.deepEqual(shared, data);

  const owned = Buffer.from(data);
  const sent = await repo.putOwnedChunk(id, owned);
  assert.equal(owned.byteLength, 0);
  assert.equal(sent, memory.objects.get(chunkKey(id))!.length);
  assert.deepEqual(await repo.getChunk(id), data);

  // A view that doesn't span its whole ArrayBuffer can't be transferred, so it stays intact.
  const larger = Buffer.alloc(data.length + 16);
  data.copy(larger, 8);
  const view = larger.subarray(8, 8 + data.length);
  await repo.putOwnedChunk(id, view);
  assert.deepEqual(view, data);

  const small = data.subarray(0, 4096);
  const smallID = key.chunkID(small);
  const smallCopy = Buffer.from(small);
  await repo.putOwnedChunk(smallID, smallCopy);
  assert.deepEqual(smallCopy, small);
  assert.deepEqual(await repo.getChunk(smallID), small);
  key.destroy();
});
