// The user's settings in config.toml: defaults, parsing, validation, the commented template and
// `frost config` get and set. Also the config and cache folders and private file writes.

import TOML from '@iarna/toml';
import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { type S3Config } from './storage.js';
import type { SFTPConfig } from './sftp.js';
import type { LocalConfig } from './local.js';
export { newBackend } from './storage.js';

export interface Config {
  paths: string[];
  exclude: string[];
  schedule: { enabled: boolean; every: string; time: string; day: string; catch_up: boolean };
  verify: { sample: number };
  update: { auto: boolean };
  storage: {
    backend: string;
    s3: S3Config;
    permafrost: { url: string; token: string };
    sftp: SFTPConfig;
    local: LocalConfig;
  };
}

export type Storage = Config['storage'];

// The S3 folder, and the folder on an SFTP server, that hold the repository unless the settings say otherwise.
const defaultPrefix = 'frost';
// Intervals offered to users. interval() also accepts 1h, 24h and 168h.
export const intervals = ['hourly', '2h', '3h', '4h', '6h', '8h', '12h', 'daily', 'weekly'];
// The days schedule.day accepts, in the order schedulers number them from 0.
export const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const errNoConfig = new Error("frost isn't set up yet, run `frost init`");

export function defaultConfig(): Config {
  return {
    paths: [],
    exclude: ['.DS_Store', 'Thumbs.db', '*.tmp', '*.swp', 'node_modules', '.cache'],
    schedule: { enabled: true, every: 'daily', time: '15:00', day: 'sunday', catch_up: true },
    verify: { sample: 20 },
    update: { auto: true },
    storage: {
      backend: '',
      s3: {
        endpoint: '',
        region: '',
        bucket: '',
        prefix: defaultPrefix,
        access_key_id: '',
        secret_access_key: '',
        insecure: false,
      },
      permafrost: { url: '', token: '' },
      sftp: { host: '', port: 0, path: defaultPrefix },
      local: { path: '' },
    },
  };
}

// Converts schedule.every to milliseconds.
export function interval(value: string): number {
  const clean = value.trim().toLowerCase();
  const hours: Record<string, number> = {
    hourly: 1,
    '1h': 1,
    daily: 24,
    '24h': 24,
    weekly: 168,
    '168h': 168,
    '2h': 2,
    '3h': 3,
    '4h': 4,
    '6h': 6,
    '8h': 8,
    '12h': 12,
  };
  if (!(clean in hours)) throw new Error('schedule.every must be one of ' + intervals.join(', '));
  return hours[clean] * 3600e3;
}

// Converts schedule.time, a 24-hour local time like 15:00 or 9:30, to an hour and minute.
export function timeOfDay(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d\d)$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
    throw new Error('schedule.time must use 24-hour HH:MM format (e.g., 15:00 or 09:30)');
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

// Converts schedule.day to a weekday number, 0 for Sunday.
export function weekday(value: string): number {
  const day = days.indexOf(value.trim().toLowerCase());
  if (day < 0) throw new Error('schedule.day must be a valid day of the week (e.g., sunday)');
  return day;
}

// The schedule as numbers: the interval in milliseconds, the hour and minute runs are counted from, and
// the weekday of weekly runs.
export function times(s: Config['schedule']): { every: number; hour: number; minute: number; day: number } {
  return { every: interval(s.every), ...timeOfDay(s.time), day: weekday(s.day) };
}

// The storage.backend values, as errors list them.
export const backends = 'permafrost, s3, sftp or local';

// Reports every problem at once, one per line, so the user can fix them in one pass.
export function validate(c: Config): void {
  const errors: string[] = [];
  if (!c.paths.length) errors.push('paths is empty: add at least one directory to back up');
  if (c.schedule.enabled)
    for (const check of [
      () => interval(c.schedule.every),
      () => timeOfDay(c.schedule.time),
      () => weekday(c.schedule.day),
    ])
      try {
        check();
      } catch (error) {
        errors.push((error as Error).message);
      }
  if (c.verify.sample < 0) errors.push("verify.sample can't be negative");
  const { backend, s3, sftp, local } = c.storage;
  if (backend === 's3') {
    if (!s3.endpoint || !s3.bucket) errors.push('storage.s3 needs an endpoint and a bucket');
  } else if (backend === 'sftp') {
    if (!sftp.host.trim() || !sftp.path.trim()) errors.push('storage.sftp needs a host and a path');
  } else if (backend === 'local') {
    if (!local.path.trim()) errors.push('storage.local needs a path');
  } else if (!backend) errors.push("storage.backend isn't set (" + backends + ')');
  else if (backend !== 'permafrost') errors.push(`unknown storage.backend ${JSON.stringify(backend)} (${backends})`);
  if (sftp.port < 0 || sftp.port > 65535)
    errors.push('storage.sftp.port must be an integer between 1 and 65535, or 0 to use the SSH default');
  if (errors.length) throw new Error(errors.join('\n'));
}

