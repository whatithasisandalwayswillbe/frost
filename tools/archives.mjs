// Reads and writes the archives the tools handle: ustar for pinned Node runtimes, npm packages and Frost's Unix
// packages, and zip for Frost's Windows packages. Writers use zero times and owners and sort names by their
// bytes, so the same input always gives the same archive.
import { deflateRawSync, gzipSync } from 'node:zlib';

// Reads an uncompressed ustar archive into { name, type, data } entries. Each 512-byte header holds the name at 0,
// the octal size at 124, the checksum at 148, the type at 156 and a name prefix at 345. The checksum counts its own
// field as spaces, file data is padded to whole blocks, and an all-zero header ends the archive.
export function readTar(tar) {
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, '');
    const length = parseInt(text(124, 12).trim() || '0', 8);
    const prefix = text(345, 155);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (
      checksum !== parseInt(text(148, 8).trim(), 8) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + 512 + length > tar.length
    )
      throw new Error('Invalid tar archive');
    entries.push({
      name: (prefix ? prefix + '/' : '') + text(0, 100),
      type: header[156],
      data: tar.subarray(offset + 512, offset + 512 + length),
    });
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  return entries;
}

// True for a regular file entry, type NUL or '0'.
export const isFile = entry => entry.type === 0 || entry.type === 48;

// Writes { name, data, mode } entries as a gzipped ustar archive. A name over 100 bytes splits at its last slash into
// the 155-byte prefix field.
export function writeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    let name = e.name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const pos = name.lastIndexOf('/');
      prefix = name.slice(0, pos);
      name = name.slice(pos + 1);
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Package path too long');

    // Numeric fields are octal: mode at 100, uid 108, gid 116, size 124 and mtime 136. Type '0' marks a regular file.
    header.write(name);
    header.write(e.mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(e.data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(prefix, 345);

    // The checksum is written back as six octal digits, NUL and space.
    const checksum = [...header].reduce((a, b) => a + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }

  // Two zero blocks end the archive.
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

// CRC-32 with the reflected polynomial zip uses.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function crc32(bytes) {
  let n = 0xffffffff;
  for (const value of bytes) n = crcTable[(n ^ value) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}

// Writes { name, data, mode } entries as a zip of deflated files: each local header and its data, then the central
// directory, then the end record. There's no zip64, so an archive must stay under 65,535 entries and 4 GiB.
export function writeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  let directorySize = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);

    // Version 2.0, flag 0x800 for UTF-8 names, method 8 (deflate), time 0 and date 33 (1980-01-01).
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(33, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(e.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    // The central header repeats those fields and adds the local header's offset. It's made by Unix (0x0314), so the
    // external attributes carry the file mode.
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(33, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(e.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    local.push(localHeader, name, data);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
    directorySize += centralHeader.length + name.length;
  }

  // The end record holds the entry counts and the central directory's size and offset.
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
