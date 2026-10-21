// Runs CLI commands against an in-memory repository and checks their output, settings, scheduled logs, updates
// and terminal handling. Recorded native output lives in test/fixtures/cli.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, rm, mkdtemp, chmod } from 'node:fs/promises';
import { readFileSync, renameSync, symlinkSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { Prompter } from '../../src/cli/prompt.js';
import { colorSequence, terminalProfile, convertProfile, type ColorProfile } from '../../src/cli/terminal.js';
import path from 'node:path';
import os from 'node:os';
import { execute } from '../../src/cli/index.js';
import { type Hooks, syncLaterCommand } from '../../src/cli/context.js';
import { Format, statusLine, cellWidth, tildify, humanBytes, when } from '../../src/cli/format.js';
import { phraseGrid } from '../../src/cli/key.js';
import { probe, explainConnect } from '../../src/cli/connect.js';
import { openScheduledLog, accessHint } from '../../src/cli/backup.js';
import { updateStatePath } from '../../src/cli/update.js';
import { knownPath, loadKnown } from '../../src/cli/known.js';
import { desiredJob, loadRuns, rememberFinish, rememberStart, runsPath, scheduledDue } from '../../src/cli/runs.js';
import { spawn } from 'node:child_process';
import { Manifest } from '../../src/core/manifest.js';
import { setTimeout as delay } from 'node:timers/promises';
import { rerunCommand } from '../../src/cli/restore.js';
import { Key } from '../../src/core/crypto.js';
import { Repo, chunkKey } from '../../src/core/repo.js';
import * as config from '../../src/core/config.js';
import * as update from '../../src/platform/update.js';
import { Memory } from '../support.js';
import { copyCLI } from '../copy.js';
import { APIError, PermafrostBackend, errConditionalUnsupported, request } from '../../src/core/storage.js';
import { createServer, type AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

// Joins lines and ends with a newline, the way the CLI prints them.
const lines = (...parts: string[]) => parts.join('\n') + '\n';

// Points frost's config and cache at private folders and stores backups in memory under a fixed key. The hooks
// record schedule changes and refuse to open a browser, go online or install anything.
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frost-cli-test-'));
  const src = path.join(root, 'src');
  const conf = path.join(root, 'config');
  const cache = path.join(root, 'cache');
  await mkdir(src);
  await mkdir(conf);
  await mkdir(cache);
  const oldConfig = process.env.FROST_CONFIG_DIR;
  const oldCache = process.env.FROST_CACHE_DIR;
  process.env.FROST_CONFIG_DIR = conf;
  process.env.FROST_CACHE_DIR = cache;

  const mem = new Memory();
  const key = Key.fromMaster(Buffer.alloc(32));
  const schedule: config.Config[] = [];
  const later = { count: 0 };
  const hooks: Partial<Hooks> = {
    backend: () => mem,
    newKey: () => key,
    pickWords: () => [2, 17],
    syncSchedule: async c => {
      schedule.push(structuredClone(c));
    },
    scheduleKind: async () => 'test scheduler',
    scheduleInstalled: async () => true,
    // Every scheduled run is due unless a test decides otherwise. The decision has its own tests.
    scheduledDue: async () => true,
    // A fixed noon, hours from the init answers' 6-hourly runs at 03:00, 09:00, 15:00 and 21:00, so a backup
    // typed in a terminal only asks first when a test sets the time.
    clock: () => new Date(2026, 9, 17, 12, 0),
    // Counts background processes a change waiting for a scheduled backup would start, without starting one.
    syncLater: () => {
      later.count++;
      return undefined;
    },
    // Long before any recorded run, so a run counts as running while its process is there.
    bootTime: () => 0,
    openBrowser: async () => {
      throw new Error('no browser in tests');
    },
    latestRelease: async () => {
      throw new Error('no network in tests');
    },
    installRelease: async () => {
      throw new Error('no updates in tests');
    },
  };

  // invoke runs a command and collects its exit code and output. must also requires it to succeed.
  const invoke = async (args: string[], input = '') => {
    let stdout = '',
      stderr = '';
    const code = await execute(args, {
      input,
      write: s => {
        stdout += s;
      },
      error: s => {
        stderr += s;
      },
      hooks,
    });
    return { code, stdout, stderr };
  };
  const must = async (args: string[], input = '') => {
    const result = await invoke(args, input);
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
    return result.stdout;
  };

  // Answers to every frost init prompt, in order.
  const answers = lines(
    '2', // S3-compatible storage
    'http://localhost:9000', // endpoint
    'us-east-1', // region
    'backups', // bucket
    '', // keep the default folder inside the bucket
    'AKID', // access key ID
    'SECRET', // secret access key
    src, // folders to back up
    '*.tmp', // files to skip
    'y', // back up automatically
    '6h', // how often
    '', // the phrase is written down
    key.phrase().split(' ')[2], // word #3, from pickWords
    key.phrase().split(' ')[17], // word #18
  );

  // junk.tmp matches the skip pattern above.
  await writeFile(path.join(src, 'todo.txt'), 'buy milk');
  await writeFile(path.join(src, 'junk.tmp'), 'skip');
  t.after(async () => {
    if (oldConfig === undefined) delete process.env.FROST_CONFIG_DIR;
    else process.env.FROST_CONFIG_DIR = oldConfig;
    if (oldCache === undefined) delete process.env.FROST_CACHE_DIR;
    else process.env.FROST_CACHE_DIR = oldCache;
    await rm(root, { recursive: true, force: true });
  });
  return { root, src, conf, cache, mem, key, schedule, later, hooks, invoke, must, answers };
}

// Uses the block helpers with colour off, so only the rail characters and spacing are compared.
test('plain rails, blank lines, hanging values and error closing match the recorded output', () => {
  let out = '';
  const fmt = new Format(s => {
    out += s;
  });
  const b = fmt.block();

  b.open('backup', 's3://backups/frost/');
  b.gap();
  b.row('files', '2 (300.0 kB)');
  b.warnRow('not found', "~/Old\nSkipped until it's back.");
  b.ok('valid phrase');
  b.fail("doesn't open\n\nthe repository");
  b.section('snapshots');
  assert.equal(fmt.blockOpen, true);
  b.close('Saved snapshot gift-flock-3664\nsecond line');
  assert.equal(fmt.blockOpen, false);

  assert.equal(
    out,
    lines(
      '',
      '┌  backup  s3://backups/frost/',
      '│',
      '│  files        2 (300.0 kB)',
      '▲  not found    ~/Old',
      "│               Skipped until it's back.",
      '●  valid phrase',
      "■  doesn't open",
      '│',
      '│  the repository',
      '├  snapshots',
      '└  Saved snapshot gift-flock-3664',
      '   second line',
      '',
    ),
  );

  // An error closes the block and hangs its later lines under the message.
  assert.equal(
    fmt.errorLine(new Error('restore stopped\n\nTo carry on, run:'), true),
    '└  error: restore stopped\n\n   To carry on, run:',
  );
});

// enableANSI reports a console that can't take escape sequences. Every command must still restore the console
// mode, even when writing its output fails.
test('console mode failure keeps setup in prompts, disables live escapes and restores mode after every command outcome', async t => {
  const f = await fixture(t);
  let restores = 0,
    setups = 0,
    stdout = '',
    stderr = '';
  const hooks: Partial<Hooks> = {
    ...f.hooks,
    enableANSI: () => ({
      ansiOK: false,
      restore: () => {
        restores++;
      },
    }),
    setup: async () => {
      setups++;
    },
  };
  // Runs a command as if every stream were a terminal.
  const invoke = async (args: string[], input = '') => {
    stdout = '';
    stderr = '';
    return execute(args, {
      input,
      inputTTY: true,
      outputTTY: true,
      errorTTY: true,
      colors: true,
      width: 80,
      write: s => {
        stdout += s;
      },
      error: s => {
        stderr += s;
      },
      hooks,
    });
  };

  // Without escape sequences, init stays in plain prompts and no command prints escapes or live progress.
  assert.equal(await invoke(['init'], f.answers), 0, stderr);
  assert.equal(setups, 0);
  assert.match(stdout, /your recovery phrase/);
  assert.doesNotMatch(stdout, /\x1b/);
  assert.equal(await invoke(['backup', '--no-verify']), 0, stderr);
  assert.doesNotMatch(stdout, /\x1b|\r/);
  assert.equal(await invoke(['restore', 'latest', '--overwrite', '-y']), 0, stderr);
  assert.doesNotMatch(stdout, /\x1b|\r/);
  assert.equal(await invoke(['unknown']), 1);
  assert.doesNotMatch(stderr, /\x1b/);
  assert.equal(restores, 4);

  // The mode is restored even when both output streams throw.
  await assert.rejects(
    execute([], {
      hooks,
      write: () => {
        throw new Error('write failed');
      },
      error: () => {
        throw new Error('error write failed');
      },
    }),
    /error write failed/,
  );
  assert.equal(restores, 5);

  // Once escape sequences work, init opens the full-screen setup instead.
  hooks.enableANSI = () => ({
    ansiOK: true,
    restore: () => {
      restores++;
    },
  });
  assert.equal(
    await execute(['init'], {
      input: '',
      inputTTY: true,
      outputTTY: true,
      colorProfile: 'ascii',
      write: () => {},
      error: () => {},
      hooks,
    }),
    0,
  );
  assert.equal(setups, 1);
  assert.equal(restores, 6);
});
test(
  'CLI matches captured reference output, errors and exit codes',
  {
    skip:
      !['win32', 'linux'].includes(process.platform) &&
      'Native command captures are recorded only for Windows and Linux.',
  },
  async t => {
    // Tests run from dist/test/cli, so the fixtures are three folders up.
    const f = await fixture(t);
    const referenceDir = new URL('../../../test/fixtures/cli/' + process.platform + '/', import.meta.url);
    const names = JSON.parse(readFileSync(new URL('index.json', referenceDir), 'utf8')).names as string[];
    const differences: string[] = [];

    // Each recording holds a command's args, input, exit code and both streams. Configured ones start from a fixed
    // config, and the rest start with none.
    for (const name of names) {
      const ref = JSON.parse(readFileSync(new URL(name + '.json', referenceDir), 'utf8'));
      process.env.FROST_CONFIG_DIR = f.conf;
      process.env.FROST_CACHE_DIR = f.cache;
      await rm(path.join(f.conf, 'config.toml'), { force: true });
      if (ref.configured)
        await writeFile(
          path.join(f.conf, 'config.toml'),
          'paths = [' +
            JSON.stringify(path.join(f.root, 'data').replaceAll('\\', '/')) +
            ']\nexclude = []\n[schedule]\nenabled = false\nevery = "daily"\n[verify]\nsample = 20\n[update]\nauto = true\n[storage]\nbackend = "permafrost"\n[storage.permafrost]\ntoken = "REFERENCE-ONLY"\n',
        );
      const args = ref.args.map((s: string) => s.replaceAll('<temp>', f.root));
      const actual = await f.invoke(args, ref.input ?? '');

      // The temporary folder and default config folder differ per machine, so both sides swap them for placeholders.
      const normalize = (s: string) =>
        s
          .replace(
            /use a different config directory \(default [^)]+\)/,
            'use a different config directory (default <config>)',
          )
          .replaceAll(f.root, '<temp>')
          .replaceAll(f.root.replaceAll('\\', '/'), '<temp>')
          .replaceAll(tildify(f.root), '<temp>');

      // Collect every mismatch, so one run reports them all.
      if (actual.code !== ref.code) differences.push(name + ' code: ' + actual.code + ' expected ' + ref.code);
      for (const stream of ['stdout', 'stderr'] as const)
        if (normalize(actual[stream]) !== copyCLI(normalize(ref[stream])))
          differences.push(
            name +
              ' ' +
              stream +
              ': ' +
              JSON.stringify(normalize(actual[stream])) +
              ' expected ' +
              JSON.stringify(copyCLI(normalize(ref[stream]))),
          );
    }
    assert.deepEqual(differences, []);
  },
);
// Without a key, plain init opens the key page for the default server and takes the key the user pastes.
test('plain init opens the key page for a new Permafrost key and takes the pasted key', async t => {
  const f = await fixture(t);
  const opened: string[] = [];
  f.hooks.openBrowser = async url => {
    opened.push(url);
  };
  const words = f.key.phrase().split(' ');
  const out = await f.must(['init'], lines('1', '2', 'pasted-key', f.src, '*.tmp', 'n', '', words[2], words[17]));
  assert.deepEqual(opened, ['https://getfro.st/perma']);
  assert.match(out, /Obtain a key at getfro\.st\/perma, then paste it below\./);
  assert.equal((await config.loadFile()).storage.permafrost.token, 'pasted-key');
});

