// Client for self-hosted storage over SSH. It runs the system OpenSSH client with the sftp subsystem and
// speaks the parts of SFTP version 3 that frost needs over its pipes, so the server needs nothing but SSH.
// Objects are files under one folder, named by their keys: the same layout as an S3 bucket, so a
// repository can be copied between them.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MissingRootError,
  UnsafeFolderError,
  abortable,
  errExists,
  errNotFound,
  maxChunkSize,
  maxObjectSize,
  validObjectKey,
  type Backend,
  type Usage,
} from './storage.js';

// Field names match the [storage.sftp] settings in config.toml. port 0 leaves the port to the SSH
// config, which defaults to 22.
export interface SFTPConfig {
  host: string;
  port: number;
  path: string;
}

// Packet types, status codes and open flags from the SFTP version 3 draft.
const fxp = {
  init: 1,
  version: 2,
  open: 3,
  close: 4,
  read: 5,
  write: 6,
  lstat: 7,
  fstat: 8,
  opendir: 11,
  readdir: 12,
  remove: 13,
  mkdir: 14,
  stat: 17,
  rename: 18,
  status: 101,
  handle: 102,
  data: 103,
  name: 104,
  attrs: 105,
  extended: 200,
  extendedReply: 201,
};
const fx = { ok: 0, eof: 1, noSuchFile: 2, permissionDenied: 3, failure: 4, opUnsupported: 8 };
const statusNames = [
  'ok',
  'end of file',
  'no such file',
  'permission denied',
  'failure',
  'bad message',
  'no connection',
  'connection lost',
  'operation unsupported',
];
const openRead = 0x01;
const openWrite = 0x02;
const openCreate = 0x08;
const openExclusive = 0x20;

// The largest packet frost accepts. OpenSSH sends at most 256 KiB. Anything far bigger is text that
// a login script printed before SFTP started.
const maxPacket = 1 << 20;
// Requests per file kept in flight at once while reading or writing.
const window = 16;

// The parts of a child process the client needs. Tests pass a fake.
export interface SSHProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
  ref?(): void;
  unref?(): void;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SSHSpawn = (program: string, args: string[]) => SSHProcess;

const spawnSSH: SSHSpawn = (program, args) =>
  spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

// The OpenSSH client that ships with the OS, or ssh from PATH where it lives elsewhere.
export function sshProgram(): string {
  const fixed =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      : '/usr/bin/ssh';
  return existsSync(fixed) ? fixed : 'ssh';
}

// What went wrong with an SSH connection. Only `transport` problems, like a dropped connection, are
// worth trying again; the others need a person to change something.
export type SSHProblem =
  'login' | 'hostkey' | 'unknownhost' | 'nosftp' | 'noclient' | 'nokey' | 'garbled' | 'transport';

// code holds a network error code, like ECONNREFUSED, when ssh reported one, so scheduled backups know
// the server was unreachable.
export class SSHError extends Error {
  constructor(
    message: string,
    public problem: SSHProblem,
    public code?: string,
  ) {
    super(message);
  }
}

// A definite answer from the server to one request.
export class SFTPStatusError extends Error {
  constructor(
    public status: number,
    what: string,
    detail: string,
  ) {
    super(`sftp: ${what}: ${detail || statusNames[status] || 'error ' + status}`);
  }
}

const isStatus = (error: unknown, status: number) => error instanceof SFTPStatusError && error.status === status;

// The host without a user name, as `ssh-keygen -R` expects it.
const hostName = (host: string) => host.slice(host.lastIndexOf('@') + 1);

