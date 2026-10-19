// Remembers where this machine's backups were last opened, so a command that can't find them can say where
// they went and how to fix it. The record lives in the cache folder and never holds credentials.

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as config from '../core/config.js';
import {
  isDefaultPermafrost,
  location,
  permafrostName,
  permafrostRecoverPage,
  permafrostSupport,
  type Backend,
} from '../core/storage.js';
import { frostCommand } from './command.js';

// `where` identifies the storage location, and `shown` is how it's printed. `checked` is a location whose
// settings were already checked as a change from `where`, so using it doesn't check them again.
interface Known {
  storage?: config.Storage;
  shown?: string;
  where?: string;
  repo_id?: string;
  checked?: string;
  failed?: { time: string; error: string };
}

// One record per config folder, named after a hash of its path.
export const knownPath = () => path.join(config.cacheDir(), 'storage-' + config.dirTag() + '.json');

// A missing, unparseable or non-object record counts as empty. Older records show Permafrost as
// "permafrost:<host>", so its name is worked out again from the settings, and records from before
// self-hosted and local drive storage get those settings' defaults.
export async function loadKnown(): Promise<Known> {
  try {
    const parsed: unknown = JSON.parse(await readFile(knownPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const k = parsed as Known;
    if (k.storage && typeof k.storage === 'object') k.storage = { ...config.defaultConfig().storage, ...k.storage };
    if (k.storage?.backend === 'permafrost') k.shown = permafrostName(k.storage.permafrost?.url ?? '');
    return k;
  } catch {
    return {};
  }
}

async function saveKnown(k: Known): Promise<void> {
  await mkdir(config.cacheDir(), { recursive: true, mode: 0o700 });
  await config.writePrivate(knownPath(), JSON.stringify(k, null, 2) + '\n');
}

// Records a storage that opened, with its credentials blanked. It only writes when something changed, and
// a failed write is ignored.
export async function rememberStorage(s: config.Storage, b: Backend, id: string): Promise<void> {
  const copy = structuredClone(s);
  copy.s3.access_key_id = '';
  copy.s3.secret_access_key = '';
  copy.permafrost.token = '';
  const known = { storage: copy, shown: String(b), where: location(b), repo_id: id };
  const old = await loadKnown();
  if (JSON.stringify(old) !== JSON.stringify(known)) await saveKnown(known).catch(() => {});
}

// Records that a change to the location `where` has been checked.
export async function rememberChecked(where: string): Promise<void> {
  const k = await loadKnown();
  k.checked = where;
  await saveKnown(k).catch(() => {});
}

// Records the last failure to open the storage, for `frost status`.
export async function rememberFailure(err: Error): Promise<void> {
  const k = await loadKnown();
  k.failed = { time: new Date().toISOString(), error: err.message };
  await saveKnown(k).catch(() => {});
}

// Backups move by hand only between storages with folders. Permafrost has none, so with it on either side, no
// move is suggested.
export const movable = (...storages: (config.Storage | undefined)[]) =>
  storages.every(s => s?.backend !== 'permafrost');

// How to move existing backups to `shown`.
export const moveHint = (shown: string) =>
  'move the whole folder (frost.repo, chunks/, snapshots/ and trees/) to ' + shown;

// The settings that decide where backups live. After a change of backend, nothing else is compared.
function changedStorage(a: config.Storage, b: config.Storage): { key: string; was: string; now: string }[] {
  const result: { key: string; was: string; now: string }[] = [];
  const add = (key: string, was: string, now: string) => {
    if (was !== now) result.push({ key, was, now });
  };
  add('storage.backend', a.backend, b.backend);
  if (a.backend !== b.backend) return result;
  if (b.backend === 's3') {
    add('storage.s3.endpoint', a.s3.endpoint, b.s3.endpoint);
    add('storage.s3.bucket', a.s3.bucket, b.s3.bucket);
    add('storage.s3.prefix', a.s3.prefix, b.s3.prefix);
  } else if (b.backend === 'permafrost') add('storage.permafrost.url', a.permafrost.url, b.permafrost.url);
  else if (b.backend === 'sftp') {
    add('storage.sftp.host', a.sftp.host, b.sftp.host);
    add('storage.sftp.port', String(a.sftp.port), String(b.sftp.port));
    add('storage.sftp.path', a.sftp.path, b.sftp.path);
  } else if (b.backend === 'local') add('storage.local.path', a.local.path, b.local.path);
  return result;
}

// Quotes a setting value for the comparison text, if it's empty or has spaces or quotes in it.
const quoteValue = (v: string): string => (!v || /[ \t'"]/.test(v) ? JSON.stringify(v) : v);

// Explains a repository missing from where it was last opened. Backups in a folder were probably moved, and on a
// drive, another drive may be mounted in its place. Permafrost refuses the access key once it removes an account's
// backups itself, so with the key still working, they were most likely deleted using it.
function goneHint(s: config.Storage): string {
  const here = 'This is where your backups were.';
  if (s.backend === 'local')
    return (
      here +
      ' If another drive is connected in its place, connect the one with your backups. If you moved them, move all of them back, or point frost at where they are now.'
    );
  if (s.backend !== 'permafrost')
    return here + ' If you moved them, move all of them back, or point frost at where they are now.';
  if (!isDefaultPermafrost(s.permafrost.url)) return here + ' Ask whoever runs this server what happened to them.';
  return (
    here +
    ' Permafrost keeps backups while their access key works, so they were most likely deleted using yours. Email ' +
    permafrostSupport +
    ' straight away. If someone else might have your key, get a new one at ' +
    permafrostRecoverPage.replace('https://', '') +
    '.'
  );
}

// Explains where the backups might be. If the repository is missing from where it was last opened, goneHint says
// why. If the settings now point elsewhere, it lists what changed and offers ways out.
function storageHint(k: Known, s: config.Storage, b: Backend, missing: boolean): string {
  if (!k.where) return '';
  if (k.where === location(b)) return missing ? goneHint(s) : '';

  const changed = k.storage ? changedStorage(k.storage, s) : [];
  const lines = ['Your backups were last opened in ' + k.shown + '.'];
  changed.forEach(c => lines.push(`Since then ${c.key} changed from ${quoteValue(c.was)} to ${quoteValue(c.now)}.`));
  if (!changed.length && s.backend === 'permafrost')
    lines.push('Since then storage.permafrost.token changed, so this may be a different Permafrost account.');

  // The quickest way back is the command that undoes the change.
  let back = 'frost init, pointed back at ' + k.shown;
  if (k.storage?.backend === s.backend) {
    if (changed.length) {
      back = 'frost config edit, and set ' + changed.map(c => c.key + ' to ' + quoteValue(c.was)).join(' and ');
      if (changed.length === 1)
        try {
          back = frostCommand(['config', 'set', changed[0].key, changed[0].was]);
        } catch {
          // Values the platform shell can't preserve use the existing editor hint.
        }
    } else if (s.backend === 'permafrost') back = 'frost init, with the access key you used before';
  }
  lines.push('', 'Do one of these:', '  put it back:       ' + back);
  if (movable(k.storage, s)) lines.push('  keep the change:   ' + moveHint(String(b)));
  lines.push('  start over there:  frost init (your old backups stay where they are)');
  return lines.join('\n');
}

// An error opening the repository, with a hint about where the backups went. Backup records it, and
// `frost status` shows it in a storage row.
export class StorageError extends Error {}

export async function cantOpen(
  problem: string,
  s: config.Storage,
  b: Backend,
  missing: boolean,
): Promise<StorageError> {
  const hint = storageHint(await loadKnown(), s, b, missing);
  return new StorageError(problem + (hint ? '\n\n' + hint : ''));
}
