// `frost config` lists the settings, reads or changes one, or opens config.toml in an editor. A change to
// the schedule reinstalls the scheduled job, and a change of storage is checked before it's saved. Changes
// made to config.toml outside frost are applied before these commands run, by sync.ts.

import { readFile, mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import * as config from '../core/config.js';
import { Context } from './context.js';
import { Block, printable, tildify } from './format.js';
import { checkStorageChange } from './storagecheck.js';
import { rememberChecked } from './known.js';
import { jobNote, syncJob } from './sync.js';
import { location } from '../core/storage.js';

interface SettingChange {
  key: string;
  how: string;
}

// The items added to and removed from a list setting.
function listChange(b: Block, was: string[], now: string[]): string {
  const lines = [
    ...now.filter(v => !was.includes(v)).map(v => b.fmt.good('+') + ' ' + printable(v)),
    ...was.filter(v => !now.includes(v)).map(v => b.fmt.error('-') + ' ' + printable(v)),
  ];
  return lines.length ? lines.join('\n') : 'same items, new order';
}

// Every setting that differs between two configs. A secret only says it changed.
function configChanges(b: Block, was: config.Config, now: config.Config): SettingChange[] {
  const result: SettingChange[] = [];
  const value = (v: string) => (v ? printable(v) : b.fmt.dim('not set'));
  for (const key of config.keys()) {
    const a = config.get(was, key);
    const v = config.get(now, key);
    if (a === v) continue;
    result.push({
      key,
      how: config.isSecret(key)
        ? 'changed'
        : config.isList(key)
          ? listChange(b, a ? a.split('\n') : [], v ? v.split('\n') : [])
          : value(a) + b.fmt.dim(' to ') + b.fmt.bold(value(v)),
    });
  }
  return result;
}

// Widens the label column to fit the longest key, then prints a row for each change.
function printChanges(b: Block, changes: SettingChange[]): void {
  changes.forEach(c => {
    b.width = Math.max(b.width, c.key.length + 1);
  });
  changes.forEach(c => b.row(c.key, c.how));
}

// Reinstalls or removes the scheduled job if the schedule changed. Returns a note for the closing line.
async function resync(ctx: Context, before: config.Config['schedule'], cfg: config.Config): Promise<string> {
  if (JSON.stringify(before) === JSON.stringify(cfg.schedule)) return '';
  let applied: boolean;
  try {
    applied = await syncJob(ctx, cfg);
  } catch (err) {
    throw new Error('saved, but updating the scheduled job failed: ' + (err as Error).message);
  }
  return ctx.fmt.dim(' ' + jobNote(cfg, applied));
}

// A storage change that went through its check before saving isn't checked again when it's first used.
async function storageChecked(ctx: Context, was: config.Storage, now: config.Storage): Promise<void> {
  try {
    const where = location(ctx.hooks.backend(now));
    if (where !== location(ctx.hooks.backend(was))) await rememberChecked(where);
  } catch {}
}

// The editor named on the command line wins, then $VISUAL, then $EDITOR. Without one it's Notepad on
// Windows, or the first of nano, vim and vi that's installed.
async function editorCommand(named: string): Promise<string[]> {
  const text = [named, process.env.VISUAL ?? '', process.env.EDITOR ?? ''].find(s => s.trim())?.trim();
  if (!text) {
    if (process.platform === 'win32') return ['notepad'];
    for (const name of ['nano', 'vim', 'vi']) if (await findProgram(name)) return [name];
    return ['vi'];
  }

  // A value that names a file is one path, even with spaces in it. Otherwise it's a command and arguments.
  const parts = (await stat(text).catch(() => undefined))?.isFile() ? [text] : text.split(/\s+/);
  if (await findProgram(parts[0])) return parts;

  // nano on Windows usually comes with Git and isn't on the PATH.
  if (process.platform === 'win32' && /^nano(?:\.exe)?$/i.test(parts[0])) {
    const nano = await gitNano();
    if (nano) {
      parts[0] = nano;
      return parts;
    }
  }
  throw new Error(
    `cannot find the editor ${JSON.stringify(parts[0])}; verify that it is installed and available in your PATH`,
  );
}

// Finds a program by absolute path or on the PATH, trying Windows' executable extensions.
async function findProgram(name: string): Promise<string | undefined> {
  if (path.isAbsolute(name) && (await stat(name).catch(() => undefined))?.isFile()) return name;
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter))
    for (const ext of ['', ...extensions]) {
      const candidate = path.join(dir, name + ext);
      if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
    }
  return undefined;
}

