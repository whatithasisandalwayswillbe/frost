// `frost init` opens the full-screen setup from src/tui in a terminal. With piped input it asks plain
// questions one per line. Both save through `finishSetup`.

import { statSync } from 'node:fs';
import * as config from '../core/config.js';
import { Key } from '../core/crypto.js';
import { Repo } from '../core/repo.js';
import { location, permafrostKeyPage, type Backend } from '../core/storage.js';
import { ConnectError, RepoState } from '../tui/setup.js';
import { checkAddress, checkDrivePath, joinAddress, splitAddress } from '../tui/providers.js';
import { Excluder } from '../engine/exclude.js';
import { Context, errNoKey } from './context.js';
import { connect, explainConnect, installKey, keyFileShown, opensRepo, phraseKey } from './connect.js';
import { Prompter } from './prompt.js';
import { phraseGrid } from './key.js';
import { loadKnown, rememberChecked } from './known.js';
import { syncJob } from './sync.js';
import { authorizedLine } from '../core/sshkey.js';
import { printable, tildify } from './format.js';

// The closing line after a successful setup.
export const setUp = (ctx: Context) =>
  ctx.fmt.good('frost is set up.') +
  " Preview your first backup using '" +
  ctx.fmt.bold('frost backup --dry-run') +
  "', or begin the backup with '" +
  ctx.fmt.bold('frost backup') +
  "'.";

// Saves a finished setup. It creates the repository if the storage is new, writes config.toml and the key
// file, then installs the scheduled job. A schedule that can't be installed shows in the returned rows
// instead of failing setup. Setup checked the storage, so the first command to use it doesn't again.
export async function finishSetup(
  ctx: Context,
  cfg: config.Config,
  key: Key,
  newRepo: boolean,
  signal = ctx.signal,
): Promise<[string, string][]> {
  config.validate(cfg);
  if (newRepo) {
    try {
      await Repo.init(ctx.hooks.backend(cfg.storage), key, signal);
    } catch (err) {
      throw explainConnect(err);
    }
  }
  await config.save(cfg);
  await ctx.saveKey(key);
  try {
    await rememberChecked(location(ctx.hooks.backend(cfg.storage)));
  } catch {}

  const rows: [string, string][] = [
    ['config', printable(tildify(config.configPath()))],
    ['key', printable(tildify(config.keyPath())) + ' (readable only by you)'],
  ];
  try {
    const applied = await syncJob(ctx, cfg);
    const after = applied ? '' : ', once the running backup finishes';
    rows.push([
      'schedule',
      (cfg.schedule.enabled ? cfg.schedule.every + ' via ' + (await ctx.hooks.scheduleKind()) : 'off') + after,
    ]);
  } catch (err) {
    rows.push(['schedule', 'not installed: ' + ctx.fmt.errorText(err)]);
  }
  return rows;
}

// The folders on the list that don't exist yet.
function missingDirs(paths: string[]): string[] {
  return paths.filter(p => {
    try {
      return !statSync(config.expand(p)).isDirectory();
    } catch {
      return true;
    }
  });
}

// Asks until the answer passes check, which returns a problem to show or ''.
async function askChecked(ctx: Context, p: Prompter, q: string, def: string, check: (v: string) => string) {
  for (;;) {
    const v = (await p.required(q, def)).trim();
    const problem = check(v);
    if (!problem) return v;
    p.line(ctx.fmt.dim('  ' + problem));
  }
}

