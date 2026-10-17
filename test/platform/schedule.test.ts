// Tests for scheduled backup definitions (launchd, systemd, cron and Windows Task Scheduler) and
// the Scheduler's install and remove steps. Every command goes to a stub runner, so no real
// scheduler or lingering setting is touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Scheduler,
  hour,
  launchdPlist,
  systemdUnits,
  cronLine,
  stripCron,
  taskXML,
  taskCommand,
  utf16File,
  windowsQuote,
  lingerMarker,
  onCalendar,
  cronSpec,
  runBefore,
  runAfter,
} from '../../src/platform/schedule.js';
import type { Runner } from '../../src/platform/command.js';
import { openRoot } from '../../src/platform/fs-root.js';

const job = {
  binary: '/usr/local/bin/frost',
  every: 6 * hour,
  hour: 15,
  minute: 0,
  day: 0,
  catchUp: false,
  logFile: '/home/me/.cache/frost/frost.log',
};

// Paths with quotes, ampersands and angle brackets must survive each format's escaping. Runs under a
// day apart count from the configured time, so 6h from 15:00 runs at 03:00, 09:00, 15:00 and 21:00.
test('scheduler definitions preserve interval, quoting, and logging', () => {
  const j = { ...job, configDir: "/it's here", cacheDir: '/cache & <files>' };
  assert.match(launchdPlist(j), /\/cache &amp; &lt;files&gt;/);
  assert.doesNotMatch(launchdPlist(j), /StartInterval/);
  const { service, timer } = systemdUnits(j);
  assert.match(service, /ExecStart="\/usr\/local\/bin\/frost" backup --scheduled/);
  assert.match(timer, /OnCalendar=\*-\*-\* 03,09,15,21:00:00\nPersistent=false/);
  assert.equal(
    cronLine({ ...job, configDir: "/it's here" }),
    "0 3,9,15,21 * * * '/usr/local/bin/frost' backup --scheduled --config-dir '/it'\\''s here' >> '/home/me/.cache/frost/frost.log' 2>&1 # frost-backup",
  );

  // Only frost's own line is removed, never a line that merely mentions the marker.
  assert.equal(stripCron('0 1 * * * other\n' + cronLine(job) + '\n'), '0 1 * * * other\n');
  assert.equal(stripCron("* * * * * echo '# frost-backup'\n"), "* * * * * echo '# frost-backup'\n");
  assert.equal(stripCron('# See # frost-backup\n'), '# See # frost-backup\n');
  assert.equal(stripCron(cronLine(job) + '\n'), '');

  // Every scheduler gets the same run times. Weekly runs fall on the configured day, here Wednesday.
  const at = { hour: 9, minute: 30, day: 3 };
  for (const [every, calendar, cron] of [
    [hour, '*-*-* *:30:00', '30 * * * *'],
    [8 * hour, '*-*-* 01,09,17:30:00', '30 1,9,17 * * *'],
    [12 * hour, '*-*-* 09,21:30:00', '30 9,21 * * *'],
    [24 * hour, '*-*-* 09:30:00', '30 9 * * *'],
    [168 * hour, 'Wed *-*-* 09:30:00', '30 9 * * 3'],
  ] as const) {
    assert.equal(onCalendar({ ...at, every }), calendar);
    assert.equal(cronSpec({ ...at, every }), cron);
  }

  // launchd gets one calendar entry per run time, in the same order as cron's fields.
  const launchdTimes = (j: typeof job) =>
    [...launchdPlist(j).matchAll(/<dict>\n((?:\t+<key>\w+<\/key>\n\t+<integer>\d+<\/integer>\n)+)\t+<\/dict>/g)].map(
      m => [...m[1].matchAll(/<key>(\w+)<\/key>\n\t+<integer>(\d+)<\/integer>/g)].map(f => f[1] + '=' + f[2]).join(' '),
    );
  assert.deepEqual(launchdTimes({ ...job, every: hour }), ['Minute=0']);
  assert.deepEqual(launchdTimes(job), ['Hour=3 Minute=0', 'Hour=9 Minute=0', 'Hour=15 Minute=0', 'Hour=21 Minute=0']);
  assert.deepEqual(launchdTimes({ ...job, ...at, every: 8 * hour }), [
    'Hour=1 Minute=30',
    'Hour=9 Minute=30',
    'Hour=17 Minute=30',
  ]);
  assert.deepEqual(launchdTimes({ ...job, every: 24 * hour }), ['Hour=15 Minute=0']);
  assert.deepEqual(launchdTimes({ ...job, ...at, every: 168 * hour }), ['Weekday=3 Hour=9 Minute=30']);
});

