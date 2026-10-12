// `frost backup` runs the engine, prints the result block and spot-checks a sample of stored objects.
// Scheduled runs also keep a log and check for updates afterwards.

import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { existing, openRoot, sameFile, type RootFile } from '../platform/fs-root.js';
import * as config from '../core/config.js';
import { shorten, shortOf, compare } from '../core/snapshot.js';
import type { Backend, Usage } from '../core/storage.js';
import { changesNone, type BackupResult, type Changes, type Progress } from '../engine/index.js';
import { code, message } from '../engine/types.js';
import { Context } from './context.js';
import {
  ago,
  Block,
  Format,
  humanBytes,
  humanCount,
  plural,
  printable,
  statusLine,
  strip,
  tildify,
  cellWidth,
  truncateLeft,
  nativePath,
} from './format.js';
import { sentence } from '../tui/render.js';
import { StorageError, rememberFailure } from './known.js';
import { autoUpdate } from './update.js';

interface BackupFlags {
  paths: string[];
  exclude: string[];
  dryRun: boolean;
  noVerify: boolean;
  scheduled: boolean;
  logFile: string;
}

// Sums up what changed since the last snapshot, files first, then folders.
function changesText(c: Changes): string {
  const parts: string[] = [];
  for (const key of ['added', 'changed', 'removed'] as const)
    if (c.files[key]) parts.push(humanCount(c.files[key]) + ' ' + key);
  for (const key of ['added', 'changed', 'removed'] as const)
    if (c.folders[key]) parts.push(plural(c.folders[key], 'folder') + ' ' + key);
  return parts.join(', ');
}

// Up to ten items, one per line, then a count of the rest.
function someOf(items: string[], total: number): string {
  return (
    items
      .slice(0, 10)
      .map(s => '\n  ' + printable(s))
      .join('') +
    (total > Math.min(items.length, 10) ? '\n  ... and ' + (total - Math.min(items.length, 10)) + ' more' : '')
  );
}