// Asks where backups go and fills in that storage's settings. Without a key for the default Permafrost
// server, it opens the key page so the user can get one and paste it.
async function askStorage(ctx: Context, p: Prompter, cfg: config.Config): Promise<void> {
  const f = ctx.fmt;
  const options = [
    'Permafrost ' + f.dim('(one access key, nothing else to set up)'),
    'S3-compatible bucket ' + f.dim('(AWS, Backblaze B2, Cloudflare R2, Wasabi, Ceph, ...)'),
    'Self-hosted ' + f.dim('(your server over SSH)'),
    'Local drive ' + f.dim('(USB or internal disk)'),
  ];
  const kinds = ['permafrost', 's3', 'sftp', 'local'];
  const i = await p.choose(
    f.bold('Where would you like to store your backups?'),
    options,
    kinds.indexOf(cfg.storage.backend),
  );
  const s = cfg.storage;

  // The answers follow kinds: 0 is Permafrost, 1 is S3, 2 is a server over SSH and 3 is a drive.
  if (i === 2) {
    s.backend = 'sftp';
    const address = await askChecked(
      ctx,
      p,
      '  Server (an SSH address, like me@nas.local)',
      joinAddress(s.sftp.host, s.sftp.port),
      checkAddress,
    );
    Object.assign(s.sftp, splitAddress(address));
    s.sftp.path = (await p.ask('  Folder on the server', s.sftp.path || 'frost')).trim() || 'frost';
  } else if (i === 3) {
    s.backend = 'local';
    s.local.path = await askChecked(
      ctx,
      p,
      '  Folder (a full path on a connected drive)',
      s.local.path,
      checkDrivePath,
    );
  } else if (!i) {
    s.backend = 'permafrost';
    if (
      !s.permafrost.token &&
      !s.permafrost.url &&
      (await p.choose('  Do you have a Permafrost access key?', ['I have a key', "I don't have a key yet"], 0)) === 1
    ) {
      await ctx.hooks.openBrowser(permafrostKeyPage).catch(() => {});
      p.line(
        '  ' +
          f.dim('Obtain a key at') +
          ' ' +
          f.bold(permafrostKeyPage.replace('https://', '')) +
          f.dim(', then paste it below.'),
      );
    }
    s.permafrost.token = await p.secret('  Access key', s.permafrost.token);
  } else {
    s.backend = 's3';
    s.s3.endpoint = await p.required('  Endpoint (e.g. s3.us-east-1.amazonaws.com)', s.s3.endpoint);
    s.s3.region = await p.ask("  Region (blank if your server or provider doesn't use one)", s.s3.region);
    s.s3.bucket = await p.required('  Bucket', s.s3.bucket);
    s.s3.prefix = (await p.ask('  Folder inside the bucket (/ for the top level)', s.s3.prefix)).replace(
      /^\/+|\/+$/g,
      '',
    );
    s.s3.access_key_id = await p.required('  Access key ID', s.s3.access_key_id);
    s.s3.secret_access_key = await p.secret('  Secret access key', s.s3.secret_access_key);
  }
}

// frost's SSH key isn't on the server yet. ssh can add it after asking for the password, or the person adds
// the line by hand. Returns the connection options for the next try: a key added by hand may come with a
// server this computer hasn't seen, so its host key is trusted the first time.
async function addKey(ctx: Context, p: Prompter, s: config.Storage): Promise<{ acceptNewHostKey: boolean }> {
  const f = ctx.fmt;
  const way = await p.choose(
    "frost's SSH key isn't on " + printable(s.sftp.host) + ' yet.',
    ['Add it for me ' + f.dim('(needs your password once)'), "I'll add it myself"],
    0,
  );
  if (!way) {
    try {
      await installKey(ctx, s);
    } catch (err) {
      p.fail(f.caution("the key wasn't added: " + f.errorText(err)));
    }
    return { acceptNewHostKey: false };
  }
  p.line('  Add the following line to ~/.ssh/authorized_keys on ' + printable(s.sftp.host) + ':');
  p.line('  ' + f.bold(printable(authorizedLine(await ctx.hooks.sshKey()))));
  p.line(f.dim("  It's also in " + printable(keyFileShown()) + '.'));
  await p.ask(f.dim('Press Enter once added.'));
  return { acceptNewHostKey: true };
}