// With catch-up on, launchd also runs the job at login, systemd catches up a run missed while the
// machine was off, Task Scheduler starts a missed run when it can, and cron checks every 15 minutes
// from the configured minute. Off, each scheduler runs only on time.
test('catch-up adds each scheduler its way of running a missed backup', () => {
  const on = { ...job, catchUp: true, minute: 20 };
  assert.match(launchdPlist(on), /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.doesNotMatch(launchdPlist(job), /RunAtLoad/);
  assert.match(systemdUnits(on).timer, /Persistent=true/);
  assert.match(systemdUnits(job).timer, /Persistent=false/);
  assert.match(taskXML(on), /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(taskXML(job), /<StartWhenAvailable>false<\/StartWhenAvailable>/);
  assert.match(cronLine(on), /^5,20,35,50 \* \* \* \* /);
  assert.equal(cronSpec(job, true), '0,15,30,45 * * * *');
});

// Run times follow the local clock. A time exactly on a run counts as that run, and the next one is
// strictly later.
test('the run before and after a moment follow the schedule', () => {
  const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
  const daily = { every: 24 * hour, hour: 15, minute: 0, day: 0 };
  assert.deepEqual(runBefore(daily, local(17, 14, 59)), local(16, 15));
  assert.deepEqual(runBefore(daily, local(17, 15)), local(17, 15));
  assert.deepEqual(runAfter(daily, local(17, 15)), local(18, 15));
  assert.deepEqual(runAfter(daily, local(31, 23)), new Date(2026, 10, 1, 15));

  // 2026-10-07 is a Wednesday, and 2026-10-17 a Saturday.
  const weekly = { every: 168 * hour, hour: 9, minute: 30, day: 3 };
  assert.deepEqual(runBefore(weekly, local(17, 12)), local(14, 9, 30));
  assert.deepEqual(runAfter(weekly, local(17, 12)), local(21, 9, 30));
  assert.deepEqual(runAfter(weekly, local(7, 9, 29)), local(7, 9, 30));

  const sixHours = { every: 6 * hour, hour: 15, minute: 0, day: 0 };
  assert.deepEqual(runBefore(sixHours, local(17, 2, 59)), local(16, 21));
  assert.deepEqual(runAfter(sixHours, local(17, 3)), local(17, 9));
});
// Installed frost runs as the bundled runtime plus a launch script, which must stay two arguments.
test('signed runtime and script remain separate scheduler arguments', () => {
  const j = { ...job, binary: '/app/runtime/bin/node', script: '/app/launch.mjs' };
  assert.match(launchdPlist(j), /<string>\/app\/runtime\/bin\/node<\/string>\n\t\t<string>\/app\/launch.mjs<\/string>/);
  assert.match(systemdUnits(j).service, /ExecStart="\/app\/runtime\/bin\/node" "\/app\/launch.mjs" backup --scheduled/);
  assert.match(cronLine(j), /'\/app\/runtime\/bin\/node' '\/app\/launch.mjs' backup --scheduled/);
  assert.match(taskCommand(j).args, /^"\/app\/launch.mjs" backup --scheduled/);
});
// systemd expands % specifiers everywhere and $ variables in arguments, but not in the executable path.
// The : prefix that turns substitution off needs systemd 242, so units don't use it. Cron treats % as a
// newline. A value that looks like a flag or a shell command stays one literal argument.
test('systemd and cron escape substitutions in paths', () => {
  const j = { ...job, binary: '/path/100%/$HOME/frost', configDir: '/config/%h/$USER' };
  assert.match(systemdUnits(j).service, /ExecStart="\/path\/100%%\/\$HOME\/frost" /);
  assert.match(systemdUnits(j).service, /"\/config\/%%h\/\$\$USER"/);
  assert.match(cronLine(j), /100'\\%'/);

  const literal = { ...job, script: 'backup', configDir: '--name; $(touch file)' };
  assert.match(systemdUnits(literal).service, /"backup" backup --scheduled --config-dir "--name; \$\$\(touch file\)"/);
  assert.match(cronLine(literal), /'backup' backup --scheduled --config-dir '--name; \$\(touch file\)'/);
  assert.match(taskCommand(literal).args, /^"backup" backup --scheduled --config-dir "--name; \$\(touch file\)"/);
});

// Cronie's command parser tracks backslashes before the shell reads quotes. An unescaped % ends
// the command; a backslash is removed only when it escapes %. Other backslashes survive unchanged.
function cronCommand(line: string): string {
  const source = line.replace(/^(?:\S+\s+){5}/, '');
  let command = '';
  let escaped = false;
  for (const c of source) {
    if (escaped) {
      command += c === '%' ? c : '\\' + c;
      escaped = false;
    } else if (c === '\\') escaped = true;
    else if (c === '%') throw new Error('cron split the command at an unescaped percent');
    else command += c;
  }
  return command + (escaped ? '\\' : '');
}

test('cron keeps literal percent signs after any number of path backslashes', () => {
  for (const slashes of ['', '\\', '\\\\', '\\\\\\']) {
    const value = "/name' $HOME " + slashes + '%part';
    const j = { ...job, binary: value, script: value, configDir: value, cacheDir: value, logFile: value, every: hour };
    const command = cronCommand(cronLine(j));
    assert.ok(command.includes(slashes + "'%"));
    if (process.platform !== 'win32') {
      // Parse every generated path as a shell argument without executing it. Treat the log path
      // as one more argument instead of redirecting to it; no filesystem or scheduler is touched.
      const parsed = execFileSync('/bin/sh', [
        '-c',
        'set -- ' + command.replace(' >> ', ' ') + '\nprintf \'%s\\0\' "$@"',
      ]);
      assert.deepEqual(parsed.toString().split('\0').slice(0, -1), [
        value,
        value,
        'backup',
        '--scheduled',
        '--config-dir',
        value,
        '--cache-dir',
        value,
        value,
      ]);
    }
  }
});
// Windows command lines double backslashes only before a quote, so a trailing backslash in a
// quoted path becomes two. The task runs as the signed-in user with least privilege.
test('Windows task preserves registration, least privilege, schedule, and paths', () => {
  const now = new Date(2026, 9, 4, 11, 18, 40);
  const j = {
    binary: 'C:\\program files\\node.exe',
    script: 'C:\\frost\\launch.mjs',
    configDir: 'C:\\backup config\\',
    cacheDir: 'C:\\cache & 100% !\\',
    logFile: 'C:\\log\\frost.log',
    every: hour,
    hour: 15,
    minute: 0,
    day: 0,
    catchUp: false,
  };
  const { command, args } = taskCommand(j);
  assert.equal(command, '"C:\\program files\\node.exe"');
  assert.match(args, /--config-dir "C:\\backup config\\\\"/);
  assert.match(args, /--cache-dir "C:\\cache & 100% !\\\\"/);
  assert.match(args, /--log-file "C:\\log\\frost.log"/);

  // Every task starts at its next run time and repeats daily or weekly. Under a day, each day's start
  // repeats every N hours for that day, so the runs keep their clock times.
  const xml = taskXML(j, now);
  assert.match(xml, /<StartBoundary>2026-10-04T12:00:00<\/StartBoundary>/);
  assert.match(xml, /<Repetition>\n {8}<Interval>PT1H<\/Interval>\n {8}<Duration>P1D<\/Duration>/);
  assert.match(xml, /<ScheduleByDay>/);
  assert.match(xml, /Runs frost backup hourly at :00\./);
  assert.match(xml, /<Author>frost<\/Author>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /&amp;/);
  const daily = taskXML({ ...j, every: 24 * hour }, now);
  assert.match(daily, /<StartBoundary>2026-10-04T15:00:00<\/StartBoundary>/);
  assert.doesNotMatch(daily, /<Repetition>/);
  const weekly = taskXML({ ...j, every: 168 * hour, hour: 9, minute: 30, day: 3 }, now);
  assert.match(weekly, /<StartBoundary>2026-10-07T09:30:00<\/StartBoundary>/);
  assert.match(weekly, /<DaysOfWeek>\n {10}<Wednesday\/>/);
  assert.match(weekly, /Runs frost backup weekly on Wednesday at 09:30\./);

  // Task XML is written as UTF-16LE with a byte order mark (FF FE).
  assert.equal(utf16File('<a>é😀</a>').subarray(2).toString('utf16le'), '<a>é😀</a>');
  assert.deepEqual([...utf16File('a').subarray(0, 2)], [255, 254]);
  assert.equal(windowsQuote('a\\"b\\'), '"a\\\\\\"b\\\\"');
});
// A Linux install with a stub runner and a private home. Lingering reports "no", so frost enables
// it, marks the timer as the owner of that change, and disables it again on removal.
test('scheduler tests never run the real scheduler', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'frost-schedule-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: [string, string[], string | Buffer | undefined][] = [];
  const runner: Runner = async (cmd, args, input) => {
    calls.push([cmd, args, input]);
    return { code: 0, stdout: args.includes('--property=Linger') ? 'no\n' : '', stderr: '' };
  };
  const scheduler = new Scheduler({ platform: 'linux', home, env: {}, uid: 123, runner });

  await scheduler.install(job);
  assert.ok(calls.some(([cmd, args]) => cmd === 'loginctl' && args.includes('enable-linger')));
  assert.match(
    await readFile(path.join(home, '.config', 'systemd', 'user', 'frost-backup.timer'), 'utf8'),
    new RegExp(lingerMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  await scheduler.remove();
  assert.ok(calls.some(([cmd, args]) => cmd === 'loginctl' && args.includes('disable-linger')));

  await assert.rejects(scheduler.install({ ...job, binary: 'bad\npath' }), /line breaks/);
  await assert.rejects(scheduler.install({ ...job, every: 1 }), /at least an hour/);
  for (const bad of [{ hour: 24 }, { minute: -1 }, { day: 7 }, { minute: 1.5 }])
    await assert.rejects(scheduler.install({ ...job, ...bad }), /valid hour, minute and weekday/);
});

async function alias(source: string, destination: string, kind: 'hardlink' | 'symlink'): Promise<void> {
  if (kind === 'hardlink') return link(source, destination);
  const directory = await openRoot(path.dirname(destination));
  try {
    directory.symlink(source, path.basename(destination));
  } finally {
    directory.close();
  }
}

for (const platform of ['linux', 'darwin'] as const)
  for (const kind of ['hardlink', 'symlink'] as const)
    test(`${platform} scheduler definitions replace ${kind} aliases without writing outside targets`, async t => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'frost-schedule-links-'));
      t.after(() => rm(base, { recursive: true, force: true }));
      const home = path.join(base, 'home');
      const directory =
        platform === 'linux'
          ? path.join(home, '.config', 'systemd', 'user')
          : path.join(home, 'Library', 'LaunchAgents');
      await mkdir(directory, { recursive: true });
      const units = systemdUnits(job);
      const definitions =
        platform === 'linux'
          ? [
              ['frost-backup.service', units.service],
              ['frost-backup.timer', units.timer],
            ]
          : [['io.github.whatithasisandalwayswillbe.frost.plist', launchdPlist(job)]];
      for (const [name] of definitions) {
        const outside = path.join(base, name);
        await writeFile(outside, 'outside sentinel');
        await alias(outside, path.join(directory, name), kind);
      }
      const calls: string[] = [];
      const runner: Runner = async (command, args) => {
        calls.push(command);
        return { code: 0, stdout: args.includes('--property=Linger') ? 'yes\n' : '', stderr: '' };
      };
      await new Scheduler({ platform, home, env: {}, uid: 123, runner }).install(job);
      for (const [name, expected] of definitions) {
        assert.equal(await readFile(path.join(base, name), 'utf8'), 'outside sentinel');
        assert.equal(await readFile(path.join(directory, name), 'utf8'), expected);
        const stat = await lstat(path.join(directory, name));
        assert.equal(stat.isSymbolicLink(), false);
        assert.equal(stat.nlink, 1);
        if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o644);
      }
      assert.ok(calls.includes(platform === 'linux' ? 'systemctl' : 'launchctl'));
      assert.deepEqual((await readdir(directory)).sort(), definitions.map(([name]) => name).sort());
    });

