// Byte-preserving compression shared by inline crypto and crypto workers.
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export const maxPlaintextSize = 256 << 20;
const bufferSize = (size: number): number => Math.max(16384, Math.min((8 << 20) + 16384, size + 16384));
const fast = { [constants.ZSTD_c_compressionLevel]: 1, [constants.ZSTD_c_windowLog]: 23 };
const matched = { ...fast, [constants.ZSTD_c_strategy]: constants.ZSTD_dfast, [constants.ZSTD_c_minMatch]: 4 };

function encode(data: Buffer, params: typeof fast): Buffer {
  return zstdCompressSync(data, { chunkSize: bufferSize(data.length), params });
}

// Check delimiters and repetition in bounded samples. Repeated code templates keep the
// fast match finder; varied source can benefit from shorter matches.
function codeLike(data: Buffer): boolean {
  const size = 2048;
  const parts = [
    data.subarray(0, size),
    data.subarray((data.length - size) >>> 1, ((data.length - size) >>> 1) + size),
    data.subarray(-size),
  ];
  for (const part of parts) {
    let controls = 0;
    for (let i = 0; i < part.length; i += 16) {
      const byte = part[i];
      if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) if (++controls > 3) return false;
    }
  }
  const sample = parts.find(part => part.includes(40) && part.includes(41) && part.includes(123) && part.includes(125));
  if (!sample) return false;
  let repeated = 0;
  for (let i = 0; i < 256; i += 32)
    if (sample.indexOf(sample.subarray(i, i + 16), i + 16) >= 0 && ++repeated >= 3) return false;
  return true;
}

// Choose from byte patterns, including when the object is an interior file chunk. Small
// compressed containers benefit from short matches without another full compression pass.
function plan(data: Buffer): { params: typeof fast; refine: boolean } {
  if (data.length <= 64 << 10) {
    const zip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
    const gzip = data.length >= 3 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 8;
    const pdf =
      data.length >= 5 &&
      data.readUInt32BE(0) === 0x25504446 &&
      data[4] === 45 &&
      data.subarray(0, 4096).includes('/FlateDecode');
    if (zip || gzip || pdf) return { params: matched, refine: false };
  }
  if (data.length >= 8 << 10 && codeLike(data)) return { params: matched, refine: false };
  return { params: fast, refine: data.length <= 64 << 10 };
}

function worthRefining(data: Buffer, output: Buffer): boolean {
  return output.length >= 128 && output.length >= data.length / 8 && output.length < data.length;
}

// Only unclassified objects up to 64 KiB can get a second full pass. Already compact and
// incompressible outputs skip refinement. Every result remains an ordinary zstd frame.
export function compress(data: Buffer): Buffer {
  // Even an empty zstd frame takes nine bytes.
  if (data.length <= 9) return data;
  const { params, refine } = plan(data);
  let output = encode(data, params);
  if (refine && worthRefining(data, output)) {
    const candidate = encode(data, matched);
    if (candidate.length < output.length) output = candidate;
  }
  return output.length < data.length ? output : data;
}

// Reads the decompressed size from the first zstd frame, when it records one. This is a buffer
// hint; concatenated frames can produce more output, so decompression also enforces its limit.
export function zstdContentSize(data: Buffer): number | undefined {
  if (data.length < 6 || data.readUInt32LE() !== 0xfd2fb528) return undefined;
  // The descriptor encodes the size width, single-segment flag and dictionary ID width.
  const descriptor = data[4],
    single = (descriptor & 32) !== 0,
    flag = descriptor >>> 6;
  const dict = [0, 1, 2, 4][descriptor & 3],
    sizeBytes = flag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][flag],
    offset = 5 + (single ? 0 : 1) + dict;
  if (!sizeBytes || offset + sizeBytes > data.length) return undefined;
  if (sizeBytes === 8) {
    const value = data.readBigUInt64LE(offset);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  const value = data.readUIntLE(offset, sizeBytes);
  // A two-byte size is stored minus 256.
  return sizeBytes === 2 ? value + 256 : value;
}

// Known sizes avoid collecting small output blocks. Unknown sizes keep the default buffer.
export function decompress(data: Buffer): Buffer {
  const size = zstdContentSize(data);
  if (size !== undefined && size > maxPlaintextSize) throw new Error('decompressed data exceeds MaxPlaintextSize');
  return zstdDecompressSync(data, {
    chunkSize: size === undefined ? 16384 : bufferSize(size),
    maxOutputLength: maxPlaintextSize,
  });
}
