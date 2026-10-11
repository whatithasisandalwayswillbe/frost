// Connects the full-screen browser and setup in src/tui to the CLI's repository, config and storage helpers.
// Commands import it only when they need a TUI.

import { statSync } from 'node:fs';
import * as config from '../core/config.js';
import { Key } from '../core/crypto.js';
import { location } from '../core/storage.js';
import { Engine } from '../engine/index.js';
import { runBrowser as browser, RestoreStopped } from '../tui/browser.js';
import { setup } from '../tui/setup.js';
import { loadState } from '../platform/update.js';
import { Context } from './context.js';
import { connect, unlock } from './connect.js';
import { finishSetup, setUp } from './init.js';
import { loadKnown } from './known.js';
import { updateStatePath, updateSummary } from './update.js';

// Reads what the browser needs from the manifest, then closes it before the browser opens. Restores run on
// a repository-only engine, so the manifest lock isn't held while browsing.
export async function runBrowser(ctx: Context): Promise<void> {
  const a = await ctx.openApp();
  const m = a.engine.manifest!;
  const repo = a.engine.repo;
  const state = {
    known: m.snapshots(),
    last: a.engine.lastBackup(),
    hasLast: !!a.engine.lastBackup(),
    verify: a.engine.lastVerify(),
    hasVerify: !!a.engine.lastVerify(),
    version: ctx.version,
    updates: updateSummary(a.cfg, await loadState(updateStatePath()), ctx.version)[0].replaceAll('`', ''),
  };
  await a.close();

  const engine = new Engine(repo);
  try {
    await browser(
      {
        label: String(repo.backend),
        fingerprint: repo.key.fingerprint(),
        snapshots: (known, signal) => repo.snapshots(known as Parameters<typeof repo.snapshots>[0], signal),
        loadTree: (id, signal) => repo.loadTree(id, signal),
        restore: (id, opts, signal) => engine.restore(id, opts, signal),
      },
      a.cfg,
      state,
      { signal: ctx.signal, colorProfile: ctx.fmt.profile },
    );
  } catch (err) {
    // A restore the user stopped prints as a one-line result, not an error.
    if (err instanceof RestoreStopped) {
      ctx.fmt.single(ctx.fmt.caution('Restore stopped.') + ' ' + err.message.replace(/^Restore stopped\. /, ''));
      return;
    }
    throw err;
  }
}

// Runs the full-screen setup with the same connect, unlock and save steps as plain `frost init`.
export async function runSetup(ctx: Context, cfg: config.Config, existing: boolean, local?: Key): Promise<void> {
  const known = await loadKnown();
  const result = await setup(
    {
      localKey: local,
      connect: async (s, signal) => (await connect(ctx, s, local, signal)).state,
      newKey: ctx.hooks.newKey,
      unlock: (s, phrase, signal) => unlock(ctx, s, phrase, signal),
      finish: (cfg, key, newRepo, signal) => finishSetup(ctx, cfg, key as Key, newRepo, signal),
      pickWords: ctx.hooks.pickWords,
      dirExists: p => {
        try {
          return statSync(config.expand(p)).isDirectory();
        } catch {
          return false;
        }
      },

      // Where this machine's backups were last opened, if the chosen storage is somewhere else.
      elsewhere: s => {
        try {
          return known.where && known.where !== location(ctx.hooks.backend(s)) ? (known.shown ?? '') : '';
        } catch {
          return '';
        }
      },
      openBrowser: url => void ctx.hooks.openBrowser(url).catch(() => {}),
      addPath: async (typed, paths) => {
        const result = await config.addPath(typed, paths);
        return { clean: result.path, inside: result.inside };
      },
    },
    cfg,
    existing,
    { signal: ctx.signal, colorProfile: ctx.fmt.profile },
  );

  if (!result.saved) {
    ctx.fmt.single(ctx.fmt.dim('Setup closed. Nothing was changed.'));
    return;
  }
  const b = ctx.fmt.block();
  b.open('frost setup');
  b.gap();
  result.rows.forEach(([label, value]) => b.row(label, value));
  b.gap();
  b.close(setUp(ctx));
}