for (const kind of ['hardlink', 'symlink'] as const)
  test(`systemd rollback replaces a swapped ${kind} timer without changing its target`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'frost-systemd-rollback-links-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const timer = path.join(home, '.config', 'systemd', 'user', 'frost-backup.timer');
    const outside = path.join(home, 'outside');
    const original = 'outside sentinel\n' + lingerMarker + '\n';
    await writeFile(outside, original);
    const calls: string[][] = [];
    const runner: Runner = async (_command, args) => {
      calls.push(args);
      if (args.includes('daemon-reload')) {
        await unlink(timer);
        await alias(outside, timer, kind);
        return { code: 1, stdout: '', stderr: 'registration failed' };
      }
      return { code: 0, stdout: args.includes('--property=Linger') ? 'no\n' : '', stderr: '' };
    };
    await assert.rejects(
      new Scheduler({ platform: 'linux', home, env: {}, runner }).install(job),
      /registration failed/,
    );
    assert.ok(calls.some(args => args.includes('disable-linger')));
    assert.equal(await readFile(outside, 'utf8'), original);
    assert.equal(await readFile(timer, 'utf8'), 'outside sentinel\n');
    assert.equal((await lstat(timer)).nlink, 1);
    assert.equal((await lstat(timer)).isSymbolicLink(), false);
  });

