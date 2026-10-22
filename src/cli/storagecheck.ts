// Checks a change of storage settings before it's saved, so a wrong setting doesn't quietly start a separate
// set of backups or lose track of the old ones. A change made to config.toml outside frost gets the same
// checks the first time a command uses it.

import type { Storage } from '../core/config.js';
import { Repo, errNotInitialized, errWrongKey } from '../core/repo.js';
import { location, type Backend } from '../core/storage.js';
import { Context } from './context.js';
import { Block, printable } from './format.js';
import { explainConnect, probe } from './connect.js';
import { loadKnown, movable } from './known.js';

// Snapshots or trees without a frost.repo mean backups were moved without it.
async function hasObjects(b: Backend, signal?: AbortSignal): Promise<boolean> {
  for (const prefix of ['snapshots/', 'trees/']) if ((await b.list(prefix, signal).catch(() => [])).length) return true;
  return false;
}

// `config set` refuses a change with a problem. `config edit` only warns about one, and so does `notice`, for
// a change already made outside frost. `notice` stays quiet when the new storage can't be opened, because
// opening it explains why. Returns false when there was no way to finish the check.
export async function checkStorageChange(
  ctx: Context,
  out: Pick<Block, 'warn' | 'fmt'>,
  was: Storage,
  now: Storage,
  mode: 'refuse' | 'warn' | 'notice',
): Promise<boolean> {
  const problem = (s: string) => {
    if (mode === 'refuse')
      throw new Error(
        s + '\n\nNothing was saved. To modify this setting without this storage check, use `frost config edit`',
      );
    out.warn(out.fmt.caution(out.fmt.errorText(s)));
    return true;
  };
  const unopenable = (s: string) => (mode === 'notice' ? false : problem(s));

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
  if (newError && oldError) return false;
  if (newError) return unopenable('with that change, storage settings are incomplete: ' + (newError as Error).message);
  if (oldB && location(newB!) === location(oldB)) return true;

  // Without a key on this machine there's no way to open the new repository.
  let key;
  try {
    key = await ctx.loadKey();
  } catch {
    return false;
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
      if (mode === 'notice') return false;
      if (await hasObjects(newB!, signal))
        return problem(
          where +
            ' contains frost backup files but is missing frost.repo. Ensure frost.repo was transferred along with data files.',
        );
      let msg = 'There are no backups in ' + where + '.';
      if (known.shown && known.shown !== where) msg += ' Yours are in ' + known.shown + '.';
      if (movable(known.storage ?? was, now))
        msg +=
          ' To use backups in this location, ensure the full directory (frost.repo, chunks/, snapshots/, and trees/) is moved to ' +
          where +
          '.';
      return problem(msg + ' To initialize a separate set of backups here, run `frost init`.');
    }
    if (e === errWrongKey)
      return unopenable(
        where +
          ' contains backups created with a different key. To access them, run `frost key import` with the corresponding recovery phrase.',
      );
    return unopenable("couldn't check " + where + ': ' + explainConnect(e).message);
  }

  // A repository with no snapshots, while the old location has the same repository with snapshots, means
  // only frost.repo was moved.
  let ids: string[];
  try {
    ids = await repo.snapshotIDs(signal);
  } catch (err) {
    return unopenable("couldn't check " + where + ': ' + explainConnect(err).message);
  }
  if (!ids.length && oldB) {
    let have = false;
    try {
      const old = await Repo.open(oldB, key, signal);
      have = old.info.id === repo.info.id && (await old.snapshotIDs(signal)).length > 0;
    } catch {}
    if (have)
      return problem(
        where +
          ' contains frost.repo but no snapshot data. Transfer the chunks/, snapshots/, and trees/ folders to complete the repository transfer.',
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
      'These backups differ from the ones in ' +
        printable(known.shown ?? '') +
        '. The display focus will now switch to these snapshots; previous backups remain unaffected.',
    );
  return true;
}
