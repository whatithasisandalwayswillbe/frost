// Native filesystem backend for Windows on x64 and arm64. Every open below a root goes through
// NtCreateFile relative to a retained parent handle and opens reparse points as themselves
// instead of following them. Importing this module binds ntdll, kernel32 and advapi32.
import path from 'node:path';
import { loadFFI, type FFIType } from './ffi-loader.js';
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

// The struct offsets below assume a 64-bit Windows ABI.
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('unsupported Windows filesystem ABI');

const ffi = loadFFI();
type Arg = number | bigint | Buffer | null;
type Call = (...args: Arg[]) => number | bigint;
const definition = (returns: FFIType, ...args: FFIType[]) => ({ return: returns, arguments: args });

// ntdll handles handle-relative opens, renames and deletes.
const nt = ffi.dlopen('ntdll.dll', {
  NtCreateFile: definition(
    'uint32',
    'pointer',
    'uint32',
    'pointer',
    'pointer',
    'pointer',
    'uint32',
    'uint32',
    'uint32',
    'uint32',
    'pointer',
    'uint32',
  ),
  NtSetInformationFile: definition('uint32', 'pointer', 'pointer', 'pointer', 'uint32', 'uint32'),
  NtQueryDirectoryFile: definition(
    'uint32',
    'pointer',
    'pointer',
    'pointer',
    'pointer',
    'pointer',
    'pointer',
    'uint32',
    'uint32',
    'uint8',
    'pointer',
    'uint8',
  ),
  NtQueryVolumeInformationFile: definition('uint32', 'pointer', 'pointer', 'pointer', 'uint32', 'uint32'),
  NtClose: definition('uint32', 'pointer'),
  RtlNtStatusToDosError: definition('uint32', 'uint32'),
}).functions as Record<string, Call>;

// kernel32 handles metadata, I/O, reparse data, locks and error text.
const win = ffi.dlopen('kernel32.dll', {
  CreateFileW: definition('pointer', 'pointer', 'uint32', 'uint32', 'pointer', 'uint32', 'uint32', 'pointer'),
  GetFileInformationByHandle: definition('int32', 'pointer', 'pointer'),
  GetFileInformationByHandleEx: definition('int32', 'pointer', 'uint32', 'pointer', 'uint32'),
  SetFileInformationByHandle: definition('int32', 'pointer', 'uint32', 'pointer', 'uint32'),
  ReadFile: definition('int32', 'pointer', 'pointer', 'uint32', 'pointer', 'pointer'),
  WriteFile: definition('int32', 'pointer', 'pointer', 'uint32', 'pointer', 'pointer'),
  SetFilePointerEx: definition('int32', 'pointer', 'int64', 'pointer', 'uint32'),
  FlushFileBuffers: definition('int32', 'pointer'),
  DeviceIoControl: definition(
    'int32',
    'pointer',
    'uint32',
    'pointer',
    'uint32',
    'pointer',
    'uint32',
    'pointer',
    'pointer',
  ),
  LockFileEx: definition('int32', 'pointer', 'uint32', 'uint32', 'uint32', 'uint32', 'pointer'),
  GetLastError: definition('uint32'),
  FormatMessageW: definition('uint32', 'uint32', 'pointer', 'uint32', 'uint32', 'pointer', 'uint32', 'pointer'),
  GetCurrentThread: definition('pointer'),
}).functions as Record<string, Call>;

// advapi32 enables the symlink privilege on a per-thread token.
const security = ffi.dlopen('advapi32.dll', {
  ImpersonateSelf: definition('int32', 'uint32'),
  RevertToSelf: definition('int32'),
  OpenThreadToken: definition('int32', 'pointer', 'uint32', 'int32', 'pointer'),
  LookupPrivilegeValueW: definition('int32', 'pointer', 'pointer', 'pointer'),
  AdjustTokenPrivileges: definition('int32', 'pointer', 'int32', 'pointer', 'uint32', 'pointer', 'pointer'),
}).functions as Record<string, Call>;

// CreateFileW returns INVALID_HANDLE_VALUE on failure.
const invalid = 0xffffffffffffffffn;

// Access rights: SYNCHRONIZE, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES and DELETE.
const syncAccess = 0x100000;
const readAttributes = 0x80;
const writeAttributes = 0x100;
const deleteAccess = 0x10000;