test('lingering ownership requires a confirmed disabled state', async () => {
  for (const reply of [
    { code: 0, stdout: 'yes\n', stderr: '' },
    { code: 1, stdout: 'no\n', stderr: 'permission denied' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: 'unknown\n', stderr: '' },
  ]) {
    const calls: string[][] = [];
    const runner: Runner = async (_cmd, args) => {
      calls.push(args);
      return reply;
    };
    const scheduler = new Scheduler({ platform: 'linux', runner });
    assert.deepEqual(await scheduler.claimLinger(''), { ours: false, enabled: false });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes('enable-linger'));
  }
});

test('failed systemd registration clears a rolled-back lingering claim before retry', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'frost-systemd-rollback-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let fails = true;
  const calls: string[][] = [];
  const runner: Runner = async (_cmd, args) => {
    calls.push(args);
    return {
      code: fails && args.includes('daemon-reload') ? 1 : 0,
      stdout: args.includes('--property=Linger') ? 'no\n' : '',
      stderr: 'registration failed',
    };
  };
  const scheduler = new Scheduler({ platform: 'linux', home, env: {}, runner });
  await assert.rejects(scheduler.install(job), /registration failed/);
  const timer = path.join(home, '.config', 'systemd', 'user', 'frost-backup.timer');
  assert.ok(calls.some(args => args.includes('disable-linger')));
  assert.ok(!(await readFile(timer, 'utf8')).includes(lingerMarker));

  fails = false;
  await scheduler.install(job);
  assert.equal(calls.filter(args => args.includes('enable-linger')).length, 2);
  assert.ok((await readFile(timer, 'utf8')).includes(lingerMarker));
});

