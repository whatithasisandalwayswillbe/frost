// Keys and sealed objects. One master key derives the encryption, chunk ID, chunker and
// fingerprint subkeys with HKDF. Objects are sealed with XChaCha20-Poly1305, and the object's
// storage key is the associated data, so a blob only opens under the name it was sealed for.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { isMarkedAsUntransferable } from 'node:worker_threads';
import { decode, encode } from './bip39.js';
import { runCryptoWorker, workerReady } from './crypto-pool.js';
import { compress, decompress, zstdContentSize, maxPlaintextSize } from './compression.js';

const keySize = 32;
// Largest plaintext, before compression or after decompression.
export { maxPlaintextSize };
export const errDecrypt = new Error('decryption failed: wrong key or corrupted data');
export type ID = string;

// A job for a crypto worker. `data`, `enc` and `mac` are transferred to the worker and erased
// there. `id` is the expected chunk ID and `ad` is the object key used as associated data.
export interface CryptoJob {
  kind: 'seal' | 'open' | 'inflate' | 'hash';
  data: Uint8Array;
  enc: Uint8Array;
  mac: Uint8Array;
  id: string;
  ad: string;
}

// Checks a 64-digit hex chunk ID and returns it in lower case.
export function parseID(value: string): ID {
  if (value.length !== 64) throw new Error('invalid chunk id length');
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`invalid chunk id ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

// HKDF-SHA256 with an empty salt. Each label gives an independent subkey.
function derive(master: Buffer, label: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(label), length));
}

// An owned buffer that spans its whole transferable ArrayBuffer goes to the worker without a
// copy, and is detached. Anything else is copied, so the caller's buffer stays intact.
function workerInput(data: Buffer, owned: boolean): Uint8Array {
  if (
    owned &&
    data.buffer instanceof ArrayBuffer &&
    !data.buffer.resizable &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength &&
    !isMarkedAsUntransferable(data.buffer)
  )
    return new Uint8Array(data.buffer);
  return new Uint8Array(data);
}

function rotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

// The ChaCha quarter round on four words of the state.
function quarter(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  let va = state[a],
    vb = state[b],
    vc = state[c],
    vd = state[d];
  va = (va + vb) >>> 0;
  vd = rotate(vd ^ va, 16);
  vc = (vc + vd) >>> 0;
  vb = rotate(vb ^ vc, 12);
  va = (va + vb) >>> 0;
  vd = rotate(vd ^ va, 8);
  vc = (vc + vd) >>> 0;
  vb = rotate(vb ^ vc, 7);
  state[a] = va;
  state[b] = vb;
  state[c] = vc;
  state[d] = vd;
}

// HChaCha20 turns the key and the first 16 nonce bytes into a per-nonce subkey. That's the
// XChaCha20 construction, which lets Node's ChaCha20-Poly1305 take a 24-byte random nonce.
export function hChaCha20(key: Buffer, nonce: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 16) throw new Error('invalid HChaCha20 input');

  // State: the "expand 32-byte k" constants, the key, then the nonce.
  const state = new Uint32Array(16);
  state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) state[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) state[12 + i] = nonce.readUInt32LE(i * 4);

  // 20 rounds, as 10 pairs of column and diagonal rounds.
  for (let i = 0; i < 10; i++) {
    quarter(state, 0, 4, 8, 12);
    quarter(state, 1, 5, 9, 13);
    quarter(state, 2, 6, 10, 14);
    quarter(state, 3, 7, 11, 15);
    quarter(state, 0, 5, 10, 15);
    quarter(state, 1, 6, 11, 12);
    quarter(state, 2, 7, 8, 13);
    quarter(state, 3, 4, 9, 14);
  }

  // The subkey is the first and last rows of the state, with no final addition of the input.
  const result = Buffer.allocUnsafe(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((index, i) => result.writeUInt32LE(state[index], i * 4));
  state.fill(0);
  return result;
}

// The master key and its subkeys, kept in private fields and erased by destroy(). Ordinary
// methods never change the caller's buffers; only openOwnedChunk may detach its input.
export class Key {
  #master: Buffer;
  #enc: Buffer;
  #mac: Buffer;
  #macKey: KeyObject | undefined;
  #gear: bigint;

  // With `subkeys`, a worker gets only the encryption and chunk ID keys. The master is then a
  // zero placeholder and the chunker seed is unused.
  private constructor(master: Buffer, subkeys?: { enc: Uint8Array; mac: Uint8Array }) {
    if (master.length !== keySize) throw new Error('recovery phrase must be 24 words');
    this.#master = Buffer.from(master);
    this.#enc = subkeys ? Buffer.from(subkeys.enc) : derive(master, 'frost v1 encryption', 32);
    this.#mac = subkeys ? Buffer.from(subkeys.mac) : derive(master, 'frost v1 chunk id', 32);
    this.#macKey = createSecretKey(this.#mac);
    this.#gear = subkeys ? 0n : derive(master, 'frost v1 chunker', 8).readBigUInt64LE();
  }

  static new(): Key {
    return new Key(randomBytes(keySize));
  }

  static fromMaster(master: Buffer): Key {
    return new Key(master);
  }

  static fromPhrase(phrase: string): Key {
    return new Key(decode(phrase));
  }

  // destroy() clears #macKey, so it doubles as the "still alive" flag.
  #assertAlive(): void {
    if (!this.#macKey) throw new Error('crypto key has been destroyed');
  }

  phrase(): string {
    this.#assertAlive();
    return encode(this.#master);
  }

  // A short, non-secret ID for the key, shown in `frost status`.
  fingerprint(): string {
    this.#assertAlive();
    return derive(this.#master, 'frost v1 fingerprint', 6).toString('hex');
  }

  // Compares master keys in constant time.
  equals(other: Key | undefined): boolean {
    this.#assertAlive();
    if (other) other.#assertAlive();
    return !!other && timingSafeEqual(this.#master, other.#master);
  }

  // Seeds the chunker's gear table, so cut points depend on the key.
  chunkerSeed(): bigint {
    this.#assertAlive();
    return this.#gear;
  }

  // Keyed HMAC-SHA256 of the plaintext, so nobody without the key can match an ID to known content.
  chunkID(data: Uint8Array): ID {
    if (!this.#macKey) throw new Error('crypto key has been destroyed');
    return createHmac('sha256', this.#macKey).update(data).digest('hex');
  }

  // Runs a CryptoJob inside a worker. Every other kind checks the plaintext against the expected
  // chunk ID, so a worker never seals or returns mismatched data. `inflate` only decompresses
  // a body that the main thread already decrypted. `hash` computes the ID and hands the same
  // bytes back.
  static work(job: CryptoJob): { data: Buffer; id?: ID } {
    const key = new Key(Buffer.alloc(32), job);
    try {
      const source = Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength);
      if (job.kind === 'hash') return { data: source, id: key.chunkID(source) };
      let data: Buffer;
      if (job.kind === 'open') data = key.open(source, job.ad);
      else if (job.kind === 'inflate') {
        try {
          data = decompress(source);
        } catch {
          throw errDecrypt;
        }
      } else data = source;
      if (key.chunkID(data) !== job.id) throw new Error("chunk content doesn't match its ID");
      return { data: job.kind === 'seal' ? key.seal(data, job.ad) : data };
    } finally {
      key.destroy();
    }
  }

  // Computes a chunk's ID for a caller that gives up an exclusive buffer. From 512 KiB up, a
  // worker hashes it and hands the same buffer back, so the caller can keep working meanwhile.
  // Until a worker has started, waiting for one would cost more than hashing here. The worker
  // gets only the chunk ID subkey.
  async ownedChunkID(data: Buffer): Promise<{ id: ID; data: Buffer }> {
    this.#assertAlive();
    if (data.length < 512 << 10 || !workerReady()) return { id: this.chunkID(data), data };
    const reply = await runCryptoWorker({
      kind: 'hash',
      data: workerInput(data, true),
      enc: new Uint8Array(0),
      mac: new Uint8Array(this.#mac),
      id: '',
      ad: '',
    });
    if (typeof reply.id !== 'string') throw new Error('crypto worker returned no chunk ID');
    return { id: reply.id, data: reply.data };
  }

  // Seals a chunk after checking it against its ID. From 512 KiB up, a worker does the work on
  // a copy of the plaintext, so the caller's buffer is preserved either way.
  async sealChunk(plaintext: Buffer, id: string, ad: string): Promise<Buffer> {
    return this.#sealChunk(plaintext, id, ad, false);
  }

  // The caller gives up an exclusive plaintext buffer. Large owned buffers move to the worker
  // without a copy, which detaches them, and the worker erases them after sealing.
  async sealOwnedChunk(plaintext: Buffer, id: string, ad: string): Promise<Buffer> {
    return this.#sealChunk(plaintext, id, ad, true);
  }

  async #sealChunk(plaintext: Buffer, id: string, ad: string, owned: boolean): Promise<Buffer> {
    this.#assertAlive();
    if (plaintext.length < 512 << 10) {
      if (this.chunkID(plaintext) !== id) throw new Error("chunk content doesn't match its ID");
      return this.seal(plaintext, ad);
    }
    return (
      await runCryptoWorker({
        kind: 'seal',
        data: workerInput(plaintext, owned),
        enc: new Uint8Array(this.#enc),
        mac: new Uint8Array(this.#mac),
        id,
        ad,
      })
    ).data;
  }

  // Opens and verifies a chunk. The caller's ciphertext buffer is never changed.
  async openChunk(blob: Buffer, id: string, ad: string): Promise<Buffer> {
    return this.#openChunk(blob, id, ad, false);
  }

  // The caller gives up an exclusive ciphertext buffer. Large owned buffers may be detached.
  async openOwnedChunk(blob: Buffer, id: string, ad: string): Promise<Buffer> {
    return this.#openChunk(blob, id, ad, true);
  }

  // Blobs under 512 KiB decrypt here. If one holds a large or unknown-size zstd body, only the
  // decompression moves to a worker. Larger blobs decrypt in a worker.
  async #openChunk(blob: Buffer, id: string, ad: string, owned: boolean): Promise<Buffer> {
    this.#assertAlive();
    if (blob.length < 512 << 10) {
      const body = this.#decryptBody(blob, ad);
      if (body[0] === 1 && (zstdContentSize(body.subarray(1)) ?? Infinity) >= 512 << 10)
        return (
          await runCryptoWorker({
            kind: 'inflate',
            data: new Uint8Array(body.subarray(1)),
            enc: new Uint8Array(this.#enc),
            mac: new Uint8Array(this.#mac),
            id,
            ad,
          })
        ).data;
      const data = this.#decodeBody(body);
      if (this.chunkID(data) !== id) throw new Error("chunk content doesn't match its ID");
      return data;
    }
    return (
      await runCryptoWorker({
        kind: 'open',
        data: workerInput(blob, owned),
        enc: new Uint8Array(this.#enc),
        mac: new Uint8Array(this.#mac),
        id,
        ad,
      })
    ).data;
  }

  // Seals plaintext as version(1) | nonce(24) | ciphertext | tag(16), 42 bytes more than the
  // payload. The ciphertext starts with an encrypted flag byte, 1 for zstd or 0 for stored as is.
  // Compression searches up to 8 MiB back within the object and only keeps smaller output.
  seal(plaintext: Buffer, ad: string): Buffer {
    this.#assertAlive();
    if (plaintext.length > maxPlaintextSize) throw new Error('crypto: plaintext exceeds MaxPlaintextSize');
    const payload = compress(plaintext);
    // For XChaCha20-Poly1305, HChaCha20 derives a subkey from the first 16 nonce bytes, and
    // ChaCha20-Poly1305 takes four zero bytes plus the last 8 nonce bytes as its nonce.
    const nonce = randomBytes(24);
    const subkey = hChaCha20(this.#enc, nonce.subarray(0, 16));
    try {
      const cipher = createCipheriv(
        'chacha20-poly1305',
        createSecretKey(subkey),
        Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]),
        { authTagLength: 16 },
      );
      cipher.setAAD(Buffer.from(ad), { plaintextLength: payload.length + 1 });
      const encryptedFlag = cipher.update(Buffer.from([payload === plaintext ? 0 : 1]));
      const encryptedPayload = cipher.update(payload);
      return Buffer.concat(
        [Buffer.from([1]), nonce, encryptedFlag, encryptedPayload, cipher.final(), cipher.getAuthTag()],
        payload.length + 42,
      );
    } finally {
      subkey.fill(0);
    }
  }

  // Opens a sealed object. Every failure, including a wrong `ad`, becomes errDecrypt.
  open(blob: Buffer, ad: string): Buffer {
    this.#assertAlive();
    return this.#decodeBody(this.#decryptBody(blob, ad));
  }

  // Reads the flag byte, where 0 means stored and 1 means zstd. Output is capped at maxPlaintextSize.
  #decodeBody(body: Buffer): Buffer {
    if (!body.length) throw errDecrypt;
    if (body[0] === 0) {
      if (body.length - 1 > maxPlaintextSize) throw errDecrypt;
      return body.subarray(1);
    }
    if (body[0] === 1) {
      try {
        return decompress(body.subarray(1));
      } catch {
        throw errDecrypt;
      }
    }
    throw errDecrypt;
  }

  // Authenticates and decrypts the flag byte and payload. The checks up front reject short,
  // oversized or unknown-version blobs before any crypto runs.
  #decryptBody(blob: Buffer, ad: string): Buffer {
    if (blob.length < 42 || blob[0] !== 1 || blob.length > maxPlaintextSize + 64) throw errDecrypt;
    const nonce = blob.subarray(1, 25);
    const subkey = hChaCha20(this.#enc, nonce.subarray(0, 16));
    try {
      const cipher = createDecipheriv(
        'chacha20-poly1305',
        createSecretKey(subkey),
        Buffer.concat([Buffer.alloc(4), nonce.subarray(16)]),
        { authTagLength: 16 },
      );
      const encrypted = blob.subarray(25, -16);
      cipher.setAAD(Buffer.from(ad), { plaintextLength: encrypted.length });
      cipher.setAuthTag(blob.subarray(-16));
      const updated = cipher.update(encrypted),
        final = cipher.final();
      const body = final.length ? Buffer.concat([updated, final]) : updated;
      return body;
    } catch {
      throw errDecrypt;
    } finally {
      subkey.fill(0);
    }
  }

  // Erases the key buffers and drops the HMAC KeyObject. That KeyObject's own native copy, and
  // any other copy the runtime made, can't be erased from here.
  destroy(): void {
    this.#master.fill(0);
    this.#enc.fill(0);
    this.#mac.fill(0);
    this.#macKey = undefined;
    this.#gear = 0n;
  }

  // Keys never serialise or print their contents.
  toJSON(): string {
    return '[key]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[key]';
  }
}
