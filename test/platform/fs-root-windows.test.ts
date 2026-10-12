// Tests for the native Windows filesystem backend. Held parent handles must stay confined after a
// folder is swapped for a junction. Locks, byte offsets and links are covered too. Skipped elsewhere.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFFI } from '../../src/platform/ffi-loader.js';
import type { RootDirectory } from '../../src/platform/fs-root-types.js';

// A private folder with a `root` to work in and an `outside` folder holding a sentinel file that
// must never change.
function fixture(t: TestContext): { base: string; target: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'frost-native-windows-'));
  const target = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(target);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, target, outside };
}

// Turns an existing empty folder into a junction to `target` in place, without renaming it, so any
// handle already open on the folder stays open. This is the attack the held-parent checks must survive.
function setJunction(directory: string, target: string): void {
  const { functions } = loadFFI().dlopen('kernel32.dll', {
    CreateFileW: {
      return: 'pointer',
      arguments: ['pointer', 'uint32', 'uint32', 'pointer', 'uint32', 'uint32', 'pointer'],
    },
    DeviceIoControl: {
      return: 'int32',
      arguments: ['pointer', 'uint32', 'pointer', 'uint32', 'pointer', 'uint32', 'pointer', 'pointer'],
    },
    CloseHandle: { return: 'int32', arguments: ['pointer'] },
  });

  // Builds a mount point REPARSE_DATA_BUFFER. Its 16-byte header holds the tag (0xa0000003), the
  // data length, and the offsets and lengths of the NT substitute name and the print name.
  const name = Buffer.from(directory + '\0', 'utf16le');
  const substitute = Buffer.from('\\??\\' + target + '\0', 'utf16le');
  const print = Buffer.from(target + '\0', 'utf16le');
  const data = Buffer.alloc(16 + substitute.length + print.length);
  const returned = Buffer.alloc(4);
  data.writeUInt32LE(0xa0000003);
  data.writeUInt16LE(data.length - 8, 4);
  data.writeUInt16LE(substitute.length - 2, 10);
  data.writeUInt16LE(substitute.length, 12);
  data.writeUInt16LE(print.length - 2, 14);
  substitute.copy(data, 16);
  print.copy(data, 16 + substitute.length);

  // Opens the folder itself with FILE_WRITE_ATTRIBUTES, full sharing, OPEN_EXISTING, backup
  // semantics and open-reparse-point, then applies the buffer with FSCTL_SET_REPARSE_POINT (0x900a4).
  const handle = functions.CreateFileW(name, 0x100, 7, null, 3, 0x02200000, null) as bigint;
  assert.notEqual(handle, 0xffffffffffffffffn);
  try {
    assert.equal(functions.DeviceIoControl(handle, 0x900a4, data, data.length, null, 0, returned, null), 1);
  } finally {
    assert.equal(functions.CloseHandle(handle), 1);
  }
}

// `sub` is renamed to `moved` and a junction to `outside` takes its name. Everything done
// through the open `sub` handle must land in `moved`.
test(
  'Windows retained parents confine writes, rename, metadata and deletion after a directory replacement',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root = windowsBackend.openRoot(f.target);
    const sub = root.openDirectory('sub', { create: true });
    try {
      fs.renameSync(path.join(f.target, 'sub'), path.join(f.target, 'moved'));
      fs.symlinkSync(f.outside, path.join(f.target, 'sub'), 'junction');

      const file = sub.open('partial', { read: true, write: true, create: true, exclusive: true });
      try {
        file.writeFile('confined');
        file.utimes(1700000000123456700n, 1700000000123456700n);
        file.sync();
      } finally {
        file.close();
      }
      sub.rename('partial', sub, 'final');

      assert.equal(fs.readFileSync(path.join(f.target, 'moved', 'final'), 'utf8'), 'confined');
      assert.equal(fs.statSync(path.join(f.target, 'moved', 'final'), { bigint: true }).mtimeNs, 1700000000123456700n);
      assert.equal(fs.existsSync(path.join(f.outside, 'final')), false);
      assert.throws(() => root.openDirectory('sub'), /symbolic links/);
      sub.remove('final');
      assert.equal(fs.existsSync(path.join(f.target, 'moved', 'final')), false);
      assert.equal(fs.readFileSync(path.join(f.outside, 'sentinel'), 'utf8'), 'unchanged');
    } finally {
      sub.close();
      root.close();
    }
  },
);

test(
  'Windows native link counts identify a hardlink outside the retained root',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    fs.linkSync(path.join(f.outside, 'sentinel'), path.join(f.target, 'linked'));
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root = windowsBackend.openRoot(f.target);
    const file = root.open('linked', { read: true });
    try {
      assert.equal(file.stat().nlink, 2);
      assert.equal(root.lstat('linked').nlink, 2);
      assert.equal(file.stat().nlink, fs.statSync(path.join(f.outside, 'sentinel')).nlink);
      assert.equal(fs.readFileSync(path.join(f.outside, 'sentinel'), 'utf8'), 'unchanged');
    } finally {
      file.close();
      root.close();
    }
  },
);