// Works out why ssh stopped from what it printed. The checks run from the most specific message down.
export function classify(stderr: string, exit: number | null, host: string): SSHError {
  const text = stderr.trim();
  const last = text.split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed/i.test(text))
    return new SSHError(
      `the server's SSH host key has changed since it was trusted, so frost won't connect. If the server was reinstalled, remove its old key with \`ssh-keygen -R ${hostName(host)}\``,
      'hostkey',
    );
  if (/Host key verification failed|No \S+ host key is known/i.test(text))
    return new SSHError("the server isn't one of your known SSH hosts", 'unknownhost');
  if (/Permission denied/i.test(text)) return new SSHError("the server didn't accept frost's SSH key", 'login');
  if (/subsystem request failed/i.test(text)) return new SSHError("the server doesn't offer SFTP", 'nosftp');
  const network: [RegExp, string][] = [
    [/Could not resolve hostname|Name or service not known|nodename nor servname|No such host/i, 'ENOTFOUND'],
    [/Connection refused/i, 'ECONNREFUSED'],
    [/timed out/i, 'ETIMEDOUT'],
    [/No route to host/i, 'EHOSTUNREACH'],
    [/Network is unreachable/i, 'ENETUNREACH'],
    [/Connection reset|Connection closed|Broken pipe|kex_exchange_identification/i, 'ECONNRESET'],
  ];
  for (const [pattern, code] of network)
    if (pattern.test(text)) return new SSHError(`can't connect to ${host}: ${last}`, 'transport', code);
  return new SSHError(`ssh stopped${exit === null ? '' : ' with code ' + exit}${last ? ': ' + last : ''}`, 'transport');
}

const u32 = (value: number) => {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(value);
  return b;
};

const u64 = (value: number) => {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
};

const str = (value: string | Buffer) => {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([u32(data.length), data]);
};

// Reads the fields of one reply in order. Running past the end means a malformed reply.
class Reader {
  #at: number;
  constructor(
    private bytes: Buffer,
    at = 0,
  ) {
    this.#at = at;
  }

  #take(n: number): number {
    if (this.#at + n > this.bytes.length) throw new Error('sftp: malformed reply');
    const at = this.#at;
    this.#at += n;
    return at;
  }

  u32(): number {
    return this.bytes.readUInt32BE(this.#take(4));
  }

  u64(): bigint {
    return this.bytes.readBigUInt64BE(this.#take(8));
  }

  // A 64-bit count frost does arithmetic with, so it has to be a safe integer.
  count(): number {
    const value = this.u64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('sftp: malformed reply');
    return Number(value);
  }

  bytesField(): Buffer {
    const n = this.u32();
    const at = this.#take(n);
    return this.bytes.subarray(at, at + n);
  }

  text(): string {
    return this.bytesField().toString();
  }

  get done(): boolean {
    return this.#at >= this.bytes.length;
  }

  // File attributes. frost only uses the size and the file type from the permissions.
  attrs(): { size?: number; mode?: number } {
    const flags = this.u32();
    const attrs: { size?: number; mode?: number } = {};
    if (flags & 0x1) attrs.size = this.count();
    if (flags & 0x2) this.#take(8);
    if (flags & 0x4) attrs.mode = this.u32();
    if (flags & 0x8) this.#take(8);
    if (flags & 0x80000000)
      for (let n = this.u32(); n > 0; n--) {
        this.bytesField();
        this.bytesField();
      }
    return attrs;
  }
}

interface Reply {
  type: number;
  body: Reader;
}

// Server text in an error is cut short and stripped of control characters.
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);

// Runs work over the items, at most `limit` at a time.
async function each<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

// One ssh process running the sftp subsystem. Requests carry ids, so many can be in flight at once. Once
// the process stops, every request fails with the reason, and the backend starts a new session.
class Session {
  readonly extensions = new Map<string, string>();
  readSize = 32768;
  writeSize = 32768;
  failure?: Error;
  #pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  #next = 1;
  #chunks: Buffer[] = [];
  #size = 0;
  #stderr = '';
  #version?: { resolve(body: Reader): void; reject(error: Error): void };
  #closed: Promise<void>;

  constructor(
    private child: SSHProcess,
    private host: string,
  ) {
    let closed!: () => void;
    this.#closed = new Promise(resolve => (closed = resolve));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (data: Buffer) => this.#receive(data));
    child.stderr.on('data', (data: Buffer) => (this.#stderr = (this.#stderr + data).slice(-8192)));
    child.on('error', error =>
      this.#fail(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new SSHError("frost needs the OpenSSH client (ssh), and it isn't installed", 'noclient')
          : new SSHError('ssh: ' + error.message, 'transport', (error as NodeJS.ErrnoException).code),
      ),
    );
    child.on('close', code => {
      closed();
      this.#fail(classify(this.#stderr, code, host));
    });
  }

  // Keeps the process alive only while requests are waiting, so an idle connection never holds up exit.
  #hold(on: boolean): void {
    for (const handle of [this.child, this.child.stdin, this.child.stdout, this.child.stderr])
      (handle as { ref?(): void; unref?(): void })[on ? 'ref' : 'unref']?.();
  }