test('a systemd timer counts as installed only while it is active', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'frost-systemd-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let active = true;
  const calls: string[][] = [];
  const runner: Runner = async (_cmd, args) => {
    calls.push(args);
    return {
      code: args.includes('is-active') && !active ? 3 : 0,
      stdout: args.includes('--property=Linger') ? 'yes\n' : '',
      stderr: '',
    };
  };
  const scheduler = new Scheduler({ platform: 'linux', home, env: {}, runner });
  assert.equal(await scheduler.installed(), false);
  await scheduler.install(job);
  assert.equal(await scheduler.installed(), true);
  assert.deepEqual(calls.at(-1), ['--user', 'is-active', '--quiet', 'frost-backup.timer']);
  active = false;
  assert.equal(await scheduler.installed(), false);
});

test('a crontab mention of frost is not an installed job', async () => {
  for (const [text, installed] of [
    ["* * * * * echo '# frost-backup'\n", false],
    ['# See # frost-backup in the documentation\n', false],
    ['# See # frost-backup\n', false],
    ['  # See # frost-backup  \n', false],
    [cronLine(job) + '\n', true],
  ] as const) {
    const runner: Runner = async (cmd, _args) => ({ code: cmd === 'systemctl' ? 1 : 0, stdout: text, stderr: '' });
    assert.equal(await new Scheduler({ platform: 'linux', runner }).installed(), installed);
  }
});