// FILE_ATTRIBUTE_REPARSE_POINT and FILE_ATTRIBUTE_DIRECTORY.
const reparse = 0x400;
const directoryAttribute = 0x10;

// FILETIME counts 100 ns ticks from 1601. This is 1970 in those ticks.
const epoch = 116444736000000000n;

// Raw pointers to some buffers are written into other native structs, where the GC can't see
// them. Holding the buffers here keeps them alive until the call that uses them returns.
const nativeMemory = new Set<Buffer[]>();

const asNumber = (value: number | bigint): number => Number(value);

// Builds an error from a Win32 error code, with the system's message and the errno name the
// rest of Frost checks for. Codes without a mapping become EIO.
function error(value: number): Error & { code: string; errno: number } {
  const code: Record<number, string> = {
    2: 'ENOENT',
    3: 'ENOENT',
    5: 'EACCES',
    6: 'EBADF',
    32: 'EBUSY',
    33: 'EBUSY',
    80: 'EEXIST',
    87: 'EINVAL',
    112: 'ENOSPC',
    145: 'ENOTEMPTY',
    183: 'EEXIST',
    206: 'ENAMETOOLONG',
    267: 'ENOTDIR',
    4390: 'EINVAL',
    4392: 'ELOOP',
    1920: 'ELOOP',
    1314: 'EPERM',
  };

  // FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, into 2048 UTF-16 units.
  const text = Buffer.alloc(4096);
  const count = asNumber(win.FormatMessageW(0x1200, null, value, 0, text, 2048, null));
  const message = count
    ? text
        .subarray(0, count * 2)
        .toString('utf16le')
        .trim()
    : `Windows error ${value}`;
  return Object.assign(new Error(message), { code: code[value] ?? 'EIO', errno: value });
}

// NTSTATUS errors and warnings both have the top bit set, and either one fails here.
function requireNT(status: number): void {
  if (status & 0x80000000) throw error(asNumber(nt.RtlNtStatusToDosError(status)));
}

function requireWin(success: number | bigint): void {
  if (!success) throw error(asNumber(win.GetLastError()));
}

// A buffer's raw address, checked against the alignment its native struct needs.
function checkedPointer(buffer: Buffer, alignment: number): bigint {
  const pointer = ffi.getRawPointer(buffer);
  if (pointer % BigInt(alignment)) throw new Error('unaligned filesystem structure');
  return pointer;
}

// NUL-terminated UTF-16. An embedded NUL would silently cut the name short.
function wide(value: string): Buffer {
  if (value.includes('\0')) throw Object.assign(new Error('invalid filename'), { code: 'EINVAL' });
  return Buffer.from(value + '\0', 'utf16le');
}

// NtCreateFile for one leaf name relative to the parent handle, returning the new handle.
// With reopen and an empty name it opens the parent itself again. share defaults to
// FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE (7).
function create(
  parent: bigint,
  name: string,
  access: number,
  disposition: number,
  options: number,
  mode: number,
  share = 7,
  reopen = false,
): bigint {
  if (!(reopen && name === '')) leaf(name);
  const filename = wide(name);
  const unicode = Buffer.alloc(16);
  const object = Buffer.alloc(48);
  const result = Buffer.alloc(8);
  const iosb = Buffer.alloc(16);
  if (filename.length > 0xfffe) throw Object.assign(new Error('filename is too long'), { code: 'ENAMETOOLONG' });
  const buffers = [filename, unicode, object, result, iosb];
  nativeMemory.add(buffers);
  try {
    // UNICODE_STRING: Length and MaximumLength in bytes (Length without the NUL), then the
    // buffer pointer at 8.
    unicode.writeUInt16LE(filename.length - 2);
    unicode.writeUInt16LE(filename.length, 2);
    unicode.writeBigUInt64LE(checkedPointer(filename, 2), 8);

    // OBJECT_ATTRIBUTES: Length, RootDirectory at 8, ObjectName at 16, and Attributes at 24 set
    // to OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE (0x1040).
    object.writeUInt32LE(48);
    object.writeBigUInt64LE(parent, 8);
    object.writeBigUInt64LE(checkedPointer(unicode, 8), 16);
    object.writeUInt32LE(0x1040, 24);
    for (const b of [object, result, iosb]) checkedPointer(b, 8);

    // A new file gets FILE_ATTRIBUTE_NORMAL, or READONLY when mode lacks owner write. 0x204020
    // adds FILE_OPEN_REPARSE_POINT, FILE_OPEN_FOR_BACKUP_INTENT and FILE_SYNCHRONOUS_IO_NONALERT.
    const status = asNumber(
      nt.NtCreateFile(
        result,
        syncAccess | access,
        object,
        iosb,
        null,
        mode & 0o200 ? 0x80 : 1,
        share,
        disposition,
        0x204020 | options,
        null,
        0,
      ),
    );
    requireNT(status);
    const handle = result.readBigUInt64LE(0);
    if (!handle || handle === invalid) throw new Error('invalid filesystem handle');
    return handle;
  } finally {
    nativeMemory.delete(buffers);
  }
}

