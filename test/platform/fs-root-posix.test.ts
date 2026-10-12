// Tests for the native POSIX filesystem backend on Linux and macOS: file operations and metadata,
// confinement after folder swaps, locks and special files. Skipped on other platforms.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { posixBackend } from '../../src/platform/fs-root-posix.js';
import type { RootFile } from '../../src/platform/fs-root-types.js';

const supported = process.platform === 'linux' || process.platform === 'darwin';

// Each location may be a different filesystem: the temp folder, /var/tmp on Linux, and the test
// folder itself, which can sit on a 9p mount under WSL.
const locations = [
  ...new Set([
    fs.realpathSync(os.tmpdir()),
    ...(process.platform === 'linux' ? ['/var/tmp'] : []),
    fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))),
  ]),
];

// 0x1021997 is the 9p filesystem magic. 9p keeps whole-second mtimes and refuses some operations
// through renamed directories, so a few checks relax there.
const is9p = (location: string): boolean => process.platform === 'linux' && fs.statfsSync(location).type === 0x1021997;

// Reads a whole file through the native handle.
function bytes(file: RootFile): string {
  const buffer = Buffer.alloc(file.stat().size);
  assert.equal(file.read(buffer, 0, buffer.length, 0).bytesRead, buffer.length);
  return buffer.toString();
}