// Setup shows Permafrost's own reason for refusing a key or an upload, and keeps its general advice when
// the server didn't give one.
test('setup errors carry the Permafrost server reason', () => {
  const said = (status: number, code: string, detail = '') =>
    explainConnect(new APIError(status, code, detail || 'error', detail)).message;
  assert.equal(
    said(401, 'unauthorized', 'this access key was replaced by a newer one'),
    'Permafrost rejected the access key. This access key was replaced by a newer one.',
  );
  assert.match(said(401, 'unauthorized'), /Ensure the entire key was copied correctly/);
  assert.equal(
    said(403, 'read_only', 'uploads are paused until the account is active again'),
    "Permafrost won't store backups with that access key. Uploads are paused until the account is active again.",
  );
  assert.equal(
    said(507, 'quota_exceeded', 'this upload would go over 100 GB'),
    'your Permafrost storage is full: this upload would go over 100 GB',
  );
  assert.equal(said(507, 'quota_exceeded'), 'your Permafrost storage is full');
});

// A rejected Permafrost key stops commands with the server's reason first, then the general advice.
test('a rejected key shows the Permafrost server reason', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  const refuse = async () => {
    throw new APIError(401, 'unauthorized', 'replaced', 'a newer key replaced this one on 11 October 2026');
  };
  Object.assign(f.mem, { get: refuse, put: refuse, putNew: refuse, list: refuse });
  const backup = await f.invoke(['backup']);
  assert.equal(backup.code, 1);
  assert.match(
    backup.stderr + backup.stdout,
    /the Permafrost access key was rejected: a newer key replaced this one on 11 October 2026\. Run `frost init`/,
  );
});

// Storage that reports its use gets a status row. When the storage has something to say, such as an account
// that's nearly full, status and backup both show it as a warning. A failed usage request shows nothing.
test('status shows storage use, and status and backup show the storage warning', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  const usage = { used: 82_400_000_000, quota: 100_000_000_000, readOnly: false, message: '' };
  Object.assign(f.mem, { usage: async () => usage });

  const quiet = await f.must(['status']);
  assert.match(quiet, /storage\s+82\.4 GB of 100\.0 GB used/);
  const backup = await f.must(['backup']);
  assert.ok(!/storage/.test(backup.replace(/backup\s+\S+/, '')), backup);

  usage.used = 92_000_000_000;
  usage.message = 'your storage is 92% full';
  const warned = await f.must(['status']);
  assert.match(warned, /▲\s+storage\s+Your storage is 92% full\.\n.*92\.0 GB of 100\.0 GB used/);
  assert.match(await f.must(['backup']), /▲\s+storage\s+Your storage is 92% full\./);

  Object.assign(f.mem, {
    usage: async () => {
      throw new Error('usage is unavailable');
    },
  });
  assert.ok(!(await f.must(['status'])).includes('GB used'));
});

