// Installs the recurring `backup --scheduled` job with launchd on macOS, Task Scheduler on
// Windows, and a systemd user timer or a crontab line elsewhere. Every scheduler command goes
// through a runner, so tests never touch a real scheduler or lingering.
import { access, readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { run, checked, type Runner } from './command.js';
import { openRoot } from './fs-root.js';

interface Job {
  binary: string;
  script?: string;
  every: number;
  configDir?: string;
  cacheDir?: string;
  logFile?: string;
}

export const hour = 3_600_000;
const launchdLabel = 'io.github.whatithasisandalwayswillbe.frost';
const systemdUnit = 'frost-backup';
const cronMarker = '# frost-backup';
const taskName = 'frost backup';

// Appended to the timer file when frost turned lingering on, so removing the timer knows to
// turn it off again. Deleting the timer by hand loses this record.
export const lingerMarker =
  "# frost turned on lingering (loginctl enable-linger) so this timer runs while you're logged out, and turns it off when it removes the timer.";

interface ScheduleOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  runner?: Runner;
  uid?: number;
  now?: () => Date;
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// POSIX single quotes. An embedded quote becomes '\''.
export function shellQuote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

// Quotes one argument so CommandLineToArgvW reads it back unchanged. Backslashes before a quote
// and at the end are doubled, because the closing quote follows them.
export function windowsQuote(s: string): string {
  return (
    '"' +
    s
      .replace(/(\\*)"/g, (_, slashes: string) => slashes.repeat(2) + '\\"')
      .replace(/\\+$/, slashes => slashes.repeat(2)) +
    '"'
  );
}

// Intervals round down to whole hours. A week or more runs weekly, a day or more daily, and an
// hour or less hourly. Anything between runs every N hours.
function humanEvery(every: number): string {
  const h = Math.trunc(every / hour);
  return h >= 168 ? 'weekly' : h >= 24 ? 'daily' : h <= 1 ? 'hourly' : `every ${h} hours`;
}

export function onCalendar(every: number): string {
  const h = Math.trunc(every / hour);
  return h >= 168 ? 'weekly' : h >= 24 ? 'daily' : h <= 1 ? 'hourly' : `*-*-* 00/${h}:00:00`;
}

// Cron jobs run at minute 17, and daily and weekly ones at 03:17. Weekly means Sunday.
export function cronSpec(every: number): string {
  const h = Math.trunc(every / hour);
  return h >= 168 ? '17 3 * * 0' : h >= 24 ? '17 3 * * *' : h <= 1 ? '17 * * * *' : `17 */${h} * * *`;
}

// Only the Windows task passes --log-file. launchd and cron send output to the log themselves,
// and systemd keeps it in the journal.
function argumentsFor(j: Job, windows = false): string[] {
  const args = [...(j.script ? [j.script] : []), 'backup', '--scheduled'];
  if (j.configDir) args.push('--config-dir', j.configDir);
  if (j.cacheDir) args.push('--cache-dir', j.cacheDir);
  if (windows && j.logFile) args.push('--log-file', j.logFile);
  return args;
}

// True for arguments that are user paths (the script and each path flag's value). Those get
// quoted; fixed words like backup stay bare.
function argumentValue(j: Job, args: string[], i: number): boolean {
  return Boolean(j.script && i === 0) || ['--config-dir', '--cache-dir', '--log-file'].includes(args[i - 1] ?? '');
}

// launchd runs at the same times as cron: minute 17, and daily and weekly jobs at 03:17. Unlike
// StartInterval, which skips a run due while the Mac sleeps, StartCalendarInterval runs it on wake.
function launchdCalendar(every: number): string {
  const h = Math.trunc(every / hour);
  const times: Record<string, number>[] =
    h >= 168
      ? [{ Weekday: 0, Hour: 3, Minute: 17 }]
      : h >= 24
        ? [{ Hour: 3, Minute: 17 }]
        : h <= 1
          ? [{ Minute: 17 }]
          : Array.from({ length: Math.floor(23 / h) + 1 }, (_, i) => ({ Hour: i * h, Minute: 17 }));
  const entry = (fields: Record<string, number>) =>
    '\t\t<dict>\n' +
    Object.entries(fields)
      .map(([key, value]) => `\t\t\t<key>${key}</key>\n\t\t\t<integer>${value}</integer>\n`)
      .join('') +
    '\t\t</dict>';
  return `\t<key>StartCalendarInterval</key>\n\t<array>\n${times.map(entry).join('\n')}\n\t</array>`;
}

// A launchd agent that runs on the calendar above as a background process with low-priority I/O,
// sending stdout and stderr to the log file.
export function launchdPlist(j: Job): string {
  const args = [j.binary, ...argumentsFor(j)].map(s => `\t\t<string>${xmlEscape(s)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>${launchdLabel}</string>\n\t<key>ProgramArguments</key>\n\t<array>\n${args}\n\t</array>\n${launchdCalendar(j.every)}\n\t<key>ProcessType</key>\n\t<string>Background</string>\n\t<key>LowPriorityIO</key>\n\t<true/>\n\t<key>StandardOutPath</key>\n\t<string>${xmlEscape(j.logFile ?? '')}</string>\n\t<key>StandardErrorPath</key>\n\t<string>${xmlEscape(j.logFile ?? '')}</string>\n</dict>\n</plist>\n`;
}

// A oneshot service at low CPU and idle I/O priority, and a timer for it. Persistent catches up
// a run missed while the machine was off, and RandomizedDelaySec spreads starts over 5 minutes.
export function systemdUnits(j: Job): { service: string; timer: string } {
  // Paths are double-quoted with C-style escapes, and % is doubled so systemd doesn't expand specifiers.
  // systemd substitutes $ variables in arguments but not in the executable path, so only arguments
  // double $. The callback stops replaceAll from reading '$$' as a single '$'. The : prefix that turns
  // substitution off needs systemd 242, so older releases couldn't run the unit.
  const quote = (s: string) => JSON.stringify(s.replaceAll('%', '%%'));
  const argument = (s: string) => JSON.stringify(s.replaceAll('%', '%%').replaceAll('$', () => '$$'));
  const raw = argumentsFor(j);
  const args = raw.map((s, i) => (argumentValue(j, raw, i) ? argument(s) : s));
  const service = `[Unit]\nDescription=frost backup\n\n[Service]\nType=oneshot\nExecStart=${quote(j.binary)} ${args.join(' ')}\nNice=10\nIOSchedulingClass=idle\n`;
  const timer = `[Unit]\nDescription=Run frost backup ${humanEvery(j.every)}\n\n[Timer]\nOnCalendar=${onCalendar(j.every)}\nPersistent=true\nRandomizedDelaySec=300\n\n[Install]\nWantedBy=timers.target\n`;
  return { service, timer };
}

// Cron removes the escape before %, even inside shell quotes. Put each escaped % outside the
// single-quoted segments so a preceding literal backslash can't hide its escape from cron.
export function cronLine(j: Job): string {
  const quote = (s: string) => shellQuote(s).replaceAll('%', "'\\%'");
  const raw = argumentsFor(j);
  const args = raw.map((s, i) => (argumentValue(j, raw, i) ? quote(s) : s));
  const command = `${quote(j.binary)} ${args.join(' ')} >> ${quote(j.logFile ?? '')} 2>&1`;
  return `${cronSpec(j.every)} ${command} ${cronMarker}`;
}

// A comment mentioning the marker belongs to the user, even when the marker is its last text.
function isFrostCronLine(line: string): boolean {
  const value = line.trim();
  return !value.startsWith('#') && value.endsWith(' ' + cronMarker);
}

// Drops frost's line from a crontab and keeps everything else, with one trailing newline, or
// returns '' when nothing is left.
export function stripCron(text: string): string {
  const keep = text
    .split('\n')
    .filter(s => !isFrostCronLine(s))
    .join('\n');
  return keep.trim() ? keep.replace(/\n+$/, '') + '\n' : '';
}

export function taskCommand(j: Job): { command: string; args: string } {
  const raw = argumentsFor(j, true);
  const args = raw.map((s, i) => (argumentValue(j, raw, i) ? windowsQuote(s) : s));
  return { command: windowsQuote(j.binary), args: args.join(' ') };
}

// Local time with no zone, so the trigger follows the machine's clock.
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// Task Scheduler 1.2 XML. Under a day, a TimeTrigger repeats every N hours from now. Daily and
// weekly jobs use a CalendarTrigger at 03:17 local time, weekly on Sundays.
export function taskXML(j: Job, now = new Date()): string {
  const { command, args } = taskCommand(j);
  const h = Math.trunc(j.every / hour);
  const start = h < 24 ? localDate(now) : localDate(now).slice(0, 10) + 'T03:17:00';
  const trigger =
    h < 24
      ? `    <TimeTrigger>\n      <StartBoundary>${start}</StartBoundary>\n      <Repetition>\n        <Interval>PT${Math.max(1, h)}H</Interval>\n      </Repetition>\n    </TimeTrigger>`
      : `    <CalendarTrigger>\n      <StartBoundary>${start}</StartBoundary>\n${h >= 168 ? '      <ScheduleByWeek>\n        <WeeksInterval>1</WeeksInterval>\n        <DaysOfWeek>\n          <Sunday/>\n        </DaysOfWeek>\n      </ScheduleByWeek>' : '      <ScheduleByDay>\n        <DaysInterval>1</DaysInterval>\n      </ScheduleByDay>'}\n    </CalendarTrigger>`;

  // The task runs as the logged-in user with least privilege. It skips a run while one is going,
  // doesn't run on battery and doesn't catch up runs it missed.
  return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <RegistrationInfo>\n    <Author>frost</Author>\n    <Description>Runs frost backup ${humanEvery(j.every)}. frost created this task. To remove it, run frost config set schedule.enabled false.</Description>\n    <URI>\\${taskName}</URI>\n  </RegistrationInfo>\n  <Triggers>\n${trigger}\n  </Triggers>\n  <Principals>\n    <Principal id="Author">\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>\n    </Principal>\n  </Principals>\n  <Settings>\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>\n    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>\n    <StartWhenAvailable>false</StartWhenAvailable>\n  </Settings>\n  <Actions Context="Author">\n    <Exec>\n      <Command>${xmlEscape(command)}</Command>\n      <Arguments>${xmlEscape(args)}</Arguments>\n    </Exec>\n  </Actions>\n</Task>\n`;
}

// UTF-16LE with a byte order mark, matching the XML declaration.
export function utf16File(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

// File helpers that treat a missing file as absent, empty or already removed.
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function optionalRead(p: string): Promise<string> {
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

async function removeFile(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

// Replace the definition through its retained parent, so an existing link never redirects a write.
async function writeDefinition(destination: string, data: string): Promise<void> {
  const directory = await openRoot(path.dirname(destination), { create: true, mode: 0o755, trustedFinalLink: true });
  const temporary = '.frost-' + randomUUID();
  try {
    const file = directory.open(temporary, { write: true, create: true, exclusive: true, mode: 0o644 });
    try {
      file.writeFile(data);
      file.sync();
    } finally {
      file.close();
    }
    directory.rename(temporary, directory, path.basename(destination));
    if (process.platform !== 'win32') directory.sync();
  } finally {
    try {
      directory.remove(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      directory.close();
    }
  }
}

// Installs, removes and checks the job for one user. Options override the platform, home folder,
// environment, uid, clock and command runner.
export class Scheduler {
  private readonly runner: Runner;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly uid: number;

  constructor(private readonly options: ScheduleOptions = {}) {
    this.runner = options.runner ?? run;
    this.platform = options.platform ?? process.platform;
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
  }

  private get plistPath(): string {
    return path.join(this.home, 'Library', 'LaunchAgents', launchdLabel + '.plist');
  }

  private get unitDir(): string {
    return path.join(this.env.XDG_CONFIG_HOME || path.join(this.home, '.config'), 'systemd', 'user');
  }

  // Linux uses a systemd user timer when the user manager answers, and cron otherwise.
  async kind(): Promise<string> {
    if (this.platform === 'darwin') return 'launchd';
    if (this.platform === 'win32') return 'Task Scheduler';
    try {
      return (await this.runner('systemctl', ['--user', 'show-environment'])).code === 0 ? 'systemd' : 'cron';
    } catch {
      return 'cron';
    }
  }

  private async linger(on: boolean): Promise<void> {
    await checked(this.runner, 'loginctl', [
      '--no-ask-password',
      on ? 'enable-linger' : 'disable-linger',
      String(this.uid),
    ]);
  }

  // Works out whether frost owns lingering, given the old timer's text. A marker there means it
  // already does. Lingering that's already on belongs to someone else. Otherwise frost turns it
  // on and claims it. enabled says whether this call turned it on. Any failure claims nothing.
  async claimLinger(old: string): Promise<{ ours: boolean; enabled: boolean }> {
    if (old.includes(lingerMarker)) return { ours: true, enabled: false };
    try {
      const r = await this.runner('loginctl', ['show-user', String(this.uid), '--property=Linger', '--value']);
      // Only a confirmed disabled state is ours to change. An unreadable or unfamiliar reply
      // could hide lingering that was already enabled by the user or another application.
      if (r.code || r.stdout.trim() !== 'no') return { ours: false, enabled: false };
      await this.linger(true);
      return { ours: true, enabled: true };
    } catch {
      return { ours: false, enabled: false };
    }
  }

  // Turns lingering off, best effort, only when the removed timer carried frost's marker.
  async releaseLinger(old: string): Promise<void> {
    if (old.includes(lingerMarker)) {
      try {
        await this.linger(false);
      } catch {}
    }
  }

  // crontab -l exits 1 with "no crontab for <user>" when the user has none.
  private async readCrontab(): Promise<string> {
    const r = await this.runner('crontab', ['-l']);
    if (r.code === 1 && r.stderr.trim().startsWith('no crontab for ')) return '';
    if (r.code) throw new Error(`reading crontab: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async install(j: Job): Promise<void> {
    // A line break or NUL in a path could break out of a definition.
    for (const value of [j.binary, j.script ?? '', j.configDir ?? '', j.cacheDir ?? '', j.logFile ?? '']) {
      if (/[\r\n\x00]/.test(value)) throw new Error("scheduler paths can't contain line breaks or NUL");
    }
    if (!Number.isFinite(j.every) || j.every < hour) throw new Error('schedule interval must be at least an hour');

    switch (await this.kind()) {
      case 'launchd': {
        // Unload any copy that's already loaded, then load the new one.
        await writeDefinition(this.plistPath, launchdPlist(j));
        try {
          await this.runner('launchctl', ['bootout', `gui/${this.uid}`, this.plistPath]);
        } catch {}
        const r = await this.runner('launchctl', ['bootstrap', `gui/${this.uid}`, this.plistPath]);
        if (r.code) throw new Error(`launchctl bootstrap: ${(r.stderr || r.stdout).trim()}`);
        break;
      }
      case 'systemd': {
        // Claim lingering before writing the timer, so the marker can go in it. If anything
        // fails, lingering goes back off only when this call turned it on.
        const timer = path.join(this.unitDir, systemdUnit + '.timer');
        const claimed = await this.claimLinger(await optionalRead(timer));
        const units = systemdUnits(j);
        try {
          await writeDefinition(path.join(this.unitDir, systemdUnit + '.service'), units.service);
          await writeDefinition(timer, units.timer + (claimed.ours ? lingerMarker + '\n' : ''));
          await checked(this.runner, 'systemctl', ['--user', 'daemon-reload']);
          await checked(this.runner, 'systemctl', ['--user', 'enable', '--now', systemdUnit + '.timer']);
        } catch (e) {
          if (claimed.enabled) {
            try {
              await this.linger(false);
              // A timer written before registration failed must no longer claim the grant
              // we just rolled back. Otherwise a retry skips enabling lingering again.
              const current = await optionalRead(timer);
              if (current.includes(lingerMarker))
                await writeDefinition(timer, current.replace(lingerMarker + '\n', ''));
            } catch {}
          }
          throw e;
        }
        break;
      }
      case 'cron':
        await checked(this.runner, 'crontab', ['-'], stripCron(await this.readCrontab()) + cronLine(j) + '\n');
        break;
      default: {
        // schtasks reads the task from a UTF-16 XML file in a private temporary folder.
        const dir = await mkdtemp(path.join(j.cacheDir || os.tmpdir(), 'task-'));
        try {
          const file = path.join(dir, 'task.xml');
          await writeFile(file, utf16File(taskXML(j, this.options.now?.())), { mode: 0o600 });
          await checked(this.runner, 'schtasks', ['/Create', '/F', '/TN', taskName, '/XML', file]);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }

  // Unloading is best effort for launchd and systemd. On Windows a task that's already gone counts as
  // removed.
  async remove(): Promise<void> {
    switch (await this.kind()) {
      case 'launchd':
        await this.runner('launchctl', ['bootout', `gui/${this.uid}`, this.plistPath]).catch(() => {});
        await removeFile(this.plistPath);
        break;
      case 'systemd': {
        const timer = path.join(this.unitDir, systemdUnit + '.timer');
        const old = await optionalRead(timer);
        await this.runner('systemctl', ['--user', 'disable', '--now', systemdUnit + '.timer']).catch(() => {});
        await Promise.all([removeFile(timer), removeFile(path.join(this.unitDir, systemdUnit + '.service'))]);
        await this.runner('systemctl', ['--user', 'daemon-reload']).catch(() => {});
        await this.releaseLinger(old);
        break;
      }
      case 'cron':
        await checked(this.runner, 'crontab', ['-'], stripCron(await this.readCrontab()));
        break;
      default: {
        // A failed delete only matters when the task is still there. Asking avoids parsing
        // schtasks messages, which are translated on non-English Windows.
        const r = await this.runner('schtasks', ['/Delete', '/F', '/TN', taskName]);
        if (r.code && (await this.runner('schtasks', ['/Query', '/TN', taskName])).code === 0)
          throw new Error(`schtasks: ${(r.stderr || r.stdout).trim()}`);
      }
    }
  }

  async installed(): Promise<boolean> {
    switch (await this.kind()) {
      case 'launchd':
        // Switching frost off under Login Items unloads the job but leaves its plist, so launchd must
        // still have it loaded too.
        if (!(await exists(this.plistPath))) return false;
        try {
          return (await this.runner('launchctl', ['print', `gui/${this.uid}/${launchdLabel}`])).code === 0;
        } catch {
          return false;
        }
      case 'systemd':
        if (!(await exists(path.join(this.unitDir, systemdUnit + '.timer')))) return false;
        try {
          return (
            (await this.runner('systemctl', ['--user', 'is-active', '--quiet', systemdUnit + '.timer'])).code === 0
          );
        } catch {
          return false;
        }
      case 'cron':
        return (await this.readCrontab().catch(() => '')).split('\n').some(isFrostCronLine);
      default:
        try {
          return (await this.runner('schtasks', ['/Query', '/TN', taskName])).code === 0;
        } catch {
          return false;
        }
    }
  }
}

// Shortcuts that act on the real system with default options.
export const kind = () => new Scheduler().kind();
export const install = (j: Job) => new Scheduler().install(j);
export const remove = () => new Scheduler().remove();
export const installed = () => new Scheduler().installed();
