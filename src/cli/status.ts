// `frost status` shows the last backup, the next scheduled run, repository health, updates and recent
// snapshots. If the storage can't be opened, it still shows what went wrong.

import * as config from '../core/config.js';
import { shortOf, shorten, timeValue, type Snapshot } from '../core/snapshot.js';
import { Engine, goneText } from '../engine/index.js';
import * as update from '../platform/update.js';
import { Context } from './context.js';
import { ago, Block, humanBytes, humanCount, inTime, plural, printable, when } from './format.js';
import { missingList, readUsage, usageNotice } from './backup.js';
import { loadKnown, moveHint, StorageError } from './known.js';
import { updateSummary, updateStatePath } from './update.js';
import { loadRuns, nextBackup } from './runs.js';

// Returns the next-backup row and how bad it is, where 0 is fine, 1 is a warning and 2 is a failure. The
// next backup follows the schedule's calendar, by the same rules scheduled runs use, so a backup by hand
// doesn't move it.
async function nextRun(ctx: Context, cfg: config.Config): Promise<[string, number]> {
  if (!cfg.schedule.enabled)
    return [
      ctx.fmt.dim('automatic backups are off (') + 'frost config set schedule.enabled true' + ctx.fmt.dim(')'),
      0,
    ];
  let times;
  try {
    times = config.times(cfg.schedule);
  } catch (err) {
    return [ctx.fmt.error((err as Error).message), 2];
  }
  if (!(await ctx.hooks.scheduleInstalled()))
    return [
      ctx.fmt.caution('scheduled job is missing, run `frost init` or `frost config set schedule.enabled true`'),
      1,
    ];
  const how = ctx.fmt.dim('  ' + cfg.schedule.every + ' via ' + (await ctx.hooks.scheduleKind()));
  const now = ctx.hooks.clock();
  const next = nextBackup(times, cfg.schedule.catch_up, await loadRuns(), now);
  if (next === 'soon') return ['soon' + how, 0];
  return ['~' + (next === 'overdue' ? next : inTime(next.getTime(), now.getTime())) + how, 0];
}

// The snapshot table, closing the block. It shows the latest 10 unless `all` is set.
export function printSnapshots(b: Block, snaps: Snapshot[], short: Map<string, string>, all: boolean): void {
  if (!snaps.length) {
    b.close('No snapshots yet. Run ' + b.fmt.bold('frost backup') + '.');
    return;
  }
  const shown = all ? snaps : snaps.slice(0, 10);
  const width = shown.reduce((w, s) => Math.max(w, shortOf(short, s.id).length), 'snapshot'.length);
  const row = (id: string, taken: string, files: string, size: string, newer: string) =>
    id.padEnd(width) +
    '    ' +
    taken.padEnd(16) +
    '    ' +
    files.padStart(8) +
    '    ' +
    size.padStart(9) +
    '    ' +
    newer.padStart(9);

  b.section('snapshots');
  b.gap();
  b.line(b.fmt.dim(row('snapshot', 'taken', 'files', 'size', 'new')));
  shown.forEach(s =>
    b.line(
      row(
        shortOf(short, s.id),
        when(s.time),
        humanCount(s.stats.files),
        humanBytes(s.stats.bytes),
        humanBytes(s.stats.new_bytes),
      ),
    ),
  );
  if (shown.length < snaps.length) {
    b.line(b.fmt.dim('+' + (snaps.length - shown.length)));
    b.gap();
    b.close('See all snapshots with ' + b.fmt.bold('frost status --all'));
  } else b.close();
}

