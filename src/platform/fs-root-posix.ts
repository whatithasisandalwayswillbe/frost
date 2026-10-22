// Native filesystem backend for Linux and macOS on x64 and arm64. It binds libc's *at() system
// calls through node:ffi, so every path is a single name relative to a retained descriptor.
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import { loadFFI, type FFIType, type FFIValue, type FFILibrary } from './ffi-loader.js';
import {
  leaf,
  type RootBackend,
  type RootDirectory,
  type RootEntry,
  type RootFile,
  type RootOpenOptions,
  type RootSpace,
  type RootStat,
} from './fs-root-types.js';

// Flag values differ between Darwin and Linux, so they're spelled out per platform.
const darwin = process.platform === 'darwin';
const errors = getSystemErrorMap();
const AT_FDCWD = darwin ? -2 : -100;
const AT_SYMLINK_NOFOLLOW = darwin ? 0x20 : 0x100;
const AT_REMOVEDIR = darwin ? 0x80 : 0x200;
const O_CLOEXEC = darwin ? 0x1000000 : 0x80000;
const nanoseconds = 1_000_000_000n;

type Call = (...args: FFIValue[]) => number | bigint | undefined;
let native: { lib: FFILibrary; calls: Record<string, Call>; errno: () => number; clearErrno: () => void } | undefined;

// Binds the system calls once. mode_t is 16 bits on Darwin and 32 bits on Linux.
function bindings(): NonNullable<typeof native> {
  if (native) return native;
  if ((process.platform !== 'linux' && !darwin) || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new Error('native filesystem access is unavailable on this platform');
  }
  const ffi = loadFFI();
  const { lib } = ffi.dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : null);
  const calls: Record<string, Call> = {};
  const bind = (name: string, result: FFIType, args: FFIType[], symbol = name): void => {
    calls[name] = lib.getFunction(symbol, { return: result, arguments: args });
  };

  try {
    // Apple's fixed syscall wrapper avoids the arm64 variadic openat ABI.
    bind('openat', 'int32', ['int32', 'string', 'int32', darwin ? 'uint16' : 'uint32'], darwin ? '__openat' : 'openat');
    bind('mkdirat', 'int32', ['int32', 'string', darwin ? 'uint16' : 'uint32']);
    bind('close', 'int32', ['int32']);
    bind('pread', 'int64', ['int32', 'buffer', 'uint64', 'int64']);
    bind('pwrite', 'int64', ['int32', 'buffer', 'uint64', 'int64']);
    bind('write', 'int64', ['int32', 'buffer', 'uint64']);
    bind('ftruncate', 'int32', ['int32', 'int64']);
    bind('fsync', 'int32', ['int32']);
    bind('fchmod', 'int32', ['int32', darwin ? 'uint16' : 'uint32']);
    bind('futimens', 'int32', ['int32', 'buffer']);
    bind('flock', 'int32', ['int32', 'int32']);
    bind('renameat', 'int32', ['int32', 'string', 'int32', 'string']);
    bind('readlinkat', 'int64', ['int32', 'string', 'buffer', 'uint64']);
    bind('symlinkat', 'int32', ['string', 'int32', 'string']);
    bind('unlinkat', 'int32', ['int32', 'string', 'int32']);

    // Intel Macs need the 64-bit-inode stat symbols. Linux uses statx instead.
    if (darwin) {
      bind('fstat', 'int32', ['int32', 'buffer'], process.arch === 'x64' ? 'fstat64' : 'fstat');
      bind(
        'fstatat',
        'int32',
        ['int32', 'string', 'buffer', 'int32'],
        process.arch === 'x64' ? 'fstatat64' : 'fstatat',
      );
    } else {
      bind('statx', 'int32', ['int32', 'string', 'int32', 'uint32', 'buffer']);
    }

    // errno is thread-local, so read it through libc's accessor right after each failed call.
    const errnoPointer = lib.getFunction(darwin ? '__error' : '__errno_location', { return: 'pointer', arguments: [] });
    native = {
      lib,
      calls,
      errno: () => ffi.getInt32(errnoPointer() as bigint),
      clearErrno: () => ffi.setInt32(errnoPointer() as bigint, 0, 0),
    };
    return native;
  } catch (error) {
    lib.close();
    throw error;
  }
}