// Here the open folder itself becomes a junction. Creation and renames through it must fail, and a
// metadata change may fail or not, but it must never reach `outside`.
test(
  'Windows in-place junction conversion cannot redirect held-parent creation, rename or metadata',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root = windowsBackend.openRoot(f.target);
    const sub = root.openDirectory('sub', { create: true });
    try {
      setJunction(path.join(f.target, 'sub'), f.outside);
      assert.throws(() => sub.open('escaped', { write: true, create: true, exclusive: true }));
      const source = root.open('source', { write: true, create: true, exclusive: true });
      source.writeFile('original');
      source.close();
      assert.throws(() => root.rename('source', sub, 'escaped'));

      // Whether utimes throws doesn't matter. Only the outside folder's mtime is checked.
      const before = fs.statSync(f.outside, { bigint: true }).mtimeNs;
      try {
        sub.utimes(1700000000000000000n, 1700000000000000000n);
      } catch {}
      assert.equal(fs.statSync(f.outside, { bigint: true }).mtimeNs, before);
      assert.equal(fs.existsSync(path.join(f.outside, 'escaped')), false);
      assert.equal(fs.readFileSync(path.join(f.target, 'source'), 'utf8'), 'original');
      assert.throws(() => root.openDirectory('sub'));
    } finally {
      sub.close();
      root.close();
    }
  },
);

// A held lock refuses a second handle with EBUSY, closing releases it, and no extra lock or PID
// file appears next to it.
test(
  'Windows native locks contend and close releases them without PID files',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root: RootDirectory = windowsBackend.openRoot(f.target);
    const first = root.open('lock', { read: true, write: true, create: true });
    const second = root.open('lock', { read: true, write: true });
    try {
      first.lock(true);
      assert.throws(
        () => second.lock(true),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY',
      );
      first.close();
      second.lock(true);
    } finally {
      second.close();
      first.close();
      root.close();
    }
    assert.deepEqual(fs.readdirSync(f.target), ['lock']);
  },
);

test(
  'Windows native file I/O rejects invalid or shared memory and keeps exact byte offsets',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root = windowsBackend.openRoot(f.target);
    const file = root.open('file', { read: true, write: true, create: true, exclusive: true });
    try {
      assert.throws(() => file.write(Buffer.alloc(2), 0.5, 1, 0), RangeError);
      assert.throws(() => file.read(Buffer.from(new SharedArrayBuffer(2)), 0, 2, 0), RangeError);

      // Writes "bc" at file offset 2, so the file reads back as two zero bytes then "bc".
      file.write(Buffer.from('abcd'), 1, 2, 2);
      const bytes = Buffer.alloc(4);
      assert.equal(file.read(bytes, 0, 4, 0).bytesRead, 4);
      assert.deepEqual(bytes, Buffer.from([0, 0, 98, 99]));
    } finally {
      file.close();
      root.close();
    }

    // A closed handle refuses further use.
    assert.throws(() => file.writeFile(''));
    assert.throws(() => file.lock(true));
  },
);

test(
  'Windows native change time agrees with Node after content and timestamp changes',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    const filename = path.join(f.target, 'file');
    fs.writeFileSync(filename, 'before');
    fs.utimesSync(filename, 1_000_000_000, 1_000_000_000);
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root = windowsBackend.openRoot(f.target);
    try {
      const before = root.lstat('file');
      assert.equal(before.ctimeNs, fs.statSync(filename, { bigint: true }).ctimeNs);
      await new Promise(resolve => setTimeout(resolve, 10));
      fs.writeFileSync(filename, 'after!');
      fs.utimesSync(filename, 1_000_000_000, 1_000_000_000);
      const after = root.lstat('file');
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(after.ctimeNs, fs.statSync(filename, { bigint: true }).ctimeNs);
      assert.ok(after.ctimeNs > before.ctimeNs);
    } finally {
      root.close();
    }
  },
);

// Links keep their exact target text and open as the right kind (folder or file). Opening any link
// for writing is refused, and renaming a file onto a link replaces the link, not its target.
test(
  'Windows relative and absolute links preserve targets and directory type without following write destinations',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t);
    const { windowsBackend } = await import('../../src/platform/fs-root-windows.js');
    const root = windowsBackend.openRoot(f.target);
    const directory = root.openDirectory('dir', { create: true });
    directory.close();
    const source = root.open('file', { write: true, create: true, exclusive: true });
    source.writeFile('inside');
    source.close();
    try {
      root.symlink('dir', 'dir-link');
      assert.deepEqual(fs.readdirSync(path.join(f.target, 'dir-link')), []);
      root.symlink('file', 'file-link');
      assert.equal(fs.readFileSync(path.join(f.target, 'file-link'), 'utf8'), 'inside');
      assert.equal(root.readlink('file-link'), 'file');

      // Missing, absolute, root-relative and dotted targets. target-1 points at the outside sentinel.
      for (const [i, target] of ['missing', path.join(f.outside, 'sentinel'), '\\missing', 'dir\\..\\file'].entries()) {
        const name = 'target-' + i;
        root.symlink(target, name);
        assert.equal(root.readlink(name), target);
        assert.throws(() => root.open(name, { write: true }));
      }
      assert.equal(fs.readFileSync(path.join(f.target, 'target-1'), 'utf8'), 'unchanged');

      const replacement = root.open('replacement', { write: true, create: true, exclusive: true });
      replacement.writeFile('restored');
      replacement.close();
      root.rename('replacement', root, 'target-1');
      assert.equal(fs.readFileSync(path.join(f.target, 'target-1'), 'utf8'), 'restored');
      assert.equal(fs.readFileSync(path.join(f.outside, 'sentinel'), 'utf8'), 'unchanged');
    } finally {
      root.close();
    }
  },
);