test('init, dry run, backup, unchanged check, status, restore, settings, phrase verification and confirmation end to end', async t => {
  const f = await fixture(t);
  const init = await f.must(['init'], f.answers);
  assert.match(init, /Correct\./);
  assert.match(init, /frost is set up/);
  assert.equal(f.schedule[0].schedule.every, '6h');

  // A dry run lists what would go up, leaving out skipped files, and uploads nothing.
  const dry = await f.must(['backup', '--dry-run']);
  assert.match(dry, /todo.txt/);
  assert.ok(!dry.includes('junk.tmp'));
  assert.match(dry, /Nothing was uploaded/);

  const backup = await f.must(['backup']);
  assert.match(backup, /Saved snapshot/);
  assert.match(backup, /verified\s+ok/);

  // A second backup with nothing changed still checks objects, without downloading anything again.
  const unchanged = await f.must(['backup']);
  assert.match(unchanged, /Already backed up/);
  assert.match(unchanged, /objects checked/);
  assert.ok(!unchanged.includes('re-downloaded'));

  const status = await f.must(['status']);
  assert.match(status, /nothing new since/);
  assert.match(status, /health/);
  assert.match(status, /snapshots/);

  // Restoring into a folder makes a new folder inside it, holding each backed up folder by name.
  const target = path.join(f.root, 'restore');
  await mkdir(target);
  await f.must(['restore', 'latest', '--to', target]);
  const folder = (await readdir(target))[0];
  assert.equal((await readFile(path.join(target, folder, path.basename(f.src), 'todo.txt'))).toString(), 'buy milk');

  // Overwriting the originals asks first. Answering n keeps the edit, and -y skips the question.
  await writeFile(path.join(f.src, 'todo.txt'), 'edited');
  assert.equal((await f.invoke(['restore', 'latest', '--overwrite'], 'n\n')).code, 1);
  assert.equal((await readFile(path.join(f.src, 'todo.txt'))).toString(), 'edited');
  await f.must(['restore', 'latest', '--overwrite', '-y']);
  assert.equal((await readFile(path.join(f.src, 'todo.txt'))).toString(), 'buy milk');

  // Changing the schedule syncs the scheduled job again. Secrets stay masked in every view.
  await f.must(['config', 'set', 'schedule.every', 'daily']);
  assert.equal((await f.must(['config', 'get', 'schedule.every'])).trim(), 'daily');
  assert.equal(f.schedule.length, 2);
  assert.ok(!(await f.must(['config'])).includes('SECRET'));
  assert.equal((await f.must(['config', 'get', 'storage.s3.secret_access_key'])).trim(), '********');

  // key verify accepts only this repository's phrase, and key show needs the word show typed.
  assert.match(await f.must(['key', 'verify'], f.key.phrase() + '\n'), /opens the repository/);
  assert.equal((await f.invoke(['key', 'verify'], Key.new().phrase() + '\n')).code, 1);
  assert.equal((await f.invoke(['key', 'show'], 'no\n')).code, 1);
  assert.match(await f.must(['key', 'show'], 'show\n'), /key fingerprint/);
});

// The openEditor hook edits the draft file in place, as a real editor would.
test('config edit saves original bytes and comments only after yes, repairs parse errors, masks secrets, and removes drafts', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  const original = await readFile(config.configPath(), 'utf8');

  // Saving needs the whole word yes. Once saved, the comment survives and the draft is gone.
  f.hooks.openEditor = async (_command, file) => {
    const raw = await readFile(file, 'utf8');
    await writeFile(file, raw.replace('every = "6h"', '# mine\nevery = "daily"'));
  };
  assert.equal((await f.invoke(['config', 'edit'], 'y\n')).code, 1);
  assert.equal(await readFile(config.configPath(), 'utf8'), original);
  assert.match(await f.must(['config', 'edit'], 'yes\n'), /6h to daily/);
  assert.match(await readFile(config.configPath(), 'utf8'), /# mine/);
  assert.ok(!(await readdir(f.conf)).some(n => n.startsWith('.frost-edit-')));

  // The first edit doesn't parse, so frost offers to reopen it. The second edit fixes it.
  const saved = await readFile(config.configPath(), 'utf8');
  let n = 0;
  f.hooks.openEditor = async (_command, file) => {
    await writeFile(file, ++n === 1 ? saved + '\nnot toml\n' : saved + '\n# fixed\n');
  };
  assert.match(await f.must(['config', 'edit'], 'y\nyes\n'), /Open it again/);

  // A changed secret is reported as changed without showing either value.
  f.hooks.openEditor = async (_command, file) => {
    await writeFile(file, (await readFile(file, 'utf8')).replace('"SECRET"', '"NEWSECRET"'));
  };
  const out = await f.must(['config', 'edit'], 'yes\n');
  assert.match(out, /secret_access_key\s+changed/);
  assert.ok(!out.includes('SECRET'));
});

test("settings reinstall a missing schedule and don't write environment credentials", async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);

  // The scheduled job has gone missing, so saving a schedule setting installs it again.
  f.hooks.scheduleInstalled = async () => false;
  assert.match(await f.must(['config', 'set', 'schedule.enabled', 'true']), /Scheduled job reinstalled/);
  assert.equal(f.schedule.length, 2);

  // A secret supplied by the environment must never be written into the config file.
  const old = process.env.FROST_S3_SECRET_ACCESS_KEY;
  process.env.FROST_S3_SECRET_ACCESS_KEY = 'ENV-SECRET';
  try {
    await f.must(['config', 'set', 'verify.sample', '0']);
    assert.ok(!(await readFile(config.configPath(), 'utf8')).includes('ENV-SECRET'));
  } finally {
    if (old === undefined) delete process.env.FROST_S3_SECRET_ACCESS_KEY;
    else process.env.FROST_S3_SECRET_ACCESS_KEY = old;
  }
});

// With ignored set, putNew overwrites like put, as on storage that ignores conditional writes. The probe must
// notice. Either way, and when listing fails, it leaves no objects behind.
test('storage probe rejects ignored conditions and cleans up after every failure', async () => {
  for (const ignored of [false, true]) {
    const mem = new Memory();
    if (ignored) mem.putNew = async (k, b) => mem.put(k, b);
    if (ignored) await assert.rejects(probe(mem), e => e === errConditionalUnsupported);
    else await probe(mem);
    assert.equal(mem.objects.size, 0);
  }

  const mem = new Memory();
  mem.list = async () => {
    throw new Error('listing denied');
  };
  await assert.rejects(probe(mem), /listing denied/);
  assert.equal(mem.objects.size, 0);
});

test('scheduled log contains plain backup, verification, failures and update output; trimming preserves small old logs', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);

  // The log folder's name has spaces and characters that shells and format strings treat specially.
  const log = path.join(f.root, 'log & 100% !', 'frost.log');
  await f.must(['backup', '--scheduled', '--log-file', log]);
  await f.must(['backup', '--scheduled', '--log-file', log]);
  const raw = await readFile(log, 'utf8');
  assert.equal(raw.match(/scheduled backup starting/g)!.length, 2);
  assert.match(raw, /Saved snapshot/);
  assert.match(raw, /Already backed up/);
  assert.ok(!raw.includes('SECRET'));
  assert.ok(!raw.includes('\x1b'));

  // A small log is appended to. One over 1 MiB starts again from empty.
  const small = path.join(f.root, 'small.log');
  await writeFile(small, 'old');
  let fh = await openScheduledLog(small);
  await fh.write('new\n');
  await fh.close();
  assert.equal(await readFile(small, 'utf8'), 'oldnew\n');
  await writeFile(small, Buffer.alloc((1 << 20) + 1, 120));
  fh = await openScheduledLog(small);
  await fh.write('new\n');
  await fh.close();
  assert.equal(await readFile(small, 'utf8'), 'new\n');
});

