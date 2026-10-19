// A small SFTP version 3 server for tests, behind a fake ssh process. It serves a real temporary folder and
// follows OpenSSH's sftp-server where frost depends on it: RENAME refuses an existing target, the hardlink,
// posix-rename, fsync, statvfs and limits extensions, errno mapped to status codes, and folder listings
// that use lstat. Built from the SFTP draft, independently of src/core/sftp.ts.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SSHProcess } from '../../src/core/sftp.js';

const status = { ok: 0, eof: 1, noSuchFile: 2, permissionDenied: 3, failure: 4, badMessage: 5, opUnsupported: 8 };

export interface ServerOptions {
  // The folder relative paths start in, like a login folder.
  home: string;
  extensions?: string[];
  // Stops the process after this many requests, as if the connection dropped.
  dropAfter?: number;
  // Fails the start: what ssh prints and its exit code. No SFTP happens.
  refuse?: { stderr: string; code: number };
  // Text a login script prints before SFTP starts.
  banner?: string;
  // The most data one READ returns, to test short reads.
  shortReads?: number;
  // What hardlink@openssh.com answers instead of linking.
  hardlinkStatus?: number;
  // statvfs numbers: block size, total blocks, free blocks, available blocks and flags.
  statvfs?: { size: number; blocks: number; free: number; available: number; flags: number };
  // Called with each request type, before it's handled.
  onRequest?: (type: number) => void;
}

export const allExtensions = [
  'posix-rename@openssh.com',
  'statvfs@openssh.com',
  'hardlink@openssh.com',
  'fsync@openssh.com',
  'limits@openssh.com',
];

// A fake child process: the server reads its stdin and writes its stdout. It closes when its input ends,
// like ssh at the end of a session, and records ref and unref calls.
export class FakeSSH extends EventEmitter implements SSHProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  holds: boolean[] = [];
  closed = false;

  ref(): void {
    this.holds.push(true);
  }

  unref(): void {
    this.holds.push(false);
  }

  kill(): boolean {
    this.finish(null);
    return true;
  }

  // Prints to stderr, then closes after the data is delivered.
  finish(code: number | null, stderr = ''): void {
    if (this.closed) return;
    this.closed = true;
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('close', code);
    });
  }
}

const u32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};
const u64 = (value: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
};
const string = (value: string | Buffer) => {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([u32(data.length), data]);
};

function attrs(info: fs.Stats): Buffer {
  return Buffer.concat([u32(0x1 | 0x4), u64(info.size), u32(info.mode)]);
}

function errno(error: unknown): number {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return status.noSuchFile;
  if (code === 'EACCES' || code === 'EPERM') return status.permissionDenied;
  return status.failure;
}

