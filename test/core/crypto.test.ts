// Tests for keys, BIP39 recovery phrases, sealed objects, chunk workers and the FastCDC chunker.
// Golden values come from the frozen files in test/fixtures/core.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { markAsUntransferable } from 'node:worker_threads';
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { constants, zstdCompressSync } from 'node:zlib';
import { Key, errDecrypt, hChaCha20, parseID } from '../../src/core/crypto.js';
import { encode, decode, words } from '../../src/core/bip39.js';
import {
  newTable,
  split,
  chunks,
  chunksFromReader,
  cutpoint,
  scalarCutpoint,
  avgSize,
  maxSize,
  minSize,
  type Table,
} from '../../src/core/chunker.js';
import { random } from '../support.js';
import { compressionData } from './compression-data.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/core/repository.json', import.meta.url), 'utf8'),
);

// Authenticates an explicit body under the test's all-zero master key.
function sealBody(body: Buffer, ad: string): Buffer {
  const enc = Buffer.from(hkdfSync('sha256', Buffer.alloc(32), Buffer.alloc(0), 'frost v1 encryption', 32));
  const nonce = Buffer.alloc(24);
  const subkey = hChaCha20(enc, nonce.subarray(0, 16));
  try {
    const cipher = createCipheriv('chacha20-poly1305', subkey, Buffer.alloc(12), { authTagLength: 16 });
    cipher.setAAD(Buffer.from(ad), { plaintextLength: body.length });
    return Buffer.concat([Buffer.from([1]), nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  } finally {
    enc.fill(0);
    subkey.fill(0);
  }
}

// The plain one-byte-at-a-time FastCDC loop. The chunker's uniform, WebAssembly and scalar paths
// must all agree with it. The 64-bit gear hash is kept as two 32-bit halves, and the stricter mask
// applies before the average size.
function referenceCutpoint(input: Buffer, table: Table): number {
  const n = Math.min(input.length, maxSize);
  const normal = Math.min(n, avgSize);
  let low = 0;
  let high = 0;
  for (let i = minSize; i < n; i++) {
    const addition = low * 2 + table.low[input[i]];
    high = (high * 2 + table.high[input[i]] + Math.floor(addition / 4294967296)) >>> 0;
    low = addition >>> 0;
    if ((high & (i < normal ? 0xfffffc00 : 0xffffc000)) === 0) return i + 1;
  }
  return n;
}

test('BIP39 official vectors and normalization', () => {
  assert.equal(words.length, 2048);
  const vectors = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/core/bip39-vectors.json', import.meta.url), 'utf8'),
  ).english;

  // Decoding ignores case, surrounding space and line breaks between words.
  for (const [entropy, phrase] of vectors) {
    assert.equal(encode(Buffer.from(entropy, 'hex')), phrase);
    assert.equal(decode('  ' + phrase.toUpperCase().replaceAll(' ', '\n') + '  ').toString('hex'), entropy);
  }

  // Too few words, a bad checksum and an unknown word are all refused.
  for (const phrase of [
    'abandon abandon',
    Array(12).fill('abandon').join(' '),
    Array(11).fill('abandon').join(' ') + ' wrongword',
  ])
    assert.throws(() => decode(phrase));
  assert.throws(() => encode(Buffer.alloc(1)));
});

test('invalid recovery words report only their position', () => {
  const phrase = Array(24).fill('abandon');
  phrase[7] = 'private-recovery-input';
  assert.throws(
    () => decode(phrase.join(' ')),
    error => error instanceof Error && error.message === 'bip39: word 8 is not in the wordlist' && !error.cause,
  );
});

test('key derivation matches golden output', () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  assert.equal(key.fingerprint(), fixture.fingerprint);
  assert.equal(key.chunkerSeed().toString(), fixture.seed);
  assert.ok(Key.fromPhrase(key.phrase()).equals(key));
  assert.ok(!Key.new().equals(key));

  // A valid 12-word phrase still isn't a frost key, and serialising a key never reveals it.
  assert.throws(() => Key.fromPhrase(encode(Buffer.alloc(16))), /24 words/);
  assert.equal(JSON.stringify(key), '"[key]"');
});

