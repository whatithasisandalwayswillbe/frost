// Tests for when a scheduled run backs up and when a backup by hand asks first. Every time is a local time
// passed in, so results don't depend on the real clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  desiredJob,
  due,
  loadRuns,
  nearby,
  nextBackup,
  nearWindow,
  processAlive,
  rememberFinish,
  rememberInstall,
  rememberJob,
  rememberPending,
  rememberStart,
  scheduledRunning,
  runsPath,
  scheduledDue,
  type Runs,
} from '../../src/cli/runs.js';
import { hour } from '../../src/platform/schedule.js';
import { defaultConfig } from '../../src/core/config.js';

const daily = { every: 24 * hour, hour: 15, minute: 0, day: 0 };
const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s);
const started = (time: Date, scheduled = true): Runs => ({ run: { id: 'x', started: time.toISOString(), scheduled } });

// Yesterday's backup covered yesterday's run time. Today's backs up when the scheduler starts it on time,
// up to a minute early, or up to 10 minutes late, which covers systemd's random delay.
test('a scheduled run backs up once for each run time', () => {
  const yesterday = started(at(16, 15, 0, 5));
  for (const now of [at(17, 15), at(17, 14, 59, 30), at(17, 15, 9)])
    assert.equal(due(daily, false, yesterday, now), true);

  // A second start for the same run time, like launchd's at login, does nothing.
  assert.equal(due(daily, true, started(at(17, 15)), at(17, 18)), false);

  // A backup by hand that started up to a minute before the run time covers it. An earlier one doesn't.
  assert.equal(due(daily, false, started(at(17, 14, 59, 10), false), at(17, 15)), false);
  assert.equal(due(daily, false, started(at(17, 14, 50), false), at(17, 15)), true);
});

test('a missed run is caught up once, and only with catch-up on', () => {
  // The computer was off for three days. The first late start backs up once for all of them.
  const old = started(at(13, 15));
  assert.equal(due(daily, true, old, at(17, 9)), true);
  assert.equal(due(daily, false, old, at(17, 9)), false);
  assert.equal(due(daily, true, started(at(17, 9)), at(17, 9, 15)), false);

  // A backup by hand after the missed run time covers it, and a computer that never backed up has missed one.
  assert.equal(due(daily, true, started(at(17, 8), false), at(17, 9)), false);
  assert.equal(due(daily, true, {}, at(17, 9)), true);
});

test('installing the job covers the run times before it', () => {
  // A job installed after today's run time doesn't back up straight away, though nothing ran today.
  const runs: Runs = { installed: at(17, 16).toISOString(), ...started(at(13, 15)) };
  assert.equal(due(daily, true, runs, at(17, 16, 0, 2)), false);
  assert.equal(due(daily, true, runs, at(18, 15)), true);

  // An install just before a run time doesn't cover it.
  assert.equal(due(daily, true, { installed: at(17, 14, 58).toISOString() }, at(17, 15)), true);
});

// A clock set back can leave a start time in the future, which mustn't stop backups.
test('future and unreadable times count as unknown', () => {
  assert.equal(due(daily, false, started(at(20, 15)), at(17, 15)), true);
  assert.equal(due(daily, false, { run: { id: 'x', started: 'soon', scheduled: true } }, at(17, 15)), true);
  assert.equal(due(daily, false, { installed: at(20, 15).toISOString() }, at(17, 15)), true);
});

test('runs under a day apart count from the configured time', () => {
  const six = { ...daily, every: 6 * hour };
  assert.equal(due(six, false, started(at(17, 3)), at(17, 9)), true);
  assert.equal(due(six, false, started(at(17, 3)), at(17, 8, 50)), false);
  assert.equal(due(six, false, started(at(16, 21)), at(17, 3, 5)), true);
});