// Moves the log's folder away while the log is open and puts a link to another folder in its place. Writes must
// still reach the original file.
test('scheduled log retains its file during parent replacement and refuses an outside leaf link', async t => {
  const f = await fixture(t);
  const parent = path.join(f.root, 'log-parent');
  const moved = path.join(f.root, 'log-moved');
  const outside = path.join(f.root, 'outside');
  await mkdir(parent);
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  const file = await openScheduledLog(path.join(parent, 'frost.log'));

  // Windows may refuse to rename a folder while a file inside it is open. Then the swap waits until the log closes.
  let renamed = false;
  try {
    try {
      renameSync(parent, moved);
      renamed = true;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
    if (renamed) symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    await file.write('confined\n');
  } finally {
    await file.close();
  }
  if (!renamed) {
    renameSync(parent, moved);
    symlinkSync(outside, parent, 'junction');
  }
  assert.equal(await readFile(path.join(moved, 'frost.log'), 'utf8'), 'confined\n');
  assert.deepEqual(await readdir(outside), ['sentinel']);

  // Opening through the link now fails. frost follows a link only from a folder others can't write to, so loosen
  // the folder's mode. On Windows it refuses every link.
  if (process.platform !== 'win32') await chmod(f.root, 0o777);
  try {
    await assert.rejects(openScheduledLog(path.join(parent, 'frost.log')), /link/);
  } finally {
    if (process.platform !== 'win32') await chmod(f.root, 0o700);
  }

  // The log file itself can't be a link.
  const leaf = path.join(f.root, 'leaf.log');
  symlinkSync(path.join(outside, 'sentinel'), leaf, 'file');
  await assert.rejects(openScheduledLog(leaf), /regular file/);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});

test('scheduled log write failures cannot reject unattended backups or prevent closing the log', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);

  // Every log write fails. The backup must still succeed and the log must still close.
  let writes = 0,
    closes = 0;
  f.hooks.scheduledLog = async () => ({
    write: async () => {
      writes++;
      throw new Error('disk full');
    },
    close: async () => {
      closes++;
    },
  });
  f.mem.beforePut = async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
  };
  assert.equal((await f.invoke(['backup', '--scheduled', '--log-file', path.join(f.root, 'dummy.log')])).code, 0);
  assert.ok(writes > 1);
  assert.equal(closes, 1);

  // A real storage failure fails the backup, and the log still closes.
  f.mem.beforePut = async () => {
    throw new Error('storage unavailable');
  };
  await writeFile(path.join(f.src, 'todo.txt'), 'new backup');
  assert.equal((await f.invoke(['backup', '--scheduled', '--log-file', path.join(f.root, 'dummy.log')])).code, 1);
  assert.equal(closes, 2);
});

test('updates check permissions first, do not install on --check, and automatic failure cannot fail a backup', async t => {
  const f = await fixture(t);
  let checks = 0,
    installs = 0;
  const hooks: Partial<Hooks> = {
    ...f.hooks,
    selfPath: () => '/frost',
    canReplace: async () => {},
    latestRelease: async () => {
      checks++;
      return { version: 'v0.2.0', archive: 'frost_x.zip', page: 'https://example.com/v0.2.0', sum: Buffer.alloc(32) };
    },
    installRelease: async () => {
      installs++;
    },
  };
  // Runs a command as installed version v0.1.0, with both streams going to out.
  let out = '';
  const invoke = (args: string[]) =>
    execute(args, {
      input: '',
      version: 'v0.1.0',
      write: s => {
        out += s;
      },
      error: s => {
        out += s;
      },
      hooks,
    });

  assert.equal(await invoke(['update', '--check']), 0);
  assert.equal(installs, 0);
  assert.match(out, /Install it with frost update/);

  assert.equal(await invoke(['update']), 0);
  assert.equal(installs, 1);
  assert.equal((await update.loadState(updateStatePath())).installed, 'v0.2.0');

  // When frost can't replace itself, update fails before it asks for the latest release.
  hooks.canReplace = async () => {
    throw new Error("can't write");
  };
  assert.equal(await invoke(['update']), 1);
  assert.equal(checks, 2);

  // A scheduled backup checks for updates at most every 20 hours, so clear the state to force a check. A failed
  // check is logged and saved but doesn't fail the backup.
  await f.must(['init'], f.answers);
  hooks.latestRelease = async () => {
    throw new Error('network down');
  };
  await rm(updateStatePath());
  out = '';
  assert.equal(await invoke(['backup', '--scheduled']), 0);
  assert.match(out, /update check failed: network down/);
  assert.equal((await update.loadState(updateStatePath())).error, 'network down');
});

// The installer and the updater read the last word of `--version` as the version, so it has to stay last. An installed
// frost applies that rule to every later release.
test('--version ends with the version', async t => {
  const f = await fixture(t);
  let out = '';
  const code = await execute(['--version'], {
    input: '',
    version: 'v1.2.3-rc.1',
    write: s => {
      out += s;
    },
    error: s => {
      out += s;
    },
    hooks: f.hooks,
  });
  assert.equal(code, 0);
  assert.equal(out.trim().split(/\s+/).at(-1), 'v1.2.3-rc.1');
});

test('terminal sanitizing, truncation, palette and numbered phrase columns preserve visible behavior', () => {
  // The live status line clears its row first, and its text stays narrower than the terminal so it never wraps.
  for (const width of [1, 2, 3, 10, 40, 80]) {
    let out = '';
    statusLine(
      s => {
        out += s;
      },
      '\x1b[34m│\x1b[0m  文件 🧊 ' + 'long'.repeat(20),
      width,
    );
    assert.ok(out.startsWith('\r\x1b[K'));
    assert.ok(cellWidth(out.slice(4)) < width);
  }

  // With colour on, the rail uses the #4353ff accent. Error text turns escape characters into '?'.
  const fmt = new Format(() => {}, true);
  assert.match(fmt.rail('│'), /^\x1b\[38;2;67;83;255m/);
  assert.equal(fmt.errorText(new Error('first\n\nsecond \x1b[31mred')), 'first\n\nsecond ?[31mred');

  // The phrase grid numbers its 24 words down four columns of six.
  const grid = phraseGrid(new Format(() => {}), Key.fromMaster(Buffer.alloc(32)).phrase());
  assert.equal(grid.split('\n').length, 6);
  assert.match(grid.split('\n')[0], / 1\. abandon\s+7\. abandon\s+13\. abandon\s+19\. abandon/);
});

test('byte display preserves binary tie-to-even rounding and timestamps pad years', () => {
  const reference = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/cli/format.json', import.meta.url), 'utf8'),
  ) as { bytes: { bytes: number; text: string }[]; times: { time: string; text: string }[] };
  for (const vector of reference.bytes) assert.equal(humanBytes(vector.bytes), vector.text, String(vector.bytes));

  // The recorded times are in UTC.
  const old = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    for (const vector of reference.times) assert.equal(when(vector.time), vector.text, vector.time);
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});

test('hidden terminal input never leaks into the next answer, restores raw mode and handles split UTF-8', async () => {
  // This stream stands in for terminal input, and setRawMode records the mode so the test can check it's restored.
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  let output = '';
  const p = new Prompter(
    new Format(s => {
      output += s;
    }),
    input,
    true,
  );

  // The input splits a character across writes, then backspace and ctrl+u erase everything typed so far. Only
  // TOKEN is kept, and the line after the CRLF waits for the next question.
  const secret = p.secret('Access key');
  const word = Buffer.from('私');
  input.write(word.subarray(0, 1));
  input.write(word.subarray(1));
  input.write('old\x7f\x15TOKEN\r\nnext\n');
  assert.equal(await secret, 'TOKEN');
  assert.equal(input.isRaw, false);
  assert.equal(await p.answer(), 'next');

  // Only the prompt is echoed, never what was typed.
  assert.ok(!output.includes('TOKEN'));
  assert.ok(!output.includes('old'));
  assert.equal(output, '│  Access key \n');
  await p.closeInput();

  // Cancelling a hidden read still restores raw mode.
  const controller = new AbortController();
  const second = new Prompter(new Format(() => {}), input, true, controller.signal);
  const waiting = second.hidden();
  controller.abort();
  await assert.rejects(waiting, /context canceled/);
  assert.equal(input.isRaw, false);
  await second.closeInput();
});

test('terminal palette conversion matches recorded truecolor, ANSI256 and ANSI16 with the same environment rules', () => {
  const reference = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/cli/colors.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''),
  ) as Record<ColorProfile, Record<string, string>>;

  // Every palette colour converts to its recorded sequence in each profile.
  for (const profile of ['truecolor', 'ansi256', 'ansi'] as const)
    for (const [hex, sequence] of Object.entries(reference[profile])) {
      assert.equal(colorSequence(hex, profile), sequence);
      const color = reference.truecolor[hex];
      assert.equal(convertProfile('\x1b[' + color + 'mcolor\x1b[0m', profile), '\x1b[' + sequence + 'mcolor\x1b[0m');
    }

  // Profile detection reads variables such as TERM, COLORTERM, NO_COLOR, CLICOLOR_FORCE, CI and ANSICON, and the
  // build number on Windows.
  assert.equal(terminalProfile(true, { TERM: 'xterm-256color' }, 'linux'), 'ansi256');
  assert.equal(terminalProfile(true, { TERM: 'xterm' }, 'linux'), 'ansi');
  assert.equal(terminalProfile(true, { TERM: 'screen-256color', COLORTERM: 'truecolor' }, 'linux'), 'ansi256');
  assert.equal(
    terminalProfile(true, { TERM: 'screen-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'tmux' }, 'linux'),
    'truecolor',
  );
  assert.equal(terminalProfile(false, { CLICOLOR_FORCE: '1' }, 'linux'), 'ansi');
  assert.equal(terminalProfile(true, { NO_COLOR: '1', CLICOLOR_FORCE: '1' }, 'linux'), 'ascii');
  assert.equal(terminalProfile(true, { CI: '1', COLORTERM: 'truecolor' }, 'linux'), 'ascii');
  assert.equal(terminalProfile(true, {}, 'win32', '10.0.26100'), 'truecolor');
  assert.equal(terminalProfile(true, {}, 'win32', '10.0.14393'), 'ansi256');
  assert.equal(terminalProfile(true, { ANSICON: '1', ANSICON_VER: '180' }, 'win32', '6.1.7601'), 'ansi');
  assert.equal(convertProfile('\x1b[1;38;2;67;83;255mrail\x1b[0m', 'ascii'), 'rail');
});

