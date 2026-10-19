// Verification downloads a sample of chunks and checks that the newest file list only references known
// chunks. A missing chunk invalidates the local chunk list, so the next backup uploads it again.

import { syncDue, syncChunks, type ChunkSync } from './backup.js';
import { check, message, type EngineLike, type VerifyResult } from './types.js';
import { timeValue } from '../core/snapshot.js';
import { errNotFound } from '../core/storage.js';
import { parseID } from '../core/crypto.js';

// True when the error, or any error in its cause chain, is the storage "not found" error.
const notFound = (err: unknown): boolean => {
  while (err) {
    if (err === errNotFound) return true;
    err = (err as Error).cause;
  }
  return false;
};

export function goneText(n: number): string {
  return n === 1
    ? "1 snapshot this machine knew about isn't in storage any more"
    : `${n} snapshots this machine knew about aren't in storage any more`;
}

// Replaces the manifest's snapshot headers with the ones in storage, reusing cached headers, and counts
// known snapshots that have disappeared.
export async function refreshSnapshots(e: EngineLike, signal?: AbortSignal) {
  if (!e.manifest) throw new Error('refreshing snapshots needs a manifest');
  const cached = e.manifest.snapshots();
  const snaps = await e.repo.snapshots(cached, signal);
  const have = new Set(snaps.map(s => s.id));
  const missing = [...cached.keys()].filter(id => !have.has(id)).length;
  check(signal);
  await e.manifest.setSnapshots(snaps);
  return { snaps, missing };
}

// Checks `n` sampled chunks and the newest file list, then saves the result for `status` and the browser.
// `full` refreshes the chunk list even when it isn't due.
export async function verify(e: EngineLike, n: number, full: boolean, signal?: AbortSignal): Promise<VerifyResult> {
  if (!e.manifest) throw new Error('verification needs a manifest');
  if (n < 0) throw new Error("verification sample can't be negative");
  if (full || (await syncDue(e, signal))) await syncChunks(e, signal);

  // A snapshot that disappeared counts as a failure once; refreshing forgets it.
  const { snaps, missing: gone } = await refreshSnapshots(e, signal);
  const manifest = e.manifest;
  const res: VerifyResult = {
    time: new Date().toISOString(),
    checked: 0,
    total: manifest.chunkCount(),
    failures: gone ? [goneText(gone)] : [],
  };

  // Download the sample with a pool of workers. A failed download is recorded by index and doesn't stop
  // the rest. getChunk checks authentication and the keyed ID.
  const sample = manifest.sampleChunks(n);
  const errors: (unknown | undefined)[] = new Array(sample.length);
  let next = 0;
  let missing = false;
  await Promise.all(
    Array.from({ length: Math.min(e.downloaders > 0 ? e.downloaders : 8, sample.length) }, async () => {
      while (next < sample.length) {
        check(signal);
        const i = next++;
        try {
          await e.repo.getChunk(sample[i], signal);
        } catch (err) {
          errors[i] = err;
        }
      }
    }),
  );
  check(signal);
  for (const err of errors) {
    res.checked++;
    if (err) {
      res.failures!.push(message(err));
      missing ||= notFound(err);
    }
  }

  // Every chunk the newest file list references must be in the local chunk list.
  const newest = [...snaps].sort((a, b) =>
    timeValue(a.time) > timeValue(b.time) ? -1 : timeValue(a.time) < timeValue(b.time) ? 1 : 0,
  )[0];
  if (newest) {
    res.checked++;
    try {
      const tree = await e.repo.loadTree(newest.id, signal);
      const unknown = new Set<string>();
      for (const f of tree.files) {
        check(signal);
        for (const id of f.chunks ?? []) {
          check(signal);
          try {
            if (!manifest.hasChunk(parseID(id))) unknown.add(id);
          } catch {
            unknown.add(id);
          }
        }
      }
      if (unknown.size) {
        res.failures!.push(`snapshot ${newest.id} references ${unknown.size} missing or invalid chunks`);
        missing = true;
      }
    } catch (err) {
      check(signal);
      res.failures!.push(`snapshot ${newest.id} file list: ${message(err)}`);
      missing ||= notFound(err);
    }
  }

  // Force the next backup to list storage again, so it uploads missing chunks from the source files.
  check(signal);
  if (missing) await manifest.putMeta('chunk_sync', { ...manifest.getMeta<ChunkSync>('chunk_sync'), needed: true });
  res.failures!.sort();
  check(signal);
  await manifest.putMeta('verify', res);
  return res;
}