// Reads how much the storage holds, when it reports that. A failure only means there's nothing to show.
export async function readUsage(backend: Backend, signal?: AbortSignal): Promise<Usage | undefined> {
  if (!backend.usage) return undefined;
  try {
    return await backend.usage(signal);
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

// The storage's own warning, such as an account that's nearly full, as a sentence.
export const usageNotice = (u: Usage) => printable(sentence(u.message));

export const missingList = (paths: string[]) => paths.map(p => printable(tildify(nativePath(p)))).join(', ');

// Terminal apps by their TERM_PROGRAM value, for naming the app macOS asks about.
const terminalApps: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm',
  vscode: 'Visual Studio Code',
  WarpTerminal: 'Warp',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
};

// What to allow when macOS refuses a backup. macOS asks a scheduled run about the bundled runtime itself, and a
// run started in a terminal about that terminal app.
export function accessHint(scheduled: boolean, runtime = process.execPath, env = process.env): string {
  const open =
    'macOS blocks access to some folders until you allow it. Open System Settings > Privacy & Security > Full Disk Access and ';
  if (scheduled) return open + 'add or switch on ' + runtime;
  const app = terminalApps[env.TERM_PROGRAM ?? ''];
  return (
    open +
    (app ? 'allow ' + app + ', the app frost ran in' : 'allow the terminal app frost ran in') +
    '. Scheduled backups need ' +
    runtime +
    ' on that list too'
  );
}

// The rows for a finished backup, including any folders that weren't found and files that couldn't be read.
export function printBackup(b: Block, res: BackupResult): void {
  const s = res.snapshot;
  const f = b.fmt;

  if (res.compared && !res.unchanged && !changesNone(res.changes)) b.row('changes', changesText(res.changes));
  b.row('files', humanCount(s.stats.files) + ' (' + humanBytes(s.stats.bytes) + ')');

  // An unchanged backup that still uploaded something was replacing chunks storage had lost.
  const uploaded = `${humanBytes(s.stats.new_bytes)} in ${humanCount(s.stats.new_chunks)} chunks ${f.dim('(' + humanBytes(s.stats.uploaded_bytes) + ' uploaded after compression)')}`;
  if (res.unchanged && s.stats.new_chunks > 0 && !s.stats.kept)
    b.row('new data', uploaded + '\n' + f.dim('Uploaded again because storage was missing them.'));
  else if (s.stats.new_chunks > 0) b.row('new data', uploaded);
  else if (!res.unchanged) b.row('new data', 'none');

  if (s.missing?.length)
    b.warnRow(
      'not found',
      f.caution(missingList(s.missing)) +
        '\n' +
        f.dim("Skipped until they're back. If one moved, update it with `frost init`."),
    );
  if (s.stats.skipped)
    b.warnRow(
      'skipped',
      f.caution(`${s.stats.skipped} items couldn't be read:`) + someOf(s.warnings ?? [], s.stats.skipped),
    );
  if (s.stats.kept)
    b.warnRow(
      'kept',
      f.caution(`${s.stats.kept} files kept changing while they were read, so the snapshot has their previous copy:`) +
        someOf(
          (s.kept ?? []).map(p => tildify(nativePath(p))),
          s.stats.kept,
        ),
    );
}

// Lists every file a dry run would upload new data from, sorted by path, and closes the block.
export function printDryRun(b: Block, res: BackupResult, short: Map<string, string>): void {
  const s = res.snapshot;
  const f = b.fmt;

  b.gap();
  if (res.compared && !res.unchanged && !changesNone(res.changes)) b.row('changes', changesText(res.changes));
  b.row('files', humanCount(s.stats.files) + ' (' + humanBytes(s.stats.bytes) + ')');
  if (s.missing?.length) b.warnRow('not found', f.caution(missingList(s.missing)));
  b.gap();

  if (res.unchanged) {
    b.close(
      'Nothing has changed since snapshot ' +
        f.bold(shortOf(short, s.id)) +
        ', saved ' +
        ago(s.time) +
        ", so there's nothing to back up.",
    );
    return;
  }

  if (!res.planned.length) b.line('No new data to upload. Everything in these files is already stored.');
  else {
    b.line('Would upload new data from ' + plural(res.planned.length, 'file') + ':');
    b.gap();
    [...res.planned]
      .sort((a, b) => compare(a.path, b.path))
      .forEach(p => b.line(humanBytes(p.newBytes).padStart(10) + '  ' + printable(tildify(nativePath(p.path)))));
    b.gap();
    b.row(
      'total',
      f.bold(humanBytes(s.stats.new_bytes)) +
        ` new, in ${humanCount(s.stats.new_chunks)} chunks, out of ${humanBytes(s.stats.bytes)} scanned`,
    );
  }
  b.gap();
  b.close('Nothing was uploaded. Run without ' + f.bold('--dry-run') + ' to back up.');
}

// Opens the scheduled run log for appending through a retained folder handle. It refuses links and
// anything that isn't a regular file, and checks the file didn't change between steps. A log over 1 MiB
// starts again from empty.
export async function openScheduledLog(p: string) {
  const root = await openRoot(path.dirname(p), { create: true, mode: 0o700, trustedFinalLink: true });
  const name = path.basename(p);

  let file: RootFile | undefined;
  try {
    const before = existing(root, name);
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1))
      throw new Error('scheduled run log must be a regular file');
    file = root.open(name, { write: true, create: true, append: true, mode: 0o600 });

    // The open handle, the name and anything there before must all be the same file.
    const current = file.stat();
    const after = root.lstat(name);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      current.nlink !== 1 ||
      !sameFile(current, after) ||
      (before && !sameFile(before, current))
    )
      throw new Error('scheduled run log changed while opening it');

    if (current.size > 1 << 20) {
      const trim = root.open(name, { write: true });
      try {
        const stat = trim.stat();
        if (stat.nlink !== 1 || !sameFile(stat, current))
          throw new Error('scheduled run log changed while trimming it');
        trim.truncate(0);
      } finally {
        trim.close();
      }
    }

    const held = file;
    return {
      stat: async () => held.stat(),
      write: async (data: string | Buffer) => {
        if (held.stat().nlink !== 1) throw new Error('scheduled run log must have one hardlink');
        held.writeFile(data);
        return { bytesWritten: Buffer.byteLength(data) };
      },
      close: async () => {
        try {
          held.close();
        } finally {
          root.close();
        }
      },
    };
  } catch (error) {
    try {
      file?.close();
    } finally {
      root.close();
    }
    throw error;
  }
}