test('HChaCha20 draft vector', () => {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const nonce = Buffer.from('000000090000004a0000000031415927', 'hex');
  assert.equal(
    hChaCha20(key, nonce).toString('hex'),
    '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
  );
});

test('sealing opens existing raw and zstd reference objects', () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  assert.equal(key.open(Buffer.from(fixture.raw, 'base64'), 'test/raw').toString(), 'hello');
  assert.deepEqual(key.open(Buffer.from(fixture.compressed, 'base64'), 'test/compressed'), Buffer.alloc(100000, 'a'));

  // The object name is associated data, so a wrong name, a wrong key, a flipped tag byte or a
  // truncated blob all fail with the same error.
  for (const data of [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(100000, 'a'), random(1 << 20)]) {
    const blob = key.seal(data, 'test/object');
    assert.deepEqual(key.open(blob, 'test/object'), data);
    assert.throws(
      () => key.open(blob, 'wrong/object'),
      error => error === errDecrypt,
    );
    assert.throws(
      () => Key.new().open(blob, 'test/object'),
      error => error === errDecrypt,
    );
    blob[blob.length - 1] ^= 1;
    assert.throws(
      () => key.open(blob, 'test/object'),
      error => error === errDecrypt,
    );
    assert.throws(
      () => key.open(blob.subarray(0, 5), 'test/object'),
      error => error === errDecrypt,
    );
  }
});

test('compression preserves complete files and reduces distant text, image and binary repeats', async () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  try {
    for (const [name, input] of compressionData()) {
      const original = Buffer.from(input);
      const id = key.chunkID(input);
      const ad = `test/compression/${name}`;
      const legacy = zstdCompressSync(input, { params: { [constants.ZSTD_c_compressionLevel]: 1 } });
      const previous = zstdCompressSync(input, {
        params: { [constants.ZSTD_c_compressionLevel]: 1, [constants.ZSTD_c_windowLog]: 23 },
      });
      const blob = key.seal(input, ad);
      assert.ok(blob.length <= input.length + 42, name);
      assert.deepEqual(key.open(blob, ad), original, name);
      assert.deepEqual(await key.openChunk(blob, id, ad), original, name);
      const workerBlob = await key.sealChunk(input, id, ad);
      assert.equal(workerBlob.length, blob.length, name);
      assert.deepEqual(key.open(workerBlob, ad), original, name);
      assert.deepEqual(input, original, name);
      assert.equal(key.chunkID(input), id, name);

      if (name === 'bmp' || name === 'distant-binary' || name === 'distant-max')
        assert.ok(blob.length - 42 < legacy.length * 0.8, name);
      if (name === 'distant-text') assert.ok(blob.length - 42 < legacy.length, name);
      if (name.startsWith('random')) assert.equal(blob.length, input.length + 42, name);
      if (['code-js', 'code-bundle', 'code-worker', 'pdf-flate', 'gzip'].includes(name))
        assert.ok(blob.length - 42 < previous.length * 0.97, name);
      if (name === 'docx') assert.ok(blob.length - 42 < previous.length * 0.99, name);
      if (name === 'code-short') assert.ok(blob.length - 42 < previous.length * 0.99, name);
      if (name === 'zip') assert.ok(blob.length - 42 < previous.length * 0.9, name);
      if (['source', 'code-ts', 'code-python', 'code-cpp'].includes(name))
        assert.ok(blob.length - 42 <= previous.length, name);
    }
  } finally {
    key.destroy();
  }
});