// The storage record is a cache. Anything that isn't a JSON object counts as no record.
test('a storage record that is not an object counts as empty', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'frost-known-'));
  const saved = { config: process.env.FROST_CONFIG_DIR, cache: process.env.FROST_CACHE_DIR };
  process.env.FROST_CONFIG_DIR = path.join(folder, 'config');
  process.env.FROST_CACHE_DIR = path.join(folder, 'cache');
  t.after(async () => {
    if (saved.config === undefined) delete process.env.FROST_CONFIG_DIR;
    else process.env.FROST_CONFIG_DIR = saved.config;
    if (saved.cache === undefined) delete process.env.FROST_CACHE_DIR;
    else process.env.FROST_CACHE_DIR = saved.cache;
    await rm(folder, { recursive: true, force: true });
  });

  await mkdir(path.join(folder, 'cache'), { recursive: true });
  for (const text of ['null', '[]', '"text"', '{not json']) {
    await writeFile(knownPath(), text);
    assert.deepEqual(await loadKnown(), {});
  }
});

// Ordinary rerun hints work in the platform's usual shells. Windows shell expansion characters need
// PowerShell literals and the runtime directly, bypassing the batch launcher.
test('restore rerun hints quote arguments for the platform shell', () => {
  const flags = { beside: false, to: '', overwrite: false, yes: false };
  assert.equal(
    rerunCommand('ab12', ["/home/me/it's here"], { ...flags, to: '/tmp/out dir' }, 'linux'),
    "frost restore ab12 '/home/me/it'\\''s here' --to '/tmp/out dir'",
  );
  assert.equal(
    rerunCommand('ab12', ['/home/me/plain'], { ...flags, beside: true }, 'linux'),
    'frost restore ab12 /home/me/plain --beside',
  );
  assert.equal(
    rerunCommand(
      'ab12',
      [],
      { ...flags, to: '/tmp/a\\b', configDir: '/tmp/config dir', cacheDir: '/tmp/cache' },
      'linux',
    ),
    "frost restore ab12 --to '/tmp/a\\b' --config-dir '/tmp/config dir' --cache-dir /tmp/cache",
  );
  assert.equal(
    rerunCommand(
      'ab12',
      ['C:\\Users\\me\\My Files', 'C:\\Users\\me\\plain'],
      { ...flags, to: 'D:\\Restore Folder' },
      'win32',
    ),
    'frost restore ab12 "C:\\Users\\me\\My Files" C:\\Users\\me\\plain --to "D:\\Restore Folder"',
  );
  const special = rerunCommand(
    'ab12',
    ["C:\\Users\\me\\$cash`back%USERPROFILE%!it's"],
    { ...flags, to: 'D:\\Restore (1)' },
    'win32',
  );
  assert.ok(special.startsWith('& '));
  const literals = [...special.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1].replaceAll("''", "'"));
  assert.equal(literals[0], process.execPath);
  assert.ok(literals[1].endsWith(process.env.FROST_APP_ROOT ? 'launch.mjs' : 'main.js'));
  assert.deepEqual(literals.slice(2), [
    'restore',
    'ab12',
    "C:\\Users\\me\\$cash`back%USERPROFILE%!it's",
    '--to',
    'D:\\Restore (1)',
  ]);
});

test(
  'restore selections preserve a literal backslash in POSIX filenames',
  { skip: process.platform === 'win32' },
  async t => {
    const f = await fixture(t);
    const selected = path.join(f.src, 'report\\final.txt');
    await writeFile(selected, 'literal backslash');
    await f.must(['init'], f.answers);
    await f.must(['backup']);
    const target = path.join(f.root, 'selected');
    await mkdir(target);
    await f.must(['restore', 'latest', selected, '--to', target]);
    const folders = await readdir(target);
    assert.equal(folders.length, 1);
    assert.deepEqual(await readdir(path.join(target, folders[0])), ['report\\final.txt']);
    assert.equal(await readFile(path.join(target, folders[0], 'report\\final.txt'), 'utf8'), 'literal backslash');
  },
);

test('an interrupted restore keeps its config and cache directories in the command that resumes it', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  await f.must(['backup']);
  const target = path.join(f.root, 'resume');
  await mkdir(target);
  const repo = await Repo.open(f.mem, f.key);
  const snapshot = (await repo.snapshots())[0];
  const tree = await repo.loadTree(snapshot.id);
  const fileChunk = chunkKey(tree.files.find(file => file.type === 'file')!.chunks![0]);
  f.mem.beforeGet = async key => {
    if (key === fileChunk) throw new Error('connection lost');
  };
  const stopped = await f.invoke(['restore', 'latest', '--to', target]);
  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /To resume, run(?: the following in PowerShell)?:/);
  assert.ok(
    stopped.stderr.includes(
      rerunCommand(snapshot.id, [], {
        beside: false,
        to: target,
        overwrite: false,
        yes: false,
        configDir: f.conf,
        cacheDir: f.cache,
      }),
    ),
  );

  f.mem.beforeGet = undefined;
  await f.must(['restore', snapshot.id, '--to', target, '--config-dir', f.conf, '--cache-dir', f.cache]);
  const folders = await readdir(target);
  assert.equal(folders.length, 1);
  assert.equal(await readFile(path.join(target, folders[0], path.basename(f.src), 'todo.txt'), 'utf8'), 'buy milk');
});

// macOS asks a scheduled run about the bundled runtime, and a run started in a terminal about the terminal app.
test('the macOS access hint names what macOS asks about', () => {
  const runtime = '/Users/me/Library/Application Support/frost/app/runtime/bin/node';
  const settings = 'Open System Settings > Privacy & Security > Full Disk Access and ';
  assert.match(
    accessHint(true, runtime, { TERM_PROGRAM: 'Apple_Terminal' }),
    new RegExp(settings + 'add or enable /Users/me/.+/node\\.$'),
  );
  assert.match(
    accessHint(false, runtime, { TERM_PROGRAM: 'Apple_Terminal' }),
    new RegExp(
      settings +
        'allow Terminal \\(the application running frost\\)\\. Scheduled backups also require /Users/me/.+/node on this list\\.$',
    ),
  );
  assert.match(
    accessHint(false, runtime, { TERM_PROGRAM: 'iTerm.app' }),
    /allow iTerm \(the application running frost\)/,
  );
  assert.match(accessHint(false, runtime, {}), /allow the terminal application running frost\. /);
});

// Runs a command as if typed in a terminal, so `frost backup` can ask before it starts.
async function interactive(f: Awaited<ReturnType<typeof fixture>>, args: string[], input: string) {
  let stdout = '',
    stderr = '';
  const code = await execute(args, {
    input,
    inputTTY: true,
    write: s => {
      stdout += s;
    },
    error: s => {
      stderr += s;
    },
    hooks: f.hooks,
  });
  return { code, stdout, stderr };
}

const snapshotCount = (f: Awaited<ReturnType<typeof fixture>>) =>
  [...f.mem.objects.keys()].filter(k => k.startsWith('snapshots/')).length;