  #fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of waiting) p.reject(error);
    this.#version?.reject(error);
    this.#version = undefined;
    this.#hold(false);
  }

  // Splits the output into packets. A first packet that's absurdly long is text, not SFTP.
  #receive(data: Buffer): void {
    this.#chunks.push(data);
    this.#size += data.length;
    while (this.#size >= 4 && !this.failure) {
      if (this.#chunks[0].length < 4) this.#chunks = [Buffer.concat(this.#chunks, this.#size)];
      const length = this.#chunks[0].readUInt32BE(0);
      if (length < 1 || length > maxPacket) {
        this.#fail(
          new SSHError(
            'the server sent text before SFTP started. A login script there probably prints something, which breaks SFTP',
            'garbled',
          ),
        );
        this.child.kill();
        return;
      }
      if (this.#size < 4 + length) return;
      const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#size);
      const packet = all.subarray(4, 4 + length);
      const rest = all.subarray(4 + length);
      this.#chunks = rest.length ? [rest] : [];
      this.#size = rest.length;
      this.#dispatch(packet);
    }
  }

  #dispatch(packet: Buffer): void {
    const type = packet[0];
    if (type === fxp.version) {
      const waiter = this.#version;
      this.#version = undefined;
      waiter?.resolve(new Reader(packet, 1));
      return;
    }
    if (packet.length < 5) return;
    const id = packet.readUInt32BE(1);
    const waiter = this.#pending.get(id);
    if (!waiter) return;
    this.#pending.delete(id);
    if (!this.#pending.size) this.#hold(false);
    waiter.resolve({ type, body: new Reader(packet, 5) });
  }