// Calls only the local drive storage uses, each bound on first use, so a libc without one of them can't stop
// the rest from loading. Intel Macs need the 64-bit-inode symbols for folder entries and volume sizes.
const intelMac = darwin && process.arch === 'x64';
const optional: Record<string, [string, FFIType, FFIType[]]> = {
  fdopendir: [intelMac ? 'fdopendir$INODE64' : 'fdopendir', 'pointer', ['int32']],
  readdir: [intelMac ? 'readdir$INODE64' : 'readdir', 'pointer', ['pointer']],
  closedir: ['closedir', 'int32', ['pointer']],
  linkat: ['linkat', 'int32', ['int32', 'string', 'int32', 'string', 'int32']],
  renameNoReplace: [darwin ? 'renameatx_np' : 'renameat2', 'int32', ['int32', 'string', 'int32', 'string', 'uint32']],
  space: [darwin ? (intelMac ? 'fstatfs64' : 'fstatfs') : 'fstatvfs', 'int32', ['int32', 'buffer']],
};

function ensure(name: string): void {
  const api = bindings();
  if (api.calls[name]) return;
  const [symbol, result, args] = optional[name];
  api.calls[name] = api.lib.getFunction(symbol, { return: result, arguments: args });
}

// The errno for a call that isn't available, ENOSYS: 78 on Darwin and 38 on Linux.
const ENOSYS = darwin ? 78 : 38;

// Builds an error shaped like Node's own, with the code name from libuv's errno table.
function systemError(errno: number, syscall: string, name?: string): NodeJS.ErrnoException {
  const [code, message] = errors.get(-errno) ?? ['EIO', 'input/output error'];
  return Object.assign(new Error(`${code}: ${message}, ${syscall}${name === undefined ? '' : ` '${name}'`}`), {
    code,
    errno: -errno,
    syscall,
    ...(name === undefined ? {} : { path: name }),
  });
}

// Calls a bound function and throws on -1. EINTR (4) retries, except for close, where the
// descriptor may already be released and reused.
function invoke(name: string, args: FFIValue[], pathname?: string): number | bigint {
  const api = bindings();
  for (;;) {
    const result = api.calls[name](...args) as number | bigint;
    if (result !== -1 && result !== -1n) return result;
    const errno = api.errno();
    if (errno === 4 && name !== 'close') continue;
    throw systemError(errno, name, pathname);
  }
}

function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('filesystem offset must be a nonnegative safe integer');
}

function mode(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0o7777) throw new RangeError('invalid filesystem mode');
  return value;
}

// Native calls get a raw pointer, so the buffer must be a plain, fixed-size Buffer and the
// range must fit inside it.
function range(buffer: Buffer, offset: number, length: number): Buffer {
  integer(offset);
  integer(length);
  if (
    !Buffer.isBuffer(buffer) ||
    offset + length > buffer.length ||
    buffer.buffer instanceof SharedArrayBuffer ||
    (buffer.buffer as ArrayBuffer).resizable
  ) {
    throw new RangeError('invalid native filesystem buffer');
  }
  return buffer.subarray(offset, offset + length);
}

// Sizes past Number.MAX_SAFE_INTEGER and out-of-range nanoseconds fail with EOVERFLOW
// (84 on Darwin, 75 on Linux).
function statValue(
  dev: bigint,
  ino: bigint,
  size: bigint,
  fileMode: number,
  uid: number,
  nlink: number,
  seconds: bigint,
  ns: bigint,
  changedSeconds: bigint,
  changedNs: bigint,
): RootStat {
  if (
    size < 0n ||
    size > BigInt(Number.MAX_SAFE_INTEGER) ||
    ns < 0n ||
    ns >= nanoseconds ||
    changedNs < 0n ||
    changedNs >= nanoseconds
  )
    throw systemError(darwin ? 84 : 75, 'stat');
  return {
    dev,
    ino,
    size: Number(size),
    mode: fileMode,
    uid,
    nlink,
    mtimeNs: seconds * nanoseconds + ns,
    ctimeNs: changedSeconds * nanoseconds + changedNs,
    isFile: () => (fileMode & 0o170000) === 0o100000,
    isDirectory: () => (fileMode & 0o170000) === 0o040000,
    isSymbolicLink: () => (fileMode & 0o170000) === 0o120000,
  };
}