// The fixture's init answers back up every 6 hours, counted from the default 15:00, so runs fall at 03:00,
// 09:00, 15:00 and 21:00. A run that isn't due prints nothing, keeps no log and checks for no updates.
test('scheduled runs back up once per run time, catch up a missed one and record how they ended', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  let now = new Date(2026, 9, 17, 15, 0, 20);
  f.hooks.clock = () => now;
  f.hooks.scheduledDue = scheduledDue;
  let checks = 0;
  f.hooks.latestRelease = async () => {
    checks++;
    throw new Error('no network in tests');
  };
  const log = path.join(f.root, 'frost.log');
  const scheduled = async () => {
    let stdout = '';
    const code = await execute(['backup', '--scheduled', '--log-file', log], {
      write: s => {
        stdout += s;
      },
      error: () => {},
      hooks: f.hooks,
      version: 'v1.0.0',
    });
    assert.equal(code, 0);
    return stdout;
  };

  assert.match(await scheduled(), /Saved snapshot/);
  assert.equal(checks, 1);
  const run = (await loadRuns()).run!;
  assert.deepEqual(
    { ...run, id: '' },
    {
      id: '',
      started: now.toISOString(),
      scheduled: true,
      pid: process.pid,
      finished: now.toISOString(),
      ok: true,
    },
  );

  // A second start for 15:00, then one after a backup by hand covered 21:00, both do nothing.
  await rm(updateStatePath(), { force: true });
  now = new Date(2026, 9, 17, 15, 5);
  assert.equal(await scheduled(), '');
  now = new Date(2026, 9, 17, 20, 59, 30);
  await f.must(['backup']);
  now = new Date(2026, 9, 17, 21, 0, 10);
  assert.equal(await scheduled(), '');
  assert.equal((await readFile(log, 'utf8')).match(/scheduled backup starting/g)!.length, 1);
  assert.equal(checks, 1);

  // The computer was off from 21:00 until 10:00. The first start backs up once for 03:00 and 09:00.
  now = new Date(2026, 9, 18, 10, 0);
  assert.match(await scheduled(), /scheduled backup starting/);
  now = new Date(2026, 9, 18, 10, 15);
  assert.equal(await scheduled(), '');

  // With catch-up off, a late start skips the run it missed, and the next run on time backs up.
  await f.must(['config', 'set', 'schedule.catch_up', 'false']);
  now = new Date(2026, 9, 18, 16, 0);
  assert.equal(await scheduled(), '');
  now = new Date(2026, 9, 18, 21, 3);
  assert.match(await scheduled(), /scheduled backup starting/);
});

test('a backup by hand asks first near a scheduled backup', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  let now = new Date(2026, 9, 17, 14, 20);
  f.hooks.clock = () => now;

  // Saying no saves nothing and stops like a declined restore. The question sits in the backup block.
  const declined = await interactive(f, ['backup'], 'n\n');
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /cancelled/);
  assert.match(
    declined.stdout,
    /┌ {2}backup {2}memory\n│\n│ {2}A scheduled backup starts in 40m, at 15:00\.\n│ {2}Back up now anyway\? \[Y\/n\] /,
  );
  assert.equal(snapshotCount(f), 0);

  // Enter goes ahead, and the result continues in the same block.
  const accepted = await interactive(f, ['backup'], '\n');
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(accepted.stdout.match(/┌/g)!.length, 1);
  assert.match(accepted.stdout, /Back up now anyway\? \[Y\/n\] │\n│ {2}files .*\n[^]*Saved snapshot/);
  assert.equal(snapshotCount(f), 1);

  // Under a minute away, it gives only the time.
  now = new Date(2026, 9, 17, 14, 59, 30);
  assert.match((await interactive(f, ['backup'], 'n\n')).stdout, /A scheduled backup starts at 15:00\./);

  // Nothing is asked without a terminal, for a dry run, for chosen folders, or when the job is missing or off.
  assert.ok(!(await f.must(['backup'])).includes('scheduled backup'));
  assert.ok(!(await interactive(f, ['backup', '--dry-run'], '')).stdout.includes('scheduled backup'));
  assert.ok(!(await interactive(f, ['backup', f.src], '')).stdout.includes('scheduled backup'));
  f.hooks.scheduleInstalled = async () => false;
  assert.ok(!(await interactive(f, ['backup'], '')).stdout.includes('scheduled backup'));
  f.hooks.scheduleInstalled = async () => true;

  // After a scheduled backup that worked, it says when that finished. A backup by hand since then, or a
  // failed scheduled one, means there's nothing to ask.
  const id = await rememberStart(true, new Date(2026, 9, 17, 15, 0));
  await rememberFinish(id, true, new Date(2026, 9, 17, 15, 20));
  now = new Date(2026, 9, 17, 16, 0);
  assert.match((await interactive(f, ['backup'], 'n\n')).stdout, /A scheduled backup finished 40m ago\./);
  assert.equal((await interactive(f, ['backup'], 'y\n')).code, 0);
  assert.ok(!(await interactive(f, ['backup'], '')).stdout.includes('scheduled backup'));
  const failed = await rememberStart(true, new Date(2026, 9, 17, 15, 0));
  await rememberFinish(failed, false, new Date(2026, 9, 17, 15, 20));
  assert.ok(!(await interactive(f, ['backup'], '')).stdout.includes('scheduled backup'));

  await f.must(['config', 'set', 'schedule.enabled', 'false']);
  now = new Date(2026, 9, 17, 20, 30);
  assert.ok(!(await interactive(f, ['backup'], '')).stdout.includes('scheduled backup'));
});

// Both kinds of backup take the manifest's lock. A backup by hand that finds a scheduled one running says
// so, and a scheduled run waits past the usual second for a backup by hand to finish.
test('backups by hand and scheduled backups take turns with the backups', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  await f.must(['backup']);
  const file = path.join(f.cache, 'manifest-' + (await loadKnown()).repo_id + '.jsonl');
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 5);

  let held = await Manifest.open(file);
  try {
    assert.match(
      (await f.invoke(['backup'])).stderr,
      /a backup or restore operation is already in progress; try again when it completes/,
    );
    await rememberStart(true, new Date(2026, 9, 17, 15, 0));
    const busy = await f.invoke(['backup']);
    assert.equal(busy.code, 1);
    assert.match(
      busy.stderr,
      /a scheduled backup is already running \(started 5m ago\); please try again once it completes/,
    );
  } finally {
    await held.close();
  }

  held = await Manifest.open(file);
  const waiting = f.invoke(['backup', '--scheduled']);
  await delay(1500);
  await held.close();
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Already backed up/);
});

// A computer that just woke often has no network yet. Scheduled runs try again for about 5 minutes, a
// backup by hand fails at once, and an error that isn't about reaching storage never waits.
test('scheduled runs wait for the network, and other failures stop at once', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  const waits: number[] = [];
  f.hooks.wait = async ms => {
    waits.push(ms);
  };
  let failures = 2;
  f.mem.beforeGet = async () => {
    if (failures-- > 0) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), { code: 'ECONNREFUSED' });
  };
  await f.must(['backup', '--scheduled']);
  assert.deepEqual(waits, [10_000, 20_000]);

  failures = 1;
  waits.length = 0;
  assert.match((await f.invoke(['backup'])).stderr, /ECONNREFUSED/);
  assert.deepEqual(waits, []);

  failures = Infinity;
  assert.match((await f.invoke(['backup', '--scheduled'])).stderr, /ECONNREFUSED/);
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000, 150_000]);

  waits.length = 0;
  f.mem.beforeGet = async () => {
    throw new Error('access denied');
  };
  assert.match((await f.invoke(['backup', '--scheduled'])).stderr, /access denied/);
  assert.deepEqual(waits, []);
});

// The real Permafrost client, pointed at a loopback port where nothing listens, gives up after its own
// attempts with the connection error. A scheduled run sees it as offline and waits; its pauses are skipped.
test('scheduled runs recognise a refused connection from the real storage client', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise(resolve => server.close(resolve));

  f.hooks.backend = () => new PermafrostBackend('http://127.0.0.1:' + port, 'REFERENCE-ONLY', request, async () => {});
  const waits: number[] = [];
  f.hooks.wait = async ms => {
    waits.push(ms);
  };
  const result = await f.invoke(['backup', '--scheduled']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ECONNREFUSED/);
  assert.deepEqual(waits, [10_000, 20_000, 40_000, 80_000, 150_000]);
});

