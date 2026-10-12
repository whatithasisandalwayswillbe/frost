// Checks a change of storage settings before it's saved, so a wrong setting doesn't quietly start a separate
// set of backups or lose track of the old ones.

import type { Storage } from '../core/config.js';
import { Repo, errNotInitialized, errWrongKey } from '../core/repo.js';
import { location, type Backend } from '../core/storage.js';
import { Context } from './context.js';
import { Block, printable } from './format.js';
import { explainConnect, probe } from './connect.js';
import { loadKnown, moveHint } from './known.js';

// Snapshots or trees without a frost.repo mean backups were moved without it.
async function hasObjects(b: Backend, signal?: AbortSignal): Promise<boolean> {
  for (const prefix of ['snapshots/', 'trees/']) if ((await b.list(prefix, signal).catch(() => [])).length) return true;
  return false;
}

// `config set` stops on a problem. `config edit` passes `warnOnly`, so problems are only warnings.
export async function checkStorageChange(
  ctx: Context,
  out: Block,
  was: Storage,
  now: Storage,
  warnOnly: boolean,
): Promise<void> {
  const problem = (s: string) => {
    if (warnOnly) {
      out.warn(out.fmt.caution(out.fmt.errorText(s)));
      return;
    }
    throw new Error(s + '\n\nNothing was saved. To change it without this check, use `frost config edit`');
  };

  // Nothing to check if the location didn't change, or if neither setting describes a usable storage.
  let newB: Backend | undefined;
  let oldB: Backend | undefined;
  let newError: unknown;
  let oldError: unknown;
  try {
    newB = ctx.hooks.backend(now);
  } catch (e) {
    newError = e;
  }
  try {
    oldB = ctx.hooks.backend(was);
  } catch (e) {
    oldError = e;
  }
  if (newError && oldError) return;
  if (newError) return problem('with that change, storage settings are incomplete: ' + (newError as Error).message);
  if (oldB && location(newB!) === location(oldB)) return;

  // Without a key on this machine there's no way to open the new repository.
  let key;
  try {
    key = await ctx.loadKey();
  } catch {
    return;
  }

  const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(45_000)]);
  const known = await loadKnown();
  const where = String(newB);

  // The new location needs a repository this key opens.
  let repo: Repo;
  try {
    repo = await Repo.open(newB!, key, signal);
  } catch (e) {
    if (e === errNotInitialized) {
      if (await hasObjects(newB!, signal))
        return problem(
          where + " has frost backups but no frost.repo. If you moved them, frost.repo didn't come along.",
        );
      let msg = 'There are no backups in ' + where + '.';
      if (known.shown && known.shown !== where) msg += ' Yours are in ' + known.shown + '.';
      return problem(
        msg +
          ' To use them there, ' +
          moveHint(now, where) +
          ' first. To start a separate set of backups there, run `frost init`.',
      );
    }
    if (e === errWrongKey)
      return problem(
        where +
          ' has backups made with a different key. To use them, run `frost key import` with their recovery phrase.',
      );
    return problem("couldn't check " + where + ': ' + explainConnect(e).message);
  }

  // A repository with no snapshots, while the old location has the same repository with snapshots, means
  // only frost.repo was moved.
  let ids: string[];
  try {
    ids = await repo.snapshotIDs(signal);
  } catch (err) {
    return problem("couldn't check " + where + ': ' + explainConnect(err).message);
  }
  if (!ids.length && oldB) {
    let have = false;
    try {
      const old = await Repo.open(oldB, key, signal);
      have = old.info.id === repo.info.id && (await old.snapshotIDs(signal)).length > 0;
    } catch {}
    if (have)
      return problem(
        where + ' has your frost.repo but none of your snapshots. Move chunks/, snapshots/ and trees/ there too.',
      );
  }

  // The new storage has to pass the same checks as setup.
  try {
    await probe(newB!, signal);
  } catch (err) {
    return problem("couldn't check " + where + ': ' + explainConnect(err).message);
  }

  if (known.repo_id && repo.info.id !== known.repo_id)
    out.warn(
      'Those are different backups from the ones in ' +
        printable(known.shown ?? '') +
        '. frost will show their snapshots instead. Yours stay where they are.',
    );
}