// Expands a leading ~ to the home directory.
export function expand(value: string): string {
  return value === '~' || /^~[/\\]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
}

// The config and cache folders follow each OS's conventions. FROST_CONFIG_DIR and
// FROST_CACHE_DIR override them.
export function dir(): string {
  return (
    process.env.FROST_CONFIG_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'frost')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'frost'))
  );
}

export function cacheDir(): string {
  return (
    process.env.FROST_CACHE_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'frost')
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'frost'))
  );
}

// A short hash of the config folder's path, which names the cache records kept for each config folder.
export function dirTag(): string {
  return createHash('sha256').update(path.resolve(dir())).digest('hex').slice(0, 8);
}

export function configPath(): string {
  return path.join(dir(), 'config.toml');
}

export function keyPath(): string {
  return path.join(dir(), 'key');
}

// The SSH key frost logs in to a self-hosted server with. Its public half sits next to it with a .pub ending.
export function sshKeyPath(): string {
  return path.join(dir(), 'ssh', 'frost_ed25519');
}

// Parses TOML over a copy of `initial`. Unknown settings and values whose type differs from the
// default are errors, so a typo can't pass as an ignored setting.
export function parse(raw: string | Buffer, initial = defaultConfig()): Config {
  let decoded: Record<string, unknown>;
  try {
    decoded = TOML.parse(raw.toString()) as Record<string, unknown>;
  } catch (error) {
    // The parser's message and cause include source lines, which can contain storage credentials.
    const { line, col } = error as { line?: number; col?: number };
    const at =
      Number.isSafeInteger(line) && line! >= 0 && Number.isSafeInteger(col) && col! >= 0
        ? ` at line ${line! + 1}, column ${col! + 1}`
        : '';
    throw new Error(`${configPath()}: invalid TOML${at}`);
  }

  const c = structuredClone(initial);

  // Walks the TOML tables alongside the defaults. Lists must hold strings, tables recurse and
  // numbers must be safe integers.
  function apply(source: Record<string, unknown>, target: Record<string, unknown>, prefix: string): void {
    for (const [key, value] of Object.entries(source)) {
      const full = prefix ? prefix + '.' + key : key;
      if (!Object.hasOwn(target, key)) throw new Error(`${configPath()}: unknown setting ${JSON.stringify(full)}`);
      const previous = target[key];
      if (Array.isArray(previous)) {
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string'))
          throw new Error(`${configPath()}: ${full} must be a list of strings`);
        target[key] = value;
      } else if (previous !== null && typeof previous === 'object') {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date)
          throw new Error(`${configPath()}: ${full} must be a table`);
        apply(value as Record<string, unknown>, previous as Record<string, unknown>, full);
      } else {
        if (typeof value !== typeof previous || (typeof value === 'number' && !Number.isSafeInteger(value)))
          throw new Error(`${configPath()}: invalid value for ${full}`);
        target[key] = value;
      }
    }
  }

  apply(decoded, c as unknown as Record<string, unknown>, '');
  return c;
}