// Replaces text in config.toml the way a text editor would, outside frost.
async function handEdit(from: string, to: string) {
  const file = config.configPath();
  const raw = await readFile(file, 'utf8');
  assert.ok(raw.includes(from), from);
  await writeFile(file, raw.replace(from, to));
}

// A schedule changed in config.toml outside frost updates the job before the next command runs, with a line
// saying so. Commands that find nothing changed say nothing, and `config get` stays bare for scripts.
test('commands bring the scheduled job in line with hand edits to config.toml', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  assert.equal(f.schedule.length, 1);

  await handEdit('every = "6h"', 'every = "daily"');
  assert.equal((await f.must(['config', 'get', 'schedule.every'])).trim(), 'daily');
  assert.equal(f.schedule.length, 1);
  assert.match(await f.must(['status']), /^\nconfig\.toml changed\. Scheduled job updated: daily\.\n\n┌ {2}frost/);
  assert.equal(f.schedule.length, 2);
  assert.equal(f.schedule[1].schedule.every, 'daily');
  assert.ok(!(await f.must(['status'])).includes('config.toml changed'));

  // A setting that's wrong is reported on every command until it's fixed, and the job stays as it was.
  await handEdit('time = "15:00"', 'time = "noon"');
  const wrong = await f.must(['status']);
  assert.match(
    wrong,
    /^\nconfig\.toml changed, but updating the scheduled job failed: schedule\.time must use 24-hour HH:MM format/,
  );
  assert.match(wrong, /next backup\s+schedule\.time must use 24-hour HH:MM format/);
  assert.equal(f.schedule.length, 2);
  await handEdit('time = "noon"', 'time = "09:30"');

  // A scheduler that refuses doesn't stop the command.
  f.hooks.syncSchedule = async () => {
    throw new Error('scheduler refused');
  };
  const refused = await f.must(['backup']);
  assert.match(
    refused,
    /^\nconfig\.toml changed, but updating the scheduled job failed: scheduler refused\n\n┌ {2}backup/,
  );
  assert.match(refused, /Saved snapshot/);
  f.hooks.syncSchedule = async c => {
    f.schedule.push(structuredClone(c));
  };

  // `config set` applies an earlier hand edit before its own change.
  const set = await f.must(['config', 'set', 'verify.sample', '5']);
  assert.match(set, /^\nconfig\.toml changed\. Scheduled job updated: daily\.\n\n┌ {2}config/);
  assert.equal(f.schedule.at(-1)!.schedule.time, '09:30');

  // Turning automatic backups off by hand removes the job.
  await handEdit('enabled = true', 'enabled = false');
  assert.match(await f.must(['config']), /^\nconfig\.toml changed\. Scheduled job removed\.\n/);
  assert.equal(f.schedule.at(-1)!.schedule.enabled, false);
});

// A scheduled run decides from config.toml as it is, so a job left over after automatic backups were turned
// off by hand does nothing. On Linux the run also updates its own job; launchd and Task Scheduler jobs wait
// for the next command, since replacing them would stop the run.
test('scheduled runs follow hand edits to config.toml', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 0, 20);
  f.hooks.scheduledDue = scheduledDue;

  await handEdit('every = "6h"', 'every = "daily"');
  f.hooks.scheduleKind = async () => 'launchd';
  const untouched = await f.invoke(['backup', '--scheduled']);
  assert.equal(untouched.code, 0, untouched.stderr);
  assert.ok(!untouched.stdout.includes('config.toml changed'));
  assert.equal(f.schedule.length, 1);

  f.hooks.scheduleKind = async () => 'cron';
  const updated = await f.must(['backup', '--scheduled']);
  assert.match(updated, /^\[[^\]]+\] config\.toml changed\. Scheduled job updated: daily\.\n/);
  assert.equal(f.schedule.length, 2);

  // Turned off by hand, the run does nothing, and removing the job waits for a command.
  await handEdit('enabled = true', 'enabled = false');
  assert.equal(await f.must(['backup', '--scheduled']), '');
  assert.equal(f.schedule.length, 2);
});

// The next backup follows the calendar, so a backup by hand doesn't move it. A run time that passed moments
// ago is starting soon, and one missed is overdue while catch-up is on.
test("status shows the next run time the schedule hasn't covered", async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  let now = new Date(2026, 9, 17, 12, 0);
  f.hooks.clock = () => now;
  const next = async () => /next backup\s+(\S+(?: \S+)?)/.exec(await f.must(['status']))![1];

  assert.equal(await next(), 'soon');
  await f.must(['backup']);
  assert.equal(await next(), '~in 3h');
  now = new Date(2026, 9, 17, 15, 4);
  assert.equal(await next(), 'soon');
  now = new Date(2026, 9, 17, 16, 0);
  assert.equal(await next(), '~overdue');
  await f.must(['config', 'set', 'schedule.catch_up', 'false']);
  assert.equal(await next(), '~in 5h');
});

// A storage location changed in config.toml outside frost gets the checks `config edit` would show, the
// first time a command uses it. Problems that stop it opening are left to the command's own error.
test('a hand-edited storage location is checked the first time it is used', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  await f.must(['backup']);
  const other = new Memory();
  other.place = 'memory-2';
  other.toString = () => 'memory-2';
  f.hooks.backend = s => (s.s3.bucket === 'other' ? other : f.mem);

  // Only frost.repo was copied, so the snapshots stay behind.
  other.objects.set('frost.repo', f.mem.objects.get('frost.repo')!);
  await handEdit('bucket = "backups"', 'bucket = "other"');
  const moved = await f.must(['status']);
  assert.match(
    moved,
    /^\nconfig\.toml changed where backups go\. memory-2 contains frost\.repo but no snapshot data\. Transfer the chunks\/, snapshots\/, and trees\/ folders to complete the repository transfer\.\n\n┌/,
  );
  assert.ok(!(await f.must(['status'])).includes('config.toml changed'));

  // Different backups made with the same key are pointed out once.
  await handEdit('bucket = "other"', 'bucket = "backups"');
  await f.must(['status']);
  other.objects.clear();
  await Repo.init(other, f.key);
  await handEdit('bucket = "backups"', 'bucket = "other"');
  assert.match(
    await f.must(['status']),
    /^\nconfig\.toml changed where backups go\. These backups differ from the ones in memory\./,
  );

  // An empty location fails as before, with no line of its own.
  await handEdit('bucket = "other"', 'bucket = "empty"');
  f.hooks.backend = s => (s.s3.bucket === 'empty' ? new Memory() : s.s3.bucket === 'other' ? other : f.mem);
  const empty = await f.invoke(['status']);
  assert.equal(empty.code, 1);
  assert.ok(!empty.stdout.includes('config.toml changed'));

  // A change made with `config set` was checked then, so using it says nothing more.
  await handEdit('bucket = "empty"', 'bucket = "backups"');
  await f.must(['status']);
  await f.must(['config', 'set', 'storage.s3.bucket', 'other']);
  assert.ok(!(await f.must(['status'])).includes('config.toml changed'));
});

// Replacing a launchd job stops the backup it's running, so while a scheduled backup runs, updating the job
// waits for the first command after it. A run that never finished stops holding it back after 6 hours.
test('a running scheduled backup holds back updating its job', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  let now = new Date(2026, 9, 17, 15, 30);
  f.hooks.clock = () => now;
  const id = await rememberStart(true, new Date(2026, 9, 17, 15, 0));

  // A hand edit is reported once, starts one background process, and leaves the job alone.
  await handEdit('every = "6h"', 'every = "daily"');
  assert.match(
    await f.must(['status']),
    /^\nconfig\.toml changed\. The scheduled job will update after the active backup process completes\.\n\n┌/,
  );
  assert.ok(!(await f.must(['status'])).includes('config.toml changed'));
  assert.equal(f.schedule.length, 1);
  assert.equal(f.later.count, 1);

  // Once the backup finishes, the next command applies it, if the background process hasn't.
  await rememberFinish(id, true, new Date(2026, 9, 17, 15, 40));
  assert.match(await f.must(['status']), /config\.toml changed\. Scheduled job updated: daily\./);
  assert.equal(f.schedule.length, 2);

  // A backup whose process is still there holds the job back however long it takes, and stops when the
  // process goes, though it never recorded its end.
  const long = await rememberStart(true, new Date(2026, 9, 17, 16, 0));
  await handEdit('every = "daily"', 'every = "12h"');
  now = new Date(2026, 9, 18, 15, 0);
  assert.match(await f.must(['status']), /The scheduled job will update after the active backup process completes\./);
  assert.equal(f.schedule.length, 2);
  await rememberFinish(long, false, new Date(2026, 9, 18, 15, 5));
  await deadRun(new Date(2026, 9, 18, 15, 10));
  assert.match(await f.must(['status']), /config\.toml changed\. Scheduled job updated: 12h\./);
  assert.equal(f.schedule.length, 3);
});

