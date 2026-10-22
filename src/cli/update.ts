// `frost update`, and the automatic update check after scheduled backups. Both record what they found in
// update.json in the cache folder, which `frost status` and the browser summarise.

import path from 'node:path';
import * as config from '../core/config.js';
import * as update from '../platform/update.js';
import { Context } from './context.js';
import { printable, relative, tildify } from './format.js';

export const updateStatePath = () => path.join(config.cacheDir(), 'update.json');

// The updates row and whether it's a warning. Automatic updates only run after scheduled backups, so
// they're effectively off without a schedule.
export function updateSummary(
  cfg: config.Config,
  st: update.State,
  version: string,
  now = Date.now(),
): [string, boolean] {
  if (!update.valid(version)) return ['not for development builds', false];
  let mode = cfg.update.auto ? 'automatic' : 'off';
  if (cfg.update.auto && !cfg.schedule.enabled) mode = 'automatic, but only after scheduled backups, which are off';
  const auto = cfg.update.auto && cfg.schedule.enabled;

  if (update.newer(st.latest ?? '', version) && auto && st.error)
    return [st.latest + ' is out, but the last update failed: ' + st.error + '. Run `frost update`', true];
  if (update.newer(st.latest ?? '', version) && auto)
    return [mode + ', ' + st.latest + ' installs after the next backup', false];
  if (update.newer(st.latest ?? '', version)) return [mode + ', ' + st.latest + ' is out: run `frost update`', true];
  if (auto && st.error)
    return [
      mode + ', the last check failed ' + relative(now - Date.parse(st.checked ?? '')) + ' ago: ' + st.error,
      true,
    ];

  // Mention a recent update for a week.
  if (st.installed === version && st.from && now - Date.parse(st.installed_at ?? '') < 7 * 86400_000)
    return [mode + ', updated from ' + st.from + ' ' + relative(now - Date.parse(st.installed_at!)) + ' ago', false];
  return [mode, false];
}

export async function runUpdate(ctx: Context, check: boolean): Promise<void> {
  if (!update.valid(ctx.version)) throw update.errDevBuild;
  let exe: string;
  try {
    exe = await ctx.hooks.selfPath();
  } catch (err) {
    throw new Error("can't find the Frost binary: " + (err as Error).message, { cause: err });
  }

  // Make sure the install can be replaced before downloading anything.
  if (!check) await ctx.hooks.canReplace(exe);

  const file = updateStatePath();
  const state = await update.loadState(file);
  let release: update.Release;
  try {
    release = await ctx.hooks.latestRelease(ctx.signal);
  } catch (err) {
    if (err === update.errNoRelease) {
      ctx.fmt.single('Frost ' + ctx.version + ctx.fmt.dim(', no releases have been published yet'));
      return;
    }
    throw err;
  }
  state.checked = new Date().toISOString();
  state.latest = release.version;
  state.error = '';

  try {
    if (!update.newer(release.version, ctx.version)) {
      ctx.fmt.single('Frost ' + ctx.version + ctx.fmt.dim(' is the latest release'));
      return;
    }
    const b = ctx.fmt.block();
    b.open('new release', release.version + ', you have ' + ctx.version);
    b.gap();
    b.row('notes', release.page);
    if (check) {
      b.gap();
      b.close('Install it with ' + ctx.fmt.bold('frost update'));
      return;
    }
    b.row('download', release.archive);
    await ctx.hooks.installRelease(release, exe, ctx.signal);
    state.installed = release.version;
    state.from = ctx.version;
    state.installed_at = new Date().toISOString();
    b.row('installed', ctx.fmt.good('ok ') + printable(tildify(exe)));
    b.gap();
    b.close(ctx.fmt.good('Updated') + ' to Frost ' + ctx.fmt.bold(release.version));
  } finally {
    // Under sudo the state isn't saved, so the user's cache doesn't get a file owned by root.
    if (!(process.geteuid?.() === 0 && process.env.SUDO_UID)) await update.saveState(file, state).catch(() => {});
  }
}

// Runs after a scheduled backup. It checks for a release at most every 20 hours and installs it if
// automatic updates are on. Failures are logged and saved in update.json instead of thrown.
export async function autoUpdate(ctx: Context): Promise<void> {
  if (!update.valid(ctx.version)) return;
  const file = updateStatePath();
  const state = await update.loadState(file);
  const now = Date.now();
  const checked = Date.parse(state.checked ?? '');

  // A check time in the future, after a clock change, doesn't count.
  if (Number.isFinite(checked) && now - checked < 20 * 3600_000 && checked <= now) return;

  const cfg = await config.loadFile().catch(() => config.defaultConfig());
  const log = (s: string) => ctx.fmt.write('[' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + '] ' + s + '\n');
  const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(600_000)]);
  state.checked = new Date(now).toISOString();
  state.error = '';

  try {
    let release: update.Release;
    try {
      release = await ctx.hooks.latestRelease(signal);
    } catch (err) {
      if (err !== update.errNoRelease) {
        state.error = (err as Error).message;
        log('update check failed: ' + state.error);
      }
      return;
    }
    state.latest = release.version;
    if (!update.newer(release.version, ctx.version)) return;
    if (!cfg.update.auto) {
      log('Frost ' + release.version + ' is available, run `frost update` to install it');
      return;
    }

    try {
      await ctx.hooks.installRelease(release, await ctx.hooks.selfPath(), signal);
    } catch (err) {
      state.error = (err as Error).message;
      log('updating to ' + release.version + ' failed: ' + state.error);
      return;
    }
    state.installed = release.version;
    state.from = ctx.version;
    state.installed_at = new Date().toISOString();
    log('updated Frost from ' + ctx.version + ' to ' + release.version);
  } finally {
    await update.saveState(file, state).catch(() => {});
  }
}
