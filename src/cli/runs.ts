// Remembers the scheduled job frost installed, when it installed it and when the last full backup ran, one
// record per config folder. A scheduled run reads it to skip a backup that already happened and to catch up
// one that was missed, `frost status` to say when the next one is due, and `frost backup` to mention a
// scheduled backup that's due or just finished. Comparing config.toml with the recorded job shows when the
// job needs updating. The record never decides who holds the manifest lock.

import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as config from '../core/config.js';
import { hour, runAfter, runBefore, type Times } from '../platform/schedule.js';

// `job` is the schedule the installed job follows, as `desiredJob` gives it, and `pending` one waiting for a
// running scheduled backup to finish, with `waiter` the background process that will apply it. `run` is the
// last full backup, started by the scheduler or by hand, the process running it, and how it ended. Its `id`
// lets a run update its own entry and nobody else's.
export interface Runs {
  installed?: string;
  job?: string;
  pending?: string;
  waiter?: number;
  run?: { id: string; started: string; scheduled: boolean; pid?: number; finished?: string; ok?: boolean };
}

export const runsPath = () => path.join(config.cacheDir(), 'schedule-' + config.dirTag() + '.json');

// A missing, unparseable or non-object record counts as empty.
export async function loadRuns(): Promise<Runs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(runsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Runs) : {};
  } catch {
    return {};
  }
}

// Saves the record when `change` returns true. A failed write is ignored, so the record never stops a
// backup or an install.
async function updateRuns(change: (r: Runs) => boolean): Promise<void> {
  try {
    const r = await loadRuns();
    if (!change(r)) return;
    await mkdir(config.cacheDir(), { recursive: true, mode: 0o700 });
    await config.writePrivate(runsPath(), JSON.stringify(r, null, 2) + '\n');
  } catch {}
}

export const rememberInstall = (at: Date) =>
  updateRuns(r => {
    r.installed = at.toISOString();
    return true;
  });

// The job a schedule asks for: off, or its run times and catch-up setting. Throws when automatic backups
// are on and a schedule setting is invalid.
export function desiredJob(s: config.Config['schedule']): string {
  return s.enabled ? JSON.stringify({ ...config.times(s), catch_up: s.catch_up }) : 'off';
}

// Records the job now installed, which settles any change that was waiting for it.
export const rememberJob = (job: string) =>
  updateRuns(r => {
    r.job = job;
    delete r.pending;
    delete r.waiter;
    return true;
  });

export const rememberPending = (job: string, waiter?: number) =>
  updateRuns(r => {
    r.pending = job;
    if (waiter === undefined) delete r.waiter;
    else r.waiter = waiter;
    return true;
  });

// Records the start of a full backup by this process and returns its id.
export async function rememberStart(scheduled: boolean, at: Date): Promise<string> {
  const id = randomUUID();
  await updateRuns(r => {
    r.run = { id, started: at.toISOString(), scheduled, pid: process.pid };
    return true;
  });
  return id;
}

// Records how a backup ended, unless a later one has started since.
export const rememberFinish = (id: string, ok: boolean, at: Date) =>
  updateRuns(r => {
    if (r.run?.id !== id) return false;
    r.run.finished = at.toISOString();
    r.run.ok = ok;
    return true;
  });

// A run started up to a minute early still counts for its time, and one up to 10 minutes late is on time.
// systemd delays starts by up to 5 minutes.
const early = 60e3;
const late = 10 * 60e3;

// A recorded time as milliseconds. A missing or invalid time, or one in the future, which a clock change
// can leave behind, counts as unknown.
function recorded(value: string | undefined, now: Date): number | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t <= now.getTime() + early ? t : undefined;
}

// The last moment the record covers: run times up to it need no backup. A full backup covers the run
// times up to a minute after it started, and installing the job covers the ones before it. Undefined when
// the record has neither.
function coveredUntil(runs: Runs, now: Date): number | undefined {
  const started = recorded(runs.run?.started, now);
  const installed = recorded(runs.installed, now);
  const marks = [started === undefined ? undefined : started + early, installed].filter(
    (m): m is number => m !== undefined,
  );
  return marks.length ? Math.max(...marks) : undefined;
}