// The window is an hour, or a quarter of a shorter interval. A recent backup only counts while it's a
// scheduled one that worked and is still the latest full backup.
test('a backup by hand asks near a scheduled backup', () => {
  assert.equal(nearWindow(daily), 3600e3);
  assert.equal(nearWindow({ ...daily, every: 4 * hour }), 3600e3);
  assert.equal(nearWindow({ ...daily, every: 2 * hour }), 30 * 60e3);
  assert.equal(nearWindow({ ...daily, every: hour }), 15 * 60e3);

  assert.deepEqual(nearby(daily, {}, at(17, 14, 20)), { starts: at(17, 15) });
  assert.deepEqual(nearby(daily, {}, at(17, 14)), { starts: at(17, 15) });
  assert.equal(nearby(daily, {}, at(17, 13, 59)), undefined);
  assert.deepEqual(nearby({ ...daily, every: hour }, {}, at(17, 14, 50)), { starts: at(17, 15) });
  assert.equal(nearby({ ...daily, every: hour }, {}, at(17, 14, 40)), undefined);

  const done = {
    id: 'x',
    started: at(17, 15).toISOString(),
    scheduled: true,
    finished: at(17, 15, 20).toISOString(),
    ok: true,
  };
  assert.deepEqual(nearby(daily, { run: done }, at(17, 16)), { finished: at(17, 15, 20) });
  assert.equal(nearby(daily, { run: done }, at(17, 16, 21)), undefined);
  assert.equal(nearby(daily, { run: { ...done, ok: false } }, at(17, 16)), undefined);
  assert.equal(nearby(daily, { run: { ...done, scheduled: false } }, at(17, 16)), undefined);
  assert.equal(nearby(daily, { run: { ...done, finished: undefined } }, at(17, 16)), undefined);
});