// Three tries at the recovery phrase for backups that are already in the storage.
async function askPhraseFor(ctx: Context, p: Prompter, backend: Backend): Promise<Key> {
  for (let tries = 0; tries < 3; tries++) {
    const phrase = await p.secret(ctx.fmt.bold('Recovery phrase:'));
    try {
      const key = phraseKey(phrase);
      await opensRepo(ctx, backend, key);
      return key;
    } catch (err) {
      p.fail(ctx.fmt.errorText(err));
    }
  }
  throw new Error("couldn't unlock the repository");
}

// Shows a new recovery phrase, then asks for two of its words to check it was written down.
async function showNewPhrase(ctx: Context, p: Prompter, key: Key): Promise<void> {
  const f = ctx.fmt;
  p.gap();
  p.section('your recovery phrase');
  p.gap();
  p.line(phraseGrid(f, key.phrase()));
  p.gap();
  p.line(f.bold('Write down these 24 words and store them in a secure location.'));
  p.line('This phrase is required to restore your files if this machine is lost or replaced.');
  p.line('Your storage provider and the developers cannot recover these words for you.');
  p.gap();

  const words = key.phrase().split(' ');
  for (;;) {
    await p.ask(f.dim('Press Enter once you have saved them securely.'));
    const [i, j] = ctx.hooks.pickWords();
    const a = await p.ask(`Verification step: enter word #${i + 1}:`);
    const b = await p.ask(`Enter word #${j + 1}:`);
    if (a.toLowerCase() === words[i] && b.toLowerCase() === words[j]) {
      p.ok('Correct.');
      return;
    }
    p.warn(f.caution("That doesn't match."));
    if (await p.yesNo('See the words again?', true)) {
      p.gap();
      p.line(phraseGrid(f, key.phrase()));
      p.gap();
    }
  }
}

// Picks the key for the storage that was found. That's the key on this machine if it opens the backups,
// the phrase for backups made with another key, or a new key for empty storage.
async function promptKey(
  ctx: Context,
  p: Prompter,
  b: Backend,
  state: RepoState,
  local?: Key,
): Promise<{ key: Key; newRepo: boolean }> {
  if (state === RepoState.LocalOK) {
    p.gap();
    p.ok('Your key on this machine opens this storage.');
    return { key: local!, newRepo: false };
  }

  if (state === RepoState.NeedsPhrase || state === RepoState.LocalWrong) {
    p.gap();
    if (state === RepoState.NeedsPhrase)
      p.line('Existing frost backups detected in this storage location. Enter the recovery phrase to connect.');
    else {
      p.line('This storage location contains backups created with a different key from the one on this machine.');
      p.line('Enter the recovery phrase for these backups to configure frost to use that key locally.');
    }
    return { key: await askPhraseFor(ctx, p, b), newRepo: false };
  }

  // Empty storage keeps the key on this machine. If this machine's backups are somewhere else, ask before
  // starting a separate set.
  if (local) {
    const k = await loadKnown();
    if (k.where && k.where !== location(b)) {
      p.gap();
      p.warn(
        `No backups found in ${printable(String(b))}. This machine's active backups are located in ${printable(k.shown ?? '')}.`,
      );
      p.line(
        'Existing backups will remain untouched, but frost will now only manage snapshots from this location. The initial backup will upload the selected data again.',
      );
      if (!(await p.yesNo('Initialize a separate set of backups at this location?', false)))
        throw new Error(
          'nothing was changed. To continue using existing backups, run `frost init` and point to ' + k.shown,
        );
    }
    return { key: local, newRepo: true };
  }

  const key = ctx.hooks.newKey();
  await showNewPhrase(ctx, p, key);
  return { key, newRepo: true };
}

