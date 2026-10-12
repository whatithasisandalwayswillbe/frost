// Confined filesystem access through retained directory handles. openRoot walks a path one
// component at a time from the volume root, and later operations resolve against the handle.
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RootBackend, RootDirectory, RootFile, RootStat } from './fs-root-types.js';
export type { RootDirectory, RootFile, RootStat, RootOpenOptions } from './fs-root-types.js';
export { sameFile } from './fs-root-types.js';

let loaded: Promise<RootBackend> | undefined;
let native: RootBackend | undefined;
const require = createRequire(import.meta.url);

// Both backends are synchronous modules. Node 26 loads their ESM exports through require without
// starting an asynchronous path walk or changing which native bindings enforce confinement.
function backendSync(): RootBackend {
  return (native ??=
    process.platform === 'win32'
      ? require('./fs-root-windows.js').windowsBackend
      : require('./fs-root-posix.js').posixBackend);
}

// Loads the platform's native backend once. Loading the Windows backend binds its DLLs.
export function backend(): Promise<RootBackend> {
  return (loaded ??= Promise.resolve().then(backendSync));
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

// lstat that returns undefined for a missing entry.
export function existing(root: RootDirectory, name: string): RootStat | undefined {
  try {
    return root.lstat(name);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return undefined;
  }
}

// Reads a whole file in 64 KiB chunks. Hitting max exactly is fine; a longer file throws.
export function readAll(file: RootFile, max = Number.MAX_SAFE_INTEGER): Buffer {
  const buffers: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, max - offset));
    if (!buffer.length) {
      if (file.stat().size > max) throw new Error('file exceeds read limit');
      break;
    }
    const count = file.read(buffer, 0, buffer.length, offset).bytesRead;
    if (!count) break;
    buffers.push(buffer.subarray(0, count));
    offset += count;
  }
  return Buffer.concat(buffers, offset);
}

// A link may be followed only when the link and its parent belong to root or the current user,
// and the parent isn't writable by group or others. Sticky folders like /tmp are the exception.
export function trustedAncestorLink(
  link: Pick<RootStat, 'uid'>,
  parent: Pick<RootStat, 'uid' | 'mode'>,
  uid: number | undefined,
): boolean {
  if ((link.uid !== 0 && link.uid !== uid) || (parent.uid !== 0 && parent.uid !== uid)) return false;
  return !(parent.mode & 0o022) || !!(parent.mode & 0o1000);
}

// Opens an absolute folder as a retained handle, optionally creating missing folders.
// Windows refuses every link on the way. POSIX follows trusted ancestor links, and the final
// component only with trustedFinalLink. A link restarts the walk at its target's volume root.
export async function openRoot(
  name: string,
  options: { create?: boolean; mode?: number; trustedFinalLink?: boolean } = {},
): Promise<RootDirectory> {
  return openRootWith(await backend(), name, options);
}

// The same native walk for synchronous callers, such as the game's small saved preferences.
export function openRootSync(
  name: string,
  options: { create?: boolean; mode?: number; trustedFinalLink?: boolean } = {},
): RootDirectory {
  return openRootWith(backendSync(), name, options);
}

function openRootWith(
  native: RootBackend,
  name: string,
  options: { create?: boolean; mode?: number; trustedFinalLink?: boolean },
): RootDirectory {
  let absolute = path.resolve(name);
  let volume = path.parse(absolute).root;
  let currentPath = volume;
  let parts = absolute.slice(volume.length).split(path.sep).filter(Boolean);
  let links = 0;
  let root = native.openRoot(volume);

  try {
    while (parts.length) {
      const component = parts.shift()!;
      if (component === '.' || component === '..') throw new Error('unsafe filesystem component');
      const stat = existing(root, component);

      if (stat?.isSymbolicLink()) {
        if (process.platform === 'win32' || (!parts.length && !options.trustedFinalLink))
          throw new Error(name + ' goes through a link');
        const parent = root.stat();
        const self = process.getuid?.();
        if (!trustedAncestorLink(stat, parent, self))
          throw new Error(path.join(currentPath, component) + ' is a link in an untrusted folder');
        if (++links > 40) throw new Error('too many links in ' + name);

        // Splice the resolved target in front of the remaining components and start over.
        const target = root.readlink(component);
        absolute = path.resolve(currentPath, target);
        volume = path.parse(absolute).root;
        parts = [...absolute.slice(volume.length).split(path.sep).filter(Boolean), ...parts];
        root.close();
        root = native.openRoot(volume);
        currentPath = volume;
        continue;
      }

      if (stat && !stat.isDirectory()) throw new Error(path.join(currentPath, component) + " isn't a folder");
      const next = root.openDirectory(component, { create: options.create, mode: options.mode ?? 0o755 });
      root.close();
      root = next;
      currentPath = path.join(currentPath, component);
    }
    return root;
  } catch (error) {
    root.close();
    throw error;
  }
}

// Opens a relative restore folder below root without following any link. Returns root itself
// when relative is empty, so callers must not close the result if it's root.
export function directory(
  root: RootDirectory,
  relative: string,
  options: { create?: boolean; mode?: number } = {},
): RootDirectory {
  if (path.isAbsolute(relative)) throw new Error('restore path escapes the target');
  const parts = relative.split(process.platform === 'win32' ? /[\\/]/u : /\//u).filter(value => value && value !== '.');
  if (parts.some(value => value === '..')) throw new Error('restore path escapes the target');
  if (!parts.length) return root;

  let current = root;
  try {
    for (const part of parts) {
      let next: RootDirectory;
      try {
        next = current.openDirectory(part, { create: options.create, mode: options.mode ?? 0o755 });
      } catch (error) {
        // The backends report a link or a file in the way as ELOOP or ENOTDIR.
        if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw new Error(`restore parent ${JSON.stringify(part)} isn't a real directory`, { cause: error });
        throw error;
      }
      if (current !== root) current.close();
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== root) current.close();
    throw error;
  }
}
