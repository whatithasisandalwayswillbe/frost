// Tests for the SFTP backend against the reference server in sftp-server.ts, and against OpenSSH's own
// sftp-server binary when the machine has one. Neither starts ssh or touches the network.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SFTPBackend, SSHError, classify, type SFTPConfig, type SSHSpawn } from '../../src/core/sftp.js';
import { MissingRootError, errExists, errNotFound, maxChunkSize } from '../../src/core/storage.js';
import { allExtensions, serve, type FakeSSH, type ServerOptions } from './sftp-server.js';
import { conformance } from '../support.js';

// A private home folder on the "server", a key file for the access check, and a backend whose every ssh
// start is a fresh reference server. `spawns` records the program and arguments of each start.
async function setup(t: TestContext, server: Partial<ServerOptions> = {}, config: Partial<SFTPConfig> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'frost-sftp-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const identity = path.join(home, 'frost_ed25519');
  writeFileSync(identity, 'key');
  mkdirSync(path.join(home, 'backups'));
  const spawns: { program: string; args: string[]; child: FakeSSH }[] = [];
  const spawnFake: SSHSpawn = (program, args) => {
    const child = serve({ home, ...server });
    spawns.push({ program, args, child });
    return child;
  };
  const backend = new SFTPBackend(
    { host: 'me@nas.local', port: 0, path: 'backups/frost', ...config },
    { identity, spawn: spawnFake, program: 'ssh', pause: async () => {} },
  );
  t.after(() => backend.close());
  return { home, root: path.join(home, 'backups', 'frost'), identity, backend, spawns };
}