export async function runInit(ctx: Context): Promise<void> {
  const cfg = await config.loadFile().catch(e => {
    if (e !== config.errNoConfig) throw e;
    return config.defaultConfig();
  });
  const existing = !!cfg.paths.length;
  let local: Key | undefined;
  try {
    local = await ctx.loadKey();
  } catch (err) {
    if (err !== errNoKey) throw err;
  }

  // A real terminal gets the full-screen setup.
  if (ctx.inputTTY && ctx.outputTTY && ctx.ansiOK) {
    if (ctx.hooks.setup) return ctx.hooks.setup(ctx, cfg, existing, local);
    const { runSetup } = await import('./tui.js');
    return runSetup(ctx, cfg, existing, local);
  }

  const p = ctx.prompt(),
    f = ctx.fmt;
  p.open('frost setup');
  if (existing) p.line(f.dim('Existing config found. Press Enter to retain the current value.'));
  p.gap();

  // Ask for storage until it connects. A self-hosted server that won't take frost's key yet gets the key
  // added, and is tried again without asking for its settings.
  let connected: { backend: Backend; state: RepoState } | undefined;
  let options: { acceptNewHostKey?: boolean } | undefined;
  while (!connected) {
    if (!options) await askStorage(ctx, p, cfg);
    p.question(f.dim('Connecting ...'));
    try {
      connected = await connect(ctx, cfg.storage, local, ctx.signal, options);
      f.write(f.good('ok') + '\n');
    } catch (err) {
      f.write(f.error('failed') + '\n');
      if (err instanceof ConnectError && err.about === 'login' && cfg.storage.backend === 'sftp' && !options) {
        options = await addKey(ctx, p, cfg.storage);
        continue;
      }
      options = undefined;
      p.fail(f.caution(f.errorText(err)));
      p.gap();
    }
  }
  p.gap();

  // Ask for the folders. Each one is checked against those before it. A duplicate or a folder inside another
  // is a problem, and a folder that contains earlier ones replaces them.
  for (;;) {
    const list = await p.list(f.bold('Folders to back up') + f.dim(' (full paths, comma separated)'), cfg.paths);
    let paths: string[] = [];
    let problem = '';
    for (const v of list) {
      try {
        const added = await config.addPath(v, paths);
        paths = [...paths.filter((_p, i) => !added.inside.includes(i)), added.path];
      } catch (err) {
        problem = v + ': ' + (err as Error).message;
        break;
      }
    }
    if (problem) {
      p.warn(f.caution(printable(problem)));
      continue;
    }
    if (!paths.length) {
      p.line(f.dim('  add at least one folder'));
      continue;
    }
    cfg.paths = paths;
    const missing = missingDirs(paths);
    if (!missing.length) break;
    p.warn(f.caution('not found: ' + missing.map(printable).join(', ')));
    if (await p.yesNo('  Add anyway? Missing paths will be skipped until they become available.', false)) break;
  }

  // Ask for exclude patterns until they all compile.
  for (;;) {
    cfg.exclude = await p.list(f.bold('Skip files matching') + f.dim(' (comma separated, - for none)'), cfg.exclude);
    const bad = cfg.exclude.find(pat => {
      try {
        new Excluder([pat]);
        return false;
      } catch {
        return true;
      }
    });
    if (!bad) break;
    p.warn(f.caution(JSON.stringify(bad) + ' is not a valid pattern; check matching brackets'));
  }
  p.gap();

  // Ask about the schedule. Automatic backups default to on for a first setup.
  cfg.schedule.enabled = await p.yesNo(f.bold('Back up automatically?'), cfg.schedule.enabled || !existing);
  if (cfg.schedule.enabled)
    for (;;) {
      cfg.schedule.every = await p.ask(
        f.bold('How often?') + f.dim(' (' + config.intervals.join(', ') + ')'),
        cfg.schedule.every || 'daily',
      );
      try {
        config.interval(cfg.schedule.every);
        break;
      } catch {
        p.line(f.dim('  pick one of: ' + config.intervals.join(', ')));
      }
    }

  config.validate(cfg);
  const { key, newRepo } = await promptKey(ctx, p, connected.backend, connected.state, local);
  const rows = await finishSetup(ctx, cfg, key, newRepo);
  p.gap();
  rows.forEach(([label, value]) => p.row(label, value));
  p.gap();
  p.close(setUp(ctx));
}
