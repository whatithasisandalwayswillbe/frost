// Shared types for the native filesystem backends. Every operation on a RootDirectory takes a
// single name relative to that retained handle, so nothing below it is resolved by path.

export interface RootStat {
  dev: bigint;
  ino: bigint;
  size: number;
  mode: number;
  uid: number;
  nlink: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface RootOpenOptions {
  read?: boolean;
  write?: boolean;
  create?: boolean;
  exclusive?: boolean;
  append?: boolean;
  truncate?: boolean;
  mode?: number;
}

export interface RootFile {
  stat(): RootStat;
  read(buffer: Buffer, offset: number, length: number, position: number): { bytesRead: number };
  write(buffer: Buffer, offset: number, length: number, position: number | null): { bytesWritten: number };
  writeFile(data: string | Buffer): void;
  truncate(length: number): void;
  sync(): void;
  chmod(mode: number): void;
  utimes(accessNs: bigint, modifiedNs: bigint): void;
  // Takes a non-blocking exclusive OS lock that lasts until close. Without strict, a lock held
  // elsewhere or a closed file still throws, but other lock failures are ignored.
  lock(strict?: boolean): void;
  close(): void;
}

// One folder entry and what it is, as the folder reports it. A link is never followed.
export interface RootEntry {
  name: string;
  kind: 'file' | 'directory' | 'link' | 'other';
}

// The size and free space of the volume holding a folder, in bytes. available is what this account
// may still use.
export interface RootSpace {
  total: number;
  free: number;
  available: number;
  readOnly: boolean;
}

export interface RootDirectory extends RootFile {
  open(name: string, options: RootOpenOptions): RootFile;
  openDirectory(name: string, options?: { create?: boolean; exclusive?: boolean; mode?: number }): RootDirectory;
  lstat(name: string): RootStat;
  readlink(name: string): string;
  symlink(target: string, name: string, directory?: boolean): void;
  // Without replace, an existing destination fails with EEXIST, checked atomically by the filesystem. A
  // filesystem that can't do that fails with EINVAL, ENOSYS or ENOTSUP.
  rename(name: string, destination: RootDirectory, destinationName: string, replace?: boolean): void;
  // Adds a hard link. An existing destination fails with EEXIST.
  link(name: string, destination: RootDirectory, destinationName: string): void;
  remove(name: string, directory?: boolean): void;
  // The entries other than . and .., in no particular order.
  list(): RootEntry[];
  space(): RootSpace;
}

export interface RootBackend {
  openRoot(name: string): RootDirectory;
}

// Rejects anything that isn't a single plain name: empty, dot entries, separators and NUL,
// plus drive and stream colons and wildcard characters on Windows.
export function leaf(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\0]/u.test(name) ||
    (process.platform === 'win32' && /[\\:?*<>|]/u.test(name))
  ) {
    throw new Error('unsafe filesystem component');
  }
}

export function sameFile(a: RootStat, b: RootStat): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