export async function runBackup(ctx: Context, flags: BackupFlags): Promise<void> {
  if (flags.logFile && !flags.scheduled) throw new Error('--log-file requires --scheduled');

  let log: { write(data: string | Buffer): Promise<{ bytesWritten: number }>; close(): Promise<void> } | undefined;
  let pending = Promise.resolve();
  const oldFmt = ctx.fmt;

  // Log writes are chained so they land in order, and a failed write never fails the backup.
  const queueLog = (text: string) => {
    pending = pending
      .then(() => log!.write(text))
      .then(
        () => {},
        () => {},
      );
  };

  let error: unknown;
  try {
    if (flags.scheduled) {
      // On Windows, or with --log-file, frost writes the log itself and copies everything it prints there
      // without styling. Elsewhere the scheduler collects the output, so this only trims an oversized log.
      if (flags.logFile || process.platform === 'win32') {
        try {
          log = await (ctx.hooks.scheduledLog ?? openScheduledLog)(
            flags.logFile || path.join(config.cacheDir(), 'frost.log'),
          );
          const write = ctx.fmt.write;
          ctx.fmt = new Format(
            s => {
              queueLog(strip(s));
              write(s);
            },
            ctx.fmt.colors,
            ctx.fmt.profile,
          );
        } catch (err) {
          ctx.error("couldn't open scheduled run log: " + ctx.fmt.errorText(err) + '\n');
        }
      } else {
        const p = path.join(config.cacheDir(), 'frost.log');
        const st = await lstat(p).catch(() => undefined);
        if (st?.isFile() && !st.isSymbolicLink() && st.size > 1 << 20) {
          const f = await openScheduledLog(p).catch(() => undefined);
          await f?.close();
        }
      }
      ctx.fmt.write('[' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '] scheduled backup starting\n');
    }

    // A storage failure is remembered so `frost status` can show it.
    let a;
    try {
      a = await ctx.openApp();
    } catch (err) {
      if (err instanceof StorageError) await rememberFailure(err);
      throw err;
    }

    try {
      const { cfg, engine: e } = a;
      const b = ctx.fmt.block();
      b.open(flags.dryRun ? 'dry run' : 'backup', printable(String(e.repo.backend)));

      // Progress redraws at most every 100 ms, and only on an interactive terminal.
      let last = 0;
      const progress =
        !flags.scheduled && ctx.outputTTY && ctx.ansiOK
          ? (p: Progress) => {
              if (Date.now() - last < 100) return;
              last = Date.now();
              let name = printable(tildify(nativePath(p.path)));
              if (cellWidth(name) > 40) name = '...' + truncateLeft(name, 37);
              statusLine(
                ctx.fmt.write,
                ctx.fmt.railed(
                  `${humanCount(p.files)} files, ${humanBytes(p.bytes)} scanned, ${humanBytes(p.newBytes)} new  ${ctx.fmt.dim(name)}`,
                ),
                ctx.width,
              );
            }
          : undefined;

      let res: BackupResult;
      try {
        res = await e.backup(
          {
            paths: flags.paths.length ? flags.paths : cfg.paths.map(config.expand),
            exclude: [...cfg.exclude.map(config.expand), ...flags.exclude],
            dryRun: flags.dryRun,
            progress,
          },
          ctx.signal,
        );
      } catch (err) {
        // On macOS a permission error anywhere in the cause chain gets a Full Disk Access hint.
        let reason: unknown = err;
        let denied = false;
        while (reason) {
          denied ||= code(reason) === 'EACCES' || code(reason) === 'EPERM';
          reason = (reason as Error).cause;
        }
        if (process.platform === 'darwin' && denied)
          throw new Error(message(err) + '\n\n' + accessHint(flags.scheduled), { cause: err });
        throw err;
      } finally {
        if (progress) ctx.fmt.write('\r\x1b[K');
      }

      const short = shorten([...e.manifest!.snapshots().values()]);
      if (flags.dryRun) {
        printDryRun(b, res, short);
        return;
      }
      b.gap();
      printBackup(b, res);

      // Spot-check a random sample of stored objects. An unchanged backup reuses the last check unless a
      // new one is due.
      if (cfg.verify.sample > 0 && !flags.noVerify) {
        const last = e.lastVerify();
        if (last && res.unchanged && !e.verifyDue())
          b.row('verified', ctx.fmt.good('ok ') + `${ago(last.time)}, ${last.checked} objects checked`);
        else {
          let v;
          try {
            v = await e.verify(cfg.verify.sample, false, ctx.signal);
          } catch (err) {
            b.failRow('verified', "couldn't run: " + message(err));
            throw new Error("verification couldn't complete: " + message(err), { cause: err });
          }
          if (!v.failures?.length)
            b.row(
              'verified',
              ctx.fmt.good('ok') + ctx.fmt.dim(`, ${v.checked} random objects re-downloaded and checked`),
            );
          else {
            b.failRow(
              'verified',
              ctx.fmt.error('failed') + `, ${v.failures.length} of ${v.checked} checks didn't pass:`,
            );
            v.failures.forEach(f => b.row('', '  ' + printable(f)));
            throw new Error('verification failed, see `frost status`');
          }
        }
      }

      // Storage that reports its use can warn that it's nearly full.
      const used = await readUsage(e.repo.backend, ctx.signal);
      if (used?.message) b.warnRow('storage', ctx.fmt.caution(usageNotice(used)));

      b.gap();
      b.close(
        res.unchanged
          ? ctx.fmt.good('Already backed up.') +
              ' Nothing has changed since snapshot ' +
              ctx.fmt.bold(shortOf(short, res.snapshot.id)) +
              ', saved ' +
              ago(res.snapshot.time) +
              '.'
          : ctx.fmt.good('Saved') + ' snapshot ' + ctx.fmt.bold(shortOf(short, res.snapshot.id)),
      );
    } finally {
      await a.close();
    }
  } catch (err) {
    error = err;
    throw err;
  } finally {
    // A scheduled run logs its error, then checks for updates. The original formatter comes back last and
    // keeps the block state, so the error line still knows whether to close a block.
    try {
      if (flags.scheduled) {
        if (log && error) queueLog(strip(ctx.fmt.errorLine(error, ctx.fmt.blockOpen)) + '\n\n');
        await autoUpdate(ctx);
      }
    } finally {
      try {
        await pending;
        await log?.close();
      } finally {
        if (log) {
          oldFmt.blockOpen = ctx.fmt.blockOpen;
          ctx.fmt = oldFmt;
        }
      }
    }
  }
}
