// `frost key` shows the recovery phrase, checks a typed one, or imports one. `key show` and `frost init`
// are the only commands that print the phrase.

import * as config from '../core/config.js';
import { Repo, errWrongKey } from '../core/repo.js';
import { Context, errNoKey } from './context.js';
import { phraseKey } from './connect.js';
import { Format, printable } from './format.js';
import { requireConfirmation } from './prompt.js';

// Lays the words out in four columns, numbered down each column.
export function phraseGrid(fmt: Format, phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  const n = Math.ceil(words.length / 4);
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    let row = '';
    for (let c = 0; c < 4; c++) {
      const i = c * n + r;
      if (i < words.length) row += fmt.dim(String(i + 1).padStart(2) + '.') + ' ' + words[i].padEnd(10);
    }
    rows.push(row.trimEnd());
  }
  return rows.join('\n');
}

export async function runKey(ctx: Context, action: string): Promise<void> {
  const p = ctx.prompt(),
    f = ctx.fmt;

  // The phrase only shows after the user types "show".
  if (action === 'show') {
    const key = await ctx.loadKey();
    p.open('recovery phrase');
    p.gap();
    p.warn(f.caution('Anyone who sees this phrase can decrypt all of your backups.'));
    p.line("Make sure nobody's looking at your screen and you're not screen sharing.");
    await requireConfirmation(p.confirm('show', 'continue'));
    p.gap();
    p.line(phraseGrid(f, key.phrase()));
    p.gap();
    p.close(f.dim('key fingerprint ' + key.fingerprint()));
    return;
  }

  // Checks a typed phrase against the key on this machine and the configured storage. A missing key or
  // config skips that check.
  if (action === 'verify') {
    p.open('key verify');
    p.gap();
    const key = phraseKey(await p.secret(f.bold('Recovery phrase:')));
    p.ok('valid phrase  ' + f.dim('fingerprint ' + key.fingerprint()));

    let mismatch = false;
    try {
      const local = await ctx.loadKey();
      if (local.equals(key)) p.ok('matches the key on this machine');
      else {
        p.fail("doesn't match the key on this machine " + f.dim('(' + local.fingerprint() + ')'));
        mismatch = true;
      }
    } catch (err) {
      if (err !== errNoKey) throw err;
    }

    let cfg;
    try {
      cfg = await config.load();
    } catch (err) {
      if (err !== config.errNoConfig) throw err;
    }
    if (cfg) {
      const b = ctx.hooks.backend(cfg.storage);
      try {
        await Repo.open(b, key, ctx.signal);
        p.ok('opens the repository at ' + printable(String(b)));
      } catch (err) {
        if (err === errWrongKey) {
          p.fail("doesn't open the repository at " + printable(String(b)));
          throw new Error("key doesn't match");
        }
        p.warn("couldn't check the repository: " + f.errorText(err));
        throw err;
      }
    }

    p.gap();
    if (mismatch) throw new Error("phrase doesn't match the local key");
    p.close(f.good('The phrase checks out.'));
    return;
  }

  // Replaces the key on this machine. If there's a config, the phrase has to open its storage. Replacing a
  // different key asks first.
  if (action === 'import') {
    p.open('key import');
    p.gap();
    let local;
    try {
      local = await ctx.loadKey();
    } catch (err) {
      if (err !== errNoKey) p.warn(f.caution('The existing key file is unreadable and will be replaced.'));
    }

    const key = phraseKey(await p.secret(f.bold('Recovery phrase:')));
    if (local?.equals(key)) {
      p.close(f.good("That's already the key on this machine."));
      return;
    }

    let cfg;
    try {
      cfg = await config.load();
    } catch (err) {
      if (err !== config.errNoConfig) throw err;
    }
    if (cfg) {
      const b = ctx.hooks.backend(cfg.storage);
      try {
        await Repo.open(b, key, ctx.signal);
      } catch (err) {
        throw new Error(`this phrase can't open ${b}: ${(err as Error).message}`);
      }
      p.ok('opens the repository at ' + printable(String(b)));
    } else p.line(f.dim("No config yet, so the phrase wasn't checked against any storage. Run `frost init` next."));

    if (local) {
      p.warn(f.caution('This replaces the key currently on this machine (' + local.fingerprint() + ').'));
      p.line('Backups made with the old key will need the old phrase to restore.');
      await requireConfirmation(p.yesNo('Replace it?', false));
    }
    await ctx.saveKey(key);
    p.gap();
    p.close(f.good('Key imported. ') + f.dim('fingerprint ' + key.fingerprint()));
    return;
  }

  throw new Error(`unknown key action ${JSON.stringify(action)} (use show, verify or import)`);
}