export async function runStatus(ctx: Context, verify: boolean, all: boolean): Promise<void> {
  // If the storage can't be opened, show why and whether the last backup failed too, then fail.
  let a;
  try {
    a = await ctx.openApp();
  } catch (err) {
    if (!(err instanceof StorageError)) throw err;
    const b = ctx.fmt.block();
    b.open('frost', ctx.version);
    b.gap();
    b.failRow('storage', ctx.fmt.error('problem: ') + ctx.fmt.errorText(err));
    const k = await loadKnown();
    if (k.failed)
      b.failRow(
        'last backup',
        ctx.fmt.error('failed ') + ago(k.failed.time) + ctx.fmt.dim(", it couldn't open the storage either"),
      );
    b.gap();
    throw new Error("can't open your backups");
  }

  try {
    const e = a.engine;
    const f = ctx.fmt;
    const b = f.block();
    let verifyFailed = false;
    b.open('frost', ctx.version + '  ' + printable(String(e.repo.backend)) + '  key ' + e.repo.key.fingerprint());
    b.gap();

    // --verify checks a sample now. A failure is reported at the end, after the rest of the status.
    if (verify) {
      const n = a.cfg.verify.sample || 20;
      f.write(f.railed(f.dim(`Checking ${n} random chunks... `)));
      try {
        const v = await e.verify(n, true, ctx.signal);
        verifyFailed = !!v.failures?.length;
      } catch (err) {
        f.write('\n');
        throw err;
      }
      f.write(f.dim('done') + '\n');
      b.gap();
    }

    // Sort newest first.
    const { snaps, missing } = await e.refreshSnapshots(ctx.signal);
    snaps.sort((a, b) => (timeValue(a.time) > timeValue(b.time) ? -1 : timeValue(a.time) < timeValue(b.time) ? 1 : 0));
    const short = shorten(snaps);
    const last = e.lastBackup();

    if (!last) b.row('last backup', f.dim('never'));
    else if (last.error)
      b.failRow('last backup', f.error('failed') + ' ' + ago(last.time) + ': ' + printable(last.error));
    else if (last.missing?.length || last.skipped || last.kept) {
      const buts: string[] = [];
      if (last.missing?.length) buts.push('not found: ' + missingList(last.missing));
      if (last.skipped) buts.push(`${last.skipped} items couldn't be read`);
      if (last.kept) buts.push(`${last.kept} busy files kept their previous copy`);
      b.warnRow(
        'last backup',
        f.caution('ok, but ' + buts.join('; ') + ' ') +
          ago(last.time) +
          f.dim('  ' + shortOf(short, last.snapshot_id ?? '')),
      );
    } else if (last.unchanged)
      b.row(
        'last backup',
        f.good('ok ') + ago(last.time) + f.dim(', nothing new since ' + shortOf(short, last.snapshot_id ?? '')),
      );
    else b.row('last backup', f.good('ok ') + ago(last.time) + f.dim('  ' + shortOf(short, last.snapshot_id ?? '')));

    const [next, level] = await nextRun(ctx, a.cfg);
    if (level === 2) b.failRow('next backup', next);
    else if (level === 1) b.warnRow('next backup', next);
    else b.row('next backup', next);

    const v = e.lastVerify();
    if (!v) b.row('health', f.dim('not checked yet'));
    else if (!v.failures?.length) b.row('health', f.good('ok ') + `${v.checked} objects checked ${ago(v.time)}`);
    else
      b.failRow(
        'health',
        f.error(`${v.failures.length} of ${v.checked} checks failed`) +
          ' ' +
          ago(v.time) +
          v.failures.map(s => '\n' + printable(s)).join('') +
          '\n' +
          f.dim('Run a new backup to re-upload anything missing, then `frost status --verify`.'),
      );

    const [updates, warn] = updateSummary(a.cfg, await update.loadState(updateStatePath()), ctx.version);
    if (warn) b.warnRow('updates', f.caution(printable(updates)));
    else b.row('updates', printable(updates));

    if (snaps.length)
      b.row(
        'protected',
        `${humanCount(snaps[0].stats.files)} files, ${humanBytes(snaps[0].stats.bytes)}, in ${plural(snaps.length, 'snapshot')}`,
      );

    // Storage that reports its use gets a row, which leads with the storage's warning when it has one.
    const used = await readUsage(e.repo.backend, ctx.signal);
    if (used) {
      const amount = humanBytes(used.used) + (used.quota ? ' of ' + humanBytes(used.quota) : '') + ' used';
      if (used.message) b.warnRow('storage', f.caution(usageNotice(used)) + '\n' + f.dim(amount));
      else b.row('storage', amount);
    }

    // `missing` counts snapshots the manifest knew about that storage no longer has.
    if (missing)
      b.warnRow(
        'missing',
        f.caution(goneText(missing) + '.') +
          '\n' +
          f.dim('If you moved your backups, ' + moveHint(a.cfg.storage, String(e.repo.backend)) + '.'),
      );

    b.gap();
    printSnapshots(b, snaps, short, all);
    if (verifyFailed) throw new Error('verification failed');
  } finally {
    await a.close();
  }
}
