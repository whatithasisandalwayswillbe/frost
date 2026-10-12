// `frost init` opens the full-screen setup from src/tui in a terminal. With piped input it asks plain
// questions one per line. Both save through `finishSetup`.

import { statSync } from 'node:fs';
import * as config from '../core/config.js';
import { Key } from '../core/crypto.js';
import { Repo } from '../core/repo.js';
import { location, permafrostKeyPage, type Backend } from '../core/storage.js';
import { RepoState } from '../tui/setup.js';
import { Excluder } from '../engine/exclude.js';
import { Context, errNoKey } from './context.js';
import { connect, explainConnect, opensRepo, phraseKey } from './connect.js';
import { Prompter } from './prompt.js';
import { phraseGrid } from './key.js';
import { loadKnown } from './known.js';
import { printable, tildify } from './format.js';

// The closing line after a successful setup.
export const setUp = (ctx: Context) =>
  ctx.fmt.good('frost is set up.') +
  ' Preview your first backup with ' +
  ctx.fmt.bold('frost backup --dry-run') +
  ', or start it with ' +
  ctx.fmt.bold('frost backup') +
  '.';

// Saves a finished setup. It creates the repository if the storage is new, writes config.toml and the key
// file, then installs the scheduled job. A schedule that can't be installed shows in the returned rows
// instead of failing setup.
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

  const rows: [string, string][] = [
    ['config', printable(tildify(config.configPath()))],
    ['key', printable(tildify(config.keyPath())) + ' (readable only by you)'],
  ];
  try {
    await ctx.hooks.syncSchedule(cfg);
    rows.push([
      'schedule',
      cfg.schedule.enabled ? cfg.schedule.every + ' via ' + (await ctx.hooks.scheduleKind()) : 'off',
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

// Asks where backups go and fills in that storage's settings. Without a key for the default Permafrost
// server, it opens the key page so the user can get one and paste it.
async function askStorage(ctx: Context, p: Prompter, cfg: config.Config): Promise<void> {
  const f = ctx.fmt;
  const options = [
    'Permafrost ' + f.dim('(one access key, nothing else to set up)'),
    'S3-compatible bucket ' + f.dim('(AWS, Backblaze B2, Cloudflare R2, Wasabi, MinIO, ...)'),
  ];
  const i = await p.choose(
    f.bold('Where should backups go?'),
    options,
    cfg.storage.backend === 'permafrost' ? 0 : cfg.storage.backend === 's3' ? 1 : -1,
  );
  const s = cfg.storage;

  // 0 is Permafrost and 1 is S3.
  if (!i) {
    s.backend = 'permafrost';
    if (
      !s.permafrost.token &&
      !s.permafrost.url &&
      (await p.choose('  Do you have a Permafrost access key?', ['I have a key', "I don't have a key yet"], 0)) === 1
    ) {
      await ctx.hooks.openBrowser(permafrostKeyPage).catch(() => {});
      p.line(
        '  ' +
          f.dim('Get one at') +
          ' ' +
          f.bold(permafrostKeyPage.replace('https://', '')) +
          f.dim(', then paste it below.'),
      );
    }
    s.permafrost.token = await p.secret('  Access key', s.permafrost.token);
  } else {
    s.backend = 's3';
    s.s3.endpoint = await p.required('  Endpoint (e.g. s3.us-east-1.amazonaws.com)', s.s3.endpoint);
    s.s3.region = await p.ask("  Region (blank if your provider doesn't use one)", s.s3.region);
    s.s3.bucket = await p.required('  Bucket', s.s3.bucket);
    s.s3.prefix = (await p.ask('  Folder inside the bucket (/ for the top level)', s.s3.prefix)).replace(
      /^\/+|\/+$/g,
      '',
    );
    s.s3.access_key_id = await p.required('  Access key ID', s.s3.access_key_id);
    s.s3.secret_access_key = await p.secret('  Secret access key', s.s3.secret_access_key);
  }
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
  p.line(f.bold('Write these 24 words down and keep them somewhere safe.'));
  p.line("They're the only way to restore your files if this machine is lost.");
  p.line('Nobody can recover them for you: not your storage provider, not us.');
  p.gap();

  const words = key.phrase().split(' ');
  for (;;) {
    await p.ask(f.dim("Press enter once you've written them down."));
    const [i, j] = ctx.hooks.pickWords();
    const a = await p.ask(`To check: what's word #${i + 1}?`);
    const b = await p.ask(`And word #${j + 1}?`);
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
      p.line('This storage already has frost backups. Enter the recovery phrase to connect.');
    else {
      p.line('This storage has backups made with a different key than the one on this machine.');
      p.line('Enter the recovery phrase for these backups, and frost will use that key here instead.');
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
        `There are no backups in ${printable(String(b))} yet. This machine's backups are in ${printable(k.shown ?? '')}.`,
      );
      p.line(
        'They stay there, but frost will only show the ones made here from now on, and the first backup uploads everything again.',
      );
      if (!(await p.yesNo('Start a separate set of backups here?', false)))
        throw new Error(
          'nothing was changed. To keep using your backups, run `frost init` again and point it at ' + k.shown,
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
  if (existing) p.line(f.dim('Existing config found. Press enter to keep a value.'));
  p.gap();

  // Ask for storage until it connects.
  let connected: { backend: Backend; state: RepoState };
  for (;;) {
    await askStorage(ctx, p, cfg);
    p.question(f.dim('Connecting ...'));
    try {
      connected = await connect(ctx, cfg.storage, local);
      f.write(f.good('ok') + '\n');
      break;
    } catch (err) {
      f.write(f.error('failed') + '\n');
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
    if (await p.yesNo("  Add anyway? They're skipped until they exist.", false)) break;
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
    p.warn(f.caution(JSON.stringify(bad) + " isn't a valid pattern, check its brackets"));
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
  const { key, newRepo } = await promptKey(ctx, p, connected!.backend, connected!.state, local);
  const rows = await finishSetup(ctx, cfg, key, newRepo);
  p.gap();
  rows.forEach(([label, value]) => p.row(label, value));
  p.gap();
  p.close(setUp(ctx));
}
