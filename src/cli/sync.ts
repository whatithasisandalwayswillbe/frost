// Keeps the scheduled job in line with config.toml, whether a command changed it or a text editor did.
// Replacing a job never stops a scheduled backup it's running: the change waits for the backup to finish.
// A change made outside Frost is applied before the next command runs, and a new storage location gets the
// same checks `frost config edit` gives it. Those commands print a line for each thing done, before their
// own output. The other settings need nothing here, because every command reads them when it runs.

import * as config from '../core/config.js';
import { location } from '../core/storage.js';
import { Context } from './context.js';
import { loadKnown, rememberChecked } from './known.js';
import { checkStorageChange } from './storagecheck.js';
import {
  desiredJob,
  loadRuns,
  processAlive,
  rememberJob,
  rememberPending,
  scheduledRunning,
  type Runs,
} from './runs.js';

// Whether the record shows a scheduled backup running now.
export const running = (ctx: Context, runs: Runs) =>
  scheduledRunning(runs, ctx.hooks.clock(), processAlive, ctx.hooks.bootTime());

// Installs or removes the scheduled job to match `cfg` and records the schedule it follows. Replacing a
// launchd job stops the backup it's running, and Task Scheduler may do the same, so while a scheduled backup
// runs there, the change is recorded as pending, a background process is started to apply it once the
// backup finishes, and this returns false. Replacing a systemd timer or a crontab line never stops a run.
// `force` applies the change anyway, for that background process once the backup is done.
export async function syncJob(ctx: Context, cfg: config.Config, force = false): Promise<boolean> {
  const job = desiredJob(cfg.schedule);
  const runs = await loadRuns();
  if (!force && running(ctx, runs) && !['systemd', 'cron'].includes(await ctx.hooks.scheduleKind())) {
    // One background process is enough, since it applies config.toml as it is when the backup finishes.
    const waiting = runs.waiter !== undefined && processAlive(runs.waiter);
    await rememberPending(job, waiting ? runs.waiter : ctx.hooks.syncLater());
    return false;
  }
  await ctx.hooks.syncSchedule(cfg);
  await rememberJob(job);
  return true;
}

// What happened to the scheduled job, to end a line. `applied` is false when the change waits for the
// running scheduled backup.
export function jobNote(cfg: config.Config, applied = true): string {
  if (applied)
    return cfg.schedule.enabled ? 'Scheduled job updated: ' + cfg.schedule.every + '.' : 'Scheduled job removed.';
  return cfg.schedule.enabled
    ? 'The scheduled job will update after the active backup process completes.'
    : 'The scheduled job will be removed after the active backup process completes.';
}

// Updates the job when config.toml asks for a different one than Frost installed. Returns the line to print,
// or '' when they already match. Without a recorded job there's nothing to compare with, so the job is left
// alone. A change already waiting for the running scheduled backup was reported when it began to wait.
export async function reconcileJob(ctx: Context, cfg: config.Config, force = false): Promise<string> {
  const runs = await loadRuns();
  if (runs.job === undefined) return '';
  const failed = (err: unknown) =>
    ctx.fmt.caution('config.toml changed, but updating the scheduled job failed: ' + ctx.fmt.errorText(err));
  let job: string;
  try {
    job = desiredJob(cfg.schedule);
  } catch (err) {
    return failed(err);
  }
  if (job === runs.job) {
    // A change that was waiting, then undone, leaves nothing to do.
    if (runs.pending !== undefined) await rememberJob(job);
    return '';
  }
  if (!force && runs.pending === job && running(ctx, runs)) return '';
  let applied: boolean;
  try {
    applied = await syncJob(ctx, cfg, force);
  } catch (err) {
    return failed(err);
  }
  return 'config.toml changed. ' + jobNote(cfg, applied);
}

// The background process `syncJob` starts while a scheduled backup runs, as `frost config --after-backup`.
// It checks every 15 seconds until no scheduled backup is running, then brings the job in line with
// config.toml as it is by then. A config.toml that's gone means Frost was uninstalled, so it removes the
// job, which could only fail without settings, and writes nothing to the cache. It prints nothing.
export async function syncAfterBackup(ctx: Context): Promise<void> {
  for (;;) {
    while (running(ctx, await loadRuns())) await ctx.hooks.wait(15_000, ctx.signal);
    let cfg: config.Config;
    try {
      cfg = await config.loadFile();
    } catch (err) {
      if (err !== config.errNoConfig) return;
      const off = config.defaultConfig();
      off.schedule.enabled = false;
      await ctx.hooks.syncSchedule(off).catch(() => {});
      return;
    }
    let job: string;
    try {
      job = desiredJob(cfg.schedule);
    } catch {
      return;
    }
    const runs = await loadRuns();
    if (job === runs.job) {
      if (runs.pending !== undefined) await rememberJob(job);
      return;
    }

    // A scheduled backup that started while this was reading gets to finish first.
    if (running(ctx, runs)) continue;
    await syncJob(ctx, cfg, true).catch(() => {});
    return;
  }
}

// Brings the job in line from inside a scheduled run. Only systemd and cron jobs can be replaced by one of
// their own runs: replacing a launchd or Task Scheduler job would stop the run, so those wait for the next
// command. Removing a job waits too, since a run does nothing while automatic backups are off.
export async function reconcileFromRun(ctx: Context): Promise<string> {
  let cfg: config.Config;
  let job: string;
  try {
    cfg = await config.loadFile();
    job = desiredJob(cfg.schedule);
  } catch {
    return '';
  }
  const installed = (await loadRuns()).job;
  if (installed === undefined || job === installed || job === 'off') return '';
  if (!['systemd', 'cron'].includes(await ctx.hooks.scheduleKind())) return '';
  return reconcileJob(ctx, cfg, true);
}

// Checks a storage location that config.toml changed to outside Frost, the first time a command uses it,
// and returns a line for each problem. Problems that stop the storage opening are left to the command,
// whose error explains them.
export async function storageNotes(ctx: Context): Promise<string[]> {
  let cfg: config.Config;
  let where: string;
  try {
    cfg = await config.load();
    where = location(ctx.hooks.backend(cfg.storage));
  } catch {
    return [];
  }
  const known = await loadKnown();
  if (!known.where || !known.storage || where === known.where || where === known.checked) return [];

  // The record leaves out credentials, so the old location is opened with today's.
  const was = structuredClone(known.storage);
  was.s3.access_key_id = cfg.storage.s3.access_key_id;
  was.s3.secret_access_key = cfg.storage.s3.secret_access_key;
  was.permafrost.token = cfg.storage.permafrost.token;
  const lines: string[] = [];
  const out = { fmt: ctx.fmt, warn: (s: string) => lines.push('config.toml changed where backups go. ' + s) };
  try {
    if (await checkStorageChange(ctx, out, was, cfg.storage, 'notice')) await rememberChecked(where);
  } catch {}
  return lines;
}

// Applies changes made outside Frost before a command runs, and prints what it did. A config.toml that
// can't be read is left for the command to report. `storage` says whether the command uses the backups.
export async function applyConfigEdits(ctx: Context, storage: boolean): Promise<void> {
  let cfg: config.Config;
  try {
    cfg = await config.loadFile();
  } catch {
    return;
  }
  const lines = [await reconcileJob(ctx, cfg), ...(storage ? await storageNotes(ctx) : [])].filter(Boolean);
  if (lines.length) ctx.fmt.write('\n' + lines.join('\n') + '\n');
}
