// The chunker's gear-hash scan as a tiny WebAssembly function. JavaScript has no fast 64-bit
// integers, and this loop runs several times faster than the best JavaScript version. The
// module is assembled from the instructions below the first time it's needed; no compiled file
// ships, and V8 runs it in the same sandbox as the rest of Frost.

import type { Table } from './chunker.js';

// Memory layout: the gear table as 256 little-endian 64-bit entries, then the data window.
// Data byte i lives at WINDOW + i, so the window holds a whole chunk of up to 8 MiB.
const TABLE_BYTES = 256 * 8;
const WINDOW = TABLE_BYTES;
const WINDOW_BYTES = 8 << 20;
const PAGES = Math.ceil((WINDOW + WINDOW_BYTES) / 65536);

// Data is copied in and scanned this much at a time, so a cut early in a long input doesn't copy
// the rest of it for nothing.
const SEGMENT = 1 << 20;

// The cut masks as signed 64-bit constants: the top 22 bits before the average size, and the
// top 18 bits after it. They match 0xfffffc00 and 0xffffc000 on the high 32-bit half.
const MASK_BEFORE_AVERAGE = -(1n << 42n);
const MASK_AFTER_AVERAGE = -(1n << 46n);

// WebAssembly opcodes and types used below.
const op = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  return: 0x0f,
  localGet: 0x20,
  localSet: 0x21,
  globalGet: 0x23,
  globalSet: 0x24,
  i64Load: 0x29,
  i32Load8U: 0x2d,
  i32Const: 0x41,
  i64Const: 0x42,
  i32GeU: 0x4f,
  i64Eqz: 0x50,
  i32Add: 0x6a,
  i32Shl: 0x74,
  i64Add: 0x7c,
  i64And: 0x83,
  i64Shl: 0x86,
};
const empty = 0x40;
const i32 = 0x7f;
const i64 = 0x7e;

function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function sleb(value: bigint): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    if ((value === 0n && !(byte & 0x40)) || (value === -1n && byte & 0x40)) return [...out, byte];
    out.push(byte | 0x80);
  }
}

const name = (text: string): number[] => [...uleb(text.length), ...Buffer.from(text, 'ascii')];
const section = (id: number, body: number[]): number[] => [id, ...uleb(body.length), ...body];

// Locals of cut(i, end, normal): 0 is the position, 1 the end, 2 the average-size boundary,
// 3 the 64-bit hash, and 4 and 5 the gear values of the current pair of bytes. Global 0 carries
// the hash from one call to the next.
const [I, END, NORMAL, HASH, G0, G1] = [0, 1, 2, 3, 4, 5];
const SAVED = 0;

// Pushes gear[data[i + offset]].
function gear(offset: number): number[] {
  // prettier-ignore
  return [
    op.localGet, I, op.i32Load8U, 0, ...uleb(WINDOW + offset), op.i32Const, 3, op.i32Shl,
    op.i64Load, 3, 0,
  ];
}

// Tests the hash on the stack and returns the given position when its masked top bits are zero.
function cutAt(mask: bigint, position: number[]): number[] {
  // prettier-ignore
  return [
    op.i64Const, ...sleb(mask), op.i64And, op.i64Eqz,
    op.if, empty, ...position, op.return, op.end,
  ];
}

// Two bytes per step while i + 1 < limit. The hash after both, (h << 2) + ((g0 << 1) + g1), doesn't
// wait for the check after the first, (h << 1) + g0, so each step's chain of dependent work is one
// shift and one add instead of two of each.
function pairs(limit: number, mask: bigint): number[] {
  // prettier-ignore
  return [
    op.block, empty, op.loop, empty,
    op.localGet, I, op.i32Const, 1, op.i32Add, op.localGet, limit, op.i32GeU, op.brIf, 1,
    ...gear(0), op.localSet, G0,
    ...gear(1), op.localSet, G1,
    op.localGet, HASH, op.i64Const, 1, op.i64Shl, op.localGet, G0, op.i64Add,
    ...cutAt(mask, [op.localGet, I, op.i32Const, 1, op.i32Add]),
    op.localGet, HASH, op.i64Const, 2, op.i64Shl,
    op.localGet, G0, op.i64Const, 1, op.i64Shl, op.localGet, G1, op.i64Add,
    op.i64Add, op.localSet, HASH,
    op.localGet, I, op.i32Const, 2, op.i32Add, op.localSet, I,
    op.localGet, HASH, ...cutAt(mask, [op.localGet, I]),
    op.br, 0,
    op.end, op.end,
  ];
}