test("cron install and removal preserve comments that end with frost's marker", async () => {
  const comment = '# See # frost-backup\n';
  let crontab = comment;
  const runner: Runner = async (cmd, args, input) => {
    if (cmd === 'systemctl') return { code: 1, stdout: '', stderr: '' };
    assert.equal(cmd, 'crontab');
    if (args[0] === '-') crontab = String(input);
    return { code: 0, stdout: args[0] === '-l' ? crontab : '', stderr: '' };
  };
  const scheduler = new Scheduler({ platform: 'linux', runner });
  assert.equal(await scheduler.installed(), false);
  await scheduler.install(job);
  assert.equal(crontab, comment + cronLine(job) + '\n');
  assert.equal(await scheduler.installed(), true);
  await scheduler.install(job);
  assert.equal(crontab, comment + cronLine(job) + '\n');
  await scheduler.remove();
  assert.equal(crontab, comment);
  assert.equal(await scheduler.installed(), false);
});

// Switching frost off under Login Items unloads the launchd job and leaves its plist behind, so an
// installed job needs both the plist and a loaded service.
test('a launchd job counts as installed only while launchd has it loaded', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'frost-launchd-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let loaded = true;
  const calls: string[][] = [];
  const runner: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: cmd === 'launchctl' && args[0] === 'print' && !loaded ? 113 : 0, stdout: '', stderr: '' };
  };
  const scheduler = new Scheduler({ platform: 'darwin', home, uid: 501, runner });
  assert.equal(await scheduler.installed(), false);

  await scheduler.install(job);
  const plist = path.join(home, 'Library', 'LaunchAgents', 'io.github.whatithasisandalwayswillbe.frost.plist');
  assert.match(await readFile(plist, 'utf8'), /StartCalendarInterval/);
  assert.deepEqual(calls.at(-1), ['launchctl', 'bootstrap', 'gui/501', plist]);
  assert.equal(await scheduler.installed(), true);
  assert.deepEqual(calls.at(-1), ['launchctl', 'print', 'gui/501/io.github.whatithasisandalwayswillbe.frost']);

  loaded = false;
  assert.equal(await scheduler.installed(), false);
  await scheduler.remove();
  await assert.rejects(readFile(plist), { code: 'ENOENT' });
});
// The stub inspects the XML file handed to `schtasks /Create`, which must be deleted afterwards.
test('Windows task is UTF-16 and gets removed after mocked registration', async t => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'frost-task-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let xmlFile = '';
  const runner: Runner = async (cmd, args) => {
    if (args.includes('/Create')) {
      xmlFile = args.at(-1)!;
      const b = await readFile(xmlFile);
      assert.equal(b.readUInt16LE(0), 0xfeff);
      assert.match(b.subarray(2).toString('utf16le'), /frost backup/);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const scheduler = new Scheduler({ platform: 'win32', runner });
  await scheduler.install({ ...job, cacheDir });
  await assert.rejects(readFile(xmlFile), { code: 'ENOENT' });
});

// schtasks messages are translated, so removal asks whether the task still exists instead of
// reading the error text.
test('Windows task removal checks for the task instead of parsing messages', async () => {
  for (const [stillThere, fails] of [
    [false, false],
    [true, true],
  ]) {
    const runner: Runner = async (_cmd, args) => {
      if (args.includes('/Delete')) return { code: 1, stdout: '', stderr: 'FEHLER: Die Aufgabe wurde nicht gefunden.' };
      if (args.includes('/Query')) return { code: stillThere ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const removal = new Scheduler({ platform: 'win32', runner }).remove();
    if (fails) await assert.rejects(removal, /schtasks: FEHLER/);
    else await removal;
  }
});
