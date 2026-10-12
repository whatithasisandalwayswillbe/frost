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
import { type Hooks } from '../../src/cli/context.js';
import { Format, statusLine, cellWidth, tildify, humanBytes, when } from '../../src/cli/format.js';
import { phraseGrid } from '../../src/cli/key.js';
import { probe, explainConnect } from '../../src/cli/connect.js';
import { openScheduledLog, accessHint } from '../../src/cli/backup.js';
import { updateStatePath } from '../../src/cli/update.js';
import { knownPath, loadKnown } from '../../src/cli/known.js';
import { rerunCommand } from '../../src/cli/restore.js';
import { Key } from '../../src/core/crypto.js';
import { Repo, chunkKey } from '../../src/core/repo.js';
import * as config from '../../src/core/config.js';
import * as update from '../../src/platform/update.js';
import { Memory } from '../support.js';
import { APIError, errConditionalUnsupported } from '../../src/core/storage.js';
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
  const hooks: Partial<Hooks> = {
    backend: () => mem,
    newKey: () => key,
    pickWords: () => [2, 17],
    syncSchedule: async c => {
      schedule.push(structuredClone(c));
    },
    scheduleKind: async () => 'test scheduler',
    scheduleInstalled: async () => true,
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
  return { root, src, conf, cache, mem, key, schedule, hooks, invoke, must, answers };
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
        if (normalize(actual[stream]) !== normalize(ref[stream]))
          differences.push(
            name +
              ' ' +
              stream +
              ': ' +
              JSON.stringify(normalize(actual[stream])) +
              ' expected ' +
              JSON.stringify(normalize(ref[stream])),
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
  assert.match(out, /Get one at getfro\.st\/perma, then paste it below\./);
  assert.equal((await config.loadFile()).storage.permafrost.token, 'pasted-key');
});

// Setup shows Permafrost's own reason for refusing a key or an upload, and keeps its general advice when
// the server didn't give one.
test('setup errors carry the Permafrost server reason', () => {
  const said = (status: number, code: string, detail = '') =>
    explainConnect(new APIError(status, code, detail || 'error', detail)).message;
  assert.equal(
    said(401, 'unauthorized', 'this access key was replaced by a newer one'),
    "Permafrost didn't accept that access key. This access key was replaced by a newer one.",
  );
  assert.match(said(401, 'unauthorized'), /Check you copied all of it/);
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
  assert.match(stopped.stderr, /To carry on from there, run(?: in PowerShell)?:/);
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
    new RegExp(settings + 'add or switch on /Users/me/.+/node$'),
  );
  assert.match(
    accessHint(false, runtime, { TERM_PROGRAM: 'Apple_Terminal' }),
    new RegExp(
      settings + 'allow Terminal, the app frost ran in\\. Scheduled backups need /Users/me/.+/node on that list too$',
    ),
  );
  assert.match(accessHint(false, runtime, { TERM_PROGRAM: 'iTerm.app' }), /allow iTerm, the app frost ran in/);
  assert.match(accessHint(false, runtime, {}), /allow the terminal app frost ran in\. /);
});