// One byte per step while i < limit: h = (h << 1) + gear[data[i]], i++, and return i when the
// masked top bits of h are all zero. After pairs, this only ever takes an odd last byte.
function scan(limit: number, mask: bigint): number[] {
  // prettier-ignore
  return [
    op.block, empty, op.loop, empty,
    op.localGet, I, op.localGet, limit, op.i32GeU, op.brIf, 1,
    op.localGet, HASH, op.i64Const, 1, op.i64Shl,
    ...gear(0), op.i64Add, op.localSet, HASH,
    op.localGet, I, op.i32Const, 1, op.i32Add, op.localSet, I,
    op.localGet, HASH, ...cutAt(mask, [op.localGet, I]),
    op.br, 0,
    op.end, op.end,
  ];
}

// The module imports its memory, exports the saved hash, and exports cut(i, end, normal), which
// returns the position after a cut, or 0 with the hash saved for the next call. A cut is always
// after at least one byte, so 0 is never a cut, even one that lands exactly at end.
function module(): Uint8Array<ArrayBuffer> {
  const locals = [1, 3, i64];
  // prettier-ignore
  const body = [
    ...locals,
    op.globalGet, SAVED, op.localSet, HASH,
    ...pairs(NORMAL, MASK_BEFORE_AVERAGE),
    ...scan(NORMAL, MASK_BEFORE_AVERAGE),
    ...pairs(END, MASK_AFTER_AVERAGE),
    ...scan(END, MASK_AFTER_AVERAGE),
    op.localGet, HASH, op.globalSet, SAVED,
    op.i32Const, 0, op.end,
  ];
  // prettier-ignore
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 3, i32, i32, i32, 1, i32]),
    ...section(2, [1, ...name('env'), ...name('memory'), 0x02, 0x00, ...uleb(PAGES)]),
    ...section(3, [1, 0]),
    ...section(6, [1, i64, 1, op.i64Const, 0, op.end]),
    ...section(7, [2, ...name('cut'), 0x00, 0, ...name('hash'), 0x03, SAVED]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

interface Scanner {
  cut: (i: number, end: number, normal: number) => number;
  hash: WebAssembly.Global;
  bytes: Uint8Array;
  table: DataView;
  // A copy of the table now in memory. Memory starts zeroed, and so does this.
  low: Uint32Array;
  high: Uint32Array;
}

// undefined until first use, then the scanner, or null when WebAssembly isn't available.
let scanner: Scanner | null | undefined;

function load(): Scanner | null {
  if (scanner !== undefined) return scanner;
  try {
    // A fixed-size memory never grows, so views of it never detach.
    const memory = new WebAssembly.Memory({ initial: PAGES, maximum: PAGES });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(module()), { env: { memory } });
    scanner = {
      cut: instance.exports.cut as Scanner['cut'],
      hash: instance.exports.hash as WebAssembly.Global,
      bytes: new Uint8Array(memory.buffer),
      table: new DataView(memory.buffer, 0, TABLE_BYTES),
      low: new Uint32Array(256),
      high: new Uint32Array(256),
    };
  } catch {
    scanner = null;
  }
  return scanner;
}

// Scans data from start for the first cut before end, and returns the chunk length, or end when
// nothing cuts. Returns undefined when WebAssembly isn't available, so the caller scans in
// JavaScript instead.
export function gearScan(
  data: Uint8Array,
  start: number,
  normal: number,
  end: number,
  table: Table,
): number | undefined {
  const s = load();
  if (!s) return undefined;
  if (end > WINDOW_BYTES) throw new RangeError('gear scan window exceeds 8 MiB');

  // Callers may edit a table between calls, so compare it with the copy in memory every time.
  for (let i = 0; i < 256; i++) {
    if (table.low[i] !== s.low[i] || table.high[i] !== s.high[i]) {
      for (let j = 0; j < 256; j++) {
        s.table.setUint32(j * 8, table.low[j], true);
        s.table.setUint32(j * 8 + 4, table.high[j], true);
      }
      s.low.set(table.low);
      s.high.set(table.high);
      break;
    }
  }

  // Copy and scan a segment at a time. The hash carries over between segments in the module.
  s.hash.value = 0n;
  for (let from = start; from < end;) {
    const to = Math.min(from + SEGMENT, end);
    s.bytes.set(data.subarray(from, to), WINDOW + from);
    const result = s.cut(from, to, Math.min(normal, to));
    if (result) return result;
    from = to;
  }
  return end;
}