// Stats an open handle and returns a POSIX-style result. uid is always 0.
function nativeStat(handle: bigint): RootStat {
  // BY_HANDLE_FILE_INFORMATION: attributes at 0, last write time at 20, volume serial at 28,
  // size high and low at 32 and 36, link count at 40, file index high and low at 44 and 48.
  const info = Buffer.alloc(52);
  requireWin(win.GetFileInformationByHandle(handle, info));
  // FileBasicInfo (0) supplies ChangeTime, which changes with contents or metadata. CreationTime
  // isn't a substitute: it stays fixed when a same-sized file is rewritten and its mtime reset.
  const basic = Buffer.alloc(40);
  requireWin(win.GetFileInformationByHandleEx(handle, 0, basic, basic.length));
  const attributes = info.readUInt32LE(0);
  const exactSize = (BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36));
  if (exactSize > BigInt(Number.MAX_SAFE_INTEGER))
    throw Object.assign(new Error('file is too large'), { code: 'EOVERFLOW' });
  let dev = BigInt(info.readUInt32LE(28));
  let ino = (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48));

  // FileIdInfo (18) gives a 64-bit volume serial and a 128-bit file ID where the filesystem
  // supports it. Otherwise the 32-bit serial and 64-bit index above stand.
  const id = Buffer.alloc(24);
  if (win.GetFileInformationByHandleEx(handle, 18, id, id.length)) {
    dev = id.readBigUInt64LE(0);
    ino = id.readBigUInt64LE(8) | (id.readBigUInt64LE(16) << 64n);
  }

  // Any reparse point counts as a link. The read-only attribute drops the write bits.
  const isLink = !!(attributes & reparse);
  const isDir = !!(attributes & directoryAttribute);
  const mode =
    (isLink ? 0o120000 : isDir ? 0o40000 : 0o100000) |
    (attributes & 1 ? (isDir ? 0o555 : 0o444) : isDir ? 0o777 : 0o666);
  return {
    dev,
    ino,
    size: Number(exactSize),
    mode,
    uid: 0,
    nlink: info.readUInt32LE(40),
    mtimeNs: (info.readBigUInt64LE(20) - epoch) * 100n,
    ctimeNs: (basic.readBigInt64LE(24) - epoch) * 100n,
    isFile: () => !isDir && !isLink,
    isDirectory: () => isDir && !isLink,
    isSymbolicLink: () => isLink,
  };
}