  // Sends INIT and reads the server's version and extensions, then asks OpenSSH for its size limits.
  async start(timeout: number, signal?: AbortSignal): Promise<void> {
    this.#hold(true);
    const version = new Promise<Reader>((resolve, reject) => (this.#version = { resolve, reject }));
    this.child.stdin.write(Buffer.concat([u32(5), Buffer.from([fxp.init]), u32(3)]));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SSHError(`${this.host} didn't finish connecting in time`, 'transport', 'ETIMEDOUT')),
        timeout,
      );
    });
    try {
      const body = await abortable(Promise.race([version, late]), signal);
      if (body.u32() < 3) throw new SSHError(`${this.host} offers an SFTP version older than 3`, 'nosftp');
      while (!body.done) this.extensions.set(body.text(), body.text());
    } finally {
      clearTimeout(timer);
      if (!this.#pending.size) this.#hold(false);
    }
    if (this.extensions.has('limits@openssh.com')) {
      const reply = await this.request(fxp.extended, [str('limits@openssh.com')], signal);
      if (reply.type === fxp.extendedReply) {
        reply.body.count();
        const read = reply.body.count();
        const write = reply.body.count();
        const fit = (n: number) => Math.max(32768, Math.min(n || 32768, 255 * 1024));
        this.readSize = fit(read);
        this.writeSize = fit(write);
      }
    }
  }

  request(type: number, parts: Buffer[], signal?: AbortSignal): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#next;
    this.#next = this.#next >= 0xffffffff ? 1 : this.#next + 1;
    const packet = Buffer.concat([u32(0), Buffer.from([type]), u32(id), ...parts]);
    packet.writeUInt32BE(packet.length - 4, 0);
    return new Promise<Reply>((resolve, reject) => {
      const abort = () => {
        if (!this.#pending.delete(id)) return;
        if (!this.#pending.size) this.#hold(false);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#pending.set(id, {
        resolve: reply => {
          signal?.removeEventListener('abort', abort);
          resolve(reply);
        },
        reject: error => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      if (this.#pending.size === 1) this.#hold(true);
      this.child.stdin.write(packet);
    });
  }

  // Throws the server's status unless it's OK.
  static status(reply: Reply, what: string): void {
    if (reply.type !== fxp.status) throw new Error(`sftp: ${what}: unexpected reply`);
    const code = reply.body.u32();
    if (code !== fx.ok) throw new SFTPStatusError(code, what, clean(reply.body.text()));
  }

  async simple(type: number, parts: Buffer[], what: string, signal?: AbortSignal): Promise<void> {
    Session.status(await this.request(type, parts, signal), what);
  }

  async open(file: string, flags: number, signal?: AbortSignal): Promise<Buffer> {
    const reply = await this.request(fxp.open, [str(file), u32(flags), u32(0)], signal);
    if (reply.type === fxp.handle) return Buffer.from(reply.body.bytesField());
    Session.status(reply, 'open ' + file);
    throw new Error(`sftp: open ${file}: unexpected reply`);
  }

  close(handle: Buffer, signal?: AbortSignal): Promise<void> {
    return this.simple(fxp.close, [str(handle)], 'close', signal);
  }

  async attrs(type: number, target: Buffer, what: string, signal?: AbortSignal) {
    const reply = await this.request(type, [str(target)], signal);
    if (reply.type === fxp.attrs) return reply.body.attrs();
    Session.status(reply, what);
    throw new Error(`sftp: ${what}: unexpected reply`);
  }

  // Whether something exists at the path, following a symlink as the folder it points to.
  async exists(file: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.attrs(fxp.stat, Buffer.from(file), 'stat ' + file, signal);
      return true;
    } catch (error) {
      if (isStatus(error, fx.noSuchFile)) return false;
      throw error;
    }
  }

  async extended(name: string, parts: Buffer[], signal?: AbortSignal): Promise<Reply> {
    return this.request(fxp.extended, [str(name), ...parts], signal);
  }

  // Reads exactly `size` bytes into a fresh buffer of that size, which the caller then owns. A short read
  // asks again for the rest; the end of the file before `size` means it shrank.
  async readAll(handle: Buffer, size: number, signal?: AbortSignal): Promise<Buffer> {
    const out = Buffer.allocUnsafeSlow(size);
    const ranges: [number, number][] = [];
    for (let at = 0; at < size; at += this.readSize) ranges.push([at, Math.min(this.readSize, size - at)]);
    await each(ranges, window, async ([at, length]) => {
      while (length > 0) {
        const reply = await this.request(fxp.read, [str(handle), u64(at), u32(length)], signal);
        if (reply.type !== fxp.data) {
          Session.status(reply, 'read');
          throw new Error('sftp: read: unexpected reply');
        }
        const data = reply.body.bytesField();
        if (!data.length) throw new Error('unexpected EOF');
        if (data.length > length) throw new Error('sftp: read: the server sent more than was asked for');
        data.copy(out, at);
        at += data.length;
        length -= data.length;
      }
    }).catch(error => {
      // A read that ended early is an EOF from the server's point of view.
      throw isStatus(error, fx.eof) ? new Error('unexpected EOF') : error;
    });
    return out;
  }

  async writeAll(handle: Buffer, data: Buffer, signal?: AbortSignal): Promise<void> {
    const ranges: number[] = [];
    for (let at = 0; at < data.length; at += this.writeSize) ranges.push(at);
    await each(ranges, window, async at => {
      // str copies the piece into the packet, so the caller's buffer is never queued on the pipe.
      const piece = data.subarray(at, Math.min(at + this.writeSize, data.length));
      await this.simple(fxp.write, [str(handle), u64(at), str(piece)], 'write', signal);
    });
  }

  // Lists a folder's entries with their types. null means it doesn't exist.
  async readdir(folder: string, signal?: AbortSignal): Promise<{ name: string; dir: boolean; file: boolean }[] | null> {
    let handle: Buffer;
    try {
      const reply = await this.request(fxp.opendir, [str(folder)], signal);
      if (reply.type !== fxp.handle) {
        Session.status(reply, 'list ' + folder);
        throw new Error(`sftp: list ${folder}: unexpected reply`);
      }
      handle = Buffer.from(reply.body.bytesField());
    } catch (error) {
      if (isStatus(error, fx.noSuchFile)) return null;
      throw error;
    }
    const entries: { name: string; dir: boolean; file: boolean }[] = [];
    try {
      for (;;) {
        const reply = await this.request(fxp.readdir, [str(handle)], signal);
        if (reply.type !== fxp.name) {
          if (reply.type === fxp.status && reply.body.u32() === fx.eof) break;
          throw new Error(`sftp: list ${folder}: unexpected reply`);
        }
        for (let n = reply.body.u32(); n > 0; n--) {
          const name = reply.body.text();
          const long = reply.body.text();
          const { mode } = reply.body.attrs();
          // Without permissions, the long name's first letter gives the type, as in `ls -l`.
          const type = mode === undefined ? ({ d: 0o040000, '-': 0o100000 }[long[0]] ?? 0) : mode & 0o170000;
          if (name !== '.' && name !== '..' && !name.includes('/'))
            entries.push({ name, dir: type === 0o040000, file: type === 0o100000 });
        }
      }
    } finally {
      this.close(handle).catch(() => {});
    }
    return entries;
  }

  // Ends the session: closes the input so ssh stops by itself, and kills it if it's still running a second
  // later. The process stays referenced until then, so whoever awaits this sees it finish.
  async end(): Promise<void> {
    this.#fail(new SSHError('the SSH connection was closed', 'transport'));
    this.#hold(true);
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>(resolve => (timer = setTimeout(() => resolve(true), 1000)));
    if (await Promise.race([this.#closed.then(() => false), late])) this.child.kill();
    clearTimeout(timer);
    this.#hold(false);
  }
}

// Options that come from outside config.toml: the key file, and fakes for tests.
export interface SFTPOptions {
  identity: string;
  spawn?: SSHSpawn;
  program?: string;
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  // How long the connection and SFTP start may take.
  timeout?: number;
}

const sleep = async (ms: number, signal?: AbortSignal) => {
  await delay(ms, undefined, { signal });
};

// The folder setting cleaned up: forward slashes, no `~/` or trailing slash. A relative folder starts in
// the login folder on the server.
function cleanFolder(value: string): string {
  let folder = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  if (folder === '~') folder = '';
  else if (folder.startsWith('~/')) folder = folder.slice(2);
  if (folder.length > 1) folder = folder.replace(/\/$/, '');
  return folder;
}

// Client for a folder on a server reached over SSH. It logs in with frost's own key and never prompts, so
// it works the same in scheduled backups.
export class SFTPBackend implements Backend {
  #host: string;
  #port: number;
  #root: string;
  #current?: Session;
  #starting?: Promise<Session>;
  // Accepts a server's host key the first time, for setup after a person added frost's key by hand. A
  // changed key is still refused.
  acceptNewHostKey = false;

  constructor(
    config: SFTPConfig,
    private options: SFTPOptions,
  ) {
    this.#host = config.host.trim();
    if (!this.#host) throw new Error('sftp: host is required');
    // The host goes to ssh after `--`, and also mustn't look like an option or hold a command.
    if (this.#host.startsWith('-') || !/^[A-Za-z0-9._%+:[\]@-]+$/.test(this.#host))
      throw new Error('sftp: invalid host');
    if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535)
      throw new Error('sftp: port must be from 1 to 65535, or 0 for the SSH default');
    this.#port = config.port;
    this.#root = cleanFolder(config.path);
    if (!this.#root || /[\x00-\x1f]/.test(this.#root)) throw new Error('sftp: path is required');
  }

  // sftp://me@nas/~/frost for a folder in the login folder, sftp://me@nas/srv/frost for a full path.
  toString(): string {
    const host = /:/.test(hostName(this.#host)) && !this.#host.includes('[') ? this.#bracket() : this.#host;
    return `sftp://${host}${this.#port ? ':' + this.#port : ''}${this.#root.startsWith('/') ? '' : '/~/'}${this.#root}`;
  }

  #bracket(): string {
    const at = this.#host.lastIndexOf('@');
    return this.#host.slice(0, at + 1) + '[' + this.#host.slice(at + 1) + ']';
  }

  location(): string {
    return this.toString();
  }

  // The ssh command line. -T, -x and -a turn off the terminal, X11 and agent forwarding. BatchMode makes
  // ssh fail instead of asking for anything. The agent is disabled; explicit IdentityFile entries in
  // the user's SSH config may also be offered alongside frost's key. The host comes after `--`.
  args(): string[] {
    return [
      '-T',
      '-x',
      '-a',
      '-i',
      this.options.identity,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=20',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'StrictHostKeyChecking=' + (this.acceptNewHostKey ? 'accept-new' : 'yes'),
      ...(this.#port ? ['-p', String(this.#port)] : []),
      '-s',
      '--',
      this.#host,
      'sftp',
    ];
  }

  // The full path of an object key.
  #path(key: string): string {
    if (!validObjectKey(key)) throw new Error('sftp: invalid object key');
    return this.#join(key);
  }

  // The full path of a folder inside the repository, like chunks/ab/, or of the root for ''.
  #folder(folder: string): string {
    const name = folder.replace(/\/$/, '');
    return name ? this.#join(name) : this.#root;
  }

  #join(name: string): string {
    return (this.#root === '/' ? '' : this.#root) + '/' + name;
  }

  // Starts a session, shared by everything that asks while it starts. The key file is checked first, since
  // ssh's own complaint about it is buried among other messages.
  async #connect(signal?: AbortSignal): Promise<Session> {
    if (this.#current && !this.#current.failure) return this.#current;
    this.#starting ??= (async () => {
      try {
        await access(this.options.identity);
      } catch {
        throw new SSHError(
          `frost's SSH key is missing (${this.options.identity}). Run \`frost init\` to make a new one`,
          'nokey',
        );
      }
      const session = new Session(
        (this.options.spawn ?? spawnSSH)(this.options.program ?? sshProgram(), this.args()),
        this.#host,
      );
      try {
        await session.start(this.options.timeout ?? 60_000);
      } catch (error) {
        await session.end();
        throw error;
      }
      this.#current = session;
      return session;
    })().finally(() => (this.#starting = undefined));
    return abortable(this.#starting, signal);
  }

  // Runs an operation with up to four attempts. A dropped connection retries after 0.5, 1 and 2 seconds on a
  // new session. The server's answers and problems a person has to fix aren't retried.
  async #run<T>(signal: AbortSignal | undefined, op: (session: Session) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      try {
        return await op(await this.#connect(signal));
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof SSHError && error.problem === 'transport')) throw error;
        last = error;
      }
      if (attempt < 3) await (this.options.pause ?? sleep)(500 * 2 ** attempt, signal);
    }
    throw last;
  }

  // Fails with MissingRootError when the folder itself is gone, so a missing object there isn't mistaken
  // for an empty repository.
  async #checkRoot(session: Session, signal?: AbortSignal): Promise<void> {
    if (!(await session.exists(this.#root, signal)))
      throw new MissingRootError(`there's no folder ${this.#root} on ${this.#host}`);
  }

  // Creates the folders between the root and a key, one level at a time. The root itself is never created
  // here, only by prepare.
  async #makeParents(session: Session, folder: string, signal?: AbortSignal): Promise<void> {
    await this.#checkRoot(session, signal);
    const parts = folder.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++)
      await session
        .simple(fxp.mkdir, [str(this.#folder(parts.slice(0, i).join('/'))), u32(0)], 'mkdir', signal)
        .catch(error => {
          // An existing folder is a plain failure in OpenSSH.
          if (!isStatus(error, fx.failure)) throw error;
        });
  }

  // Writes data to a new temporary file next to the key and returns its path. The ~ in its name is never part
  // of a valid key, so listings skip it. It's flushed to disk when the server can do that.
  async #writeTemp(session: Session, key: string, data: Buffer, signal?: AbortSignal): Promise<string> {
    const folder = key.slice(0, key.lastIndexOf('/') + 1);
    const tempFile = this.#join(folder + '~' + key.slice(folder.length) + '.' + randomBytes(8).toString('hex'));
    let handle: Buffer;
    try {
      handle = await session.open(tempFile, openWrite | openCreate | openExclusive, signal);
    } catch (error) {
      if (!isStatus(error, fx.noSuchFile)) throw error;
      await this.#makeParents(session, folder, signal);
      handle = await session.open(tempFile, openWrite | openCreate | openExclusive, signal);
    }
    try {
      await session.writeAll(handle, data, signal);
      if (session.extensions.has('fsync@openssh.com'))
        Session.status(await session.extended('fsync@openssh.com', [str(handle)], signal), 'fsync');
      await session.close(handle, signal);
    } catch (error) {
      const cleanup = session
        .close(handle)
        .catch(() => {})
        .then(() => session.simple(fxp.remove, [str(tempFile)], 'remove'))
        .catch(() => {});
      if (!signal?.aborted) await cleanup;
      throw error;
    }
    return tempFile;
  }

  async #store(key: string, data: Buffer, exclusive: boolean, signal?: AbortSignal): Promise<void> {
    const target = this.#path(key);
    await this.#run(signal, async session => {
      // A conditional create needs hard links, and fails closed without them.
      if (exclusive && !session.extensions.has('hardlink@openssh.com'))
        throw new UnsafeFolderError(
          `the server can't make hard links over SFTP, which frost needs to create files safely. It needs an OpenSSH server`,
        );
      const temp = await this.#writeTemp(session, key, data, signal);
      const remove = () => session.simple(fxp.remove, [str(temp)], 'remove').catch(() => {});
      if (exclusive) {
        try {
          await this.#link(session, temp, target, signal);
        } finally {
          await remove();
        }
        return;
      }
      try {
        await this.#replace(session, temp, target, signal);
      } catch (error) {
        await remove();
        throw error;
      }
    });
  }

  // Links the temporary file to the key, which fails if the key exists. Plain RENAME isn't used here:
  // OpenSSH falls back to a check followed by a rename when the filesystem can't link, and two machines can
  // both pass that check.
  async #link(session: Session, temp: string, target: string, signal?: AbortSignal): Promise<void> {
    try {
      Session.status(await session.extended('hardlink@openssh.com', [str(temp), str(target)], signal), 'link');
    } catch (error) {
      if (!(error instanceof SFTPStatusError)) throw error;
      if (await session.exists(target, signal)) throw errExists;
      if (error.status !== fx.failure && error.status !== fx.opUnsupported) throw error;
      throw new UnsafeFolderError(
        `the server can't make hard links in ${this.#root}, which frost needs to create files safely. Use a folder on a filesystem with hard links, like ext4, Btrfs, XFS, ZFS, APFS or NTFS`,
        { cause: error },
      );
    }
  }

  // Moves the temporary file over the key. posix-rename replaces it in one step. Without it, plain RENAME
  // refuses an existing key, so the old object goes first; chunks hold the same content either way.
  async #replace(session: Session, temp: string, target: string, signal?: AbortSignal): Promise<void> {
    if (session.extensions.has('posix-rename@openssh.com')) {
      Session.status(await session.extended('posix-rename@openssh.com', [str(temp), str(target)], signal), 'rename');
      return;
    }
    try {
      await session.simple(fxp.rename, [str(temp), str(target)], 'rename', signal);
    } catch (error) {
      if (!isStatus(error, fx.failure)) throw error;
      await session.simple(fxp.remove, [str(target)], 'remove', signal).catch(e => {
        if (!isStatus(e, fx.noSuchFile)) throw e;
      });
      await session.simple(fxp.rename, [str(temp), str(target)], 'rename', signal);
    }
  }

  async put(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#store(key, data, false, signal);
  }

  async putNew(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#store(key, data, true, signal);
  }

  // Chunks are capped at the largest sealed chunk, and other objects at the largest object.
  async #download(key: string, signal?: AbortSignal): Promise<Buffer> {
    const target = this.#path(key);
    const limit = key.startsWith('chunks/') ? maxChunkSize : maxObjectSize;
    return this.#run(signal, async session => {
      let handle: Buffer;
      try {
        handle = await session.open(target, openRead, signal);
      } catch (error) {
        if (!isStatus(error, fx.noSuchFile)) throw error;
        await this.#checkRoot(session, signal);
        throw errNotFound;
      }
      try {
        const { size } = await session.attrs(fxp.fstat, handle, 'stat ' + target, signal);
        if (size === undefined) throw new Error(`sftp: ${target}: the server didn't report its size`);
        if (size > limit) throw new Error('storage response exceeds size limit');
        return await session.readAll(handle, size, signal);
      } finally {
        session.close(handle).catch(() => {});
      }
    });
  }

  async get(key: string, signal?: AbortSignal): Promise<Buffer> {
    return this.#download(key, signal);
  }

  // Every download is already a fresh buffer of its exact size.
  async getOwned(key: string, signal?: AbortSignal): Promise<Buffer> {
    return this.#download(key, signal);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    const target = this.#path(key);
    await this.#run(signal, async session => {
      try {
        await session.simple(fxp.remove, [str(target)], 'remove ' + target, signal);
      } catch (error) {
        if (!isStatus(error, fx.noSuchFile)) throw error;
      }
    });
  }

  // Walks the folders the prefix can reach, eight at a time, and returns the regular files whose keys start
  // with it. Temporary files, symlinks and anything that isn't a valid key are left out.
  async list(prefix: string, signal?: AbortSignal): Promise<string[]> {
    if (!/^[a-z0-9._/-]*$/.test(prefix)) throw new Error('sftp: invalid list prefix');
    const start = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    return this.#run(signal, async session => {
      const keys: string[] = [];
      let level = [start];
      while (level.length) {
        const next: string[] = [];
        await each(level, 8, async folder => {
          const entries = await session.readdir(this.#folder(folder), signal);
          if (!entries) {
            if (folder === start) await this.#checkRoot(session, signal);
            return;
          }
          for (const entry of entries) {
            const key = folder + entry.name;
            if (!validObjectKey(key)) continue;
            if (entry.file && key.startsWith(prefix)) keys.push(key);
            const sub = key + '/';
            if (entry.dir && (sub.startsWith(prefix) || prefix.startsWith(sub))) next.push(sub);
          }
        });
        level = next;
      }
      return keys;
    });
  }

  // How full the server's disk is, from OpenSSH's statvfs extension.
  async usage(signal?: AbortSignal): Promise<Usage> {
    return this.#run(signal, async session => {
      if (!session.extensions.has('statvfs@openssh.com'))
        throw new Error(`sftp: ${this.#host} doesn't report its disk space`);
      const reply = await session.extended('statvfs@openssh.com', [str(this.#root)], signal);
      if (reply.type !== fxp.extendedReply) {
        Session.status(reply, 'statvfs');
        throw new Error('sftp: statvfs: unexpected reply');
      }
      const r = reply.body;
      const blockSize = r.count();
      const fragment = r.count();
      const blocks = r.count();
      const free = r.count();
      const available = r.count();
      r.u64();
      r.u64();
      r.u64();
      r.u64();
      const flags = r.u64();
      const unit = fragment || blockSize;
      const total = blocks * unit;
      if (!Number.isSafeInteger(total)) throw new Error('sftp: statvfs: invalid sizes');
      const readOnly = (flags & 1n) === 1n;
      return {
        used: total - free * unit,
        quota: total,
        readOnly,
        message: readOnly
          ? "the server's disk is read-only"
          : available * unit < total * 0.05
            ? "the server's disk is nearly full"
            : '',
      };
    });
  }

  // Creates the folder when it's missing and its parent exists. A relative folder's parent is the login
  // folder, which always exists.
  async prepare(signal?: AbortSignal): Promise<void> {
    await this.#run(signal, async session => {
      if (await session.exists(this.#root, signal)) return;
      const parent = path.posix.dirname(this.#root);
      if (!(await session.exists(parent, signal)))
        throw new MissingRootError(`there's no folder ${parent} on ${this.#host}`);
      try {
        await session.simple(fxp.mkdir, [str(this.#root), u32(0)], 'mkdir ' + this.#root, signal);
      } catch (error) {
        if (!(await session.exists(this.#root, signal))) throw error;
      }
    });
  }

  async close(): Promise<void> {
    const session = this.#current;
    this.#current = undefined;
    await session?.end();
  }
}