// Stats a descriptor, or a name below it without following a link.
function stat(fd: number, name?: string): RootStat {
  const data = Buffer.alloc(darwin ? 144 : 256);

  // Darwin's 144-byte struct stat: st_dev at 0, st_mode u16 at 4, st_nlink u16 at 6, st_ino at 8, st_uid at 16,
  // st_mtimespec at 48 and 56, st_ctimespec at 64 and 72, and st_size at 96.
  if (darwin) {
    if (name === undefined) invoke('fstat', [fd, data]);
    else invoke('fstatat', [fd, name, data, AT_SYMLINK_NOFOLLOW], name);
    return statValue(
      BigInt(data.readUInt32LE(0)),
      data.readBigUInt64LE(8),
      data.readBigInt64LE(96),
      data.readUInt16LE(4),
      data.readUInt32LE(16),
      data.readUInt16LE(6),
      data.readBigInt64LE(48),
      data.readBigInt64LE(56),
      data.readBigInt64LE(64),
      data.readBigInt64LE(72),
    );
  }

  // statx has one kernel layout on both Linux architectures.
  // With no name, AT_EMPTY_PATH (0x1000) stats fd itself. 0x7ff asks for STATX_BASIC_STATS, and
  // 0x3cf checks the reply has TYPE, MODE, NLINK, UID, MTIME, CTIME, INO and SIZE.
  invoke('statx', [fd, name ?? '', AT_SYMLINK_NOFOLLOW | (name === undefined ? 0x1000 : 0), 0x7ff, data], name);
  if ((data.readUInt32LE(0) & 0x3cf) !== 0x3cf) throw new Error('filesystem did not return required native metadata');

  // stx_dev_major and stx_dev_minor sit at 136 and 140. Packing them like glibc's makedev, as
  // libuv does, keeps dev equal to what Node's fs.stat reports.
  const major = BigInt(data.readUInt32LE(136));
  const minor = BigInt(data.readUInt32LE(140));
  const dev =
    (minor & 0xffn) | ((major & 0xfffn) << 8n) | ((minor & 0xffffff00n) << 12n) | ((major & 0xfffff000n) << 32n);

  // stx_ino at 32, stx_size at 40, stx_mode u16 at 28, stx_uid at 20, stx_nlink at 16, stx_mtime at 112 and 120,
  // and stx_ctime at 96 and 104.
  return statValue(
    dev,
    data.readBigUInt64LE(32),
    data.readBigUInt64LE(40),
    data.readUInt16LE(28),
    data.readUInt32LE(20),
    data.readUInt32LE(16),
    data.readBigInt64LE(112),
    BigInt(data.readUInt32LE(120)),
    data.readBigInt64LE(96),
    BigInt(data.readUInt32LE(104)),
  );
}

// Opens a name below fd. O_NOFOLLOW refuses a final link, O_NONBLOCK keeps a FIFO from
// hanging the open, and the type check afterwards closes anything that isn't the expected kind.
function open(fd: number, name: string, flags: number, permissions: number, directory: boolean): PosixFile {
  const opened = Number(
    invoke(
      'openat',
      [fd, name, flags | constants.O_NOFOLLOW | O_CLOEXEC | constants.O_NONBLOCK, mode(permissions)],
      name,
    ),
  );
  const result = directory ? new PosixDirectory(opened) : new PosixFile(opened);
  try {
    const info = result.stat();
    if (directory ? !info.isDirectory() : !info.isFile())
      throw new Error(directory ? 'expected a directory' : 'expected a regular file');
    return result;
  } catch (error) {
    result.close();
    throw error;
  }
}

// A retained file descriptor. After close, every call fails with EBADF (9).
class PosixFile implements RootFile {
  #fd: number;

  constructor(fd: number) {
    this.#fd = fd;
  }

  protected descriptor(): number {
    if (this.#fd < 0) throw systemError(9, 'file');
    return this.#fd;
  }

  stat(): RootStat {
    return stat(this.descriptor());
  }

  read(buffer: Buffer, offset: number, length: number, position: number): { bytesRead: number } {
    const fd = this.descriptor();
    const data = range(buffer, offset, length);
    integer(position);
    return { bytesRead: length ? Number(invoke('pread', [fd, data, BigInt(length), BigInt(position)])) : 0 };
  }

  // A null position writes at the current offset, which O_APPEND moves to the end.
  write(buffer: Buffer, offset: number, length: number, position: number | null): { bytesWritten: number } {
    const fd = this.descriptor();
    const data = range(buffer, offset, length);
    if (position !== null) integer(position);
    return {
      bytesWritten: length
        ? Number(
            position === null
              ? invoke('write', [fd, data, BigInt(length)])
              : invoke('pwrite', [fd, data, BigInt(length), BigInt(position)]),
          )
        : 0,
    };
  }

  // Writes everything from the current offset. A write that makes no progress fails with EIO (5).
  writeFile(data: string | Buffer): void {
    this.descriptor();
    const buffer = typeof data === 'string' ? Buffer.from(data) : data;
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = this.write(buffer, offset, buffer.length - offset, null);
      if (!bytesWritten) throw systemError(5, 'write');
      offset += bytesWritten;
    }
  }

