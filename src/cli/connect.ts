// Connecting to storage during setup. It checks the storage behaves the way frost needs, finds out whether
// it already holds backups, and turns storage errors into advice.

import { randomBytes } from 'node:crypto';
import { Key } from '../core/crypto.js';
import { words } from '../core/bip39.js';
import { Repo, errWrongKey, errNotInitialized } from '../core/repo.js';
import {
  APIError,
  MissingRootError,
  UnsafeFolderError,
  defaultPermafrostHost,
  errConditionalUnsupported,
  errExists,
  type Backend,
} from '../core/storage.js';
import { SFTPBackend, SFTPStatusError, SSHError } from '../core/sftp.js';
import { authorizedLine } from '../core/sshkey.js';
import * as config from '../core/config.js';
import type { Storage } from '../core/config.js';
import { RepoState, ConnectError } from '../tui/setup.js';
import { sentence } from '../tui/render.js';
import { Context } from './context.js';
import { printable, tildify } from './format.js';

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

// A failed lookup of the default Permafrost server names its host, which means nothing to the person. The
// message says Permafrost instead.
export const cantReachPermafrost = "can't reach Permafrost, check your internet connection and try again";
export function permafrostLookupFailed(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { hostname?: string };
  return (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') && err.hostname === defaultPermafrostHost;
}

// What to do without an SSH client. Windows has one as an optional feature, and other systems as a package.
const noClient =
  process.platform === 'win32'
    ? "frost needs the OpenSSH client, which isn't installed. Add it in Settings, under System > Optional features."
    : "frost needs the OpenSSH client (ssh), which isn't installed. Install it with your system's package manager, often as openssh-client.";

// Advice for a self-hosted server's SSH problems. A server that refuses frost's key, or one this computer hasn't
// seen yet, becomes ConnectError('login'), which setup answers by offering to add the key.
function explainSSH(err: SSHError): Error {
  if (err.problem === 'login' || err.problem === 'unknownhost') return new ConnectError('login', sentence(err.message));
  if (err.problem === 'hostkey' || err.problem === 'garbled') return new ConnectError('address', sentence(err.message));
  if (err.problem === 'nosftp')
    return new ConnectError('address', "That server doesn't offer SFTP. Turn it on in the server's SSH settings.");
  if (err.problem === 'noclient') return new Error(noClient);
  if (err.code === 'ENOTFOUND')
    return new ConnectError('address', "Can't find that server. Check the address and your network.");
  if (err.code === 'ECONNREFUSED')
    return new ConnectError('address', "Nothing answered at that address. Check it's right and that SSH is on.");
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code ?? ''))
    return new ConnectError('address', "The server didn't answer. Check the address and that the server is on.");
  return err;
}

// Turns a storage error into advice. A ConnectError names the setup answer to go back to.
export function explainConnect(error: unknown): Error {
  const err = error as Error & { status?: number; code?: string; hostname?: string };
  if (err instanceof SSHError) return explainSSH(err);

  // A missing folder, a filesystem that can't create files safely and a folder reached through a link all
  // point at the folder answer.
  if (err instanceof MissingRootError || err instanceof UnsafeFolderError)
    return new ConnectError('folder', sentence(err.message));
  if (error instanceof SFTPStatusError && error.status === 3)
    return new ConnectError('folder', "The server won't let frost write in that folder. Check its permissions.");
  if (/goes through a link|is a link in an untrusted folder/.test(err.message ?? ''))
    return new ConnectError('folder', "frost doesn't follow links or junctions to a backup folder. Use its real path.");
  if (err.code === 'EACCES' || err.code === 'EPERM')
    return new ConnectError('folder', "frost can't write in that folder. Check its permissions.");
  if (err.code === 'EROFS') return new ConnectError('folder', 'That drive is read-only.');
  if (err.code === 'ENOSPC') return new Error('the drive is full');

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
  if (permafrostLookupFailed(err)) return new Error(cantReachPermafrost);
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
// the backups. Without one, it only says whether there are backups. Gives up after 45 seconds. A self-hosted
// server gets frost's SSH key made first, and storage with a folder gets the folder's last part created.
// acceptNewHostKey trusts a server's SSH host key the first time this computer sees it.
export async function connect(
  ctx: Context,
  s: Storage,
  local?: Key,
  parentSignal = ctx.signal,
  options: { acceptNewHostKey?: boolean } = {},
): Promise<{ backend: Backend; state: RepoState }> {
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(45_000)]);
  const backend = ctx.hooks.backend(s);
  try {
    if (s.backend === 'sftp') await ctx.hooks.sshKey();
    if (backend instanceof SFTPBackend) backend.acceptNewHostKey = !!options.acceptNewHostKey;
    await backend.prepare?.(signal);
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

// Where frost's public SSH key is, as setup shows it.
export const keyFileShown = () => tildify(config.sshKeyPath() + '.pub');

// Adds frost's SSH key to a self-hosted server. ssh runs in the terminal and asks for the password there.
export async function installKey(ctx: Context, s: Storage): Promise<void> {
  new SFTPBackend(s.sftp, { identity: config.sshKeyPath() });
  const line = authorizedLine(await ctx.hooks.sshKey());
  ctx.fmt.write(
    '\n' +
      ctx.fmt.dim("Adding frost's SSH key to ") +
      printable(s.sftp.host) +
      ctx.fmt.dim('. ssh asks for your password there; frost never sees it.') +
      '\n\n',
  );
  await ctx.hooks.sshInstall(s.sftp.host, s.sftp.port, line);
}

export async function unlock(ctx: Context, s: Storage, phrase: string, signal?: AbortSignal): Promise<Key> {
  const key = phraseKey(phrase);
  await opensRepo(ctx, ctx.hooks.backend(s), key, signal);
  return key;
}