test('decompression handles frames without sizes and rejects invalid authenticated frames', async () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  const input = Buffer.alloc(2 << 20, 97);
  const ad = 'test/frame-size';
  try {
    const frame = zstdCompressSync(input, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
    const blob = sealBody(Buffer.concat([Buffer.from([1]), frame]), ad);
    assert.deepEqual(key.open(blob, ad), input);
    assert.deepEqual(await key.openChunk(blob, key.chunkID(input), ad), input);

    const prefix = Buffer.from('original header\n');
    const concatenated = sealBody(
      Buffer.concat([Buffer.from([1]), zstdCompressSync(prefix), zstdCompressSync(input)]),
      ad,
    );
    const combined = Buffer.concat([prefix, input]);
    assert.deepEqual(key.open(concatenated, ad), combined);
    assert.deepEqual(await key.openChunk(concatenated, key.chunkID(combined), ad), combined);

    // A single-segment frame claims a nearly 2^64-byte output. The size parser and decoder
    // must reject it without trying to allocate the declared size.
    const huge = Buffer.from('28b52ffde0feffffffffffffff010000', 'hex');
    const oversized = Buffer.from('28b52ffde00100001000000000010000', 'hex');
    for (const frame of [Buffer.alloc(0), huge, oversized, zstdCompressSync(input).subarray(0, 9)]) {
      const invalid = sealBody(Buffer.concat([Buffer.from([1]), frame]), ad);
      assert.throws(
        () => key.open(invalid, ad),
        error => error === errDecrypt,
      );
      await assert.rejects(key.openChunk(invalid, key.chunkID(input), ad), /decryption failed/);
    }
  } finally {
    key.destroy();
  }
});

test('chunk IDs are keyed, normalized and reject malformed input', () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  const content = Buffer.from('same content');
  assert.equal(key.chunkID(content), Key.fromPhrase(key.phrase()).chunkID(content));
  assert.notEqual(key.chunkID(content), Key.new().chunkID(content));
  assert.equal(parseID('AB'.repeat(32)), 'ab'.repeat(32));
  for (const value of ['', 'abcd', 'z'.repeat(64), 'ab'.repeat(31), 'ab'.repeat(33)])
    assert.throws(() => parseID(value));
});

test('destroyed keys refuse all cryptographic use', async () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  const other = Key.fromMaster(Buffer.alloc(32));
  const blob = key.seal(Buffer.from('data'), 'test/destroyed');
  key.destroy();

  for (const operation of [
    () => key.phrase(),
    () => key.fingerprint(),
    () => key.chunkerSeed(),
    () => key.equals(other),
    () => other.equals(key),
    () => key.chunkID(Buffer.alloc(0)),
    () => key.seal(Buffer.alloc(0), 'test/destroyed'),
    () => key.open(blob, 'test/destroyed'),
  ])
    assert.throws(operation, /destroyed/);
  await assert.rejects(key.sealChunk(Buffer.alloc(0), '00'.repeat(32), 'test/destroyed'), /destroyed/);
  await assert.rejects(key.openChunk(blob, '00'.repeat(32), 'test/destroyed'), /destroyed/);

  // Destroying twice is harmless.
  key.destroy();
  other.destroy();
});

// Chunks are sealed and opened in worker threads. The input buffer must come back intact after
// being shared with eight workers at once.
test('parallel workers preserve chunk authentication and transfer exact data safely', async () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  const content = random(1 << 20);
  const id = key.chunkID(content);
  const blobs = await Promise.all(Array.from({ length: 8 }, () => key.sealChunk(content, id, 'test/worker')));
  assert.equal(content.length, 1 << 20);

  const opened = await Promise.all(blobs.map(blob => key.openChunk(blob, id, 'test/worker')));
  for (const data of opened) assert.deepEqual(data, content);
  assert.equal(content.length, 1 << 20);
  await assert.rejects(key.openChunk(blobs[0], id, 'wrong/name'), /decryption failed/);
  await assert.rejects(key.sealChunk(content, '00'.repeat(32), 'test/worker'), /chunk content/);
});

