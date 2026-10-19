// frost's own SSH key for self-hosted storage. Scheduled backups can't use an SSH agent or type a
// passphrase, so frost logs in with a key of its own: ed25519, unencrypted, readable only by you, written
// in the OpenSSH format every ssh client reads. The private half is never printed.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as config from './config.js';
import { ownerOnlyFolder } from '../platform/acl.js';
import type { Runner } from '../platform/command.js';

const keyType = 'ssh-ed25519';
const magic = Buffer.from('openssh-key-v1\0');

const u32 = (value: number) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(value);
  return b;
};

const field = (value: string | Buffer) => {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([u32(data.length), data]);
};

// The public half as one authorized_keys line, like `ssh-ed25519 AAAA... frost@laptop`.
export function publicLine(publicKey: Buffer, comment: string): string {
  return `${keyType} ${Buffer.concat([field(keyType), field(publicKey)]).toString('base64')} ${comment}`;
}

// The line setup adds to the server. `restrict` turns off forwarding and terminal allocation for this key.
// Shell commands still work; an SFTP-only account needs a server-side restriction.
export const authorizedLine = (line: string) => 'restrict ' + line;

// The key's comment names this computer, so the line is easy to find on the server later.
function comment(): string {
  const host = os.hostname().replace(/[^A-Za-z0-9._-]/g, '') || 'computer';
  return 'frost@' + host;
}

// Encodes a private key in OpenSSH's unencrypted format: the public key, then a section holding a repeated
// check number, the key pair and the comment, padded to 8 bytes.
export function encodePrivate(seed: Buffer, publicKey: Buffer, note: string): string {
  const check = randomBytes(4);
  const parts = [check, check, field(keyType), field(publicKey), field(Buffer.concat([seed, publicKey])), field(note)];
  const length = parts.reduce((n, part) => n + part.length, 0);
  const padding = Buffer.from(Array.from({ length: (8 - (length % 8)) % 8 }, (_, i) => i + 1));
  const secret = Buffer.concat([...parts, padding]);
  const body = Buffer.concat([
    magic,
    field('none'),
    field('none'),
    field(''),
    u32(1),
    field(Buffer.concat([field(keyType), field(publicKey)])),
    field(secret),
  ]);
  const text = body
    .toString('base64')
    .match(/.{1,70}/g)!
    .join('\n');
  secret.fill(0);
  body.fill(0);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${text}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

// Reads fixed-size and length-prefixed fields in order. Running past the end throws.
function reader(bytes: Buffer) {
  let at = 0;
  const take = (n: number) => {
    if (at + n > bytes.length) throw new Error('truncated');
    at += n;
    return bytes.subarray(at - n, at);
  };
  return { take, field: () => take(take(4).readUInt32BE(0)) };
}

// Reads the public key and comment back out of a key file in that format. Anything else is refused.
export function decodePrivate(text: string): { publicKey: Buffer; comment: string } {
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  const body = Buffer.from(match?.[1].replace(/\s+/g, '') ?? '', 'base64');
  try {
    const outer = reader(body);
    const ok =
      outer.take(magic.length).equals(magic) &&
      outer.field().toString() === 'none' &&
      outer.field().toString() === 'none' &&
      outer.field().length === 0 &&
      outer.take(4).readUInt32BE(0) === 1;
    outer.field();
    const inner = reader(outer.field());
    if (!ok || !inner.take(4).equals(inner.take(4)) || inner.field().toString() !== keyType) throw new Error();
    const publicKey = Buffer.from(inner.field());
    const pair = inner.field();
    if (publicKey.length !== 32 || pair.length !== 64 || !pair.subarray(32).equals(publicKey)) throw new Error();
    return { publicKey, comment: inner.field().toString() };
  } catch {
    throw new Error("that isn't an unencrypted ed25519 key in OpenSSH format");
  } finally {
    body.fill(0);
  }
}

// Returns frost's public key line, making the key pair first if there isn't one. The .pub file is only a
// copy, so a missing or damaged one is written again from the private key. On Windows the key's folder is
// made owner-only before anything is written, and again for a key that's already there.
export async function ensureKey(file = config.sshKeyPath(), runner?: Runner): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await ownerOnlyFolder(path.dirname(file), runner);
  let existing: string | undefined;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (existing !== undefined) {
    let decoded;
    try {
      decoded = decodePrivate(existing);
    } catch (error) {
      throw new Error(`can't use frost's SSH key at ${file}: ${(error as Error).message}`);
    }
    const line = publicLine(decoded.publicKey, decoded.comment);
    const saved = await readFile(file + '.pub', 'utf8').catch(() => '');
    if (saved.trim() !== line) await config.writePrivate(file + '.pub', line + '\n');
    return line;
  }

  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d!, 'base64url');
  const publicKey = Buffer.from(jwk.x!, 'base64url');
  const note = comment();
  try {
    await config.writePrivate(file, encodePrivate(seed, publicKey, note));
  } finally {
    seed.fill(0);
  }
  const line = publicLine(publicKey, note);
  await config.writePrivate(file + '.pub', line + '\n');
  return line;
}

// The remote command that adds a key line to the server, read from standard input so nothing needs quoting.
// It runs under sh whatever the login shell is, and adds the line only once.
export const installScript =
  "sh -c 'umask 077; mkdir -p .ssh && touch .ssh/authorized_keys && read -r k && " +
  '{ grep -qxF "$k" .ssh/authorized_keys || printf "%s\\n" "$k" >> .ssh/authorized_keys; }\'';

// The ssh command line that adds frost's key, run in the terminal so ssh can ask for the password and show
// the host key on first contact. Keys you already use may log in instead of the password.
export function installArgs(host: string, port: number): string[] {
  return ['-T', '-o', 'LogLevel=ERROR', ...(port ? ['-p', String(port)] : []), '--', host, installScript];
}