// Whether a scheduled run should back up. It shouldn't when the latest run time is covered. Otherwise a run
// on time backs up, and a late one, which the scheduler started after a run it missed, backs up only with
// catch-up on. However many runs were missed, the first late run covers them all.
export function due(t: Times, catchUp: boolean, runs: Runs, now: Date): boolean {
  const slot = runBefore(t, new Date(now.getTime() + early)).getTime();
  const covered = coveredUntil(runs, now);
  if (covered !== undefined && slot <= covered) return false;
  return now.getTime() <= slot + late || catchUp;
}

// When the next scheduled backup should start, by the same rules as `due`. It's 'soon' when a run time
// passed moments ago without a backup, or the record holds nothing to go by, and 'overdue' when one was
// missed and catch-up will run it. With catch-up off, a missed run is skipped, so the next run time counts.
export function nextBackup(t: Times, catchUp: boolean, runs: Runs, now: Date): Date | 'soon' | 'overdue' {
  const covered = coveredUntil(runs, now);
  if (covered === undefined) return 'soon';
  const ahead = now.getTime() + early;
  const slot = runBefore(t, new Date(ahead)).getTime();
  if (slot > covered) {
    if (now.getTime() <= slot + late) return 'soon';
    if (catchUp) return 'overdue';
  }
  return runAfter(t, new Date(Math.max(ahead, covered)));
}

// Decides for a scheduled run from the saved config and record. A job left installed after automatic
// backups were turned off in config.toml does nothing. Anything else it can't read means backing up, so
// doubt never skips a backup.
export async function scheduledDue(now: Date): Promise<boolean> {
  try {
    const cfg = await config.loadFile();
    if (!cfg.schedule.enabled) return false;
    return due(config.times(cfg.schedule), cfg.schedule.catch_up, await loadRuns(), now);
  } catch {
    return true;
  }
}

// How long before and after a scheduled backup `frost backup` asks first: an hour, or a quarter of the
// interval when that's shorter.
export const nearWindow = (t: Times) => Math.min(3600e3, t.every / 4);

// Whether a process with this id exists. One that exists but belongs to someone else counts too.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// When this computer last started, in milliseconds.
export const bootTime = () => Date.now() - os.uptime() * 1000;

// Whether a scheduled backup is running: it hasn't recorded its end, and its process is still there, however
// long a big first backup takes. A run killed by a shutdown never records its end, so a run that started
// before the last boot, allowing 5 minutes for clock adjustments, doesn't count, whatever process has its id
// now. Seven days cover an id reused
// without a reboot. A record without a process id counts for 6 hours, longer than an hour waiting for the
// backups plus a long backup.
export function scheduledRunning(runs: Runs, now: Date, alive = processAlive, booted = bootTime()): boolean {
  const run = runs.run;
  const started = recorded(run?.started, now);
  if (!run?.scheduled || run.finished || started === undefined) return false;
  const age = now.getTime() - started;
  if (!Number.isSafeInteger(run.pid)) return age < 6 * hour;
  return age < 7 * 24 * hour && started > booted - 5 * 60e3 && alive(run.pid!);
}

// A scheduled backup that starts soon, or one that worked and finished recently. A recent one only counts
// while it's still the latest full backup, so a backup by hand since then means there's nothing to say.
export function nearby(t: Times, runs: Runs, now: Date): { starts: Date } | { finished: Date } | undefined {
  const window = nearWindow(t);
  const next = runAfter(t, now);
  if (next.getTime() - now.getTime() <= window) return { starts: next };
  const finished = recorded(runs.run?.finished, now);
  if (runs.run?.scheduled && runs.run.ok && finished !== undefined && now.getTime() - finished <= window)
    return { finished: new Date(finished) };
  return undefined;
}
