// Connecting to storage during setup. It checks the storage behaves the way frost needs, finds out whether
// it already holds backups, and turns provider errors into advice.

import { randomBytes } from 'node:crypto';
import { Key } from '../core/crypto.js';
import { words } from '../core/bip39.js';
import { Repo, errWrongKey, errNotInitialized } from '../core/repo.js';
import { APIError, errConditionalUnsupported, errExists, type Backend } from '../core/storage.js';
import type { Storage } from '../core/config.js';
import { RepoState, ConnectError } from '../tui/setup.js';
import { sentence } from '../tui/render.js';
import { Context } from './context.js';

// Turns a typed recovery phrase into a key, with a specific message for each way it can be wrong.
export function phraseKey(phrase: string): Key {
  const parts = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length !== 24) throw new Error(`that's ${parts.length} words, a recovery phrase has 24`);
  for (let i = 0; i < parts.length; i++)
    if (!words.includes(parts[i])) throw new Error(`word ${i + 1} isn't a recovery phrase word. Check its spelling`);
  try {
    return Key.fromPhrase(parts.join(' '));
  } catch (e) {
    if (/checksum/.test((e as Error).message))
      throw new Error("all the words are real, but they don't make a valid phrase. Check their order and spelling");
    throw e;
  }
}

// Turns a storage error into advice. A ConnectError names the setup answer to go back to.
export function explainConnect(error: unknown): Error {
  const err = error as Error & { status?: number; code?: string; hostname?: string };
  if (err === errConditionalUnsupported)
    return new Error(
      "This storage doesn't support conditional writes (If-None-Match: *). frost needs them to keep two machines from overwriting backup metadata. Choose storage that supports them.",
    );

  // Permafrost's own message says why it refused, when it sent one.
  if (err instanceof APIError) {
    const why = err.detail ? ' ' + sentence(err.detail) : '';
    if (err.status === 401)
      return new ConnectError(
        'key',
        "Permafrost didn't accept that access key." + (why || ' Check you copied all of it, or it may have expired.'),
      );
    if (err.status === 403)
      return new ConnectError('key', "Permafrost won't store backups with that access key." + why);
    if (err.status === 507) return new Error('your Permafrost storage is full' + (err.detail ? ': ' + err.detail : ''));
  }

  // Each S3 error code points at the setup answer that's most likely wrong.
  const codes: Record<string, [string, string]> = {
    InvalidAccessKeyId: ['key', "That access key ID wasn't recognised. Check you copied all of it."],
    SignatureDoesNotMatch: ['secret', "The secret key doesn't match the access key ID. Check you copied all of it."],
    NoSuchBucket: ['bucket', "There's no bucket with that name. Check the name, or create the bucket first."],
    AccessDenied: [
      'key',
      "That key doesn't have the bucket permissions frost needs. Allow reading, listing, writing and deleting objects.",
    ],
    AuthorizationHeaderMalformed: ['address', 'The bucket is in a different region. Check the region or endpoint.'],
    InvalidRegion: ['address', 'The bucket is in a different region. Check the region or endpoint.'],
    PermanentRedirect: ['address', 'The bucket is in a different region. Check the region or endpoint.'],
  };
  if (err.code && codes[err.code]) return new ConnectError(...codes[err.code]);

  // Network and certificate errors mostly point at the address.
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')
    return new ConnectError(
      'address',
      "Can't find " +
        (err as NodeJS.ErrnoException & { hostname?: string }).hostname +
        '. Check the address and your internet connection.',
    );
  if (err.code === 'ECONNREFUSED')
    return new ConnectError('address', "Nothing answered at that address. Check it's right.");
  if (err.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(err.code))
    return new ConnectError('address', "The server's certificate isn't valid for that address.");
  if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT')
    return new Error("the storage didn't answer in time, check your internet connection and try again");
  return err;
}

// Checks the storage can create, read, list and delete an object, and that creating it a second time
// fails. frost relies on that conditional write to keep machines from overwriting each other's metadata.
// The test object is deleted afterwards, even when a check fails.
export async function probe(backend: Backend, signal?: AbortSignal): Promise<void> {
  const key = 'frost.probe-' + randomBytes(16).toString('hex');
  await backend.putNew(key, Buffer.from('ok'), signal);
  let failure: unknown;
  try {
    // The second create has to fail with errExists. Succeeding means the storage ignored If-None-Match.
    try {
      await backend.putNew(key, Buffer.from('overwrite'), signal);
      throw errConditionalUnsupported;
    } catch (err) {
      if (err !== errExists) {
        if (err === errConditionalUnsupported) throw err;
        throw new Error('checking conditional object creation: ' + (err as Error).message, { cause: err });
      }
    }
    if ((await backend.get(key, signal)).toString() !== 'ok')
      throw new Error('storage probe data changed: ' + errConditionalUnsupported.message, {
        cause: errConditionalUnsupported,
      });
    if (!(await backend.list(key, signal)).includes(key))
      throw new Error('storage test object is missing from its listing');
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    try {
      await backend.delete(key, AbortSignal.timeout(5000));
    } catch (err) {
      throw new Error(
        (failure ? (failure as Error).message + '\n' : '') + 'removing storage test object: ' + (err as Error).message,
        { cause: err },
      );
    }
  }
}

// Probes the storage and works out what's there. With a key on this machine, it says whether that key opens
// the backups. Without one, it only says whether there are backups. Gives up after 45 seconds.
export async function connect(
  ctx: Context,
  s: Storage,
  local?: Key,
  parentSignal = ctx.signal,
): Promise<{ backend: Backend; state: RepoState }> {
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(45_000)]);
  const backend = ctx.hooks.backend(s);
  try {
    await probe(backend, signal);
    if (local) {
      try {
        await Repo.open(backend, local, signal);
        return { backend, state: RepoState.LocalOK };
      } catch (err) {
        if (err === errNotInitialized) return { backend, state: RepoState.New };
        if (err === errWrongKey) return { backend, state: RepoState.LocalWrong };
        throw err;
      }
    }
    return { backend, state: (await Repo.exists(backend, signal)) ? RepoState.NeedsPhrase : RepoState.New };
  } catch (err) {
    throw explainConnect(err);
  }
}

// Checks a key opens the repository, with the same 45 second limit.
export async function opensRepo(ctx: Context, b: Backend, key: Key, parentSignal = ctx.signal): Promise<void> {
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(45_000)]);
  try {
    await Repo.open(b, key, signal);
  } catch (err) {
    if (err === errWrongKey) throw new Error("that's a valid phrase, but not the one for these backups");
    throw explainConnect(err);
  }
}

export async function unlock(ctx: Context, s: Storage, phrase: string, signal?: AbortSignal): Promise<Key> {
  const key = phraseKey(phrase);
  await opensRepo(ctx, ctx.hooks.backend(s), key, signal);
  return key;
}