// openOwnedChunk may move a buffer's memory to the worker instead of copying it. That's only
// allowed when the buffer owns its whole ArrayBuffer and is transferable. Views into larger
// memory, untransferable buffers and resizable buffers must be left as they were.
test('owned chunk decryption detaches only exclusive unpooled buffers and keeps exact plaintext views', async () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  const content = random(1 << 20);
  const id = key.chunkID(content);
  const blob = await key.sealChunk(content, id, 'test/owned');

  // An exclusive buffer is transferred, which leaves it empty.
  const direct = Buffer.from(blob);
  assert.equal(direct.byteLength, direct.buffer.byteLength);
  const opened = await key.openOwnedChunk(direct, id, 'test/owned');
  assert.deepEqual(opened, content);
  assert.equal(direct.byteLength, 0);

  const protectedBuffer = Buffer.from(blob);
  markAsUntransferable(protectedBuffer.buffer);
  assert.deepEqual(await key.openOwnedChunk(protectedBuffer, id, 'test/owned'), content);
  assert.deepEqual(protectedBuffer, blob);

  // A view at an offset into a bigger buffer keeps its neighbours' bytes too.
  const backing = Buffer.alloc(blob.length + 17, 83);
  blob.copy(backing, 17);
  assert.deepEqual(await key.openOwnedChunk(backing.subarray(17), id, 'test/owned'), content);
  assert.ok(backing.subarray(0, 17).equals(Buffer.alloc(17, 83)));
  assert.deepEqual(backing.subarray(17), blob);

  const expandable = new ArrayBuffer(blob.length, { maxByteLength: blob.length + 17 });
  const resizable = Buffer.from(expandable);
  blob.copy(resizable);
  assert.deepEqual(await key.openOwnedChunk(resizable, id, 'test/owned'), content);
  assert.equal(expandable.byteLength, blob.length);
  assert.deepEqual(resizable, blob);
  expandable.resize(blob.length + 17);
  assert.deepEqual(Buffer.from(expandable, 0, blob.length), blob);
  key.destroy();
});

// Decrypts blobs by hand to check the on-disk frame. A blob is a version byte, a 24-byte XChaCha20
// nonce, the ciphertext and a 16-byte tag. The plaintext starts with 1 for zstd or 0 for raw, and
// compressed output is only kept when it's smaller.
test('bounded compression output keeps native frames and plaintext ownership across many output blocks', async () => {
  const key = Key.fromMaster(Buffer.alloc(32));
  const enc = Buffer.from(
    hkdfSync('sha256', Buffer.alloc(32), Buffer.alloc(0), Buffer.from('frost v1 encryption'), 32),
  );
  const ad = 'test/output-buffer';
  try {
    for (const input of [
      Buffer.alloc(16, 97),
      random(1024),
      random(maxSize * 2 + 97),
      Buffer.concat([random(maxSize), Buffer.alloc(maxSize, 97)]),
    ]) {
      const original = Buffer.from(input);
      const compressed = zstdCompressSync(input, {
        params: { [constants.ZSTD_c_compressionLevel]: 1, [constants.ZSTD_c_windowLog]: 23 },
      });
      const id = key.chunkID(input);
      for (const blob of [key.seal(input, ad), await key.sealChunk(input, id, ad)]) {
        // XChaCha20 is HChaCha20 on the first 16 nonce bytes, then ChaCha20 with the last 8.
        const nonce = blob.subarray(1, 25);
        const subkey = hChaCha20(enc, nonce.subarray(0, 16));
        try {
          const decipher = createDecipheriv(
            'chacha20-poly1305',
            subkey,
            Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]),
            { authTagLength: 16 },
          );
          const encrypted = blob.subarray(25, -16);
          decipher.setAAD(Buffer.from(ad), { plaintextLength: encrypted.length });
          decipher.setAuthTag(blob.subarray(-16));
          const body = Buffer.concat([decipher.update(encrypted), decipher.final()]);
          assert.equal(body[0], compressed.length < input.length ? 1 : 0);
          assert.deepEqual(body.subarray(1), compressed.length < input.length ? compressed : original);
        } finally {
          subkey.fill(0);
        }

        // Sealing and opening never change the caller's input.
        assert.deepEqual(input, original);
        assert.deepEqual(await key.openChunk(blob, id, ad), original);
        assert.deepEqual(input, original);
      }
    }
  } finally {
    enc.fill(0);
    key.destroy();
  }
});