// Starts a server on a new fake process.
export function serve(options: ServerOptions): FakeSSH {
  const child = new FakeSSH();
  const extensions = options.extensions ?? allExtensions;
  const handles = new Map<string, { fd?: number; entries?: string[]; folder?: string }>();
  let nextHandle = 0;
  let requests = 0;
  let pending = Buffer.alloc(0);

  const resolve = (name: string) => path.resolve(options.home, name);
  const send = (type: number, ...parts: Buffer[]) => {
    const body = Buffer.concat([Buffer.from([type]), ...parts]);
    child.stdout.write(Buffer.concat([u32(body.length), body]));
  };
  const reply = (id: number, code: number, message = '') => send(101, u32(id), u32(code), string(message), string(''));

  if (options.refuse) {
    child.finish(options.refuse.code, options.refuse.stderr);
    return child;
  }
  if (options.banner) child.stdout.write(options.banner);

  child.stdin.on('data', (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);
      const packet = pending.subarray(4, 4 + length);
      pending = pending.subarray(4 + length);
      handle(packet);
    }
  });
  child.stdin.on('end', () => child.finish(0));

  function handle(packet: Buffer): void {
    if (child.closed) return;
    const type = packet[0];
    let at = 1;
    const readU32 = () => {
      at += 4;
      return packet.readUInt32BE(at - 4);
    };
    const readU64 = () => {
      at += 8;
      return Number(packet.readBigUInt64BE(at - 8));
    };
    const readBytes = () => {
      const n = readU32();
      at += n;
      return packet.subarray(at - n, at);
    };
    const readText = () => readBytes().toString();

    if (type === 1) {
      send(
        2,
        u32(3),
        ...extensions.flatMap(name => [string(name), string(name === 'statvfs@openssh.com' ? '2' : '1')]),
      );
      return;
    }

    if (options.dropAfter !== undefined && requests++ >= options.dropAfter) {
      child.finish(255, 'Connection reset by 192.0.2.1 port 22\n');
      return;
    }
    options.onRequest?.(type);

    const id = readU32();
    try {
      switch (type) {
        case 3: {
          const name = resolve(readText());
          const flags = readU32();
          let mode = 0;
          if (flags & 0x1 && !(flags & 0x2)) mode = fs.constants.O_RDONLY;
          else {
            mode = fs.constants.O_WRONLY;
            if (flags & 0x8) mode |= fs.constants.O_CREAT;
            if (flags & 0x10) mode |= fs.constants.O_TRUNC;
            if (flags & 0x20) mode |= fs.constants.O_EXCL;
          }
          const fd = fs.openSync(name, mode, 0o644);
          const key = String(nextHandle++);
          handles.set(key, { fd });
          send(102, u32(id), string(key));
          return;
        }
        case 4: {
          const key = readText();
          const open = handles.get(key);
          handles.delete(key);
          if (open?.fd !== undefined) fs.closeSync(open.fd);
          reply(id, open ? status.ok : status.failure);
          return;
        }
        case 5: {
          const open = handles.get(readText());
          const offset = readU64();
          const length = Math.min(readU32(), options.shortReads ?? Infinity);
          const buffer = Buffer.alloc(length);
          const n = fs.readSync(open!.fd!, buffer, 0, length, offset);
          if (!n) reply(id, status.eof, 'End of file');
          else send(103, u32(id), string(buffer.subarray(0, n)));
          return;
        }
        case 6: {
          const open = handles.get(readText());
          const offset = readU64();
          const data = readBytes();
          fs.writeSync(open!.fd!, data, 0, data.length, offset);
          reply(id, status.ok);
          return;
        }
        case 7:
        case 17: {
          const name = resolve(readText());
          send(105, u32(id), attrs(type === 7 ? fs.lstatSync(name) : fs.statSync(name)));
          return;
        }
        case 8: {
          send(105, u32(id), attrs(fs.fstatSync(handles.get(readText())!.fd!)));
          return;
        }
        case 11: {
          const folder = resolve(readText());
          const entries = ['.', '..', ...fs.readdirSync(folder)];
          const key = String(nextHandle++);
          handles.set(key, { entries, folder });
          send(102, u32(id), string(key));
          return;
        }
        case 12: {
          // Three names per reply, so listings take several requests.
          const open = handles.get(readText())!;
          const batch = open.entries!.splice(0, 3);
          if (!batch.length) {
            reply(id, status.eof, 'End of file');
            return;
          }
          send(
            104,
            u32(id),
            u32(batch.length),
            ...batch.flatMap(name => {
              const info = fs.lstatSync(path.join(open.folder!, name));
              return [
                string(name),
                string((info.isDirectory() ? 'd' : '-') + 'rw-r--r-- 1 me me ' + name),
                attrs(info),
              ];
            }),
          );
          return;
        }
        case 13: {
          fs.unlinkSync(resolve(readText()));
          reply(id, status.ok);
          return;
        }
        case 14: {
          fs.mkdirSync(resolve(readText()));
          reply(id, status.ok);
          return;
        }
        case 18: {
          // OpenSSH links the new name and removes the old one, so an existing target fails.
          const from = resolve(readText());
          const to = resolve(readText());
          fs.linkSync(from, to);
          fs.unlinkSync(from);
          reply(id, status.ok);
          return;
        }
        case 200: {
          const name = readText();
          if (!extensions.includes(name)) {
            reply(id, status.opUnsupported, 'Unsupported');
            return;
          }
          if (name === 'posix-rename@openssh.com') {
            fs.renameSync(resolve(readText()), resolve(readText()));
            reply(id, status.ok);
          } else if (name === 'hardlink@openssh.com') {
            const from = resolve(readText());
            const to = resolve(readText());
            if (options.hardlinkStatus !== undefined) {
              reply(id, options.hardlinkStatus, 'Failure');
              return;
            }
            fs.linkSync(from, to);
            reply(id, status.ok);
          } else if (name === 'fsync@openssh.com') {
            fs.fsyncSync(handles.get(readText())!.fd!);
            reply(id, status.ok);
          } else if (name === 'statvfs@openssh.com') {
            fs.statSync(resolve(readText()));
            const v = options.statvfs ?? { size: 4096, blocks: 1000, free: 600, available: 500, flags: 0 };
            send(
              201,
              u32(id),
              u64(v.size),
              u64(v.size),
              u64(v.blocks),
              u64(v.free),
              u64(v.available),
              u64(0),
              u64(0),
              u64(0),
              u64(0xffffffffffffffffn),
              u64(v.flags),
              u64(255),
            );
          } else if (name === 'limits@openssh.com') {
            send(201, u32(id), u64(256 * 1024), u64(255 * 1024), u64(255 * 1024), u64(0));
          }
          return;
        }
        default:
          reply(id, status.opUnsupported, 'Unsupported');
      }
    } catch (error) {
      reply(id, errno(error), (error as Error).message);
    }
  }

  return child;
}