// Reads config.toml alone. Commands that save the config back start from this.
export async function loadFile(): Promise<Config> {
  let raw: Buffer;
  try {
    raw = await readFile(configPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw errNoConfig;
    throw error;
  }
  return parse(raw);
}

// Credentials from the environment override the file, in a copy of the config. Don't save the
// result, or the environment's credentials end up on disk.
export function applyEnv(config: Config, env: NodeJS.ProcessEnv = process.env): Config {
  const c = structuredClone(config);
  c.storage.s3.access_key_id = env.FROST_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || c.storage.s3.access_key_id;
  c.storage.s3.secret_access_key =
    env.FROST_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || c.storage.s3.secret_access_key;
  c.storage.permafrost.token = env.FROST_PERMAFROST_TOKEN || c.storage.permafrost.token;
  return c;
}

export async function load(): Promise<Config> {
  return applyEnv(await loadFile());
}

// Writes a mode 0600 file through a new temporary file that's flushed and renamed into place,
// so readers never see a partial file.
export async function writePrivate(destination: string, data: Buffer | string): Promise<void> {
  const temporary = path.join(path.dirname(destination), '.frost-' + randomUUID());
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);

    // Flush the folder too, so the rename survives a crash. It's best effort: Windows can't open a
    // folder this way and some filesystems refuse to sync one, and the file is already in place.
    if (process.platform !== 'win32') {
      const folder = await open(path.dirname(destination), 'r').catch(() => undefined);
      await folder?.sync().catch(() => {});
      await folder?.close().catch(() => {});
    }
  } finally {
    // Cleans up after a failure. After a rename, the temporary name is already gone.
    await handle.close().catch(() => {});
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function save(c: Config): Promise<void> {
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  await writePrivate(configPath(), render(c));
}

// The config template. Its comments are user-facing text.
export function render(c: Config): string {
  const q = (value: string | string[]) =>
    Array.isArray(value) ? '[' + value.map(v => JSON.stringify(v)).join(', ') + ']' : JSON.stringify(value);
  return `# frost config. Edit by hand or with \`frost config set\`.
# Nothing in here is secret except the storage credentials. Your encryption
# key lives in a separate file next to this one, and the SSH key for a
# self-hosted server lives in the ssh folder.

# Directories to back up. ~ means your home directory.
paths = ${q(c.paths)}

# Patterns to skip. A bare name like "node_modules" or "*.tmp" matches that
# name anywhere. A pattern with a slash matches that path and everything under it.
exclude = ${q(c.exclude)}

[schedule]
# Run backups automatically using your OS scheduler (no daemon).
enabled = ${c.schedule.enabled}
# hourly, 2h, 3h, 4h, 6h, 8h, 12h, daily or weekly.
every = ${q(c.schedule.every)}
# The local time backups run, on a 24-hour clock. Shorter intervals count
# from it, so 6h from "15:00" runs at 03:00, 09:00, 15:00 and 21:00.
time = ${q(c.schedule.time)}
# The day weekly backups run, sunday to saturday.
day = ${q(c.schedule.day)}
# Run a backup that was missed while your computer was off or asleep as soon
# as it's back. However many runs it missed, it backs up once.
catch_up = ${c.schedule.catch_up}

[verify]
# After a backup that saves a snapshot, and at least once a day otherwise,
# download this many random chunks and check them. 0 turns the check off.
sample = ${c.verify.sample}

[update]
# Install new frost releases after a scheduled backup, at most every 20 hours.
# false only tells you about them in frost status. Either way, frost update
# installs one now.
auto = ${c.update.auto}

[storage]
# "permafrost", "s3" for any S3-compatible bucket, "sftp" for your own server
# over SSH, or "local" for a folder on a drive.
backend = ${q(c.storage.backend)}

[storage.s3]
endpoint = ${q(c.storage.s3.endpoint)}
region = ${q(c.storage.s3.region)}
bucket = ${q(c.storage.s3.bucket)}
prefix = ${q(c.storage.s3.prefix)}
# Can also come from FROST_S3_ACCESS_KEY_ID / FROST_S3_SECRET_ACCESS_KEY.
access_key_id = ${q(c.storage.s3.access_key_id)}
secret_access_key = ${q(c.storage.s3.secret_access_key)}
# true to use plain http when the endpoint has no scheme (local testing only).
insecure = ${c.storage.s3.insecure}

[storage.permafrost]
# Leave blank for the default server.
url = ${q(c.storage.permafrost.url)}
# Can also come from FROST_PERMAFROST_TOKEN.
token = ${q(c.storage.permafrost.token)}

[storage.sftp]
# Your server's SSH address, like "me@nas.local", or a Host from your SSH
# config. frost logs in with its own key, in the ssh folder.
host = ${q(c.storage.sftp.host)}
# 0 uses the port from your SSH config, or 22.
port = ${c.storage.sftp.port}
# The folder on the server. A relative path starts in your home folder there.
path = ${q(c.storage.sftp.path)}

[storage.local]
# The full path of a folder on a drive, like "/Volumes/Backup/frost" or E:\\frost.
path = ${q(c.storage.local.path)}
`;
}

// Every key `frost config` can get or set, sorted.
const configKeys = [
  'paths',
  'exclude',
  'schedule.catch_up',
  'schedule.day',
  'schedule.enabled',
  'schedule.every',
  'schedule.time',
  'verify.sample',
  'update.auto',
  'storage.backend',
  'storage.s3.endpoint',
  'storage.s3.region',
  'storage.s3.bucket',
  'storage.s3.prefix',
  'storage.s3.access_key_id',
  'storage.s3.secret_access_key',
  'storage.s3.insecure',
  'storage.permafrost.url',
  'storage.permafrost.token',
  'storage.sftp.host',
  'storage.sftp.port',
  'storage.sftp.path',
  'storage.local.path',
].sort();

export function keys(): string[] {
  return [...configKeys];
}

// Settings that hold credentials.
export function isSecret(key: string): boolean {
  return key === 'storage.s3.secret_access_key' || key === 'storage.permafrost.token';
}

export function isList(key: string): boolean {
  return key === 'paths' || key === 'exclude';
}

// Finds the object that holds a dotted key, and the key's last part.
function field(c: Config, key: string): [Record<string, unknown>, string] {
  if (!configKeys.includes(key))
    throw new Error(`unknown config key ${JSON.stringify(key)}, valid keys:\n  ${keys().join('\n  ')}`);
  const parts = key.split('.');
  let parent = c as unknown as Record<string, unknown>;
  for (const name of parts.slice(0, -1)) parent = parent[name] as Record<string, unknown>;
  return [parent, parts[parts.length - 1]];
}

// Lists print one item per line.
export function get(c: Config, key: string): string {
  const [parent, name] = field(c, key);
  const value = parent[name];
  return Array.isArray(value) ? value.join('\n') : String(value);
}

// Parses the new value by the type of the current one.
export function set(c: Config, key: string, values: string[]): void {
  const [parent, name] = field(c, key);
  const old = parent[name];
  let value: unknown;
  try {
    if (Array.isArray(old)) value = [...values];
    else if (typeof old === 'boolean') {
      if (values.length !== 1) throw new Error('expected true or false');
      if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(values[0])) value = true;
      else if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(values[0])) value = false;
      else throw new Error(`expected true or false, got ${JSON.stringify(values[0])}`);
    } else if (typeof old === 'number') {
      if (values.length !== 1) throw new Error('expected a number');
      if (!/^\+?\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0])))
        throw new Error(
          `expected ${key === 'storage.sftp.port' ? 'a port number' : 'a number of chunks'}, got ${JSON.stringify(values[0])}`,
        );
      value = Number(values[0]);
    } else {
      if (values.length !== 1) throw new Error(`expected one value, got ${values.length}`);
      value = values[0];
    }
  } catch (error) {
    throw new Error(`${key}: ${(error as Error).message}`);
  }
  parent[name] = value;
}