// The child adds a bad flag to its own execArgv. Workers would crash if they inherited it.
test('crypto workers ignore flags inherited from the invoking Node process', () => {
  const module = new URL('../../src/core/crypto.js', import.meta.url).href;
  const script = `process.execArgv.push('--invalid-worker-flag'); const {Key}=await import(${JSON.stringify(module)}); const key=Key.fromMaster(Buffer.alloc(32)); const input=Buffer.alloc(1<<20,97), id=key.chunkID(input); const blob=await key.sealChunk(input,id,'test/flags'); const opened=await key.openChunk(blob,id,'test/flags'); if(!opened.equals(input)) throw new Error('worker data differs'); key.destroy();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
});

// The chunker takes a shortcut when everything after minSize is one repeated byte. These cases check
// that shortcut against recorded cuts and the reference loop, including a single changed byte
// that must force the normal path.
test('uniform FastCDC shortcuts preserve recorded boundaries and fall back after a changed byte', () => {
  for (const vector of fixture.uniform) {
    const input = Buffer.alloc(vector.size, vector.byte);
    const table = newTable(BigInt(vector.seed));
    assert.deepEqual(
      split(input, table).map(part => part.length),
      vector.cuts,
    );
  }

  for (const high of [0, 0xffffc100, 0x100]) {
    const table = { low: new Uint32Array(256), high: new Uint32Array(256).fill(high) };
    const input = Buffer.alloc(maxSize, 97);
    assert.equal(cutpoint(input, table), referenceCutpoint(input, table));
  }

  const table = newTable(42n);
  for (const offset of [minSize, minSize + 63, minSize + 64, avgSize, maxSize - 1]) {
    const input = Buffer.alloc(maxSize, 97);
    input[offset] = 98;
    assert.equal(cutpoint(input, table), referenceCutpoint(input, table));
  }

  // Bytes before minSize are never hashed, so random bytes there don't matter.
  const ignoredPrefix = Buffer.alloc(maxSize, 97);
  random(minSize).copy(ignoredPrefix);
  assert.equal(cutpoint(ignoredPrefix, table), referenceCutpoint(ignoredPrefix, table));

  // The chunker caches a derived table per gear table. Editing the table afterwards must not
  // reuse the stale cache.
  const mutable = newTable(42n);
  const nonuniform = random(maxSize);
  cutpoint(nonuniform, mutable);
  mutable.low.fill(0);
  mutable.high.fill(0xffffc100);
  assert.equal(cutpoint(nonuniform, mutable), referenceCutpoint(nonuniform, mutable));
});

// The fast path hashes two bytes per step and prefilters on the high word. These tables are built
// to land a cut exactly where carries from the low word, unsigned wrap or the mask switch at the
// average size decide the result.
test('paired FastCDC prefilter preserves carries, wrap and both boundary masks', () => {
  // Bytes 0, 1 and 2 sit at minSize. Byte 2's gear value decides whether the cut lands right after them.
  for (const [high, low, hit] of [
    [0, 0xffffffff, true],
    [1, 0, true],
    [1024, 0xffffffff, false],
    [1025, 0xffffffff, false],
  ] as const) {
    const table = newTable(42n);
    const input = random(avgSize + 8193);
    table.low[0] = table.low[1] = 0xffffffff;
    table.high[0] = 1024;
    table.high[1] = 0x7ffff7fd;
    table.low[2] = low;
    table.high[2] = high;
    input.set([0, 1, 2], minSize);
    const wanted = referenceCutpoint(input, table);
    assert.equal(wanted === minSize + 3, hit);
    assert.equal(cutpoint(input, table), wanted);
  }

  // Run the hash over `offset` zero bytes, then pick byte 1's gear value so the high word becomes
  // exactly zero. That forces a cut at each chosen offset, on both halves of a paired step.
  for (const offset of [0, 1, 2, 31, 62, 63, 64, avgSize - minSize - 2, avgSize - minSize - 1, avgSize - minSize]) {
    const table = { low: new Uint32Array(256).fill(0x55555555), high: new Uint32Array(256).fill(0x55555555) };
    const input = Buffer.alloc(avgSize + 8193);
    let low = 0;
    let high = 0;
    for (let i = 0; i < offset; i++) {
      const addition = low * 2 + table.low[0];
      high = (high * 2 + table.high[0] + Math.floor(addition / 4294967296)) >>> 0;
      low = addition >>> 0;
    }
    table.low[1] = 0;
    table.high[1] = (-high * 2 - Math.floor((low * 2) / 4294967296)) >>> 0;
    input[minSize + offset] = 1;
    assert.equal(referenceCutpoint(input, table), minSize + offset + 1);
    assert.equal(cutpoint(input, table), minSize + offset + 1);
  }

  const data = random(maxSize);
  for (const seed of [0n, 1n, 42n, 313n, 0xffffffffffffffffn])
    for (const size of [avgSize - 1, avgSize + 1, maxSize - 1, maxSize]) {
      const input = data.subarray(0, size);
      const table = newTable(seed);
      assert.equal(cutpoint(input, table), referenceCutpoint(input, table));
    }
});

// Random gear tables with extreme values planted at shifting positions, against inputs of odd
// and even lengths around the average size.
test('FastCDC phases preserve scalar boundaries for adversarial gear tables and odd tails', () => {
  const data = random(avgSize * 2 + 1);
  const extremes = [0, 1, 0x3ff, 0x400, 0x3fff, 0x4000, 0x7fffffff, 0xffffffff];
  let state = 31337;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (let round = 0; round < 12; round++) {
    const table = { low: new Uint32Array(256), high: new Uint32Array(256) };
    for (let i = 0; i < 256; i++) {
      table.low[i] = next();
      table.high[i] = next();
    }
    for (let i = 0; i < extremes.length; i++) {
      table.low[(round * 17 + i) % 256] = extremes[i];
      table.high[(round * 31 + i) % 256] = extremes[extremes.length - 1 - i];
    }
    for (const size of [avgSize - 1, avgSize, avgSize + 1, avgSize + 2, data.length]) {
      const input = data.subarray(0, size);
      assert.equal(cutpoint(input, table), referenceCutpoint(input, table));
    }
  }
});

test('FastCDC exact boundaries match captured objects, with bounded streaming and insertion dedupe', async () => {
  const data = random(20 << 20);
  const table = newTable(42n);
  const pieces = split(data, table);
  assert.deepEqual(
    pieces.map(piece => piece.length),
    fixture.boundaries,
  );
  assert.deepEqual(Buffer.concat(pieces), data);
  pieces.forEach((piece, i) => {
    assert.ok(piece.length <= maxSize);
    if (i < pieces.length - 1) assert.ok(piece.length >= minSize);
  });

  // Streaming in odd-sized reads gives the same pieces as splitting in one go.
  async function* reader() {
    for (let i = 0; i < data.length; i += 8191) yield data.subarray(i, i + 8191);
  }
  const streamed: Buffer[] = [];
  for await (const piece of chunks(reader(), table)) streamed.push(piece);
  assert.deepEqual(streamed, pieces);

  // Inserting a few bytes in the middle changes at most two chunks.
  const key = Key.fromMaster(Buffer.alloc(32));
  const known = new Set(pieces.map(piece => key.chunkID(piece)));
  const edited = Buffer.concat([data.subarray(0, 5 << 20), Buffer.from('inserted!'), data.subarray(5 << 20)]);
  assert.ok(split(edited, table).filter(piece => !known.has(key.chunkID(piece))).length <= 2);
  assert.notDeepEqual(
    split(data, newTable(43n)).map(piece => piece.length),
    fixture.boundaries,
  );

  // A prefix of the data cuts the same way, except for its last piece.
  for (const prefix of [0, 1, minSize, 9 << 20, data.length - 1]) {
    const partial = split(data.subarray(0, prefix), table);
    assert.deepEqual(partial.slice(0, -1), pieces.slice(0, Math.max(0, partial.length - 1)));
  }
  assert.deepEqual(split(Buffer.alloc(0), table), []);
  assert.deepEqual(split(Buffer.from('tiny'), table), [Buffer.from('tiny')]);

  // newTable hands out copies, so editing one doesn't change later tables for the same seed.
  const independent = newTable(42n);
  independent.low.fill(0);
  independent.high.fill(0);
  assert.deepEqual(
    split(data, newTable(42n)).map(piece => piece.length),
    fixture.boundaries,
  );
});

test('streaming keeps exact cuts across multiple windows and dense boundary inputs', async () => {
  for (const [size, seed, step] of [
    [maxSize + 1, 0n, 32771],
    [maxSize * 2, 1n, maxSize * 2],
    [maxSize * 3 + 97, 313n, 1048573],
  ] as const) {
    const input = random(size);
    const table = newTable(seed);
    const wanted = split(input, table);
    async function* reader() {
      for (let i = 0; i < input.length; i += step) yield input.subarray(i, i + step);
    }
    const output: Buffer[] = [];
    for await (const part of chunks(reader(), table)) output.push(part);
    assert.deepEqual(
      output.map(part => part.length),
      wanted.map(part => part.length),
    );
    assert.deepEqual(Buffer.concat(output), input);
  }

  // An all-zero table cuts every chunk at minSize + 1, the densest output possible.
  const input = random(maxSize * 2);
  const table = { low: new Uint32Array(256), high: new Uint32Array(256) };
  async function* dense() {
    yield input;
  }
  const output: Buffer[] = [];
  for await (const part of chunks(dense(), table)) output.push(part);
  assert.deepEqual(
    output.map(part => part.length),
    split(input, table).map(part => part.length),
  );
  assert.deepEqual(Buffer.concat(output), input);
});

// chunksFromReader fills one caller-owned scratch buffer. The pieces it yields must not share
// that buffer, because the buffer is overwritten by later reads.
test('direct readers preserve exact cuts across short reads, EOF tails and reused scratch buffers', async () => {
  const buffer = Buffer.allocUnsafe(maxSize * 2);
  const retained: { input: Buffer; output: Buffer[] }[] = [];
  for (const [size, step, seed] of [
    [0, 1, 0n],
    [minSize - 1, 8191, 1n],
    [avgSize + 1, 32771, 42n],
    [maxSize * 3 + 97, 1048573, 313n],
  ] as const) {
    const input = random(size);
    const table = newTable(seed);
    const output: Buffer[] = [];
    let cursor = 0;
    const reader = {
      async read(target: Buffer, offset: number, length: number) {
        const count = Math.min(length, step, input.length - cursor);
        input.copy(target, offset, cursor, cursor + count);
        cursor += count;
        return { bytesRead: count };
      },
    };
    for await (const part of chunksFromReader(reader, table, buffer)) output.push(part);
    assert.deepEqual(
      output.map(part => part.length),
      split(input, table).map(part => part.length),
    );
    assert.deepEqual(Buffer.concat(output), input);
    retained.push({ input, output });
  }
  buffer.fill(83);
  for (const { input, output } of retained) assert.deepEqual(Buffer.concat(output), input);

  // Read errors pass through, and impossible byte counts are refused.
  const failed = {
    async read() {
      throw new Error('source read failed');
    },
  };
  await assert.rejects(async () => {
    for await (const _part of chunksFromReader(failed, newTable(0n), buffer)) {
    }
  }, /source read failed/);
  for (const bytesRead of [-1, 0.5, buffer.length + 1]) {
    const invalid = {
      async read() {
        return { bytesRead };
      },
    };
    await assert.rejects(async () => {
      for await (const _part of chunksFromReader(invalid, newTable(0n), buffer)) {
      }
    }, /invalid byte count/);
  }

  // Stopping the generator early stops reading, and the first piece survives a scratch overwrite.
  const input = random(maxSize * 3);
  const table = newTable(42n);
  let reads = 0;
  let cursor = 0;
  const reader = {
    async read(target: Buffer, offset: number, length: number) {
      reads++;
      const count = Math.min(length, input.length - cursor);
      input.copy(target, offset, cursor, cursor + count);
      cursor += count;
      return { bytesRead: count };
    },
  };
  const stream = chunksFromReader(reader, table, buffer);
  const first = await stream.next();
  if (first.done) throw new Error('reader yielded no chunk');
  const beforeReturn = reads;
  await stream.return(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, beforeReturn);
  buffer.fill(83);
  assert.deepEqual(first.value, split(input, table)[0]);
});

// ownedChunkID matches chunkID. A large exclusive buffer goes to a worker and comes back as a new
// view of the same bytes, leaving the original detached. Small or shared buffers stay put.
test('owned chunk IDs match chunkID and hand large exclusive buffers back from a worker', async () => {
  const key = Key.fromMaster(Buffer.alloc(32, 9));
  const data = random(1 << 20);
  const expected = key.chunkID(data);

  // Hashing only moves to a worker once one has started, so seal one chunk first.
  await key.sealChunk(data, expected, 'chunks/warm');

  const owned = Buffer.from(data);
  const large = await key.ownedChunkID(owned);
  assert.equal(large.id, expected);
  assert.deepEqual(large.data, data);
  assert.equal(owned.byteLength, 0);

  const view = Buffer.alloc(data.length + 8);
  data.copy(view, 8);
  const shared = await key.ownedChunkID(view.subarray(8));
  assert.equal(shared.id, expected);
  assert.deepEqual(view.subarray(8), data);

  const small = data.subarray(0, 1000);
  const tiny = await key.ownedChunkID(small);
  assert.equal(tiny.id, key.chunkID(small));
  assert.equal(tiny.data, small);
  key.destroy();
});

// The scan copies and hashes 1 MiB at a time from minSize, carrying the hash between segments. With
// gear[0] = 2^63 the hash stays at 2^63 and never cuts, and a single byte with gear 0 zeroes it, so
// the cut lands right after that byte. These positions sit on and around segment boundaries.
test('chunk cuts on and around scan segment boundaries match the reference', () => {
  const table = { low: new Uint32Array(256), high: new Uint32Array(256).fill(0x80000000) };
  table.high[1] = 0;
  const boundary = minSize + (1 << 20);
  for (const cut of [minSize + 1, boundary - 1, boundary, boundary + 1, boundary + (1 << 20), maxSize - 1, maxSize]) {
    const input = Buffer.alloc(maxSize);
    input[cut - 1] = 1;
    assert.equal(referenceCutpoint(input, table), cut);
    assert.equal(cutpoint(input, table), cut);
    assert.equal(scalarCutpoint(input, table), cut);
  }

  // With no trigger byte, nothing cuts and the chunk runs to maxSize.
  assert.equal(cutpoint(Buffer.alloc(maxSize + 5), table), maxSize);
});