// Finds the nano that comes with Git for Windows, in the usual install folders or above git on the PATH.
async function gitNano(): Promise<string> {
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean).map(p => path.join(p!, 'Git'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'));
  const git = await findProgram('git');
  if (git) {
    const dir = path.dirname(git);
    roots.push(path.dirname(dir), path.dirname(path.dirname(dir)));
  }
  for (const root of roots) {
    const p = path.join(root, 'usr', 'bin', 'nano.exe');
    if ((await stat(p).catch(() => undefined))?.isFile()) return p;
  }
  return '';
}

const editorName = (command: string[]): string => {
  const name = path.basename(command[0], path.extname(command[0]));
  return name.toLowerCase() === 'notepad' ? 'Notepad' : printable(name);
};

// Runs `frost config edit`. The editor works on a private copy, and config.toml only changes once the copy
// parses and the user types yes.
async function configEdit(ctx: Context, named: string): Promise<void> {
  const file = config.configPath();
  const orig = await readFile(file).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw config.errNoConfig;
    throw err;
  });
  const editor = await editorCommand(named);

  // A config that doesn't parse can still be opened and fixed.
  let was = config.defaultConfig();
  let wasOK = false;
  try {
    was = config.parse(orig);
    wasOK = true;
  } catch {}

  await mkdir(config.dir(), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(config.dir(), '.frost-edit-'));
  const draft = path.join(dir, 'config.toml');
  try {
    await config.writePrivate(draft, orig);
    const p = ctx.prompt();
    p.open('config', printable(tildify(file)));
    p.gap();

    // Edit until the copy parses, or the user gives up.
    let edited: Buffer, now: config.Config;
    for (;;) {
      const name = editorName(editor);
      p.line(ctx.fmt.dim(`Opened config.toml in ${name}. Save your changes, then close ${name} to continue.`));
      const start = Date.now();
      try {
        await ctx.hooks.openEditor(editor, draft);
      } catch (err) {
        throw new Error(name + " didn't run: " + (err as Error).message);
      }
      p.gap();
      edited = await readFile(draft);

      // Some editors hand the file to a window that's already open and return at once. If nothing changed
      // within a second, wait for the user.
      if (Date.now() - start < 1000 && edited.equals(orig)) {
        await p.ask(name + ' did not wait for editing to finish. Save and close config.toml, then press Enter.');
        edited = await readFile(draft);
      }
      if (wasOK && edited.equals(orig)) {
        p.close('No changes, so nothing was saved.');
        return;
      }
      try {
        now = config.parse(edited);
        break;
      } catch (err) {
        p.fail(ctx.fmt.caution(ctx.fmt.errorText(err)));
        if (!(await p.yesNo('Open it again to fix it?', true))) throw new Error('cancelled, nothing was saved');
        p.gap();
      }
    }

    // Show what changed. Invalid settings and storage problems only warn here, because editing is the way
    // to save a change the checks would refuse.
    const changes = configChanges(p, was, now!);
    if (!wasOK) p.ok('config.toml reads cleanly again.');
    else if (changes.length) printChanges(p, changes);
    else p.line('No settings were changed (only comments or layout were modified).');
    try {
      config.validate(now!);
    } catch (err) {
      p.warn(ctx.fmt.caution(ctx.fmt.errorText(err)));
    }
    await checkStorageChange(ctx, p, was.storage, now!.storage, 'warn');

    p.gap();
    if (!(await p.confirm('yes', 'save'))) throw new Error('cancelled, nothing was saved');
    await config.writePrivate(file, edited!);
    await storageChecked(ctx, was.storage, now!.storage);
    const done = await resync(ctx, was.schedule, now!);
    p.gap();
    p.close(ctx.fmt.good('Saved.') + done);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runConfig(ctx: Context, args: string[], showSecrets: boolean): Promise<void> {
  if (args[0] === 'edit') {
    if (args.length > 2) throw new Error('usage: frost config edit [editor]');
    return configEdit(ctx, args[1] ?? '');
  }
  const cfg = await config.loadFile();

  // `frost config` lists every setting. Secrets are hidden unless --show-secrets.
  if (!args.length) {
    const b = ctx.fmt.block();
    b.open('config', printable(tildify(config.configPath())));
    b.gap();
    config.keys().forEach(k => (b.width = Math.max(b.width, k.length + 1)));
    for (const key of config.keys()) {
      let value = config.get(cfg, key);
      if (!value) value = ctx.fmt.dim('not set');
      else if (config.isSecret(key) && !showSecrets) value = '********';
      else value = printable(value.replaceAll('\n', ', '));
      b.row(key, value);
    }
    b.gap();
    b.close('Change one with ' + ctx.fmt.bold('frost config set <key> <value>') + '.');
    return;
  }

  // `get` prints the bare value, for scripts.
  if (args[0] === 'get') {
    if (args.length !== 2) throw new Error('usage: frost config get <key>');
    let value = config.get(cfg, args[1]);
    if (config.isSecret(args[1]) && value && !showSecrets) value = '********';
    ctx.fmt.write(value + '\n');
    return;
  }

  if (args[0] !== 'set') throw new Error(`unknown config action ${JSON.stringify(args[0])} (use get, set or edit)`);
  if (args.length < 2) throw new Error('usage: frost config set <key> <value...>');
  const was = structuredClone(cfg);
  config.set(cfg, args[1], args.slice(2));

  // Only a problem in the section being set stops the change, so a problem elsewhere can still be fixed.
  try {
    config.validate(cfg);
  } catch (err) {
    if ((err as Error).message.includes(args[1].split('.')[0])) throw err;
  }

  const b = ctx.fmt.block();
  b.open('config', printable(tildify(config.configPath())));
  b.gap();
  const changes = configChanges(b, was, cfg);
  if (!changes.length) {
    // Setting a schedule value again reinstalls the scheduled job if it has gone missing.
    if (args[1].startsWith('schedule.') && cfg.schedule.enabled && !(await ctx.hooks.scheduleInstalled())) {
      let applied: boolean;
      try {
        applied = await syncJob(ctx, cfg);
      } catch (err) {
        throw new Error('the scheduled job is missing, and reinstalling it failed: ' + (err as Error).message);
      }
      b.close(
        applied
          ? ctx.fmt.good('Scheduled job reinstalled.') +
              ctx.fmt.dim(' ' + args[1] + ' was already set to this value, but the scheduled job was missing.')
          : 'The scheduled job will be reinstalled once the active backup finishes.',
      );
      return;
    }
    b.close(args[1] + ' is already set to that, so nothing changed.');
    return;
  }

  printChanges(b, changes);
  if (args[1].startsWith('storage.')) await checkStorageChange(ctx, b, was.storage, cfg.storage, 'refuse');
  await config.save(cfg);
  await storageChecked(ctx, was.storage, cfg.storage);
  const done = await resync(ctx, was.schedule, cfg);
  b.gap();
  b.close(ctx.fmt.good('Saved.') + done);
}