// Every file under a folder, as relative paths with forward slashes.
function files(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

test('SFTP backend passes the storage contract and leaves no temporary files', async t => {
  const { backend, root } = await setup(t);
  await backend.prepare();
  await conformance(backend);
  assert.deepEqual(files(root), ['chunks/ab/ab01', 'chunks/cd/cd01', 'snapshots/one']);
  assert.equal((await backend.get('snapshots/one')).toString(), 'encrypted bytes\0\x01\x02');
});

test('SFTP backend runs ssh with frost key, no prompts and the host after --', async t => {
  const { backend, spawns, identity } = await setup(t, {}, { port: 2222 });
  await backend.prepare();
  assert.equal(spawns[0].program, 'ssh');
  assert.deepEqual(spawns[0].args, [
    '-T',
    '-x',
    '-a',
    '-i',
    identity,
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
    'StrictHostKeyChecking=yes',
    '-p',
    '2222',
    '-s',
    '--',
    'me@nas.local',
    'sftp',
  ]);
  backend.acceptNewHostKey = true;
  assert.ok(backend.args().join(' ').includes('-o StrictHostKeyChecking=accept-new -p 2222 -s --'));
});

test('SFTP settings refuse option-like hosts and name the location', () => {
  const options = { identity: 'key' };
  for (const host of ['', '-oProxyCommand=sh', 'me@nas;rm', 'me nas', 'nas\nrm'])
    assert.throws(
      () => new SFTPBackend({ host, port: 0, path: 'frost' }, options),
      /sftp: (host is required|invalid host)/,
    );
  assert.throws(() => new SFTPBackend({ host: 'nas', port: 70000, path: 'frost' }, options), /port/);
  assert.throws(() => new SFTPBackend({ host: 'nas', port: 0, path: '  ' }, options), /path is required/);
  assert.throws(() => new SFTPBackend({ host: 'nas', port: 0, path: '~' }, options), /path is required/);

  const name = (config: SFTPConfig) => String(new SFTPBackend(config, options));
  assert.equal(name({ host: 'me@nas', port: 0, path: 'frost' }), 'sftp://me@nas/~/frost');
  assert.equal(name({ host: 'me@nas', port: 0, path: '~/backups/frost/' }), 'sftp://me@nas/~/backups/frost');
  assert.equal(name({ host: 'me@nas', port: 2222, path: '/srv/frost' }), 'sftp://me@nas:2222/srv/frost');
  assert.equal(name({ host: 'me@fe80::1', port: 0, path: '/srv\\frost' }), 'sftp://me@[fe80::1]/srv/frost');
  assert.equal(new SFTPBackend({ host: 'nas', port: 0, path: '/' }, options).location(), 'sftp://nas/');
});

test('SFTP backend never creates a missing folder except through prepare', async t => {
  const { backend, home, root } = await setup(t);
  await assert.rejects(backend.get('frost.repo'), MissingRootError);
  await assert.rejects(backend.list('snapshots/'), MissingRootError);
  await assert.rejects(backend.list(''), MissingRootError);
  await assert.rejects(backend.put('chunks/ab/ab01', Buffer.from('x')), MissingRootError);
  await assert.rejects(backend.putNew('frost.repo', Buffer.from('x')), MissingRootError);
  assert.equal(existsSync(root), false);

  // prepare makes only the last folder, and only below an existing parent.
  const deep = new SFTPBackend(
    { host: 'nas', port: 0, path: 'missing/frost' },
    { identity: path.join(home, 'frost_ed25519'), spawn: () => serve({ home }), pause: async () => {} },
  );
  t.after(() => deep.close());
  await assert.rejects(
    deep.prepare(),
    (e: Error) => e instanceof MissingRootError && /no folder missing on nas/.test(e.message),
  );
  assert.equal(existsSync(path.join(home, 'missing')), false);

  await backend.prepare();
  await backend.prepare();
  assert.ok(statSync(root).isDirectory());
  await assert.rejects(backend.get('frost.repo'), error => error === errNotFound);
  assert.deepEqual(await backend.list(''), []);
});

test('SFTP conditional creates need hard links and fail closed without them', async t => {
  const missing = await setup(t, { extensions: allExtensions.filter(e => e !== 'hardlink@openssh.com') });
  await missing.backend.prepare();
  await assert.rejects(missing.backend.putNew('frost.repo', Buffer.from('x')), /can't make hard links over SFTP/);
  assert.deepEqual(files(missing.root), []);

  const unsupported = await setup(t, { hardlinkStatus: 4 });
  await unsupported.backend.prepare();
  await assert.rejects(unsupported.backend.putNew('frost.repo', Buffer.from('x')), /filesystem with hard links/);
  assert.deepEqual(files(unsupported.root), []);

  // A failed link where the key exists is an ordinary errExists.
  const exists = await setup(t);
  await exists.backend.prepare();
  await exists.backend.putNew('trees/one', Buffer.from('first'));
  await assert.rejects(exists.backend.putNew('trees/one', Buffer.from('second')), error => error === errExists);
  assert.deepEqual(files(exists.root), ['trees/one']);
});

test('SFTP replaces objects with plain RENAME when posix-rename is missing', async t => {
  const { backend, root } = await setup(t, { extensions: ['hardlink@openssh.com'] });
  await backend.prepare();
  await backend.put('chunks/ab/ab01', Buffer.from('first'));
  await backend.put('chunks/ab/ab01', Buffer.from('second'));
  assert.equal((await backend.get('chunks/ab/ab01')).toString(), 'second');
  assert.deepEqual(files(root), ['chunks/ab/ab01']);
});

test('SFTP reads large objects through short reads into a fresh exact buffer', async t => {
  const { backend } = await setup(t, { shortReads: 10_000 });
  await backend.prepare();
  const data = randomBytes(3 * 255 * 1024 + 17);
  await backend.put('chunks/aa/big', data);
  const owned = await backend.getOwned('chunks/aa/big');
  assert.ok(owned.equals(data));
  assert.equal(owned.byteOffset, 0);
  assert.equal(owned.buffer.byteLength, data.length);
});

test('SFTP refuses objects over the size limits before reading them', async t => {
  const { backend, root } = await setup(t);
  await backend.prepare();
  mkdirSync(path.join(root, 'chunks', 'aa'), { recursive: true });
  writeFileSync(path.join(root, 'chunks', 'aa', 'huge'), '');
  truncateSync(path.join(root, 'chunks', 'aa', 'huge'), maxChunkSize + 1);
  await assert.rejects(backend.get('chunks/aa/huge'), /storage response exceeds size limit/);
});

test('SFTP listings skip temporary files, symlinks, folders and invalid names', async t => {
  const { backend, root } = await setup(t);
  await backend.prepare();
  await backend.put('snapshots/one', Buffer.from('x'));
  writeFileSync(path.join(root, 'snapshots', '~one.0123456789abcdef'), 'partial');
  writeFileSync(path.join(root, 'snapshots', 'Upper'), 'x');
  mkdirSync(path.join(root, 'snapshots', 'folder'));
  try {
    symlinkSync(path.join(root, 'snapshots', 'one'), path.join(root, 'snapshots', 'link'));
  } catch {
    /* Creating symlinks needs a privilege on Windows. */
  }
  assert.deepEqual(await backend.list('snapshots/'), ['snapshots/one']);
  assert.deepEqual(await backend.list('snap'), ['snapshots/one']);
  assert.deepEqual(await backend.list('snapshots/o'), ['snapshots/one']);
  assert.deepEqual(await backend.list('chunks/'), []);
  await assert.rejects(backend.list('Snapshots/'), /invalid list prefix/);
  await assert.rejects(backend.get('../escape'), /invalid object key/);
});

test('SFTP retries a dropped connection on a new session, up to four attempts', async t => {
  const healthy = await setup(t);
  await healthy.backend.prepare();
  let starts = 0;
  const flaky = new SFTPBackend(
    { host: 'nas', port: 0, path: 'backups/frost' },
    {
      identity: healthy.identity,
      spawn: () => serve({ home: healthy.home, dropAfter: starts++ < 2 ? 0 : undefined }),
      pause: async () => {},
    },
  );
  t.after(() => flaky.close());
  await flaky.put('chunks/ab/ab01', Buffer.from('saved'));
  assert.equal(starts, 3);
  assert.equal((await healthy.backend.get('chunks/ab/ab01')).toString(), 'saved');

  const broken = await setup(t, { dropAfter: 0 });
  await assert.rejects(
    broken.backend.get('frost.repo'),
    (e: SSHError) => e instanceof SSHError && e.problem === 'transport' && e.code === 'ECONNRESET',
  );
  assert.equal(broken.spawns.length, 4);
});

test('SFTP reports why ssh stopped and only retries network trouble', async t => {
  const cases: [string, string, string | undefined, RegExp][] = [
    ['me@nas: Permission denied (publickey,password).', 'login', undefined, /didn't accept frost's SSH key/],
    [
      'No ED25519 host key is known for nas and you have requested strict checking.\nHost key verification failed.',
      'unknownhost',
      undefined,
      /known SSH hosts/,
    ],
    [
      '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.',
      'hostkey',
      undefined,
      /ssh-keygen -R nas/,
    ],
    ['subsystem request failed on channel 0', 'nosftp', undefined, /doesn't offer SFTP/],
  ];
  for (const [stderr, problem, code, message] of cases) {
    const { backend, spawns } = await setup(t, { refuse: { stderr, code: 255 } });
    await assert.rejects(
      backend.get('frost.repo'),
      (e: SSHError) => e instanceof SSHError && e.problem === problem && e.code === code && message.test(e.message),
    );
    assert.equal(spawns.length, 1, problem);
  }

  const offline = await setup(t, {
    refuse: { stderr: 'ssh: Could not resolve hostname nas: Name or service not known', code: 255 },
  });
  await assert.rejects(offline.backend.get('frost.repo'), (e: SSHError) => e.code === 'ENOTFOUND');
  assert.equal(offline.spawns.length, 4);

  for (const [text, code] of [
    ['ssh: connect to host nas port 22: Connection refused', 'ECONNREFUSED'],
    ['ssh: connect to host nas port 22: Operation timed out', 'ETIMEDOUT'],
    ['ssh: connect to host nas port 22: No route to host', 'EHOSTUNREACH'],
    ['ssh: connect to host nas port 22: Network is unreachable', 'ENETUNREACH'],
  ])
    assert.equal(classify(text, 255, 'nas').code, code);
  assert.match(classify('something odd', 1, 'nas').message, /ssh stopped with code 1: something odd/);
});

test('SFTP explains garbled output, a missing ssh client and a missing key', async t => {
  const garbled = await setup(t, { banner: 'Welcome to my NAS! Have a nice day.\n' });
  await assert.rejects(
    garbled.backend.get('frost.repo'),
    (e: SSHError) => e.problem === 'garbled' && /login script/.test(e.message),
  );

  const { home, identity } = await setup(t);
  const noClient = new SFTPBackend(
    { host: 'nas', port: 0, path: 'frost' },
    { identity, program: path.join(home, 'no-such-ssh'), pause: async () => {} },
  );
  await assert.rejects(noClient.get('frost.repo'), (e: SSHError) => e.problem === 'noclient');

  let spawned = false;
  const noKey = new SFTPBackend(
    { host: 'nas', port: 0, path: 'frost' },
    {
      identity: path.join(home, 'missing_key'),
      spawn: () => {
        spawned = true;
        return serve({ home });
      },
    },
  );
  await assert.rejects(noKey.get('frost.repo'), (e: SSHError) => e.problem === 'nokey' && /frost init/.test(e.message));
  assert.equal(spawned, false);
});

test('SFTP aborts stop waiting while the session stays usable', async t => {
  const { backend, spawns } = await setup(t);
  await backend.prepare();
  await backend.put('chunks/ab/ab01', Buffer.from('kept'));
  const controller = new AbortController();
  const waiting = backend.get('chunks/ab/ab01', controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(waiting, /stop/);
  await assert.rejects(backend.get('chunks/ab/ab01', controller.signal), /stop/);
  assert.equal((await backend.get('chunks/ab/ab01')).toString(), 'kept');
  assert.equal(spawns.length, 1);
});

test('SFTP reports disk space from statvfs and lets idle sessions go', async t => {
  const { backend, spawns } = await setup(t);
  await backend.prepare();
  assert.deepEqual(await backend.usage(), { used: 400 * 4096, quota: 1000 * 4096, readOnly: false, message: '' });
  assert.equal(spawns[0].child.holds.at(-1), false);

  const full = await setup(t, { statvfs: { size: 1024, blocks: 1000, free: 30, available: 20, flags: 0 } });
  await full.backend.prepare();
  assert.equal((await full.backend.usage()).message, "the server's disk is nearly full");
  const readOnly = await setup(t, { statvfs: { size: 1024, blocks: 1000, free: 900, available: 900, flags: 1 } });
  await readOnly.backend.prepare();
  assert.deepEqual(await readOnly.backend.usage(), {
    used: 100 * 1024,
    quota: 1000 * 1024,
    readOnly: true,
    message: "the server's disk is read-only",
  });

  await backend.close();
  assert.equal(spawns[0].child.closed, true);
});

// OpenSSH's sftp-server speaks SFTP on its standard input and output, so it can run without ssh.
// FROST_TEST_SFTP_SERVER points at one elsewhere, like a copy unpacked without installing it.
const sftpServer = [
  process.env.FROST_TEST_SFTP_SERVER ?? '',
  ...(process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'sftp-server.exe')]
    : ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/libexec/sftp-server']),
].find(file => file && existsSync(file));

test('SFTP backend passes the storage contract against OpenSSH sftp-server', { skip: !sftpServer }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'frost-sftp-openssh-'));
  writeFileSync(path.join(home, 'key'), 'key');
  const backend = new SFTPBackend(
    { host: 'localhost', port: 0, path: path.join(home, 'frost') },
    {
      identity: path.join(home, 'key'),
      spawn: () => spawn(sftpServer!, ['-d', home], { stdio: ['pipe', 'pipe', 'pipe'] }),
      pause: async () => {},
    },
  );
  // The server process has to stop before Windows lets its folder go.
  t.after(async () => {
    await backend.close();
    await rm(home, { recursive: true, force: true });
  });
  await backend.prepare();
  await conformance(backend);
  assert.deepEqual(files(path.join(home, 'frost')), ['chunks/ab/ab01', 'chunks/cd/cd01', 'snapshots/one']);
  const usage = await backend.usage();
  assert.ok(usage.quota > 0 && usage.used >= 0);
  const data = randomBytes(1 << 20);
  await backend.put('chunks/ff/big', data);
  assert.ok((await backend.getOwned('chunks/ff/big')).equals(data));
});