// Refuses a reparse point with ELOOP. directory true or false also demands that type.
function noLink(handle: bigint, directory?: boolean): void {
  const stat = nativeStat(handle);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
  if (directory === true && !stat.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
  if (directory === false && !stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
}

// create plus noLink. The handle is closed again unless it's a plain entry of the right type.
function opened(
  parent: bigint,
  name: string,
  access: number,
  disposition: number,
  options: number,
  mode: number,
  dir?: boolean,
  share = 7,
): bigint {
  const handle = create(parent, name, access, disposition, options, mode, share);
  try {
    noLink(handle, dir);
    return handle;
  } catch (err) {
    nt.NtClose(handle);
    throw err;
  }
}

// A retained file handle. An append handle has FILE_APPEND_DATA instead of FILE_WRITE_DATA,
// so the system puts every write at the end.
class WindowsFile implements RootFile {
  protected value: bigint;
  private lockMemory: Buffer | undefined;
  private locked = false;

  constructor(
    handle: bigint,
    private append = false,
  ) {
    this.value = handle;
  }

  // A closed handle fails with ERROR_INVALID_HANDLE (6), mapped to EBADF.
  protected get handle(): bigint {
    if (!this.value) throw error(6);
    return this.value;
  }

  stat(): RootStat {
    return nativeStat(this.handle);
  }

  // Handles are synchronous, so ReadFile and WriteFile use the pointer set here (FILE_BEGIN).
  private position(position: number): void {
    if (!Number.isSafeInteger(position) || position < 0)
      throw Object.assign(new Error('invalid file offset'), { code: 'EINVAL' });
    requireWin(win.SetFilePointerEx(this.handle, BigInt(position), null, 0));
  }

  // ERROR_HANDLE_EOF (38) counts as zero bytes read, like a plain end of file.
  read(buffer: Buffer, offset: number, length: number, position: number): { bytesRead: number } {
    if (
      !Buffer.isBuffer(buffer) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.length ||
      length > 0xffffffff ||
      buffer.buffer instanceof SharedArrayBuffer ||
      (buffer.buffer as ArrayBuffer).resizable
    )
      throw new RangeError('invalid read buffer');
    this.position(position);
    const count = Buffer.alloc(4);
    const success = win.ReadFile(this.handle, buffer.subarray(offset, offset + length), length, count, null);
    if (!success) {
      const code = asNumber(win.GetLastError());
      if (code !== 38) throw error(code);
    }
    return { bytesRead: count.readUInt32LE(0) };
  }

  // A null position writes at the current pointer. Append handles skip the seek.
  write(buffer: Buffer, offset: number, length: number, position: number | null): { bytesWritten: number } {
    if (
      !Buffer.isBuffer(buffer) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.length ||
      length > 0xffffffff ||
      buffer.buffer instanceof SharedArrayBuffer ||
      (buffer.buffer as ArrayBuffer).resizable
    )
      throw new RangeError('invalid write buffer');
    if (position !== null) {
      if (!Number.isSafeInteger(position) || position < 0)
        throw Object.assign(new Error('invalid file offset'), { code: 'EINVAL' });
      if (!this.append) this.position(position);
    }
    const count = Buffer.alloc(4);
    requireWin(win.WriteFile(this.handle, buffer.subarray(offset, offset + length), length, count, null));
    return { bytesWritten: count.readUInt32LE(0) };
  }

  // Writes everything from offset 0, or at the end for an append handle.
  writeFile(data: string | Buffer): void {
    this.handle; // Throws if the file is closed.
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      const n = this.write(bytes, offset, bytes.length - offset, this.append ? null : offset).bytesWritten;
      if (!n) throw new Error('filesystem write made no progress');
      offset += n;
    }
  }

  // FileEndOfFileInfo (6) sets the file size.
  truncate(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0)
      throw Object.assign(new Error('invalid file size'), { code: 'EINVAL' });
    const info = Buffer.alloc(8);
    info.writeBigInt64LE(BigInt(length));
    requireWin(win.SetFileInformationByHandle(this.handle, 6, info, info.length));
  }

  sync(): void {
    requireWin(win.FlushFileBuffers(this.handle));
  }

  // Attribute changes use a second handle reopened from this one with read and write attribute
  // access, since this handle may not have FILE_WRITE_ATTRIBUTES.
  private metadata(fn: (handle: bigint) => void): void {
    const handle = create(this.handle, '', readAttributes | writeAttributes, 1, 0, 0o600, 7, true);
    try {
      fn(handle);
    } finally {
      requireNT(asNumber(nt.NtClose(handle)));
    }
  }

  // Only owner write maps to Windows, as the read-only attribute. In FILE_BASIC_INFO (class 0)
  // zero times and zero attributes mean "no change", so FILE_ATTRIBUTE_NORMAL (0x80) stands in.
  chmod(mode: number): void {
    this.metadata(handle => {
      const old = Buffer.alloc(52);
      requireWin(win.GetFileInformationByHandle(handle, old));
      const attributes = mode & 0o200 ? old.readUInt32LE(0) & ~1 : old.readUInt32LE(0) | 1;
      const info = Buffer.alloc(40);
      info.writeUInt32LE(attributes || 0x80, 32);
      requireWin(win.SetFileInformationByHandle(handle, 0, info, info.length));
    });
  }

  // Sets LastAccessTime (8) and LastWriteTime (16) in FILE_BASIC_INFO, in 100 ns ticks.
  utimes(accessNs: bigint, modifiedNs: bigint): void {
    this.metadata(handle => {
      const info = Buffer.alloc(40);
      const a = accessNs / 100n + epoch;
      const m = modifiedNs / 100n + epoch;
      if (a < 0n || m < 0n || a > 0x7fffffffffffffffn || m > 0x7fffffffffffffffn)
        throw Object.assign(new Error('invalid file time'), { code: 'EINVAL' });
      info.writeBigInt64LE(a, 8);
      info.writeBigInt64LE(m, 16);
      requireWin(win.SetFileInformationByHandle(handle, 0, info, info.length));
    });
  }

  // LockFileEx on the first byte with LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK (3).
  // ERROR_LOCK_VIOLATION (33) means another handle holds it and always throws EBUSY. Other
  // failures only throw when strict. The zeroed OVERLAPPED (offset 0) stays referenced until close.
  lock(strict = false): void {
    this.handle;
    if (this.locked) return;
    const memory = Buffer.alloc(32);
    this.lockMemory = memory;
    if (!win.LockFileEx(this.handle, 3, 0, 1, 0, memory)) {
      const code = asNumber(win.GetLastError());
      if (code === 33) throw Object.assign(new Error('another restore is using it'), { code: 'EBUSY', errno: code });
      if (strict) throw error(code);
    } else this.locked = true;
  }

  // Closing the handle also releases its lock.
  close(): void {
    if (this.value) {
      const handle = this.value;
      this.value = 0n;
      requireNT(asNumber(nt.NtClose(handle)));
      this.lockMemory = undefined;
    }
  }
}

