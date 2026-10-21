// Snapshot headers and file lists: their types, snapshot IDs, path checks for restore, time
// selectors and tree diffs.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { words } from './bip39.js';

// Field names match the stored JSON.
export interface Stats {
  files: number;
  dirs: number;
  bytes: number;
  new_chunks: number;
  new_bytes: number;
  uploaded_bytes: number;
  skipped?: number;
  kept?: number;
}

// A snapshot header, stored at `snapshots/<id>`. Warning lists are capped; stats keep full counts.
export interface Snapshot {
  id: string;
  time: string;
  host: string;
  paths: string[];
  stats: Stats;
  warnings?: string[];
  kept?: string[];
  missing?: string[];
}

type FileType = 'file' | 'dir' | 'symlink';

// One file-list entry. `chunks` holds a file's content in order, and `target` a symlink's target.
export interface FileEntry {
  path: string;
  type: FileType;
  mode: number;
  mtime: string;
  size?: number;
  chunks?: string[];
  target?: string;
}

export type File = FileEntry;

// A file list. It's stored as chunks and indexed by `trees/<id>`.
export interface Tree {
  files: FileEntry[];
}

type ChangeKind = 'added' | 'removed' | 'modified';

export interface Change {
  path: string;
  kind: ChangeKind;
  old?: FileEntry;
  new?: FileEntry;
}

export function emptyStats(): Stats {
  return { files: 0, dirs: 0, bytes: 0, new_chunks: 0, new_bytes: 0, uploaded_bytes: 0 };
}

export function sort(tree: Tree): void {
  tree.files.sort((a, b) => compare(a.path, b.path));
}

