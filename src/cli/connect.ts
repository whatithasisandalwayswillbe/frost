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
  if (parts.length !== 24)
    throw new Error(
      `entered ${parts.length} ${parts.length === 1 ? 'word' : 'words'}, but a recovery phrase must contain exactly 24 words`,
    );
  for (let i = 0; i < parts.length; i++)
    if (!words.includes(parts[i])) throw new Error(`word ${i + 1} is not a valid recovery word; check the spelling`);
  try {
    return Key.fromPhrase(parts.join(' '));
  } catch (e) {
    if (/checksum/.test((e as Error).message))
      throw new Error(
        'all words are valid individually, but together they do not form a valid recovery phrase; check their order and spelling',
      );
    throw e;
  }
}

// A failed lookup of the default Permafrost server names its host, which means nothing to the person. The
// message says Permafrost instead.
export const cantReachPermafrost = 'cannot reach Permafrost; check your internet connection and try again';
export function permafrostLookupFailed(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & { hostname?: string };
  return (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') && err.hostname === defaultPermafrostHost;
}

// What to do without an SSH client. Windows has one as an optional feature, and other systems as a package.
const noClient =
  process.platform === 'win32'
    ? 'frost requires the OpenSSH client, which is not installed. Enable it under Settings > System > Optional features.'
    : 'frost requires the OpenSSH client (ssh), which is not installed. Install it using your package manager (typically openssh-client).';

// Advice for a self-hosted server's SSH problems. A server that refuses frost's key, or one this computer hasn't
// seen yet, becomes ConnectError('login'), which setup answers by offering to add the key.
function explainSSH(err: SSHError): Error {
  if (err.problem === 'login' || err.problem === 'unknownhost') return new ConnectError('login', sentence(err.message));
  if (err.problem === 'hostkey' || err.problem === 'garbled') return new ConnectError('address', sentence(err.message));
  if (err.problem === 'nosftp')
    return new ConnectError(
      'address',
      "That server does not support SFTP. Enable SFTP in the server's SSH configuration.",
    );
  if (err.problem === 'noclient') return new Error(noClient);
  if (err.code === 'ENOTFOUND')
    return new ConnectError('address', 'Cannot locate the server. Check the address and your network connection.');
  if (err.code === 'ECONNREFUSED')
    return new ConnectError(
      'address',
      'No response from that address. Verify the address and ensure the SSH service is running.',
    );
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code ?? ''))
    return new ConnectError(
      'address',
      'The server did not respond. Verify the address and ensure the server is online.',
    );
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
    return new ConnectError('folder', 'The server denied write access to that folder. Check folder permissions.');
  if (/goes through a link|is a link in an untrusted folder/.test(err.message ?? ''))
    return new ConnectError(
      'folder',
      'frost does not follow symbolic links or directory junctions for backup folders. Specify a real path without links or junctions.',
    );
  if (err.code === 'EACCES' || err.code === 'EPERM')
    return new ConnectError('folder', 'frost cannot write to that folder. Check directory permissions.');
  if (err.code === 'EROFS') return new ConnectError('folder', 'That drive is read-only.');
  if (err.code === 'ENOSPC') return new Error('the drive is full');

  if (err === errConditionalUnsupported)
    return new Error(
      'This storage provider does not support conditional writes (If-None-Match: *). frost requires this feature to prevent conflicting updates to backup metadata across multiple machines. Choose storage that supports conditional writes.',
    );

  // Permafrost's own message says why it refused, when it sent one.
  if (err instanceof APIError) {
    const why = err.detail ? ' ' + sentence(err.detail) : '';
    if (err.status === 401)
      return new ConnectError(
        'key',
        'Permafrost rejected the access key.' +
          (why || ' Ensure the entire key was copied correctly, or verify that it has not expired.'),
      );
    if (err.status === 403)
      return new ConnectError('key', "Permafrost won't store backups with that access key." + why);
    if (err.status === 507) return new Error('your Permafrost storage is full' + (err.detail ? ': ' + err.detail : ''));
  }

  // Each S3 error code points at the setup answer that's most likely wrong.
  const codes: Record<string, [string, string]> = {
    InvalidAccessKeyId: ['key', 'Access key ID not recognized. Ensure the entire ID was copied correctly.'],
    SignatureDoesNotMatch: [
      'secret',
      'The secret key does not match the access key ID. Ensure both were copied correctly.',
    ],
    NoSuchBucket: ['bucket', 'No bucket found with that name. Verify the name or create the bucket first.'],
    AccessDenied: [
      'key',
      'The provided key lacks necessary bucket permissions. Ensure read, list, write, and delete permissions are granted.',
    ],
    AuthorizationHeaderMalformed: [
      'address',
      'The bucket is located in a different region. Verify the specified region or endpoint.',
    ],
    InvalidRegion: ['address', 'The bucket is located in a different region. Verify the specified region or endpoint.'],
    PermanentRedirect: [
      'address',
      'The bucket is located in a different region. Verify the specified region or endpoint.',
    ],
  };
  if (err.code && codes[err.code]) return new ConnectError(...codes[err.code]);

  // Network and certificate errors mostly point at the address.
  if (permafrostLookupFailed(err)) return new Error(cantReachPermafrost);
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')
    return new ConnectError(
      'address',
      'Cannot resolve ' +
        (err as NodeJS.ErrnoException & { hostname?: string }).hostname +
        '. Verify the address and your internet connection.',
    );
  if (err.code === 'ECONNREFUSED')
    return new ConnectError('address', 'No response from that address. Verify that the address is correct.');
  if (err.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(err.code))
    return new ConnectError('address', "The server's TLS certificate is not valid for that address.");
  if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT')
    return new Error('the storage host timed out; check your internet connection and try again');
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
    if (err === errWrongKey) throw new Error('that recovery phrase is valid, but it does not match these backups');
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
      ctx.fmt.dim('. SSH handles authentication directly; frost never sees or stores your password.') +
      '\n\n',
  );
  await ctx.hooks.sshInstall(s.sftp.host, s.sftp.port, line);
}

export async function unlock(ctx: Context, s: Storage, phrase: string, signal?: AbortSignal): Promise<Key> {
  const key = phraseKey(phrase);
  await opensRepo(ctx, ctx.hooks.backend(s), key, signal);
  return key;
}