// A retained directory handle. NtCreateFile's dispositions here are FILE_OPEN (1), FILE_CREATE (2)
// and FILE_OPEN_IF (3). Every name goes through leaf() inside create.
class WindowsDirectory extends WindowsFile implements RootDirectory {
  // Readers get FILE_READ_DATA (1). Writers get FILE_WRITE_DATA (2), or FILE_APPEND_DATA (4) for
  // append, plus FILE_WRITE_ATTRIBUTES. FILE_NON_DIRECTORY_FILE (0x40) refuses folders.
  open(name: string, options: RootOpenOptions): RootFile {
    let access = readAttributes | (options.read ? 1 : 0) | (options.write ? (options.append ? 4 : 2) : 0);
    if (options.write) access |= writeAttributes;
    const disposition = options.create ? (options.exclusive ? 2 : 3) : 1;
    const handle = opened(this.handle, name, access, disposition, 0x40, options.mode ?? 0o600, false);
    const file = new WindowsFile(handle, options.append);
    try {
      if (options.truncate) file.truncate(0);
      return file;
    } catch (err) {
      file.close();
      throw err;
    }
  }

  // FILE_LIST_DIRECTORY (1) with FILE_DIRECTORY_FILE (1).
  openDirectory(name: string, options: { create?: boolean; exclusive?: boolean; mode?: number } = {}): RootDirectory {
    return new WindowsDirectory(
      opened(
        this.handle,
        name,
        1 | readAttributes,
        options.create ? (options.exclusive ? 2 : 3) : 1,
        1,
        options.mode ?? 0o755,
        true,
      ),
    );
  }

  // Opens an entry as itself, links included, with no type check. lstat, readlink, rename and
  // remove use it.
  private raw(name: string, access = readAttributes, directory = false, exclusive = false): WindowsFile {
    return new WindowsFile(
      create(this.handle, name, access, exclusive ? 2 : 1, directory ? 1 : 0, 0o600, exclusive ? 0 : 7),
    );
  }

  lstat(name: string): RootStat {
    const file = this.raw(name);
    try {
      return file.stat();
    } finally {
      file.close();
    }
  }

