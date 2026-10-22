// Backup walks the configured folders, chunks changed files, uploads new chunks and saves a snapshot.
// The manifest lets it skip unchanged files and known chunks, and records what each run did.

import { open, lstat } from 'node:fs/promises';
import {
  constants,
  type BigIntStats,
  lstatSync,
  readdirSync,
  readlinkSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { chunksFromReader, newTable, split, minSize, maxSize } from '../core/chunker.js';
import { newID, compare, timeValue } from '../core/snapshot.js';
import { SaveSnapshotError } from '../core/repo.js';
import { location } from '../core/storage.js';
import { Excluder, slash } from './exclude.js';
import { listDigest, countChanges } from './changes.js';
import { isPartial } from './restore.js';
import { refuseDatalessReads } from '../platform/dataless.js';
import {
  check,
  code,
  emptyChanges,
  message,
  type EngineLike,
  type BackupOptions,
  type BackupResult,
  type File,
  type LastRun,
  type PlannedFile,
  type Snapshot,
  type Tree,
} from './types.js';

// When and where the manifest's chunk list was last checked against storage. Verification sets
// `needed` when it finds a chunk missing.
export interface ChunkSync {
  time: string;
  where: string;
  needed?: boolean;
}

// What the manifest remembers about the last saved snapshot, so the next backup can tell whether
// anything changed.
interface LastSaved {
  id: string;
  paths: string[];
  digest: string;
  entries: string;
}

// The storage location, followed by the storage behind it for a backend that reports one, such as the drive
// mounted at a path. A copy of the repository on another drive at the same path is then somewhere else.
async function syncWhere(e: EngineLike, signal?: AbortSignal): Promise<string> {
  const identity = await e.repo.backend.identity?.(signal);
  return location(e.repo.backend) + (identity ? '#' + identity : '');
}

// Backup trusts the manifest's chunk list for up to seven days, and only at the storage location where it
// was checked. A chunk that verification found missing, an empty list or a bad timestamp also forces a sync.
export async function syncDue(e: EngineLike, signal?: AbortSignal): Promise<boolean> {
  const m = e.manifest!;
  const s = m.getMeta<ChunkSync>('chunk_sync');
  if (!s || s.needed || !m.anyChunks() || s.where !== (await syncWhere(e, signal))) return true;
  const age = Date.now() - Date.parse(s.time);
  return !Number.isFinite(age) || age < 0 || age > 7 * 24 * 3600_000;
}

// Replaces the manifest's chunk list with a listing of storage.
export async function syncChunks(e: EngineLike, signal?: AbortSignal): Promise<void> {
  const where = await syncWhere(e, signal);
  const ids = await e.repo.chunkIDs(signal);
  check(signal);
  await e.manifest!.batch(tx => {
    tx.replaceChunks(ids);
    tx.putMeta('chunk_sync', { time: new Date().toISOString(), where });
  });
}

// Formats a nanosecond modification time in UTC, with trailing zeros trimmed from the fraction.
// Times before 1970 round the seconds down so the fraction stays positive.
export function mtime(s: BigIntStats): string {
  let seconds = s.mtimeNs / 1_000_000_000n;
  let nanos = s.mtimeNs % 1_000_000_000n;
  if (nanos < 0) {
    seconds--;
    nanos += 1_000_000_000n;
  }

  // Files in one folder often share a second, so the last date string is kept.
  if (seconds !== lastSecond) {
    const iso = new Date(Number(seconds * 1000n)).toISOString();
    lastDate = iso.slice(0, -5);
    lastSecond = seconds;
  }
  if (!nanos) return lastDate + 'Z';
  let frac = String(nanos).padStart(9, '0');
  let end = frac.length;
  while (frac.charCodeAt(end - 1) === 48) end--;
  frac = frac.slice(0, end);
  return lastDate + '.' + frac + 'Z';
}
let lastSecond: bigint | undefined;
let lastDate = '';

// Joins a folder and a name from readdir. The folder is already normalised and the name has no
// separators, so plain concatenation gives what path.join would, without its cost on Windows.
function childPath(folder: string, name: string): string {
  return folder.endsWith(path.sep) ? folder + name : folder + path.sep + name;
}

// Same device and inode, so a path still names the file that was opened.
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// Whether the walk stats a folder's children in parallel. See the directory branch of walk.
const parallelStat = process.platform === 'win32';

// Thrown when a file changes while it's read. The file gets one more try after the walk.
class Changed extends Error {
  constructor(p: string) {
    super('file changed while reading ' + p);
  }
}

export async function backup(e: EngineLike, opts: BackupOptions, signal?: AbortSignal): Promise<BackupResult> {
  if (!e.manifest) throw new Error('backup needs a manifest');
  if (!opts.paths.length) throw new Error('nothing to back up: no paths configured');
  if (opts.paths.some(p => !p.trim())) throw new Error("backup paths can't contain an empty entry");
  const ex = new Excluder(opts.exclude ?? []);

  // Reading a file that's only in iCloud would download it, so those reads fail instead.
  refuseDatalessReads();

  const snap: Snapshot = {
    id: newID(),
    time: new Date().toISOString(),
    host: opts.host || os.hostname(),
    paths: [],
    stats: { files: 0, dirs: 0, bytes: 0, new_chunks: 0, new_bytes: 0, uploaded_bytes: 0 },
    warnings: [],
    kept: [],
    missing: [],
  };
  const res: BackupResult = { snapshot: snap, unchanged: false, compared: false, changes: emptyChanges(), planned: [] };
  let failure: unknown;
  let saved: LastSaved | undefined;
  let rememberFiles = false;

  // `pending` holds chunk IDs counted as new in this run, `done` holds uploaded chunks not yet in the
  // manifest, and `fileEntries` holds file metadata that differs from the manifest's.
  const manifest = e.manifest;
  const pending = new Set<string>();
  const done = new Map<string, number>();
  const fileEntries = new Map<string, { size: number; mtime: string; chunks: string[] }>();

  // Uploads run in the background. The first failure is kept and thrown at the next point that checks it.
  const active = new Set<Promise<void>>();
  let uploadFailure: unknown;

  const flush = async () => {
    if (!done.size) return;
    const batch = new Map(done);
    done.clear();
    await manifest.addChunks(batch);
  };

  // Starts an upload once fewer than the configured number are running. Uploaded IDs are recorded in
  // the manifest in batches of 64. An owned chunk may move to a crypto worker and be detached, so
  // its size is taken first.
  const queue = async (id: string, data: Buffer, owned: boolean) => {
    check(signal);
    if (uploadFailure) throw uploadFailure;
    while (active.size >= (e.uploaders > 0 ? e.uploaders : 4)) {
      await Promise.race(active);
      if (uploadFailure) throw uploadFailure;
      check(signal);
    }
    const size = data.length;
    let task: Promise<void>;
    task = (owned ? e.repo.putOwnedChunk(id, data, signal) : e.repo.putChunk(id, data, signal))
      .then(async sent => {
        done.set(id, size);
        snap.stats.uploaded_bytes += sent;
        if (done.size >= 64) await flush();
      })
      .catch(err => {
        uploadFailure ??= new Error('upload failed: ' + message(err), { cause: err });
      })
      .finally(() => active.delete(task));
    active.add(task);
  };

  // The key seeds the chunker's gear table, so known files don't have a public pattern of cut points.
  // Large files share one read buffer because files are read one at a time.
  const table = newTable(e.repo.key.chunkerSeed());
  let chunkBuffer: Buffer<ArrayBuffer> | undefined;

  // Chunks one file into `f` and queues its new chunks. Throws Changed if the file changes while it's read.
  const readFile = async (p: string, f: File): Promise<PlannedFile> => {
    const planned = { path: f.path, size: f.size ?? 0, newBytes: 0 };
    const prev = manifest.file(f.path);

    // Reuse the manifest's chunk list without opening the file when the size and modification time
    // match and every chunk is known.
    if (
      prev &&
      prev.size === (f.size ?? 0) &&
      (!f.size || prev.chunks.length) &&
      prev.mtime === f.mtime &&
      manifest.hasChunks(prev.chunks)
    ) {
      f.chunks = prev.chunks;
      return planned;
    }

    // A file no bigger than the minimum chunk size is at most one chunk, so it's read synchronously into
    // one buffer. O_NOFOLLOW refuses a path that became a link after the walk; Windows has no such flag.
    if ((f.size ?? 0) <= minSize) {
      const fd = openSync(p, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile()) throw new Error(p + " isn't a regular file any more");
        if (before.size > BigInt(minSize)) throw new Changed(p);
        f.size = Number(before.size);
        f.mtime = mtime(before);
        f.mode = Number(before.mode & 0o777n);
        f.chunks = [];
        planned.size = f.size;

        // Reading one byte past the recorded size shows whether the file grew.
        const buffer = Buffer.allocUnsafe(f.size + 1);
        let read = 0;
        while (read < buffer.length) {
          check(signal);
          const n = readSync(fd, buffer, read, buffer.length - read, null);
          if (!n) break;
          read += n;
        }
        if (read > f.size) throw new Changed(p);

        // Chunks that are already stored or queued in this run aren't uploaded again.
        for (const data of split(buffer.subarray(0, read), table)) {
          check(signal);
          if (uploadFailure) throw uploadFailure;
          const id = e.repo.key.chunkID(data);
          f.chunks.push(id);
          if (e.chunkRead) await e.chunkRead(p);
          if (manifest.hasChunk(id) || pending.has(id)) continue;
          pending.add(id);
          snap.stats.new_bytes += data.length;
          planned.newBytes += data.length;
          if (!opts.dryRun) await queue(id, data, false);
        }

        // Check the open handle and the directory entry after reading. A change that keeps the file's
        // identity, size and modification time can still get past this.
        const after = fstatSync(fd, { bigint: true });
        const current = lstatSync(p, { bigint: true });
        if (read !== f.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || !same(before, current))
          throw new Changed(p);

        // Only entries that differ from the manifest are written back.
        if (
          !opts.dryRun &&
          (!prev ||
            prev.size !== f.size ||
            prev.mtime !== f.mtime ||
            JSON.stringify(prev.chunks) !== JSON.stringify(f.chunks))
        )
          fileEntries.set(f.path, { size: f.size, mtime: f.mtime, chunks: f.chunks });
        return planned;
      } finally {
        closeSync(fd);
      }
    }

    // Larger files stream through FastCDC, with the same checks as above.
    const fh = await open(p, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
      const before = await fh.stat({ bigint: true });
      if (!before.isFile()) throw new Error(p + " isn't a regular file any more");
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('file is too large: ' + p);
      f.size = Number(before.size);
      f.mtime = mtime(before);
      f.mode = Number(before.mode & 0o777n);
      const ids: string[] = (f.chunks = []);
      planned.size = f.size;

      // Crypto workers compute chunk IDs while this loop cuts the next chunks, and results are handled
      // in file order, up to four chunks behind. chunksFromReader yields fresh copies that nothing else
      // holds, so they can be handed to workers and on to the upload queue.
      const hashing: Promise<{ id: string; data: Buffer }>[] = [];
      const take = async () => {
        const { id, data } = await hashing.shift()!;
        check(signal);
        if (uploadFailure) throw uploadFailure;
        ids.push(id);
        if (e.chunkRead) await e.chunkRead(p);
        if (manifest.hasChunk(id) || pending.has(id)) return;
        pending.add(id);
        snap.stats.new_bytes += data.length;
        planned.newBytes += data.length;
        if (!opts.dryRun) await queue(id, data, true);
      };

      let read = 0;
      for await (const data of chunksFromReader(fh, table, (chunkBuffer ??= Buffer.allocUnsafe(maxSize * 2)))) {
        check(signal);
        if (uploadFailure) throw uploadFailure;
        read += data.length;
        if (read > f.size) throw new Changed(p);
        const job = e.repo.key.ownedChunkID(data);
        // A job left behind by an error mustn't become an unhandled rejection.
        job.catch(() => {});
        hashing.push(job);
        if (hashing.length >= 4) await take();
      }
      while (hashing.length) await take();

      const after = await fh.stat({ bigint: true });
      const current = await lstat(p, { bigint: true });
      if (read !== f.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || !same(before, current))
        throw new Changed(p);

      if (
        !opts.dryRun &&
        (!prev ||
          prev.size !== f.size ||
          prev.mtime !== f.mtime ||
          JSON.stringify(prev.chunks) !== JSON.stringify(f.chunks))
      )
        fileEntries.set(f.path, { size: f.size, mtime: f.mtime, chunks: f.chunks });
      return planned;
    } finally {
      await fh.close();
    }
  };

  // Counts a skipped item. The snapshot header keeps the first 100 warnings and the full count.
  const warn = (text: string) => {
    snap.stats.skipped = (snap.stats.skipped ?? 0) + 1;
    if (snap.warnings!.length < 100) snap.warnings!.push(text);
  };

  // Why a file or folder couldn't be read. With downloads refused, a read of one that's only in iCloud fails
  // with EDEADLK (11), which Node reports as an unknown system error. Node's read errors don't name the file,
  // so `named` puts the path in front.
  const icloud = (err: unknown) => process.platform === 'darwin' && (err as NodeJS.ErrnoException)?.errno === -11;
  const unreadable = (p: string, err: unknown, named = true) =>
    icloud(err)
      ? named
        ? p + ' resides in iCloud storage only and was not downloaded.'
        : 'file resides in iCloud storage only and was not downloaded.'
      : message(err);

  // `retry` holds files that changed while they were read.
  const tree: Tree = { files: [] };
  const retry: { p: string; f: File }[] = [];

  // Adds a backed-up file to the tree and reports progress.
  const add = (p: string, f: File, planned: PlannedFile) => {
    if (planned.newBytes) res.planned.push(planned);
    snap.stats.files++;
    snap.stats.bytes += f.size ?? 0;
    tree.files.push(f);
    opts.progress?.({
      path: p,
      files: snap.stats.files,
      bytes: snap.stats.bytes,
      newBytes: snap.stats.new_bytes,
      uploadedBytes: snap.stats.uploaded_bytes,
    });
  };

  try {
    if (await syncDue(e, signal)) {
      try {
        await syncChunks(e, signal);
      } catch (err) {
        throw new Error('reading repository chunk list: ' + message(err), { cause: err });
      }
    }

    // `visited` stops overlapping backup paths from being walked twice.
    const visited = new Set<string>();
    let walked = 0;

    // Walks one path depth first. `found` carries the stat, or the error, from the parent's batch.
    const walk = async (p: string, root: string, found?: { stat?: BigIntStats; error?: unknown }): Promise<void> => {
      // Give uploads and timers a turn during long walks.
      if (++walked % 32 === 0) await yieldIO();
      check(signal);
      if (uploadFailure) throw uploadFailure;
      if (visited.has(p)) return;

      // A root that can't be read fails the backup. Anything below it only adds a warning.
      let st: BigIntStats;
      try {
        if (found && !found.stat) throw found.error;
        st = found?.stat ?? lstatSync(p, { bigint: true });
      } catch (err) {
        if (p === root) throw new Error(`can't read ${root}: ${message(err)}`, { cause: err });
        warn(message(err));
        return;
      }

      // Excludes and restore partial files are skipped below a root, never the root itself.
      if (p !== root && ((st.isFile() && isPartial(path.basename(p))) || ex.match(p))) return;
      visited.add(p);
      const f: File = {
        path: slash(p),
        type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
        mode: Number(st.mode & 0o777n),
        mtime: mtime(st),
      };

      // Sockets, devices and pipes match none of these branches and are skipped.
      if (st.isDirectory()) {
        let entries: string[];
        try {
          entries = readdirSync(p);
        } catch (err) {
          if (p === root) throw new Error(`can't read ${root}: ${unreadable(p, err, false)}`, { cause: err });
          warn(unreadable(p, err));
          return;
        }
        snap.stats.dirs++;
        tree.files.push(f);
        entries.sort(compare);

        // Stat children 32 at a time, then walk them in sorted order. Windows stats are slow and run
        // in parallel on libuv's thread pool. Elsewhere a synchronous lstat is several times cheaper
        // than a round trip through the pool.
        for (let i = 0; i < entries.length; i += 32) {
          check(signal);
          const names = entries.slice(i, i + 32);
          const batch = parallelStat
            ? await Promise.all(
                names.map(async name => {
                  const child = childPath(p, name);
                  try {
                    return { child, found: { stat: await lstat(child, { bigint: true }) } };
                  } catch (error) {
                    return { child, found: { error } };
                  }
                }),
              )
            : names.map(name => {
                const child = childPath(p, name);
                try {
                  return { child, found: { stat: lstatSync(child, { bigint: true }) } };
                } catch (error) {
                  return { child, found: { error } };
                }
              });
          for (const entry of batch) await walk(entry.child, root, entry.found);
        }
      } else if (st.isSymbolicLink()) {
        // Links are recorded with their target and never followed.
        try {
          f.target = slash(readlinkSync(p));
          tree.files.push(f);
        } catch (err) {
          warn(message(err));
        }
      } else if (st.isFile()) {
        f.size = Number(st.size);
        try {
          add(p, f, await readFile(p, f));
        } catch (err) {
          // Cancellation and upload failures end the backup. A changed file is retried after the walk, and
          // any other error skips it with a warning.
          check(signal);
          if (uploadFailure) throw uploadFailure;
          if (err instanceof Changed) retry.push({ p, f });
          else warn(unreadable(p, err));
        }
      }
    };

    // A missing backup folder is recorded in the snapshot header instead of failing the backup.
    for (const root of opts.paths) {
      const abs = path.resolve(root);
      try {
        lstatSync(abs);
      } catch (err) {
        if (code(err) === 'ENOENT') {
          snap.missing!.push(slash(abs));
          continue;
        }
        throw err;
      }
      snap.paths.push(slash(abs));
      await walk(abs, abs);
    }

    // Retry files that changed while they were read. If one is still changing, keep its previous clean
    // copy, or skip it with a warning when there's no earlier copy.
    for (const { p, f: was } of retry) {
      check(signal);
      let st: BigIntStats;
      try {
        st = await lstat(p, { bigint: true });
      } catch (err) {
        warn(message(err));
        continue;
      }
      if (!st.isFile()) {
        warn(p + ' stopped being a regular file during the backup');
        continue;
      }
      const f = {
        ...was,
        size: Number(st.size),
        mtime: mtime(st),
        mode: Number(st.mode & 0o777n),
        chunks: [] as string[],
      };
      try {
        add(p, f, await readFile(p, f));
      } catch (err) {
        check(signal);
        if (uploadFailure) throw uploadFailure;
        if (!(err instanceof Changed)) {
          warn(unreadable(p, err));
          continue;
        }
        const prev = manifest.file(f.path);
        if (prev && (!prev.size || prev.chunks.length) && manifest.hasChunks(prev.chunks)) {
          f.size = prev.size;
          f.mtime = prev.mtime;
          f.chunks = prev.chunks;
          snap.stats.kept = (snap.stats.kept ?? 0) + 1;
          if (snap.kept!.length < 100) snap.kept!.push(f.path);
          add(p, f, { path: f.path, size: f.size, newBytes: 0 });
        } else warn(p + ' changed continuously during reading and lacks a prior backup version; skipped');
      }
    }

    // Every upload must succeed before the file list is compared or saved.
    await Promise.all(active);
    if (uploadFailure) throw uploadFailure;
    check(signal);
    if (!snap.paths.length) throw new Error('none of the folders to back up were found: ' + snap.missing!.join(', '));
    snap.stats.new_chunks = pending.size;
    tree.files.sort((a, b) => compare(a.path, b.path));

    // Only the complete SHA-256 file-list digest can decide that nothing changed. A skip also needs the
    // recorded snapshot to be the newest known and still present. Anything uncertain saves a snapshot.
    // Equal digests mean equal entries, so the stored entries are reused instead of building new ones.
    const list = listDigest(snap.paths, tree);
    const digest = list.digest;
    const last = manifest.getMeta<LastSaved>('last_saved');
    const entries = last?.digest === digest ? last.entries : list.entries;
    if (last && JSON.stringify(last.paths) === JSON.stringify(snap.paths)) {
      res.compared = true;
      res.changes = countChanges(last.entries, entries);
      const known = manifest.snapshots();
      const prev = known.get(last.id);
      if (last.digest === digest && prev && ![...known.values()].some(s => timeValue(s.time) > timeValue(prev.time))) {
        try {
          await e.repo.loadSnapshot(last.id, signal);
          res.unchanged = true;
          snap.id = prev.id;
          snap.time = prev.time;
        } catch {
          check(signal);
        }
      }
    }
    if (opts.dryRun) return res;

    // The file list is saved as chunks too, so a future prune must count the chunks listed by trees/<id>
    // as referenced. Chunks uploaded before a failure are still recorded.
    if (!res.unchanged) {
      try {
        for (const [id, size] of await e.repo.saveSnapshot(
          snap,
          tree,
          id => manifest.hasChunk(id) || done.has(id),
          signal,
        ))
          done.set(id, size);
      } catch (err) {
        if (err instanceof SaveSnapshotError) for (const [id, size] of err.uploaded) done.set(id, size);
        throw err;
      }
      saved = { id: snap.id, paths: snap.paths, digest, entries };
    }
    rememberFiles = true;
    return res;
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    // Record the run in one manifest transaction, even after a failure. Uploaded chunks are always
    // recorded, so the next run can reuse them; file entries and the snapshot only after success.
    await Promise.all(active);
    if (!opts.dryRun) {
      const run: LastRun = {
        time: new Date().toISOString(),
        snapshot_id: failure ? undefined : snap.id,
        unchanged: res.unchanged || undefined,
        skipped: snap.stats.skipped,
        kept: snap.stats.kept,
        missing: snap.missing?.length ? snap.missing : undefined,
        error: failure ? message(failure) : undefined,
      };
      await manifest.batch(tx => {
        tx.addChunks(done);
        if (rememberFiles) tx.putFiles(fileEntries);
        if (saved) {
          tx.putSnapshot(snap);
          tx.putMeta('last_saved', saved);
        }
        tx.putMeta('last_backup', run);
      });
    }
  }
}
