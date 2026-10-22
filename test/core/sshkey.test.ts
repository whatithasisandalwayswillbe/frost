// Tests for Frost's own SSH key: the OpenSSH file format, reuse, repair of the public copy, and the command
// that adds the key to a server.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  authorizedLine,
  decodePrivate,
  encodePrivate,
  ensureKey,
  installArgs,
  installScript,
  publicLine,
} from '../../src/core/sshkey.js';
import { ownerOnlyFolder } from '../../src/platform/acl.js';
import type { Runner } from '../../src/platform/command.js';

async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frost-sshkey-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Pulls the private seed out of a key file by its fixed layout, independently of decodePrivate.
function seedOf(text: string): Buffer {
  const body = Buffer.from(text.split('\n').slice(1, -2).join(''), 'base64');
  let at = 15;
  const read = () => {
    const n = body.readUInt32BE(at);
    at += 4 + n;
    return body.subarray(at - n, at);
  };
  read();
  read();
  read();
  at += 4;
  read();
  const secret = read();
  let i = 8;
  const inner = () => {
    const n = secret.readUInt32BE(i);
    i += 4 + n;
    return secret.subarray(i - n, i);
  };
  inner();
  inner();
  return Buffer.from(inner().subarray(0, 32));
}

test('Frost SSH key is a working ed25519 pair in OpenSSH format, reused and repaired', async t => {
  const dir = await folder(t);
  const file = path.join(dir, 'ssh', 'frost_ed25519');
  const line = await ensureKey(file);
  assert.match(line, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} frost@[A-Za-z0-9._-]+$/);
  assert.equal(readFileSync(file + '.pub', 'utf8'), line + '\n');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  }

  // The seed and the public key in the file are one key pair.
  const text = readFileSync(file, 'utf8');
  assert.match(
    text,
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=]{1,70}\n)+-----END OPENSSH PRIVATE KEY-----\n$/,
  );
  const { publicKey, comment } = decodePrivate(text);
  const x = publicKey.toString('base64url');
  const key = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: seedOf(text).toString('base64url'), x },
    format: 'jwk',
  });
  const signature = sign(null, Buffer.from('frost'), key);
  assert.ok(
    verify(
      null,
      Buffer.from('frost'),
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }),
      signature,
    ),
  );
  assert.equal(publicLine(publicKey, comment), line);

  assert.equal(await ensureKey(file), line);
  unlinkSync(file + '.pub');
  assert.equal(await ensureKey(file), line);
  writeFileSync(file + '.pub', 'damaged');
  assert.equal(await ensureKey(file), line);
  assert.equal(readFileSync(file, 'utf8'), text);

  writeFileSync(file, '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
  await assert.rejects(ensureKey(file), /can't use Frost's SSH key at .*unencrypted ed25519 key in OpenSSH format/);
  assert.equal(authorizedLine(line), 'restrict ' + line);
});

test('encoded keys pad their secret section and decode back', () => {
  for (const note of ['', 'a', 'frost@a-much-longer-computer-name.local']) {
    const text = encodePrivate(Buffer.alloc(32, 7), Buffer.alloc(32, 9), note);
    assert.deepEqual(decodePrivate(text), { publicKey: Buffer.alloc(32, 9), comment: note });
  }
  assert.throws(() => decodePrivate('not a key'), /OpenSSH format/);
});

// ssh-keygen prints the public key of a private key file it accepts. On Windows it also refuses a key file
// other accounts can read.
const keygen =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')
    : '/usr/bin/ssh-keygen';

test('OpenSSH reads Frost SSH key', { skip: !existsSync(keygen) }, async t => {
  const dir = await folder(t);
  const file = path.join(dir, 'ssh', 'frost_ed25519');
  const line = await ensureKey(file);
  const result = spawnSync(keygen, ['-y', '-f', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), line);
});

test(
  'the key install command adds the line once and keeps other keys',
  { skip: process.platform === 'win32' },
  async t => {
    const home = await folder(t);
    const run = (line: string) => {
      const result = spawnSync('sh', ['-c', installScript], { cwd: home, input: line + '\n', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    run('ssh-ed25519 AAAAother other@laptop');
    run('restrict ssh-ed25519 AAAAfrost frost@laptop');
    run('restrict ssh-ed25519 AAAAfrost frost@laptop');
    assert.equal(
      readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'),
      'ssh-ed25519 AAAAother other@laptop\nrestrict ssh-ed25519 AAAAfrost frost@laptop\n',
    );
    assert.equal(statSync(path.join(home, '.ssh')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(home, '.ssh', 'authorized_keys')).mode & 0o777, 0o600);

    assert.deepEqual(installArgs('me@nas', 0), ['-T', '-o', 'LogLevel=ERROR', '--', 'me@nas', installScript]);
    assert.deepEqual(installArgs('me@nas', 2222), [
      '-T',
      '-o',
      'LogLevel=ERROR',
      '-p',
      '2222',
      '--',
      'me@nas',
      installScript,
    ]);
  },
);

test('Windows key folders get permissions for the current account only', async () => {
  const calls: string[][] = [];
  const runner: Runner = async (program, args) => {
    const name = program.split(/[\\/]/).pop()!;
    calls.push([name, ...args]);
    return { code: 0, stdout: name === 'whoami.exe' ? '"pc\\me","S-1-5-21-1-2-3-1001"\r\n' : '', stderr: '' };
  };
  const folder = 'C:\\Users\\me\\AppData\\Roaming\\frost\\ssh';
  await ownerOnlyFolder(folder, runner, 'win32');
  assert.deepEqual(calls, [
    ['whoami.exe', '/user', '/fo', 'csv', '/nh'],
    ['icacls.exe', folder, '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F', '/q'],
  ]);
  calls.length = 0;
  await ownerOnlyFolder('/home/me/.config/frost/ssh', runner, 'linux');
  assert.deepEqual(calls, []);
  await assert.rejects(
    ownerOnlyFolder(folder, async () => ({ code: 0, stdout: 'nothing', stderr: '' }), 'win32'),
    /security ID/,
  );
});