  // FSCTL_GET_REPARSE_POINT (0x900a8) returns a REPARSE_DATA_BUFFER. Symlinks (0xa000000c) have
  // a Flags field, so their path buffer starts at 20; junctions (0xa0000003) start at 16. Anything
  // else fails as ERROR_NOT_A_REPARSE_POINT (4390), which maps to EINVAL like readlink on POSIX.
  readlink(name: string): string {
    const file = this.raw(name);
    const output = Buffer.alloc(16 * 1024);
    const returned = Buffer.alloc(4);
    try {
      requireWin(win.DeviceIoControl(file['handle'], 0x900a8, null, 0, output, output.length, returned, null));
      const tag = output.readUInt32LE(0);
      const length = returned.readUInt32LE(0);
      if (length < 16 || length > output.length || ![0xa000000c, 0xa0000003].includes(tag)) throw error(4390);

      // Read the substitute name and drop its NT prefix: \??\C:\x becomes C:\x and
      // \??\UNC\server\share becomes \\server\share.
      const start = tag === 0xa000000c ? 20 : 16;
      const offset = output.readUInt16LE(8);
      const size = output.readUInt16LE(10);
      if (offset % 2 || size % 2 || start + offset + size > length) throw new Error('invalid reparse data');
      let target = output.subarray(start + offset, start + offset + size).toString('utf16le');
      if (target.startsWith('\\??\\UNC\\')) target = '\\\\' + target.slice(8);
      else if (target.startsWith('\\??\\')) target = target.slice(4);
      return target;
    } finally {
      file.close();
    }
  }

  // Windows links are created as either file or folder links. This resolves a relative target
  // from this folder, following relative links, and reports whether it names a folder. Absolute
  // links, escaping above this folder, too many links and any error all count as no.
  private directoryLinkTarget(target: string): boolean {
    const parents: WindowsDirectory[] = [this];
    const parts = target.split(/[\\/]/u);
    let links = 0;
    try {
      while (parts.length) {
        const part = parts.shift()!;
        if (!part || part === '.') continue;
        if (part === '..') {
          if (parents.length === 1) return false;
          parents.pop()!.close();
          continue;
        }
        const parent = parents[parents.length - 1];
        const info = parent.lstat(part);
        if (info.isSymbolicLink()) {
          if (++links > 40) return false;
          const next = parent.readlink(part);
          if (path.win32.parse(next).root) return false;
          parts.unshift(...next.split(/[\\/]/u));
          continue;
        }
        parents.push(parent.openDirectory(part) as WindowsDirectory);
      }
      return true;
    } catch {
      return false;
    } finally {
      // parents[0] is this folder, which stays open.
      while (parents.length > 1) parents.pop()!.close();
    }
  }

  // Creates a symlink by writing the reparse data directly. Without an explicit directory flag,
  // a relative target that resolves to a folder makes a folder link.
  symlink(target: string, name: string, directory?: boolean): void {
    leaf(name);
    wide(target);
    if (!target) throw error(87);

    // Drive-relative (C:x) and rooted (\x) targets are resolved to full paths first. Absolute
    // targets get the NT \??\ prefix, with \\server\share stored as \??\UNC\server\share.
    if (path.win32.parse(target).root && !path.win32.isAbsolute(target)) target = path.win32.resolve(target);
    const relative = !/^(?:[a-z]:|\\\\)/iu.test(target);
    directory ??= !path.win32.parse(target).root && this.directoryLinkTarget(target);
    const nativeTarget = relative
      ? target
      : '\\??\\' +
        (target.startsWith('\\\\?\\')
          ? target.slice(4)
          : target.startsWith('\\\\')
            ? 'UNC\\' + target.slice(2)
            : target);

    // REPARSE_DATA_BUFFER for IO_REPARSE_TAG_SYMLINK. ReparseDataLength excludes the 8-byte
    // header. The substitute and print names share one string at offset 0 of the path buffer
    // (lengths at 10 and 14), and Flags at 16 is SYMLINK_FLAG_RELATIVE (1) for relative targets.
    const encoded = Buffer.from(nativeTarget, 'utf16le');
    if (encoded.length > 16 * 1024 - 20) throw error(206);
    const data = Buffer.alloc(20 + encoded.length);
    data.writeUInt32LE(0xa000000c);
    data.writeUInt16LE(data.length - 8, 4);
    data.writeUInt16LE(encoded.length, 10);
    data.writeUInt16LE(encoded.length, 14);
    data.writeUInt32LE(relative ? 1 : 0, 16);
    encoded.copy(data, 20);

    // Creates the entry with FILE_CREATE and no sharing, then sets FSCTL_SET_REPARSE_POINT
    // (0x900a4). If that fails, FileDispositionInformation (13) deletes the empty entry on close.
    const run = () => {
      const handle = create(
        this.handle,
        name,
        readAttributes | writeAttributes | deleteAccess,
        2,
        directory ? 1 : 0x40,
        0o600,
        0,
      );
      const returned = Buffer.alloc(4);
      try {
        if (!win.DeviceIoControl(handle, 0x900a4, data, data.length, null, 0, returned, null)) {
          const reason = error(asNumber(win.GetLastError()));
          const remove = Buffer.from([1]);
          nt.NtSetInformationFile(handle, Buffer.alloc(16), remove, 1, 13);
          throw reason;
        }
      } finally {
        requireNT(asNumber(nt.NtClose(handle)));
      }
    };

    // Enable SeCreateSymbolicLinkPrivilege on a thread impersonation token (SecurityImpersonation,
    // 2), so the process token never changes. If impersonation fails, try with the token as is.
    if (!security.ImpersonateSelf(2)) {
      run();
      return;
    }
    let token = 0n;
    try {
      // TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY (0x28). TOKEN_PRIVILEGES holds one LUID at 4 with
      // SE_PRIVILEGE_ENABLED (2) at 12. If the privilege can't be enabled, the reparse call fails.
      const out = Buffer.alloc(8);
      if (security.OpenThreadToken(win.GetCurrentThread(), 0x28, 0, out)) {
        token = out.readBigUInt64LE(0);
        const privileges = Buffer.alloc(16);
        const luid = Buffer.alloc(8);
        if (security.LookupPrivilegeValueW(null, wide('SeCreateSymbolicLinkPrivilege'), luid)) {
          privileges.writeUInt32LE(1);
          luid.copy(privileges, 4);
          privileges.writeUInt32LE(2, 12);
          security.AdjustTokenPrivileges(token, 0, privileges, 0, null, null);
        }
      }
      run();
    } finally {
      if (token) requireNT(asNumber(nt.NtClose(token)));
      requireWin(security.RevertToSelf());
    }
  }