async function privateFolders(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frost-runs-test-'));
  const old = { config: process.env.FROST_CONFIG_DIR, cache: process.env.FROST_CACHE_DIR };
  process.env.FROST_CONFIG_DIR = path.join(root, 'config');
  process.env.FROST_CACHE_DIR = path.join(root, 'cache');
  t.after(async () => {
    for (const [name, value] of [
      ['FROST_CONFIG_DIR', old.config],
      ['FROST_CACHE_DIR', old.cache],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  });
  return process.env.FROST_CONFIG_DIR;
}

// A backup by hand that's still holding the backups when a scheduled run starts mustn't mark the scheduled
// run finished when it ends.
test('a run only finishes its own record', async t => {
  await privateFolders(t);
  const byHand = await rememberStart(false, at(17, 14, 50));
  const scheduled = await rememberStart(true, at(17, 15));
  await rememberFinish(byHand, true, at(17, 15, 10));
  assert.equal((await loadRuns()).run?.finished, undefined);
  await rememberFinish(scheduled, true, at(17, 15, 20));
  await rememberInstall(at(17, 16));
  assert.deepEqual(await loadRuns(), {
    installed: at(17, 16).toISOString(),
    run: {
      id: scheduled,
      started: at(17, 15).toISOString(),
      scheduled: true,
      pid: process.pid,
      finished: at(17, 15, 20).toISOString(),
      ok: true,
    },
  });

  // Installing the job settles a change that was waiting for it.
  await rememberPending('off');
  assert.equal((await loadRuns()).pending, 'off');
  await rememberJob('off');
  assert.deepEqual([(await loadRuns()).job, (await loadRuns()).pending], ['off', undefined]);
});

// A scheduled backup counts as running until it finishes, its process goes, or 6 hours pass.
test('a scheduled backup is running only while it could still be', () => {
  const run = (pid?: number, finished?: Date) => ({
    run: { id: 'x', started: at(17, 15).toISOString(), scheduled: true, pid, finished: finished?.toISOString() },
  });
  const alive = () => true;
  const gone = () => false;
  const booted = at(17, 9).getTime();
  assert.equal(scheduledRunning(run(42), at(17, 16), alive, booted), true);
  assert.equal(scheduledRunning(run(42), at(17, 16), gone, booted), false);
  assert.equal(scheduledRunning(run(42, at(17, 15, 30)), at(17, 16), alive, booted), false);
  assert.equal(scheduledRunning({ run: { ...run(42).run, scheduled: false } }, at(17, 16), alive, booted), false);
  assert.equal(scheduledRunning({}, at(17, 16), alive, booted), false);

  // A big first backup runs as long as it takes, up to a week, but not across a reboot.
  assert.equal(scheduledRunning(run(42), at(18, 15), alive, booted), true);
  assert.equal(scheduledRunning(run(42), at(24, 14, 59), alive, booted), true);
  assert.equal(scheduledRunning(run(42), at(24, 15), alive, booted), false);
  assert.equal(scheduledRunning(run(42), at(17, 16), alive, at(17, 15, 30).getTime()), false);
  assert.equal(scheduledRunning(run(42), at(17, 16), alive, at(17, 15, 4).getTime()), true);

  // A record without a process id counts for 6 hours.
  assert.equal(scheduledRunning(run(undefined), at(17, 20, 59), gone, booted), true);
  assert.equal(scheduledRunning(run(undefined), at(17, 21), gone, booted), false);
  assert.equal(processAlive(process.pid), true);
});

test('a scheduled run backs up when it cannot read its settings or record', async t => {
  const configDir = await privateFolders(t);
  const now = at(17, 16, 0, 1);
  assert.equal(await scheduledDue(now), true);
  await rememberStart(true, at(17, 15));

  // With no config.toml, or one that doesn't parse, there's no schedule to go by.
  assert.equal(await scheduledDue(now), true);
  await mkdir(configDir!, { recursive: true });
  await writeFile(path.join(configDir!, 'config.toml'), 'not toml');
  assert.equal(await scheduledDue(now), true);
  await writeFile(path.join(configDir!, 'config.toml'), '[schedule]\ntime = "noon"\n');
  assert.equal(await scheduledDue(now), true);

  // A readable config and record decide normally, and an unreadable record counts as empty.
  await writeFile(path.join(configDir!, 'config.toml'), '[schedule]\nevery = "daily"\ntime = "15:00"\n');
  assert.equal(await scheduledDue(now), false);
  await writeFile(runsPath(), '[]');
  assert.equal(await scheduledDue(now), true);

  // A job left installed after automatic backups were turned off in config.toml does nothing.
  await writeFile(path.join(configDir!, 'config.toml'), '[schedule]\nenabled = false\n');
  assert.equal(await scheduledDue(now), false);
});

// The next backup is the first run time the record doesn't cover. A run time that passed moments ago is
// starting soon, and one missed long ago is overdue with catch-up on and skipped with it off.
test('the next backup follows the calendar from what the record covers', () => {
  assert.equal(nextBackup(daily, true, {}, at(17, 12)), 'soon');
  assert.deepEqual(nextBackup(daily, true, started(at(17, 10), false), at(17, 12)), at(17, 15));
  assert.deepEqual(nextBackup(daily, true, started(at(17, 14, 59, 30), false), at(17, 14, 59, 40)), at(18, 15));
  assert.equal(nextBackup(daily, true, started(at(16, 15)), at(17, 15, 5)), 'soon');
  assert.equal(nextBackup(daily, true, started(at(16, 15)), at(17, 16)), 'overdue');
  assert.deepEqual(nextBackup(daily, false, started(at(16, 15)), at(17, 16)), at(18, 15));
  assert.deepEqual(nextBackup(daily, true, { installed: at(17, 16).toISOString() }, at(17, 16, 5)), at(18, 15));
  const six = { ...daily, every: 6 * hour };
  assert.deepEqual(nextBackup(six, true, started(at(17, 9)), at(17, 10)), at(17, 15));
});

// The recorded job is compared with this to tell when config.toml asks for a different one.
test('the job a schedule asks for covers every setting the job depends on', () => {
  const s = defaultConfig().schedule;
  assert.equal(desiredJob({ ...s, enabled: false, time: 'noon' }), 'off');
  assert.equal(desiredJob(s), JSON.stringify({ every: 24 * hour, hour: 15, minute: 0, day: 0, catch_up: true }));
  for (const change of [{ every: '6h' }, { time: '9:00' }, { day: 'monday' }, { catch_up: false }])
    assert.notEqual(desiredJob({ ...s, ...change }), desiredJob(s));
  assert.equal(desiredJob({ ...s, every: 'Daily', time: ' 15:00 ' }), desiredJob(s));
  assert.throws(() => desiredJob({ ...s, time: 'noon' }), /schedule\.time/);
});