for (const location of locations) {
  test(`native POSIX operations and metadata in ${location}`, { skip: !supported }, t => {
    const base = fs.mkdtempSync(path.join(location, 'frost-native-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = posixBackend.openRoot(base);
    t.after(() => root.close());
    const child = root.openDirectory('child', { create: true, exclusive: true, mode: 0o700 });
    t.after(() => child.close());
    assert.throws(() => root.openDirectory('child', { create: true, exclusive: true }), { code: 'EEXIST' });

    // A non-ASCII name checks that names reach the kernel as UTF-8.
    const file = child.open('雪.txt', { read: true, write: true, create: true, exclusive: true, mode: 0o600 });
    t.after(() => file.close());
    file.writeFile('start');
    assert.equal(file.write(Buffer.from('XXfinishYY'), 2, 6, 0).bytesWritten, 6);
    assert.equal(bytes(file), 'finish');
    file.truncate(4);
    assert.equal(bytes(file), 'fini');
    file.chmod(0o640);
    file.sync();

    // Native stat must agree with Node's, and mtimes keep nanoseconds except on 9p.
    const modified = 1_234_567_890_123_456_700n;
    file.utimes(modified - 100n, modified);
    const native = file.stat();
    const reference = fs.statSync(path.join(base, 'child', '雪.txt'), { bigint: true });
    assert.equal(native.dev, reference.dev);
    assert.equal(native.ino, reference.ino);
    assert.equal(native.size, Number(reference.size));
    assert.equal(native.mode, Number(reference.mode));
    assert.equal(native.uid, Number(reference.uid));
    assert.equal(native.nlink, Number(reference.nlink));
    assert.equal(native.mtimeNs, reference.mtimeNs);
    assert.equal(native.ctimeNs, reference.ctimeNs);
    assert.equal(native.mtimeNs, is9p(location) ? (modified / 1_000_000_000n) * 1_000_000_000n : modified);
    assert.equal(native.isFile(), true);
    assert.equal(native.isDirectory(), false);
    assert.equal(native.isSymbolicLink(), false);

    // Append, exclusive create and truncate behave like the matching O_ open flags.
    const append = child.open('雪.txt', { write: true, append: true });
    try {
      append.writeFile('!');
    } finally {
      append.close();
    }
    assert.equal(bytes(file), 'fini!');
    assert.throws(() => child.open('雪.txt', { write: true, create: true, exclusive: true }), { code: 'EEXIST' });
    const truncate = child.open('雪.txt', { write: true, truncate: true });
    truncate.close();
    assert.equal(file.stat().size, 0);

    // Out-of-range buffers and offsets, and names that aren't a single path component, are refused.
    assert.throws(() => file.read(Buffer.alloc(1), 0, 2, 0), RangeError);
    assert.throws(() => file.write(Buffer.alloc(1), 0, 1, -1), RangeError);
    assert.throws(() => file.truncate(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.throws(() => child.open('../escape', { create: true, write: true }), /unsafe/);
    assert.throws(() => child.open('sub/name', { create: true, write: true }), /unsafe/);
    assert.throws(() => child.open('bad\0name', { create: true, write: true }), /unsafe/);

    // Closing twice is harmless, and a closed handle reports EBADF.
    file.close();
    file.close();
    assert.throws(() => file.stat(), { code: 'EBADF' });
    assert.throws(() => file.writeFile(''), { code: 'EBADF' });
    child.remove('雪.txt');
    child.close();
    root.remove('child', true);
    assert.equal(fs.existsSync(path.join(base, 'child')), false);
  });

  test(
    `native POSIX link counts identify a hardlink outside the retained root in ${location}`,
    { skip: !supported },
    t => {
      const base = fs.mkdtempSync(path.join(location, 'frost-hardlinks-'));
      t.after(() => fs.rmSync(base, { recursive: true, force: true }));
      const target = path.join(base, 'root');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(target);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
      try {
        fs.linkSync(path.join(outside, 'sentinel'), path.join(target, 'linked'));
      } catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        t.skip('the filesystem does not support hardlinks');
        return;
      }
      const root = posixBackend.openRoot(target);
      t.after(() => root.close());
      const file = root.open('linked', { read: true });
      t.after(() => file.close());
      assert.equal(file.stat().nlink, 2);
      assert.equal(root.lstat('linked').nlink, 2);
      assert.equal(file.stat().nlink, fs.statSync(path.join(outside, 'sentinel')).nlink);
      assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
    },
  );

  // `child` is renamed to `moved` and a symlink to `outside` takes its name. The open `child`
  // handle must keep working on the real folder, and nothing may land in `outside`.
  test(`native POSIX handles remain confined after parent and leaf swaps in ${location}`, { skip: !supported }, t => {
    const base = fs.mkdtempSync(path.join(location, 'frost-confined-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const target = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(target);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
    const root = posixBackend.openRoot(target);
    t.after(() => root.close());
    const child = root.openDirectory('child', { create: true });
    t.after(() => child.close());
    fs.renameSync(path.join(target, 'child'), path.join(target, 'moved'));
    fs.symlinkSync(outside, path.join(target, 'child'));
    assert.throws(() => root.openDirectory('child'));

    // 9p refuses to create a file through the renamed handle. That's still safe, so the test
    // checks nothing escaped, puts the folder back and carries on.
    let file: RootFile;
    try {
      file = child.open('result', { write: true, create: true, exclusive: true });
    } catch (error) {
      assert.equal(is9p(location), true);
      assert.equal((error as NodeJS.ErrnoException).code, 'ENXIO');
      assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
      t.diagnostic(
        '9p rejects creation through a renamed directory descriptor with ENXIO, safely refusing a renamed descriptor',
      );
      root.remove('child');
      root.rename('moved', root, 'child');
      file = child.open('result', { write: true, create: true, exclusive: true });
    }
    file.writeFile('held directory');
    file.close();
    const heldPath = fs.existsSync(path.join(target, 'moved')) ? 'moved' : 'child';
    assert.equal(fs.readFileSync(path.join(target, heldPath, 'result'), 'utf8'), 'held directory');

    // A symlink as the final name is never followed for writing, and renaming over it replaces
    // the link rather than its target.
    child.symlink(path.join(outside, 'sentinel'), 'leaf');
    assert.equal(child.lstat('leaf').isSymbolicLink(), true);
    assert.equal(child.readlink('leaf'), path.join(outside, 'sentinel'));
    assert.throws(() => child.open('leaf', { write: true, truncate: true }), { code: 'ELOOP' });
    child.rename('result', child, 'leaf');
    assert.equal(child.lstat('leaf').isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);

    const destination = root.openDirectory('destination', { create: true });
    t.after(() => destination.close());
    child.rename('leaf', destination, 'renamed');
    assert.equal(fs.readFileSync(path.join(target, 'destination', 'renamed'), 'utf8'), 'held directory');
    destination.remove('renamed');

    // A root path that is itself a link, or isn't absolute, is refused.
    fs.symlinkSync(outside, path.join(base, 'root-link'));
    assert.throws(() => posixBackend.openRoot(path.join(base, 'root-link')));
    assert.throws(() => posixBackend.openRoot('relative'), /absolute/);
  });

  test(`native POSIX locks contend and release on close in ${location}`, { skip: !supported }, t => {
    const base = fs.mkdtempSync(path.join(location, 'frost-lock-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = posixBackend.openRoot(base);
    t.after(() => root.close());
    const first = root.open('lock', { write: true, create: true });
    t.after(() => first.close());
    const second = root.open('lock', { write: true });
    t.after(() => second.close());
    // flock locks belong to the open file, so a second handle in the same process is refused too.
    first.lock(true);
    assert.throws(
      () => second.lock(true),
      error => ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? ''),
    );

    // Another process is refused as well. Its exit code is 2 if it got the lock.
    const module = new URL('../../src/platform/fs-root-posix.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {posixBackend} from ${JSON.stringify(module)};const r=posixBackend.openRoot(${JSON.stringify(base)});const f=r.open('lock',{write:true});try{f.lock(true);process.exitCode=2}catch(e){if(!['EAGAIN','EWOULDBLOCK'].includes(e.code))throw e}finally{f.close();r.close()}`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');

    // Closing the holder releases the lock.
    first.close();
    second.lock(true);
    second.close();
    assert.throws(() => second.lock(true), { code: 'EBADF' });
  });
}

// Opening a FIFO with truncate must fail the regular-file check and leave the FIFO in place.
test('native POSIX rejects nonregular files before truncation', { skip: !supported }, t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'frost-special-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = posixBackend.openRoot(base);
  t.after(() => root.close());
  const fifo = path.join(base, 'fifo');
  const result = spawnSync('mkfifo', [fifo], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => root.open('fifo', { read: true, write: true, truncate: true }), /regular file/);
  assert.equal(fs.lstatSync(fifo).isFIFO(), true);
});

// The child swaps in a fake flock that fails once with EINTR (4) and then with EIO (5). A plain
// lock retries the interruption and tolerates the failure, while a strict lock reports EIO.
test('native POSIX strict locks propagate unsupported kernel failures', { skip: !supported }, () => {
  const module = new URL('../../src/platform/fs-root-posix.js', import.meta.url).href;
  const loader = new URL('../../src/platform/ffi-loader.js', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';import {loadFFI} from ${JSON.stringify(loader)};
    import {posixBackend} from ${JSON.stringify(module)};
    const ffi=loadFFI(),originalOpen=ffi.dlopen,originalErrno=ffi.getInt32;
    let interrupted=true,errno;
    ffi.getInt32=(...args)=>errno??Reflect.apply(originalErrno,ffi,args);
    ffi.dlopen=function(...args){const result=Reflect.apply(originalOpen,ffi,args),originalFunction=result.lib.getFunction;
      result.lib.getFunction=function(name,...args){if(name==='flock')return ()=>{if(interrupted){interrupted=false;errno=4;return -1}errno=5;return -1};return Reflect.apply(originalFunction,this,[name,...args])};return result};
    const root=posixBackend.openRoot(${JSON.stringify(fs.realpathSync(os.tmpdir()))});
    try{root.lock();assert.equal(interrupted,false);assert.throws(()=>root.lock(true),{code:'EIO'})}finally{root.close()}
  `,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});