// Orders paths by code point, which is also their UTF-8 byte order. Plain string comparison
// gives the same order when neither path contains a surrogate.
export function compare(a: string, b: string): number {
  if (!/[\uD800-\uDFFF]/.test(a) && !/[\uD800-\uDFFF]/.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const first = a.codePointAt(i) ?? -1;
  const second = b.codePointAt(i) ?? -1;
  return first < second ? -1 : first > second ? 1 : 0;
}

// A new snapshot ID from 64 random bits: two BIP39 words from the low 22 bits, then the other
// 42 bits as 11 hex digits.
export function newID(): string {
  const value = randomBytes(8).readBigUInt64LE();
  return `${words[Number(value & 2047n)]}-${words[Number((value >> 11n) & 2047n)]}-${(value >> 22n).toString(16).padStart(11, '0')}`;
}

// Snapshot IDs become part of object keys, so only lowercase letters, digits and dashes pass.
export function validID(value: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(value);
}

// The short form keeps the words and the first four hex digits.
export function short(id: string): string {
  const i = id.lastIndexOf('-');
  return i >= 0 && id.length - i - 1 > 4 ? id.slice(0, i + 5) : id;
}

// Shortest unique prefix for each ID, never shorter than its short form. After sorting, only
// neighbours can share a longer prefix.
export function shorten(snapshots: Pick<Snapshot, 'id'>[]): Map<string, string> {
  const ids = [...new Set(snapshots.map(s => s.id))].sort();
  const result = new Map<string, string>();
  function common(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }
  ids.forEach((id, i) => {
    let n = short(id).length;
    if (i > 0) n = Math.max(n, common(id, ids[i - 1]) + 1);
    if (i + 1 < ids.length) n = Math.max(n, common(id, ids[i + 1]) + 1);
    result.set(id, id.slice(0, n));
  });
  return result;
}

export function shortOf(ids: Map<string, string>, id: string): string {
  return ids.get(id) ?? short(id);
}

// Turns a stored path into a relative path that's safe to restore. `C:/x` becomes `C/x`. It
// rejects `..`, NUL and empty paths, and on Windows also stream names, reserved device names,
// names ending in a dot or space, and anything still absolute.
export function safeRel(source: string, platform: NodeJS.Platform = process.platform): string {
  // Backslashes in POSIX filenames become separators on Windows. Canonicalise them before
  // restore compares destinations, so aliases can't pass as two different files.
  let value = platform === 'win32' ? source.replaceAll('\\', '/') : source;
  if (/^[a-z]:\//i.test(value)) value = value[0] + value.slice(2);
  value = value.replace(/^\/+/, '');
  if (value.split(platform === 'win32' ? /[/\\]/ : /\//).includes('..'))
    throw new Error(`unsafe path ${JSON.stringify(value)}`);
  const clean = path.posix.normalize(value).replace(/\/$/, '');
  if (clean === '.' || clean === '' || clean === '..' || clean.startsWith('../') || clean.includes('\0'))
    throw new Error(`unsafe path ${JSON.stringify(value)}`);
  if (platform === 'win32') {
    for (const part of clean.split(/[/\\]/)) {
      if (
        part.includes(':') ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
      )
        throw new Error(`unsafe Windows path ${JSON.stringify(value)}`);
    }
    if (path.win32.isAbsolute(clean)) throw new Error(`unsafe path ${JSON.stringify(value)}`);
  }
  return clean;
}

// The longest folder that all the slash-separated paths share. A shared root stays `/` or `C:/`.
export function commonDir(paths: string[]): string {
  if (!paths.length) return '';
  let common = paths[0].split('/');
  for (const value of paths.slice(1)) {
    const parts = value.split('/');
    let n = 0;
    while (n < common.length && n < parts.length && common[n] === parts[n]) n++;
    common = common.slice(0, n);
  }
  if (common.length === 1 && common[0] === '') return '/';
  if (common.length === 1 && common[0].endsWith(':')) return common[0] + '/';
  return common.join('/');
}

// The folder that restored paths are made relative to: the shared parent of the backed-up paths.
export function restoreBase(paths: string[]): string {
  return commonDir(paths.map(p => path.posix.dirname(p)));
}

export function isRoot(p: string): boolean {
  return p === '/' || (p.length === 3 && p[1] === ':' && p[2] === '/');
}

// p relative to base, checked by safeRel. p must be strictly inside base.
export function restoreRel(p: string, base: string, platform: NodeJS.Platform = process.platform): string {
  if (!base) return safeRel(p, platform);
  const prefix = base.endsWith('/') ? base : base + '/';
  if (!p.startsWith(prefix) || p.length === prefix.length)
    throw new Error(`${JSON.stringify(p)} isn't inside ${JSON.stringify(base)}`);
  return safeRel(p.slice(prefix.length), platform);
}

// A snapshot time as nanoseconds since the epoch. Date keeps only milliseconds, so the RFC 3339
// fraction is read separately to keep all nine digits.
export function timeValue(value: string): bigint {
  const match = value.match(/^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
  if (!match) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error('invalid snapshot time');
    return BigInt(ms) * 1_000_000n;
  }
  const ms = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(ms)) throw new Error('invalid snapshot time');
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0').slice(0, 9));
}

// A local `YYYY-MM-DD HH:MM` label for error messages.
function dateLabel(value: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const year = value.getFullYear();
  const label = (year < 0 ? '-' : '') + String(Math.abs(year)).padStart(4, '0');
  return `${label}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}`;
}

// Reads a time selector: now, today, yesterday, a relative time like `3 days ago` or `2h`, or a
// local `YYYY-MM-DD` with an optional `HH:MM`. Days and minutes mean their last millisecond.
export function parseTime(selector: string, now: Date): Date {
  const value = selector.trim().toLowerCase();
  const result = new Date(now);
  if (value === 'now') return result;
  if (value === 'today' || value === 'yesterday') {
    if (value === 'yesterday') result.setDate(result.getDate() - 1);
    result.setHours(23, 59, 59, 999);
    return result;
  }

  // Months and years step the calendar. Other units are fixed lengths.
  const relative = value.match(/^(\d+)\s*([a-z]+?)s?(\s+ago)?$/);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    if (!Number.isSafeInteger(n) || n > 100000) throw new Error(`relative time ${JSON.stringify(value)} is too large`);
    if (unit === 'month' || unit === 'mo') {
      result.setMonth(result.getMonth() - n);
      return result;
    }
    if (['year', 'y', 'yr'].includes(unit)) {
      result.setFullYear(result.getFullYear() - n);
      return result;
    }
    const units: Record<string, number> = {
      m: 60e3,
      min: 60e3,
      minute: 60e3,
      h: 3600e3,
      hr: 3600e3,
      hour: 3600e3,
      d: 86400e3,
      day: 86400e3,
      w: 604800e3,
      week: 604800e3,
    };
    if (unit in units) {
      // The longest duration, in milliseconds, that 64-bit nanoseconds can hold.
      const duration = n * units[unit];
      if (duration > 9223372036854) throw new Error(`relative time ${JSON.stringify(value)} is too large`);
      return new Date(now.getTime() - duration);
    }
  }

  // Setting the date and reading it back rejects days that don't exist, like the 30th of February.
  const absolute = value.match(/^(\d{4})-(\d\d)-(\d\d)(?: (\d\d):(\d\d))?$/);
  if (absolute) {
    const [year, month, day, hour, minute] = absolute.slice(1).map(Number);
    const result = new Date(0);
    result.setFullYear(year, month - 1, day);
    result.setHours(absolute[4] ? hour : 23, absolute[5] ? minute : 59, 59, 999);
    if (
      result.getFullYear() === year &&
      result.getMonth() === month - 1 &&
      result.getDate() === day &&
      (!absolute[4] || (hour < 24 && minute < 60))
    )
      return result;
  }
  throw new Error(
    `cannot parse ${JSON.stringify(value)} as a snapshot ID or timestamp (try "latest", "3 days ago", or "2026-09-20")`,
  );
}

// Picks a snapshot by selector, trying in turn: latest, an exact ID, a unique ID prefix, then the
// newest snapshot at or before a time.
export function resolve(snapshots: Snapshot[], selector = '', now = new Date()): Snapshot {
  if (!snapshots.length) throw new Error('no snapshots yet, run `frost backup` first');
  const value = selector.trim().toLowerCase();
  const newest = (items: Snapshot[]) => items.reduce((a, b) => (timeValue(b.time) > timeValue(a.time) ? b : a));
  if (!value || value === 'latest') return newest(snapshots);
  const exact = snapshots.filter(s => s.id === value);
  if (exact.length) return newest(exact);
  const prefix = snapshots.filter(s => s.id.startsWith(value));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1)
    throw new Error(`${JSON.stringify(value)} matches ${prefix.length} snapshots; provide additional ID characters`);

  // Day and minute selectors also cover the nanoseconds inside their last millisecond.
  const at = parseTime(value, now);
  const end = /^(today|yesterday|\d{4}-\d\d-\d\d(?: \d\d:\d\d)?)$/.test(value);
  const limit = BigInt(at.getTime()) * 1_000_000n + (end ? 999999n : 0n);
  const eligible = snapshots.filter(s => timeValue(s.time) <= limit);
  if (eligible.length) return newest(eligible);
  const oldest = snapshots.reduce((a, b) => (timeValue(a.time) < timeValue(b.time) ? a : b));
  throw new Error(`no snapshot at or before ${dateLabel(at)} (oldest is ${dateLabel(new Date(oldest.time))})`);
}

// Same type, mode, size, target and chunks. Modification time isn't compared.
function sameContent(a: FileEntry, b: FileEntry): boolean {
  if (
    a.type !== b.type ||
    a.mode !== b.mode ||
    (a.size ?? 0) !== (b.size ?? 0) ||
    (a.target ?? '') !== (b.target ?? '')
  )
    return false;
  const before = a.chunks;
  const after = b.chunks;
  if ((before?.length ?? 0) !== (after?.length ?? 0)) return false;
  if (before) for (let i = 0; i < before.length; i++) if (before[i] !== after![i]) return false;
  return true;
}

// Changes from a to b, sorted by path. Sorted lists merge in one pass; anything else goes
// through a map.
export function diff(a: Tree, b: Tree): Change[] {
  const ordered = (files: FileEntry[]) =>
    files.every((file, i) => i === 0 || compare(files[i - 1].path, file.path) < 0);
  if (ordered(a.files) && ordered(b.files)) {
    const result: Change[] = [];
    let i = 0;
    let j = 0;
    while (i < a.files.length || j < b.files.length) {
      if (i === a.files.length || (j < b.files.length && compare(b.files[j].path, a.files[i].path) < 0)) {
        const file = b.files[j++];
        result.push({ path: file.path, kind: 'added', new: file });
      } else if (j === b.files.length || compare(a.files[i].path, b.files[j].path) < 0) {
        const file = a.files[i++];
        result.push({ path: file.path, kind: 'removed', old: file });
      } else {
        const before = a.files[i++];
        const after = b.files[j++];
        if (!sameContent(before, after)) result.push({ path: after.path, kind: 'modified', old: before, new: after });
      }
    }
    return result;
  }

  const result: Change[] = [];
  const old = new Map(a.files.map(file => [file.path, file]));
  for (const file of b.files) {
    const before = old.get(file.path);
    if (!before) result.push({ path: file.path, kind: 'added', new: file });
    else if (!sameContent(before, file)) result.push({ path: file.path, kind: 'modified', old: before, new: file });
    old.delete(file.path);
  }
  for (const file of old.values()) result.push({ path: file.path, kind: 'removed', old: file });
  return result.sort((a, b) => compare(a.path, b.path));
}