  truncate(length: number): void {
    integer(length);
    invoke('ftruncate', [this.descriptor(), BigInt(length)]);
  }

  sync(): void {
    invoke('fsync', [this.descriptor()]);
  }

  chmod(permissions: number): void {
    invoke('fchmod', [this.descriptor(), mode(permissions)]);
  }

  // futimens takes two 16-byte timespecs (seconds, nanoseconds). Floor division keeps the
  // nanoseconds positive for times before 1970.
  utimes(accessNs: bigint, modifiedNs: bigint): void {
    const times = Buffer.alloc(32);
    for (const [index, value] of [accessNs, modifiedNs].entries()) {
      const remainder = ((value % nanoseconds) + nanoseconds) % nanoseconds;
      times.writeBigInt64LE((value - remainder) / nanoseconds, index * 16);
      times.writeBigInt64LE(remainder, index * 16 + 8);
    }
    invoke('futimens', [this.descriptor(), times]);
  }

  // flock with LOCK_EX | LOCK_NB (6). A held lock (EAGAIN, EWOULDBLOCK) or a closed descriptor
  // always throws. Other failures only throw when strict.
  lock(strict = false): void {
    try {
      invoke('flock', [this.descriptor(), 6]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (strict || code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EBADF') throw error;
    }
  }

  // Marks the descriptor closed before the call, so a failed close is never retried.
  close(): void {
    if (this.#fd < 0) return;
    const fd = this.#fd;
    this.#fd = -1;
    invoke('close', [fd]);
  }
}

// A retained directory descriptor. Every name is checked with leaf() first.
class PosixDirectory extends PosixFile implements RootDirectory {
  open(name: string, options: RootOpenOptions): RootFile {
    leaf(name);
    const write = options.write || options.append || options.truncate;
    let flags = options.read && write ? constants.O_RDWR : write ? constants.O_WRONLY : constants.O_RDONLY;
    if (options.create) flags |= constants.O_CREAT;
    if (options.exclusive) flags |= constants.O_EXCL;
    if (options.append) flags |= constants.O_APPEND;
    const result = open(this.descriptor(), name, flags, options.mode ?? 0o666, false);

    // Truncate after the type check, so a link or special file is never truncated.
    if (options.truncate) {
      try {
        result.truncate(0);
      } catch (error) {
        result.close();
        throw error;
      }
    }
    return result;
  }

  // Creates the folder if asked (an existing one is fine unless exclusive), then opens it.
  openDirectory(name: string, options: { create?: boolean; exclusive?: boolean; mode?: number } = {}): RootDirectory {
    leaf(name);
    const fd = this.descriptor();
    if (options.create) {
      try {
        invoke('mkdirat', [fd, name, mode(options.mode ?? 0o777)], name);
      } catch (error) {
        if (options.exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return open(fd, name, constants.O_RDONLY | constants.O_DIRECTORY, options.mode ?? 0o777, true) as PosixDirectory;
  }

  lstat(name: string): RootStat {
    leaf(name);
    return stat(this.descriptor(), name);
  }

  // readlinkat doesn't say when it truncates, so retry with a bigger buffer until the
  // target fits with room to spare, up to 1 MiB.
  readlink(name: string): string {
    leaf(name);
    const fd = this.descriptor();
    for (let size = 256; size <= 1_048_576; size *= 2) {
      const buffer = Buffer.alloc(size);
      const read = Number(invoke('readlinkat', [fd, name, buffer, BigInt(size)], name));
      if (read < size) return buffer.toString('utf8', 0, read);
    }
    throw new Error('symbolic link target is too long');
  }

  // The target is stored as given and never resolved here.
  symlink(target: string, name: string): void {
    leaf(name);
    if (target.includes('\0')) throw new Error('invalid symbolic link target');
    invoke('symlinkat', [target, this.descriptor(), name], name);
  }

  // Without replace, renameat2 with RENAME_NOREPLACE (1) on Linux, or renameatx_np with RENAME_EXCL (4) on
  // Darwin. Filesystems that can't check atomically fail with EINVAL or ENOTSUP, and a libc without the call
  // fails with ENOSYS.
  rename(name: string, destination: RootDirectory, destinationName: string, replace = true): void {
    leaf(name);
    leaf(destinationName);
    if (!(destination instanceof PosixDirectory)) throw new Error('incompatible native directory');
    if (replace) {
      invoke('renameat', [this.descriptor(), name, destination.descriptor(), destinationName], name);
      return;
    }
    try {
      ensure('renameNoReplace');
    } catch {
      throw systemError(ENOSYS, 'rename', name);
    }
    invoke(
      'renameNoReplace',
      [this.descriptor(), name, destination.descriptor(), destinationName, darwin ? 4 : 1],
      name,
    );
  }

  // linkat with no flags, so a final link is linked as itself rather than followed.
  link(name: string, destination: RootDirectory, destinationName: string): void {
    leaf(name);
    leaf(destinationName);
    if (!(destination instanceof PosixDirectory)) throw new Error('incompatible native directory');
    ensure('linkat');
    invoke('linkat', [this.descriptor(), name, destination.descriptor(), destinationName, 0], name);
  }

  remove(name: string, directory = false): void {
    leaf(name);
    invoke('unlinkat', [this.descriptor(), name, directory ? AT_REMOVEDIR : 0], name);
  }

  // fdopendir takes over the descriptor it's given, so it gets a fresh one for this folder, and reading never
  // moves this handle. A struct dirent has d_type at 18 and a NUL-terminated d_name at 19 on Linux; Darwin's has
  // d_namlen at 18, d_type at 20 and d_name at 21. An unknown type (0) is looked up without following links.
  list(): RootEntry[] {
    const fd = this.descriptor();
    for (const name of ['fdopendir', 'readdir', 'closedir']) ensure(name);
    const api = bindings();
    const ffi = loadFFI();
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC | constants.O_NONBLOCK;
    const copy = Number(invoke('openat', [fd, '.', flags, 0], '.'));
    const dir = api.calls.fdopendir(copy) as bigint;
    if (!dir) {
      const errno = api.errno();
      invoke('close', [copy]);
      throw systemError(errno, 'fdopendir');
    }
    const entries: RootEntry[] = [];
    try {
      for (;;) {
        // readdir returns NULL both at the end and on an error, and only an error sets errno.
        api.clearErrno();
        const entry = api.calls.readdir(dir) as bigint;
        if (!entry) {
          const errno = api.errno();
          if (errno) throw systemError(errno, 'readdir');
          break;
        }
        const name = darwin
          ? ffi.toBuffer(entry + 21n, ffi.getUint16(entry, 18)).toString()
          : ffi.toString(entry + 19n);
        if (name === '.' || name === '..') continue;
        const type = ffi.getUint8(entry, darwin ? 20 : 18);
        let kind: RootEntry['kind'] = type === 8 ? 'file' : type === 4 ? 'directory' : type === 10 ? 'link' : 'other';
        if (!type) {
          const info = stat(fd, name);
          kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'other';
        }
        entries.push({ name, kind });
      }
    } finally {
      api.calls.closedir(dir);
    }
    return entries;
  }

  // fstatvfs on Linux: f_bsize at 0, f_frsize at 8, f_blocks, f_bfree and f_bavail at 16, 24 and 32, and f_flag
  // at 72. Darwin's fstatfs: f_bsize (32 bits) at 0, f_blocks, f_bfree and f_bavail at 8, 16 and 24, and f_flags
  // (32 bits) at 64. Read-only is ST_RDONLY or MNT_RDONLY, both 1.
  space(): RootSpace {
    ensure('space');
    const data = Buffer.alloc(darwin ? 2168 : 112);
    invoke('space', [this.descriptor(), data]);
    const unit = darwin ? BigInt(data.readUInt32LE(0)) : data.readBigUInt64LE(8) || data.readBigUInt64LE(0);
    const at = darwin ? 8 : 16;
    const bytes = (offset: number) => {
      const value = data.readBigUInt64LE(offset) * unit;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw systemError(darwin ? 84 : 75, 'statfs');
      return Number(value);
    };
    const flags = darwin ? data.readUInt32LE(64) : Number(data.readBigUInt64LE(72) & 0xffffffffn);
    return { total: bytes(at), free: bytes(at + 8), available: bytes(at + 16), readOnly: (flags & 1) === 1 };
  }
}

// This is the only path-based open, of an absolute folder relative to AT_FDCWD. Frost only
// passes volume roots here and walks down from them.
export const posixBackend: RootBackend = {
  openRoot(name: string): RootDirectory {
    if (!isAbsolute(name) || name.includes('\0')) throw new Error('native root requires an absolute path');
    return open(AT_FDCWD, name, constants.O_RDONLY | constants.O_DIRECTORY, 0o777, true) as PosixDirectory;
  },
};
