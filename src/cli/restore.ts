// `frost restore` restores a snapshot beside the originals, into another folder or over the originals.
// Without a snapshot it opens the snapshot browser.

import path from 'node:path';
import { stat } from 'node:fs/promises';
import * as config from '../core/config.js';
import { resolve, restoreBase, shorten, shortOf } from '../core/snapshot.js';
import { besideFolder, newRestoreFolder, canOverwrite, RestoreError } from '../engine/index.js';
import { slash } from '../engine/exclude.js';
import { Context } from './context.js';
import { ago, when, tildify, humanCount, humanBytes, printable, statusLine } from './format.js';
import { requireConfirmation } from './prompt.js';
import { frostCommand } from './command.js';

interface RestoreFlags {
  beside: boolean;
  to: string;
  overwrite: boolean;
  yes: boolean;
  configDir?: string;
  cacheDir?: string;
}

// The command that carries on an interrupted restore. Ordinary Windows paths work in cmd and PowerShell.
// Paths containing shell expansion characters use PowerShell literals and the runtime directly, avoiding
// frost.cmd's extra round of argument expansion.
export function rerunCommand(
  id: string,
  paths: string[],
  flags: RestoreFlags,
  platform: NodeJS.Platform = process.platform,
): string {
  const args = [
    'restore',
    id,
    ...paths.map(p => (platform === 'win32' ? p.replaceAll('/', '\\') : p)),
    ...(flags.beside ? ['--beside'] : flags.to ? ['--to', flags.to] : flags.overwrite ? ['--overwrite'] : []),
    ...(flags.configDir ? ['--config-dir', flags.configDir] : []),
    ...(flags.cacheDir ? ['--cache-dir', flags.cacheDir] : []),
  ];
  return frostCommand(args, platform);
}

export async function runRestore(ctx: Context, args: string[], flags: RestoreFlags): Promise<void> {
  if (!args.length) {
    if (!ctx.inputTTY) throw new Error('say which snapshot to restore, e.g. `frost restore latest`');
    if (ctx.hooks.browser) return ctx.hooks.browser(ctx);
    const { runBrowser } = await import('./tui.js');
    return runBrowser(ctx);
  }

  // Exactly one destination flag must be given.
  const n = Number(flags.beside) + Number(flags.overwrite) + Number(!!flags.to);
  if (!n) throw new Error('choose where to restore: --beside, --to <dir> or --overwrite');
  if (n > 1) throw new Error('choose only one of --beside, --to and --overwrite');
  if (flags.to) {
    flags.to = path.resolve(config.expand(flags.to));
    if (!(await stat(flags.to).catch(() => undefined))?.isDirectory())
      throw new Error("there's no folder at " + tildify(flags.to));
  }

  const a = await ctx.openApp();
  try {
    // Paths are made slash-separated to match the snapshot's. Without any, a new folder is laid out from
    // the snapshot's own folders, and --overwrite restores everything in place.
    const snaps = await a.engine.repo.snapshots(a.engine.manifest!.snapshots(), ctx.signal);
    const snap = resolve(snaps, args[0]);
    const rerunInclude = args.slice(1).map(p => slash(path.resolve(config.expand(p))));
    const rerun = rerunCommand(snap.id, rerunInclude, {
      ...flags,
      ...(process.env.FROST_CONFIG_DIR ? { configDir: path.resolve(config.dir()) } : {}),
      ...(process.env.FROST_CACHE_DIR ? { cacheDir: path.resolve(config.cacheDir()) } : {}),
    });
    const include = rerunInclude.length || flags.overwrite ? rerunInclude : snap.paths;

    // Check the destination before showing anything. A new folder may pick up an unfinished restore of the
    // same snapshot and paths.
    let base = restoreBase(include);
    let target = '';
    let resume = false;
    if (flags.beside) {
      try {
        ({ dir: target, resume } = await besideFolder(base, snap.id, include));
      } catch (err) {
        throw new Error("can't restore beside the originals: " + (err as Error).message + '. Use --to <dir> instead');
      }
    } else if (flags.to) ({ dir: target, resume } = await newRestoreFolder(flags.to, snap.id, include));
    else {
      try {
        await canOverwrite(include.length ? include : snap.paths);
      } catch (err) {
        throw new Error(
          "can't overwrite the originals: " + (err as Error).message + '. Use --beside or --to <dir> instead',
        );
      }
    }

    const p = ctx.prompt();
    p.open('restore ' + shortOf(shorten(snaps), snap.id), when(snap.time) + ' (' + ago(snap.time) + ')');
    p.gap();
    p.row('paths', include.length ? include.map(printable).join('\n') : 'everything');
    if (target)
      p.row(
        'into',
        printable(tildify(target)) + (resume ? ctx.fmt.dim(', carrying on with the unfinished restore there') : ''),
      );
    else {
      // Restoring in place has no base, so every file goes back to its original path.
      base = '';
      p.warnRow('into', 'original locations ' + ctx.fmt.caution('(existing files will be replaced)'));
    }
    if (flags.overwrite && !flags.yes) {
      p.gap();
      await requireConfirmation(p.yesNo('Go ahead?', false));
    }

    // Progress redraws at most every 100 ms. The checking phase compares what's already on disk.
    let last = 0;
    try {
      const res = await a.engine.restore(
        snap.id,
        {
          target,
          newTarget: !!target,
          base,
          include,
          progress:
            ctx.outputTTY && ctx.ansiOK
              ? pr => {
                  if (Date.now() - last < 100) return;
                  last = Date.now();
                  const name = ctx.fmt.dim(printable(path.posix.basename(pr.path)));
                  statusLine(
                    ctx.fmt.write,
                    ctx.fmt.railed(
                      pr.checking
                        ? `checking what's already there, ${humanBytes(pr.bytes)} of ${humanBytes(pr.totalBytes)}  ${name}`
                        : `${humanCount(pr.files)}/${humanCount(pr.totalFiles)} files, ${humanBytes(pr.bytes)} of ${humanBytes(pr.totalBytes)}  ${name}`,
                    ),
                    ctx.width,
                  );
                }
              : undefined,
        },
        ctx.signal,
      );
      if (ctx.outputTTY && ctx.ansiOK) ctx.fmt.write('\r\x1b[K');
      p.gap();
      p.close(
        ctx.fmt.good('Restored') +
          ` ${humanCount(res.files)} files (${humanBytes(res.bytes)}), every chunk checked against its hash.`,
      );
    } catch (err) {
      // An unfinished restore keeps what's done, and the error says how to carry on.
      if (ctx.outputTTY && ctx.ansiOK) ctx.fmt.write('\r\x1b[K');
      if (err instanceof RestoreError && err.result.unfinished)
        throw new Error(
          err.message +
            "\n\nWhat's restored so far was kept. To carry on from there, run" +
            (rerun.startsWith('& ') ? ' in PowerShell' : '') +
            ':\n\n  ' +
            rerun,
        );
      throw err;
    }
  } finally {
    await a.close();
  }
}
