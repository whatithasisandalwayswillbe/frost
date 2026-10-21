// Restore writes a snapshot's files back in place or into a target folder. Each regular file is written
// to a partial file beside its destination and renamed into place, so restores are atomic per file.
// All filesystem work goes through retained directory handles from fs-root.

import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import path from 'node:path';
import { chunks, newTable } from '../core/chunker.js';
import { parseID } from '../core/crypto.js';
import { safeRel, restoreRel, short, isRoot, timeValue, compare } from '../core/snapshot.js';
import {
  directory,
  existing,
  openRoot,
  readAll,
  sameFile,
  type RootDirectory,
  type RootFile,
  type RootStat,
} from '../platform/fs-root.js';
import { slash } from './exclude.js';
import {
  check,
  code,
  message,
  type EngineLike,
  type File,
  type RestoreOptions,
  type RestoreResult,
  type RestoreProgress,
} from './types.js';

// A new restore folder holds this locked marker until the restore completes.
const marker = '.frost-restore';

// Reading and later reusing a file must refer to the same unchanged contents, including writes whose
// modification time was put back. Access time and permission changes don't establish content equality.
function sameContents(a: RootStat, b: RootStat): boolean {
  return (
    sameFile(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

// The partial file's name depends only on the snapshot and path, so an interrupted restore finds it again.
export const partialName = (id: string, p: string): string =>
  '.frost-partial-' +
  createHash('sha256')
    .update(id + '\0' + p)
    .digest('hex')
    .slice(0, 16);

// Backup skips partial files.
export const isPartial = (name: string): boolean => /^\.frost-partial-[a-f0-9]{16}$/.test(name);

export const restoreFolderName = (id: string): string => 'frost-restore-' + short(id);

// The marker records the snapshot and selection, so only the same restore can resume in that folder.
const markerText = (id: string, include: string[]) =>
  JSON.stringify({ snapshot: id, ...(include.length ? { include: [...include].sort(compare) } : {}) });

// Locks a marker or partial file. If it's already locked, another restore is using it.
function lockFile(file: RootFile): void {
  try {
    file.lock();
  } catch (error) {
    if (['EBUSY', 'EAGAIN', 'EWOULDBLOCK'].includes(code(error) ?? ''))
      throw Object.assign(new Error('another restore is using it', { cause: error }), { code: 'EBUSY' });
    throw error;
  }
}

// Picks the first `frost-restore-<id>` name in `parent` that's either unused or holds a matching marker,
// in which case the restore resumes there.
export async function newRestoreFolder(
  parent: string,
  id: string,
  include: string[] = [],
): Promise<{ dir: string; resume: boolean }> {
  const base = restoreFolderName(id);
  const root = await openRoot(parent, { trustedFinalLink: true });
  try {
    for (let n = 0; n < 10000; n++) {
      const name = base + (n ? '-' + n : '');
      const dir = path.join(parent, name);
      const info = existing(root, name);
      if (!info) return { dir, resume: false };
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      let folder: RootDirectory | undefined;
      let file: RootFile | undefined;
      try {
        folder = root.openDirectory(name);
        const stat = existing(folder, marker);
        if (!stat?.isFile() || stat.isSymbolicLink()) continue;
        file = folder.open(marker, { read: true, write: true });
        lockFile(file);
        if (JSON.stringify(JSON.parse(readAll(file, 1 << 20).toString())) === markerText(id, include))
          return { dir, resume: true };
      } catch {
        // A locked or unreadable marker belongs to another restore, so try the next name.
      } finally {
        file?.close();
        folder?.close();
      }
    }
    throw new Error('no unused restore folder found beside ' + path.join(parent, base));
  } finally {
    root.close();
  }
}

// Picks a restore folder in `base`, the folder that holds the whole selection. A probe folder checks that
// `base` is writable first.
export async function besideFolder(
  base: string,
  id: string,
  include: string[] = [],
): Promise<{ dir: string; resume: boolean }> {
  if (!base) throw new Error('the selected paths span across multiple drive volumes');
  if (isRoot(base)) throw new Error('the selected paths share only the filesystem root directory');
  if (!path.isAbsolute(base))
    throw new Error('the snapshot uses a path format that is incompatible with this operating system');
  let root: RootDirectory;
  try {
    root = await openRoot(base, { trustedFinalLink: true });
  } catch {
    throw new Error(base + " isn't on this computer");
  }
  const name = '.frost-probe-' + randomUUID();
  try {
    const probe = root.openDirectory(name, { create: true, exclusive: true, mode: 0o700 });
    probe.close();
    root.remove(name, true);
  } catch {
    throw new Error("can't write to " + base);
  } finally {
    root.close();
  }
  return newRestoreFolder(base, id, include);
}

// Checks before an in-place restore that the nearest existing folder above each path opens safely.
// openRoot refuses untrusted links on the way.
export async function canOverwrite(paths: string[]): Promise<void> {
  const seen = new Set<string>();
  for (const p of paths) {
    if (!path.isAbsolute(p))
      throw new Error('the snapshot uses a path format that is incompatible with this operating system');
    let parent = path.dirname(p);
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (;;) {
      try {
        const root = await openRoot(parent, { trustedFinalLink: true });
        root.close();
        break;
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        const next = path.dirname(parent);
        if (parent === next) throw error;
        parent = next;
      }
    }
  }
}

// A handle for the folder that holds a destination. close() leaves the shared target handle open.
interface Parent {
  root: RootDirectory;
  close(): void;
}

// Runs every step even when some fail, and returns the first error.
function cleanup(operations: (() => void)[]): unknown {
  let failure: unknown;
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}

// Opens the folder that will hold `out`. Inside a target it's opened through the retained target handle,
// so no restore path can leave the target. An in-place restore opens the absolute parent.
async function restoreParent(out: string, target?: string, targetRoot?: RootDirectory): Promise<Parent> {
  if (target && targetRoot) {
    const relative = path.relative(target, path.dirname(out));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('restore path escapes the target');
    const root = directory(targetRoot, relative, { create: true, mode: 0o755 });
    return {
      root,
      close: () => {
        if (root !== targetRoot) root.close();
      },
    };
  }
  const root = await openRoot(path.dirname(out), { create: true, trustedFinalLink: true });
  return { root, close: () => root.close() };
}

// Carries the progress made before a failure, including whether there's unfinished work to resume.
export class RestoreError extends Error {
  constructor(
    cause: unknown,
    public result: RestoreResult,
  ) {
    super(message(cause), { cause });
  }
}

// Restore only reads the repository, so it works without the manifest.
export async function restore(
  e: EngineLike,
  id: string,
  opts: RestoreOptions,
  signal?: AbortSignal,
): Promise<RestoreResult> {
  const res: RestoreResult = { files: 0, dirs: 0, bytes: 0, unfinished: false };

  // `active` is the partial file being written. It's named `activeName` in `activeParent` and holds
  // `activeLength` bytes so far. `mark` is the locked marker of a new restore folder.
  let targetRoot: RootDirectory | undefined;
  let mark: RootFile | undefined;
  let active: RootFile | undefined;
  let activeParent: Parent | undefined;
  let activeName = '';
  let activeLength = 0;
  let activeStat: RootStat | undefined;
  let completed = false;
  let failed = false;

  try {
    let tree;
    try {
      tree = await e.repo.loadTree(id, signal);
    } catch (err) {
      throw new Error(`loading snapshot ${id}: ${message(err)}`, { cause: err });
    }

    // Select files. The root folder isn't restored. With a `base`, neither are `base` and the folders above
    // it, because the target stands in for `base`.
    const target = opts.target ? path.resolve(opts.target) : undefined;
    const base = opts.base ?? '';
    const include = opts.include ?? [];
    if (base && !target) throw new Error('a restore base needs a target');
    const included = (p: string) =>
      !include.length ||
      include.some(inc => {
        inc = slash(inc).replace(/\/$/, '');
        return p === inc || p.startsWith(inc + '/');
      });
    const files = tree.files.filter(
      f =>
        !(f.path === '/' && f.type === 'dir') &&
        !(base && f.type === 'dir' && (base + '/').startsWith(f.path.replace(/\/$/, '') + '/')) &&
        included(f.path),
    );
    if (!files.length) throw new Error('no items in the snapshot match the specified paths');
    check(signal);

    // Check every destination before writing anything. Names are compared without case on Windows and
    // macOS, whose filesystems usually ignore it. macOS filesystems also treat composed and decomposed
    // forms of a name (é and e plus an accent) as one file, so names are compared decomposed there.
    const relOf = (p: string) => (target ? restoreRel(p, base) : safeRel(p));
    const destinations = new Map<string, string>();
    for (const f of files) {
      let rel = relOf(f.path);
      if (!target && !path.isAbsolute(f.path))
        throw new Error(`can't restore foreign or relative path ${JSON.stringify(f.path)} in place`);
      if (process.platform === 'win32' || process.platform === 'darwin') rel = rel.toLowerCase();
      if (process.platform === 'darwin') rel = rel.normalize('NFD');
      if (destinations.has(rel)) throw new Error(`duplicate restore destination ${JSON.stringify(f.path)}`);
      if (opts.newTarget && rel.toLowerCase() === marker)
        throw new Error(
          `cannot restore ${JSON.stringify(f.path)} into a new folder: this name is reserved for frost's restore state`,
        );
      if (!['file', 'dir', 'symlink'].includes(f.type)) throw new Error(`unknown file type ${JSON.stringify(f.type)}`);
      if ((f.size ?? 0) < 0 || !Number.isSafeInteger(f.size ?? 0))
        throw new Error(`negative file size for ${JSON.stringify(f.path)}`);
      if (f.chunks) {
        f.chunks = f.chunks.map(c => {
          try {
            return parseID(c);
          } catch {
            throw new Error('invalid chunk ID ' + JSON.stringify(c));
          }
        });
      }
      destinations.set(rel, f.type);
    }

    // No destination may sit below one that isn't a folder.
    for (const rel of destinations.keys()) {
      for (
        let parent = path.posix.dirname(slash(rel));
        parent !== '.' && parent !== '/';
        parent = path.posix.dirname(parent)
      ) {
        if (destinations.has(parent) && destinations.get(parent) !== 'dir')
          throw new Error(`restore path ${JSON.stringify(rel)} has a non-directory ancestor`);
      }
    }

    // A new target is created exclusively. If it already exists, it must hold this restore's marker.
    let fresh = false;
    if (target) {
      if (opts.newTarget) {
        const parent = await openRoot(path.dirname(target), { create: true, mode: 0o700, trustedFinalLink: true });
        try {
          try {
            targetRoot = parent.openDirectory(path.basename(target), { create: true, exclusive: true, mode: 0o700 });
            fresh = true;
          } catch (error) {
            if (code(error) !== 'EEXIST')
              throw new Error('creating new restore target: ' + message(error), { cause: error });
            targetRoot = parent.openDirectory(path.basename(target));
          }
        } finally {
          parent.close();
        }
      } else targetRoot = await openRoot(target, { create: true, mode: 0o700 });
      if (opts.newTarget) {
        if (!fresh) {
          const stat = existing(targetRoot, marker);
          if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('the restore folder already exists');
        }
        mark = targetRoot.open(marker, { read: true, write: true, create: fresh, exclusive: fresh, mode: 0o600 });
        lockFile(mark);
        if (fresh) {
          mark.writeFile(markerText(id, include));
          mark.sync();
        } else if (JSON.stringify(JSON.parse(readAll(mark, 1 << 20).toString())) !== markerText(id, include))
          throw new Error('the target directory contains an incomplete restore state from another operation');
      }
    } else if (opts.newTarget) throw new Error('new restore target is empty');

    // `have` and `haveLen` count the leading chunks and bytes a partial file already holds. `partial`
    // and `parent` keep an existing partial file open and locked until it's written.
    const dest = (f: File) => (target ? path.join(target, relOf(f.path)) : f.path);
    const table = newTable(e.repo.key.chunkerSeed());
    const regular = files
      .filter(f => f.type === 'file')
      .map(f => ({
        f,
        out: dest(f),
        done: false,
        have: 0,
        haveLen: 0,
        partial: undefined as RootFile | undefined,
        parent: undefined as Parent | undefined,
        checked: undefined as RootStat | undefined,
      }));

    const progress: RestoreProgress = {
      checking: !fresh,
      path: '',
      files: 0,
      totalFiles: regular.length,
      bytes: 0,
      totalBytes: regular.reduce((n, r) => n + (r.f.size ?? 0), 0),
    };
    const report = (name: string) => {
      progress.path = name;
      opts.progress?.({ ...progress });
    };

    // Chunks an existing file and counts its leading chunks that match the snapshot's keyed IDs. Names
    // alone are never trusted.
    const matched = async (
      file: RootFile,
      f: File,
      before: RootStat,
    ): Promise<{ n: number; len: number; stat: RootStat }> => {
      let n = 0;
      let len = 0;
      async function* input() {
        let offset = 0;
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
          check(signal);
          const read = file.read(buffer, 0, buffer.length, offset);
          if (!read.bytesRead) return;
          offset += read.bytesRead;
          yield buffer.subarray(0, read.bytesRead);
        }
      }
      for await (const b of chunks(input(), table)) {
        check(signal);
        if (n >= (f.chunks?.length ?? 0) || e.repo.key.chunkID(b) !== f.chunks![n]) break;
        n++;
        len += b.length;
        progress.bytes += b.length;
        report(f.path);
      }
      const stat = file.stat();
      return sameContents(before, stat) ? { n, len, stat } : { n: 0, len: 0, stat };
    };

    // Closes and deletes the partial file being written.
    const discard = () => {
      active?.close();
      active = undefined;
      if (activeParent && activeName) activeParent.root.remove(activeName);
      activeName = '';
      activeParent?.close();
      activeParent = undefined;
    };

    try {
      // Unless the target is new, check what's already there. A complete destination is skipped, and an
      // existing partial file keeps its matching leading chunks.
      if (!fresh) {
        for (const r of regular) {
          check(signal);
          const parent = await restoreParent(r.out, target, targetRoot);
          try {
            const name = path.basename(r.out);
            const st = existing(parent.root, name);
            if (st?.isFile() && !st.isSymbolicLink() && st.size === (r.f.size ?? 0)) {
              let file: RootFile | undefined;
              try {
                file = parent.root.open(name, { read: true });
                const opened = file.stat();
                if (sameFile(st, opened)) {
                  const have = await matched(file, r.f, opened);
                  r.done =
                    have.stat.size === (r.f.size ?? 0) &&
                    have.n === (r.f.chunks?.length ?? 0) &&
                    have.len === (r.f.size ?? 0) &&
                    // Updating linked metadata would also change an alias outside the target. A fresh
                    // partial separates those destinations; matching metadata needs no writes.
                    (have.stat.nlink === 1 ||
                      ((have.stat.mode & 0o777) === (r.f.mode & 0o777) && have.stat.mtimeNs === timeValue(r.f.mtime)));
                  if (r.done) r.checked = have.stat;
                }
              } catch {
                check(signal);
              } finally {
                file?.close();
              }
            }
            if (r.done) continue;
            const namePartial = partialName(id, r.f.path);
            const ps = existing(parent.root, namePartial);
            if (!ps) continue;
            if (!ps.isFile() || ps.isSymbolicLink())
              throw new Error(`restoring ${r.f.path}: ${namePartial} isn't a regular file`);
            if (ps.nlink !== 1) throw new Error(`restoring ${r.f.path}: ${namePartial} has more than one link`);
            r.partial = parent.root.open(namePartial, { read: true, write: true });
            lockFile(r.partial);
            const opened = r.partial.stat();
            if (!sameFile(ps, opened) || opened.nlink !== 1)
              throw new Error(`restoring ${r.f.path}: ${namePartial} changed while it was opened`);
            r.parent = parent;
            const have = await matched(r.partial, r.f, opened);
            if (have.stat.nlink !== 1) throw new Error(`restoring ${r.f.path}: ${namePartial} has more than one link`);
            r.have = have.n;
            r.haveLen = have.len;
            r.checked = have.stat;
          } finally {
            if (r.parent !== parent) parent.close();
          }
        }
      }
      progress.checking = false;
      progress.bytes = 0;

      // `k` indexes the next file to finish, and `need` counts the chunks it still needs.
      let k = 0;
      let need = 0;

      // Finishes files in order until one needs downloaded chunks. That file's partial file is opened,
      // truncated to its matching chunks and left active. A finished partial file is checked against its
      // recorded size, flushed and renamed into place.
      const settle = async () => {
        while (k < regular.length) {
          check(signal);
          const r = regular[k];
          if (!r.done && !active) {
            activeParent = r.parent ?? (await restoreParent(r.out, target, targetRoot));
            r.parent = undefined;
            activeName = partialName(id, r.f.path);
            active =
              r.partial ??
              activeParent.root.open(activeName, {
                read: true,
                write: true,
                create: true,
                exclusive: true,
                mode: 0o600,
              });
            r.partial = undefined;
            lockFile(active);
            const current = active.stat();
            if (current.nlink !== 1 || (r.checked && !sameContents(r.checked, current)))
              throw new Error(`restoring ${r.f.path}: the partial file changed after it was checked`);
            activeLength = r.haveLen;
            if (current.size !== activeLength) {
              active.truncate(activeLength);
              activeStat = active.stat();
            } else activeStat = current;
            progress.bytes += r.haveLen;
            need = (r.f.chunks?.length ?? 0) - r.have;
          }
          if (!r.done && need) return;
          const ns = timeValue(r.f.mtime);
          if (r.done) {
            const parent = await restoreParent(r.out, target, targetRoot);
            let file: RootFile | undefined;
            try {
              file = parent.root.open(path.basename(r.out), { read: true });
              const current = file.stat();
              if (!sameContents(r.checked!, current))
                throw new Error(`restoring ${r.f.path}: the destination changed after it was checked`);
              const mode = r.f.mode & 0o777;
              const changedMode = (current.mode & 0o777) !== mode;
              const changedTime = current.mtimeNs !== ns;
              if (changedMode) file.chmod(mode);
              if (changedTime) file.utimes(ns, ns);
            } finally {
              file?.close();
              parent.close();
            }
            progress.bytes += r.f.size ?? 0;
          } else {
            if (!sameContents(activeStat!, active!.stat()))
              throw new Error(`restoring ${r.f.path}: the partial file changed while it was restored`);
            if (activeLength !== (r.f.size ?? 0)) {
              discard();
              throw new Error(`restoring ${r.f.path}: size mismatch`);
            }
            active!.chmod(r.f.mode & 0o777);
            active!.utimes(ns, ns);
            active!.sync();
            const final = active!.stat();
            const named = existing(activeParent!.root, activeName);
            if (final.nlink !== 1 || final.size !== activeLength || !named || !sameFile(final, named))
              throw new Error(`restoring ${r.f.path}: the partial file changed while it was restored`);
            active!.close();
            active = undefined;
            // A folder at the destination gets a clear error. POSIX refuses to rename a file over a folder,
            // so there the check only runs after a failed rename, saving a lookup per file. Windows checks
            // first, because its replacing rename isn't documented to refuse every folder.
            const name = path.basename(r.out);
            const folderInTheWay = () => existing(activeParent!.root, name)?.isDirectory();
            if (process.platform === 'win32' && folderInTheWay())
              throw new Error('destination is a directory: ' + r.out);
            try {
              activeParent!.root.rename(activeName, activeParent!.root, name);
            } catch (err) {
              if (folderInTheWay()) throw new Error('destination is a directory: ' + r.out);
              throw err;
            }
            activeName = '';
            activeParent!.close();
            activeParent = undefined;
          }
          progress.files++;
          res.files = progress.files;
          res.bytes = progress.bytes;
          report(r.f.path);
          k++;
          if (k % 32 === 0) await yieldIO();
        }
        check(signal);
      };
      await settle();

      // Download every missing chunk across the selection. Chunks arrive in request order, so each one
      // belongs to regular[k], the active file.
      const ids = regular.flatMap(r => (r.done ? [] : (r.f.chunks ?? []).slice(r.have)));
      await e.repo.fetch(
        ids,
        e.downloaders > 0 ? e.downloaders : 8,
        async (_i, data) => {
          check(signal);
          const r = regular[k];
          if (!sameContents(activeStat!, active!.stat()))
            throw new Error(`restoring ${r.f.path}: the partial file changed while it was restored`);
          if (data.length > (r.f.size ?? 0) - activeLength) {
            discard();
            throw new Error(`restoring ${r.f.path}: data exceeds recorded size`);
          }
          let written = 0;
          while (written < data.length) {
            check(signal);
            const count = active!.write(data, written, data.length - written, activeLength + written).bytesWritten;
            if (!count) throw new Error('restore write made no progress');
            written += count;
          }
          activeLength += data.length;
          activeStat = active!.stat();
          if (activeStat.nlink !== 1) throw new Error(`restoring ${r.f.path}: the partial file has more than one link`);
          need--;
          progress.bytes += data.length;
          res.bytes = progress.bytes;
          report(r.f.path);
          if (data.length >= 1024 * 1024) await yieldIO();
          if (!need) await settle();
        },
        signal,
      );

      // Symlinks come after regular files. Each is created under a temporary name and renamed into place.
      for (const f of files.filter(f => f.type === 'symlink')) {
        check(signal);
        const out = dest(f);
        const parent = await restoreParent(out, target, targetRoot);
        const tmp = '.frost-restore-' + randomUUID();
        let error: unknown;
        try {
          parent.root.symlink(f.target ?? '', tmp);
          parent.root.rename(tmp, parent.root, path.basename(out));
        } catch (cause) {
          error = cause;
          throw cause;
        } finally {
          const failure = cleanup([
            () => {
              try {
                parent.root.remove(tmp);
              } catch (cause) {
                if (code(cause) !== 'ENOENT') throw cause;
              }
            },
            () => parent.close(),
          ]);
          if (!error && failure) throw failure;
        }
      }

      // Folder modes and times go last, deepest first, so file writes can't change a folder's time and a
      // restrictive mode can't block the folders below it. The placeholder name makes restoreParent open
      // the folder itself.
      for (const f of files.filter(f => f.type === 'dir').sort((a, b) => compare(b.path, a.path))) {
        check(signal);
        const parent = await restoreParent(path.join(dest(f), '.frost-directory'), target, targetRoot);
        try {
          parent.root.chmod(f.mode & 0o777);
          const ns = timeValue(f.mtime);
          parent.root.utimes(ns, ns);
          res.dirs++;
        } finally {
          parent.close();
        }
      }
      check(signal);
      completed = true;
      return res;
    } finally {
      // Partial files that were opened but never reached stay on disk for a later resume.
      for (const r of regular) {
        if (r.partial) res.unfinished = true;
        cleanup([() => r.partial?.close(), () => r.parent?.close()]);
      }
    }
  } catch (err) {
    // A new folder's marker or a partial file with data is left for a later restore to resume.
    failed = true;
    res.unfinished ||= !!mark || (!!activeName && activeLength > 0);
    throw new RestoreError(err, res);
  } finally {
    // An empty partial file is removed. The marker is only removed after a complete restore.
    const error = cleanup([
      () => active?.close(),
      () => {
        if (!activeLength && activeName && activeParent) {
          try {
            activeParent.root.remove(activeName);
          } catch (cause) {
            if (code(cause) !== 'ENOENT') throw cause;
          }
        }
      },
      () => activeParent?.close(),
      () => mark?.close(),
      () => {
        if (mark && completed) {
          try {
            targetRoot!.remove(marker);
          } catch {}
        }
      },
      () => targetRoot?.close(),
    ]);
    if (!failed && error) throw new RestoreError(error, res);
  }
}