// Checks a folder before it's added to paths, and returns it cleaned up. It rejects a folder
// that's already listed, even under another path, and one inside a listed folder. `inside`
// holds the indexes of listed folders that the new one contains.
export async function addPath(raw: string, paths: string[]): Promise<{ path: string; inside: number[] }> {
  if (!raw.trim()) throw new Error("type a folder's path");
  const normalized = path.normalize(raw.trim());
  const clean = normalized === path.parse(normalized).root ? normalized : normalized.replace(/[\\/]$/, '');
  const full = expand(clean);
  if (!path.isAbsolute(full)) throw new Error('provide an absolute path (e.g., ~/Documents)');
  try {
    if (!(await stat(full)).isDirectory()) throw new Error('path is a file; frost backs up entire directories');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // macOS and Windows filesystems are usually case-insensitive.
  const fold = (p: string) => (['darwin', 'win32'].includes(process.platform) ? p.toLowerCase() : p);
  const within = (child: string, parent: string) => {
    const relative = path.relative(fold(parent), fold(child));
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };

  // Folders match by path, or by device and inode when both exist.
  const inside: number[] = [];
  for (let i = 0; i < paths.length; i++) {
    const existing = expand(path.normalize(paths[i]));
    let same = fold(full) === fold(existing);
    try {
      const [a, b] = await Promise.all([stat(full), stat(existing)]);
      same ||= a.dev === b.dev && a.ino === b.ino;
    } catch {
      /* Missing folders compare by path. */
    }
    if (same) throw new Error(`${paths[i]} is already on the list`);
    if (within(full, existing)) throw new Error(`path is already included via target directory ${paths[i]}`);
    if (within(existing, full)) inside.push(i);
  }
  return { path: clean, inside };
}