// Records a scheduled backup that started at `time` in a process that has since exited.
async function deadRun(time: Date) {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  await rememberStart(true, time);
  const file = runsPath();
  const runs = JSON.parse(await readFile(file, 'utf8'));
  runs.run.pid = child.pid;
  await writeFile(file, JSON.stringify(runs));
}

// Every command that changes the schedule waits for a running scheduled backup instead of replacing its
// job, says so, and starts the background process that applies the change once the backup finishes.
test('config set, config edit and init wait for a running scheduled backup', async t => {
  const f = await fixture(t);
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 30);
  const id = await rememberStart(true, new Date(2026, 9, 17, 15, 0));
  assert.match(
    await f.must(['init'], f.answers),
    /schedule {5}6h via test scheduler, once the running backup finishes/,
  );
  assert.equal(f.schedule.length, 0);
  assert.equal(f.later.count, 1);

  assert.match(
    await f.must(['config', 'set', 'schedule.every', 'daily']),
    /Saved\. The scheduled job will update after the active backup process completes\.\n/,
  );
  assert.match(
    await f.must(['config', 'set', 'schedule.enabled', 'false']),
    /Saved\. The scheduled job will be removed after the active backup process completes\.\n/,
  );
  f.hooks.openEditor = async (_command, file) => {
    await writeFile(file, (await readFile(file, 'utf8')).replace('enabled = false', 'enabled = true'));
  };
  assert.match(
    await f.must(['config', 'edit'], 'yes\n'),
    /Saved\. The scheduled job will update after the active backup process completes\.\n/,
  );
  assert.equal(f.schedule.length, 0);
  assert.equal(f.later.count, 4);
  assert.equal((await loadRuns()).pending, desiredJob(config.parse(await readFile(config.configPath())).schedule));

  // Setting a value again while the job is missing reinstalls it later too.
  f.hooks.scheduleInstalled = async () => false;
  assert.match(
    await f.must(['config', 'set', 'schedule.enabled', 'true']),
    /The scheduled job will be reinstalled once the active backup finishes\.\n/,
  );
  assert.equal(f.schedule.length, 0);

  // A finished backup, or one whose process has gone, no longer holds anything back.
  await rememberFinish(id, true, new Date(2026, 9, 17, 15, 40));
  assert.match(await f.must(['config', 'set', 'schedule.time', '09:00']), /Saved\. Scheduled job updated: daily\./);
  assert.equal(f.schedule.length, 1);
  assert.equal((await loadRuns()).pending, undefined);
  await deadRun(new Date(2026, 9, 17, 15, 20));
  assert.match(await f.must(['config', 'set', 'schedule.time', '10:00']), /Saved\. Scheduled job updated: daily\./);
  assert.equal(f.schedule.length, 2);
});

// The background process checks until no scheduled backup is running, then applies config.toml as it is.
// With config.toml gone, it removes the job and leaves nothing in the cache.
test('the background process applies the change once the backup finishes', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 30);
  const id = await rememberStart(true, new Date(2026, 9, 17, 15, 0));
  await f.must(['config', 'set', 'schedule.every', 'daily']);
  assert.equal(f.schedule.length, 1);

  const waits: number[] = [];
  f.hooks.wait = async ms => {
    waits.push(ms);
    if (waits.length === 3) await rememberFinish(id, true, new Date(2026, 9, 17, 15, 45));
  };
  const background = await f.invoke(['config', '--after-backup']);
  assert.deepEqual(background, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(waits, [15_000, 15_000, 15_000]);
  assert.equal(f.schedule.length, 2);
  assert.equal(f.schedule[1].schedule.every, 'daily');
  assert.equal((await loadRuns()).pending, undefined);

  // Nothing left to do, so a second one returns at once.
  assert.equal((await f.invoke(['config', '--after-backup'])).code, 0);
  assert.equal(f.schedule.length, 2);

  // frost was uninstalled while the backup ran: the job goes, and the cache stays empty.
  await rm(f.conf, { recursive: true, force: true });
  await rm(f.cache, { recursive: true, force: true });
  assert.equal((await f.invoke(['config', '--after-backup'])).code, 0);
  assert.equal(f.schedule.length, 3);
  assert.equal(f.schedule[2].schedule.enabled, false);
  await assert.rejects(readFile(runsPath()), { code: 'ENOENT' });
});

// A backup by hand only names a scheduled backup as the one running while its process is there.
test('a scheduled backup that died is not named as running', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  await f.must(['backup']);
  const file = path.join(f.cache, 'manifest-' + (await loadKnown()).repo_id + '.jsonl');
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 5);
  await deadRun(new Date(2026, 9, 17, 15, 0));
  const held = await Manifest.open(file);
  try {
    const busy = await f.invoke(['backup']);
    assert.match(busy.stderr, /a backup or restore operation is already in progress; try again when it completes/);
  } finally {
    await held.close();
  }
});

test('the background process runs frost again with the internal flag', () => {
  const [command, args] = syncLaterCommand();
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(1), ['config', '--after-backup']);
  assert.match(args[0], /(main\.js|launch\.mjs)$/);
});

// Replacing a systemd timer or a crontab line never stops a running backup, so changes there don't wait.
// A change undone while it waited leaves nothing to do once the backup finishes.
test('only launchd and Task Scheduler jobs wait, and an undone change settles', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 30);
  const id = await rememberStart(true, new Date(2026, 9, 17, 15, 0));

  f.hooks.scheduleKind = async () => 'cron';
  assert.match(await f.must(['config', 'set', 'schedule.every', 'daily']), /Saved\. Scheduled job updated: daily\./);
  f.hooks.scheduleKind = async () => 'systemd';
  assert.match(await f.must(['config', 'set', 'schedule.every', '12h']), /Saved\. Scheduled job updated: 12h\./);
  assert.equal(f.schedule.length, 3);
  assert.equal(f.later.count, 0);

  f.hooks.scheduleKind = async () => 'launchd';
  assert.match(await f.must(['config', 'set', 'schedule.enabled', 'false']), /will be removed after the active backup/);
  assert.match(
    await f.must(['config', 'set', 'schedule.enabled', 'true']),
    /The scheduled job will update after the active backup/,
  );
  assert.equal(f.later.count, 2);
  await rememberFinish(id, true, new Date(2026, 9, 17, 15, 45));
  assert.equal((await f.invoke(['config', '--after-backup'])).code, 0);
  assert.equal(f.schedule.length, 3);
  assert.equal((await loadRuns()).pending, undefined);
});

// One background process applies config.toml as it is when the backup finishes, so while it's there, later
// changes don't start another.
test('changes waiting on the same backup share one background process', async t => {
  const f = await fixture(t);
  await f.must(['init'], f.answers);
  f.hooks.clock = () => new Date(2026, 9, 17, 15, 30);
  await rememberStart(true, new Date(2026, 9, 17, 15, 0));
  f.hooks.syncLater = () => {
    f.later.count++;
    return process.pid;
  };
  await f.must(['config', 'set', 'schedule.every', 'daily']);
  await f.must(['config', 'set', 'schedule.time', '09:00']);
  await f.must(['config', 'set', 'schedule.day', 'monday']);
  assert.equal(f.later.count, 1);
  assert.equal((await loadRuns()).waiter, process.pid);

  // A background process that has gone is replaced.
  await deadRun(new Date(2026, 9, 17, 15, 0));
  const runs = JSON.parse(await readFile(runsPath(), 'utf8'));
  await writeFile(
    runsPath(),
    JSON.stringify({ ...runs, waiter: runs.run.pid, run: { ...runs.run, pid: process.pid } }),
  );
  await f.must(['config', 'set', 'schedule.time', '10:00']);
  assert.equal(f.later.count, 2);
});