  // FILE_RENAME_INFORMATION and FILE_LINK_INFORMATION share a layout: flags at 0, RootDirectory at 8,
  // FileNameLength at 16 and FileName at 20. The new name is relative to the destination's handle.
  private nameInfo(destination: RootDirectory, destinationName: string, flags: number): Buffer {
    leaf(destinationName);
    if (!(destination instanceof WindowsDirectory)) throw new Error('incompatible destination directory');
    const encoded = Buffer.from(destinationName, 'utf16le');
    if (encoded.length > 0xfffc) throw error(206);
    const info = Buffer.alloc(24 + encoded.length);
    info.writeUInt32LE(flags);
    info.writeBigUInt64LE(destination.handle, 8);
    info.writeUInt32LE(encoded.length, 16);
    encoded.copy(info, 20);
    return info;
  }

  // FileRenameInformationEx (65) with POSIX_SEMANTICS (2), plus REPLACE_IF_EXISTS (1) when replacing. A system
  // without that class retries as FileRenameInformation (10). When replacing, any failure retries. Without
  // replace, an existing name fails with STATUS_OBJECT_NAME_COLLISION, mapped to EEXIST, and only an unknown
  // class or flag (invalid class, invalid parameter or not supported) retries.
  rename(name: string, destination: RootDirectory, destinationName: string, replace = true): void {
    leaf(name);
    const info = this.nameInfo(destination, destinationName, replace ? 3 : 2);
    const file = this.raw(name, deleteAccess);
    try {
      let status = asNumber(nt.NtSetInformationFile(file['handle'], Buffer.alloc(16), info, info.length, 65));
      if (replace ? status & 0x80000000 : [0xc0000003, 0xc000000d, 0xc00000bb].includes(status)) {
        info.writeUInt32LE(replace ? 1 : 0);
        status = asNumber(nt.NtSetInformationFile(file['handle'], Buffer.alloc(16), info, info.length, 10));
      }
      requireNT(status);
    } finally {
      file.close();
    }
  }

  // FileLinkInformation (11) with ReplaceIfExists clear, so an existing name fails with EEXIST.
  link(name: string, destination: RootDirectory, destinationName: string): void {
    leaf(name);
    const info = this.nameInfo(destination, destinationName, 0);
    const file = this.raw(name, readAttributes | writeAttributes);
    try {
      requireNT(asNumber(nt.NtSetInformationFile(file['handle'], Buffer.alloc(16), info, info.length, 11)));
    } finally {
      file.close();
    }
  }

  // NtQueryDirectoryFile with FileDirectoryInformation (1) on a fresh handle, since the system keeps the scan
  // position on the handle. Each entry has NextEntryOffset at 0, FileAttributes at 56, FileNameLength at 60
  // and the UTF-16 name at 64. STATUS_NO_MORE_FILES, or STATUS_NO_SUCH_FILE for a folder with no entries at
  // all, ends the scan. Any reparse point counts as a link.
  list(): RootEntry[] {
    const scan = create(this.handle, '', 1 | readAttributes, 1, 1, 0o600, 7, true);
    const buffer = Buffer.alloc(64 * 1024);
    checkedPointer(buffer, 8);
    const entries: RootEntry[] = [];
    try {
      for (let first = 1; ; first = 0) {
        const status = asNumber(
          nt.NtQueryDirectoryFile(scan, null, null, null, Buffer.alloc(16), buffer, buffer.length, 1, 0, null, first),
        );
        if (status === 0x80000006 || status === 0xc000000f) break;
        requireNT(status);
        for (let at = 0; ;) {
          const attributes = buffer.readUInt32LE(at + 56);
          const name = buffer.toString('utf16le', at + 64, at + 64 + buffer.readUInt32LE(at + 60));
          if (name !== '.' && name !== '..')
            entries.push({
              name,
              kind: attributes & reparse ? 'link' : attributes & directoryAttribute ? 'directory' : 'file',
            });
          const next = buffer.readUInt32LE(at);
          if (!next) break;
          at += next;
        }
      }
    } finally {
      requireNT(asNumber(nt.NtClose(scan)));
    }
    return entries;
  }

  // FileFsFullSizeInformation (7): total, caller-available and actually free allocation units at 0, 8 and 16,
  // then sectors per unit and bytes per sector at 24 and 28. FileFsAttributeInformation (5) has the volume's
  // flags at 0, where FILE_READ_ONLY_VOLUME is 0x80000.
  space(): RootSpace {
    const size = Buffer.alloc(32);
    requireNT(asNumber(nt.NtQueryVolumeInformationFile(this.handle, Buffer.alloc(16), size, size.length, 7)));
    const unit = BigInt(size.readUInt32LE(24)) * BigInt(size.readUInt32LE(28));
    const bytes = (offset: number) => {
      const value = size.readBigInt64LE(offset) * unit;
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
        throw Object.assign(new Error('volume size is out of range'), { code: 'EOVERFLOW' });
      return Number(value);
    };
    const attributes = Buffer.alloc(512);
    const flagged = asNumber(
      nt.NtQueryVolumeInformationFile(this.handle, Buffer.alloc(16), attributes, attributes.length, 5),
    );
    return {
      total: bytes(0),
      free: bytes(16),
      available: bytes(8),
      readOnly: !(flagged & 0x80000000) && !!(attributes.readUInt32LE(0) & 0x80000),
    };
  }

  // FileDispositionInformationEx (64) with DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE
  // (0x13). When the system rejects that class or its flags (invalid class, invalid parameter or
  // not supported), plain FileDispositionInformation (13) marks the entry for deletion instead.
  remove(name: string, directory = false): void {
    const file = this.raw(name, deleteAccess | readAttributes, directory);
    const info = Buffer.alloc(4);
    info.writeUInt32LE(0x13);
    try {
      let status = asNumber(nt.NtSetInformationFile(file['handle'], Buffer.alloc(16), info, info.length, 64));
      if ([0xc0000003, 0xc000000d, 0xc00000bb].includes(status))
        status = asNumber(nt.NtSetInformationFile(file['handle'], Buffer.alloc(16), Buffer.from([1]), 1, 13));
      requireNT(status);
    } finally {
      file.close();
    }
  }
}

// This is the only path-based open. CreateFileW opens the folder itself with OPEN_EXISTING (3) and
// FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT (0x02200000), then noLink refuses links.
export const windowsBackend: RootBackend = {
  openRoot(name: string): RootDirectory {
    const handle = win.CreateFileW(wide(name), syncAccess | 1 | readAttributes, 7, null, 3, 0x02200000, null) as bigint;
    if (handle === invalid) throw error(asNumber(win.GetLastError()));
    try {
      noLink(handle, true);
      return new WindowsDirectory(handle);
    } catch (err) {
      nt.NtClose(handle);
      throw err;
    }
  },
};
