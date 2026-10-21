// Behaviour tests for the TUI: browser navigation, file selection, diffs, restores and folder pickers, text
// input, the setup wizard, the icebreaker game and the terminal loop.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserModel, dateLabel, type BrowserDeps } from '../../src/tui/browser.js';
import { FileTree } from '../../src/tui/tree.js';
import { RestoreError } from '../../src/engine/restore.js';
import { SetupModel, RepoState, ConnectError, type SetupDeps } from '../../src/tui/setup.js';
import {
  providers,
  matchProvider,
  describeStorage,
  splitAddress,
  joinAddress,
  checkAddress,
  checkDrivePath,
} from '../../src/tui/providers.js';
import { Form, inputText } from '../../src/tui/input.js';
import { InputDecoder, runTerminal } from '../../src/tui/terminal.js';
import { Arcade, Canvas } from '../../src/tui/arcade.js';
import { defaultConfig, type Snapshot, type Tree, type BrowserRepo } from '../../src/tui/types.js';
import { width, height, strip, shortPath, truncate, truncateLeft, humanBytes } from '../../src/tui/render.js';
import { cells } from './ansi.js';
import { PassThrough } from 'node:stream';

// A snapshot header with small fixed stats. Tests vary its id and time.
const snapshot = (id = 'birch-cable-0123456789', time = '2026-09-30T12:00:00Z'): Snapshot => ({
  id,
  time,
  host: 'host',
  paths: ['/data'],
  stats: { files: 3, dirs: 2, bytes: 12, new_chunks: 3, new_bytes: 12, uploaded_bytes: 12 },
});

// Two folders and three files under /data, 12 bytes in all.
const tree: Tree = {
  files: [
    { path: '/data', type: 'dir', mode: 0o755, mtime: '2026-09-30T12:00:00Z' },
    { path: '/data/docs', type: 'dir', mode: 0o755, mtime: '2026-09-30T12:00:00Z' },
    ...[
      ['/data/docs/a', 3],
      ['/data/b', 4],
      ['/data/Z', 5],
    ].map(([p, n]) => ({
      path: String(p),
      type: 'file' as const,
      mode: 0o644,
      mtime: '2026-09-30T12:00:00Z',
      size: Number(n),
    })),
  ],
};

// Desktop hooks that can't open, pick or play anything. New restore folders get a fixed name.
function dependencies(): BrowserDeps {
  return {
    canOpen: () => false,
    canPick: () => false,
    pickFolder: async () => {
      throw new Error('no picker in tests');
    },
    openFolder: async () => {
      throw new Error('no desktop in tests');
    },
    besideFolder: async () => ({ dir: '/restored', resume: false }),
    newRestoreFolder: async parent => ({ dir: path.join(parent, 'frost-restore-birch-cable-0123'), resume: false }),
    canOverwrite: async () => {},
    gameSound: undefined,
  };
}

// An 80x24 browser over a repository with one snapshot. Tests override repository methods or desktop hooks.
function browser(repo: Partial<BrowserRepo> = {}, deps: Partial<BrowserDeps> = {}): BrowserModel {
  const m = new BrowserModel(
    {
      label: 'memory',
      fingerprint: 'abcd1234abcd',
      snapshots: async () => [snapshot()],
      loadTree: async () => tree,
      restore: async () => ({ files: 3, bytes: 12 }),
      ...repo,
    },
    defaultConfig(),
    {},
    undefined,
    { ...dependencies(), ...deps },
  );
  m.resize(80, 24);
  return m;
}

test('Permafrost account access opens only from help for the default service', async () => {
  const opened: string[] = [];
  const m = browser(
    {},
    {
      canOpen: () => true,
      openBrowser: async url => {
        opened.push(url);
      },
    },
  );
  m.loading = '';
  m.cfg.storage.backend = 'permafrost';
  await m.onKey('p');
  assert.deepEqual(opened, []);
  await m.onKey('h');
  assert.match(strip(m.helpContent(76)), /\[p\] Permafrost account/);
  await m.onKey('p');
  assert.deepEqual(opened, ['https://getfro.st/perma/portal']);
  assert.equal(m.overlay, 'help');
  for (const [backend, url] of [
    ['permafrost', 'https://private.example'],
    ['s3', ''],
  ]) {
    m.cfg.storage.backend = backend;
    m.cfg.storage.permafrost.url = url;
    assert.ok(!strip(m.helpContent(76)).includes('Permafrost account'));
    await m.onKey('p');
  }
  assert.equal(opened.length, 1);
  m.cfg.storage.backend = 'permafrost';
  m.cfg.storage.permafrost.url = '';
  m.deps.canOpen = () => false;
  await m.onKey('p');
  assert.equal(opened.length, 1);
  assert.match(m.err!.message, /Open https:\/\/getfro.st\/perma\/portal in a web browser/);
  m.err = undefined;
  m.deps.canOpen = () => true;
  m.deps.openBrowser = async () => {
    throw new Error('unavailable');
  };
  await m.onKey('p');
  assert.match(m.err!.message, /Open https:\/\/getfro.st\/perma\/portal in a web browser/);
  m.err = undefined;
  for (const w of [1, 20, 40, 76]) {
    m.resize(w, 24);
    assert.equal(width(m.view()), w);
    assert.equal(height(m.view()), 24);
  }
  m.close();
});

// A key whose phrase is word0 to word23, so tests can type single words.
const key = {
  phrase: () => Array.from({ length: 24 }, (_, i) => 'word' + i).join(' '),
  fingerprint: () => 'abcd1234abcd',
};

// Setup dependencies for a new repository. The phrase check asks for word2 and word17.
function setupDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    connect: async () => RepoState.New,
    newKey: () => key,
    unlock: async () => key,
    finish: async () => [],
    pickWords: () => [2, 17],
    ...overrides,
  };
}

// A private temporary folder, removed when the test ends.
async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'frost-tui-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Waits a turn of the event loop, so callbacks from settled promises run before the next check.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('snapshot navigation sorts equal times, clamps empty cursors, and reuses known headers', async () => {
  // All three snapshots have the same time, and one has no id. The browser drops that one and sorts the rest by id.
  let seen: unknown;
  const m = browser({
    snapshots: async known => {
      seen = known;
      return [snapshot('z'), snapshot('a'), { ...snapshot(''), id: '' }];
    },
  });
  await m.init();
  assert.deepEqual(
    m.snaps.map(s => s.id),
    ['a', 'z'],
  );

  // A reload hands the repository the headers the browser already knows.
  const known = m.st.known;
  await m.loadSnaps();
  assert.equal(seen, known);

  // b opens the snapshot list, and m marks or unmarks the snapshot under the cursor.
  await m.onKey('b');
  await m.onKey('end');
  assert.equal(m.snapCur, 1);
  await m.onKey('m');
  assert.equal(m.marked, 'z');
  await m.onKey('m');
  assert.equal(m.marked, '');

  // With no snapshots, every movement key leaves the cursor at the top.
  m.snaps = [];
  for (const k of ['down', 'pgdown', 'end', 'up', 'pgup', 'home']) {
    await m.onKey(k);
    assert.equal(m.snapCur, 0);
  }

  assert.equal(m.animation(), undefined);
  m.loading = 'Refreshing';
  assert.equal(m.animation(), 'spinner');
  m.close();
  assert.equal(m.signal!.aborted, true);
});

test('icebreaker uses the configured cache directory', () => {
  const before = process.env.FROST_CACHE_DIR;
  process.env.FROST_CACHE_DIR = path.join(os.tmpdir(), 'frost-private-cache');
  try {
    assert.equal(browser().bestPath, path.join(process.env.FROST_CACHE_DIR, 'icebreaker.json'));
  } finally {
    if (before === undefined) delete process.env.FROST_CACHE_DIR;
    else process.env.FROST_CACHE_DIR = before;
  }
});

test('file tree order and indexed totals handle root files and parent selections', () => {
  // Folders sort first, then names ignoring case. A file inside a selected folder isn't counted twice.
  const t = new FileTree(snapshot(), tree);
  assert.deepEqual(t.children.get('/data'), ['/data/docs', '/data/b', '/data/Z']);
  assert.deepEqual(t.selectionTotals(new Set(['/data/docs', '/data/docs/a'])), { files: 1, bytes: 3 });
  assert.deepEqual(t.selectionTotals(new Set(['/data'])), { files: 3, bytes: 12 });
  assert.equal(t.totals.size, 2);

  // A snapshot whose only root is a file has no folder totals.
  const root = new FileTree({ ...snapshot(), paths: ['/data/b'] }, { files: [tree.files[3]] });
  assert.deepEqual(root.selectionTotals(new Set(['/data/b'])), { files: 1, bytes: 4 });
  assert.equal(root.totals.size, 0);
});

test('file selection replaces children, keeps counts, remembers cursors, and refuses covered children', async () => {
  const m = browser();
  await m.init();
  await m.loadTree(m.snaps[0]);

  // Selecting a folder replaces the selected file inside it.
  m.selectPath('/data/docs/a');
  m.selectPath('/data/docs');
  assert.deepEqual([...m.sel], ['/data/docs']);
  m.countSel();
  assert.equal(m.selBytes, 3);

  // Inside the selected folder, its children can't be toggled on their own.
  await m.onKey('enter');
  assert.equal(m.dir, '/data/docs');
  await m.onKey(' ');
  assert.match(m.flash, /already selected/);

  // Going back up puts the cursor on the folder just left.
  await m.onKey('left');
  assert.equal(m.fileCur, 0);

  // c clears the selection and a toggles everything.
  await m.onKey('c');
  await m.onKey('a');
  assert.equal(m.selFiles, 3);
  await m.onKey('a');
  assert.equal(m.selFiles, 0);

  await m.onKey('end');
  await m.onKey(' ');
  assert.deepEqual([...m.sel], ['/data/Z']);
  assert.equal(m.fileCur, 2);
});

test('diff overlaps tree reads and puts the older snapshot first', async () => {
  // Both tree reads wait on one gate, so the test can see that they start together.
  const started: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => (release = resolve));
  const m = browser({
    loadTree: async id => {
      started.push(id);
      await ready;
      return { files: [{ ...tree.files[3], size: id === 'old' ? 4 : 8 }] };
    },
  });
  const work = m.loadDiff(snapshot('new', '2026-10-01T00:00:00Z'), snapshot('old'));
  assert.deepEqual(started, ['old', 'new']);

  release();
  await work;
  assert.equal(m.diffFrom!.id, 'old');
  assert.equal(m.diffMod, 1);

  // Growing the window clamps the scroll position back into range.
  m.diffTop = 999;
  m.resize(250, 120);
  assert.equal(m.diffTop, 0);
});

test('restore requires y for overwrite and preserves partial results on failure', async () => {
  let restores = 0,
    opened = 0;
  const partial = { files: 1, dirs: 1, bytes: 3, unfinished: true };
  const m = browser(
    {
      restore: async () => {
        restores++;
        throw new RestoreError(new Error('missing chunk'), partial);
      },
    },
    {
      canOpen: () => true,
      openFolder: async () => {
        opened++;
      },
    },
  );
  await m.init();
  await m.loadTree(m.snaps[0]);

  // Destination 2 overwrites the originals, so enter only asks for [y].
  await m.onKey('r');
  m.rs.dest = 2;
  await m.onKey('enter');
  assert.equal(restores, 0);
  assert.match(m.flash, /\[y\]/);

  // The restore fails partway. Its partial counts are kept and the folder isn't opened.
  await m.onKey('y');
  assert.equal(restores, 1);
  assert.equal(opened, 0);
  assert.equal(m.rs.phase, 'done');
  assert.deepEqual(m.rs.res, partial);
  assert.match(strip(m.view()), /missing chunk/);
});

test('restore checks a taken folder again, opens only successful files, and closes ongoing work', async () => {
  let opened = '';
  const m = browser(
    {},
    {
      canOpen: () => true,
      openFolder: async p => {
        opened = p;
        throw new Error('no file manager');
      },
    },
  );
  await m.init();
  await m.loadTree(m.snaps[0]);

  // The folder shown no longer matches the one newRestoreFolder returns, so the first enter only updates it.
  await m.onKey('r');
  m.rs.beside = '/old';
  await m.onKey('enter');
  assert.equal(m.rs.phase, 'confirm');
  assert.match(m.flash, /Review the new path/);

  // The restore succeeds, and a failure to open the folder only shows as a flash.
  await m.onKey('enter');
  assert.equal(m.rs.phase, 'done');
  assert.ok(opened);
  assert.match(m.flash, /no file manager/);

  // Closing during a restore records that it stopped. A later close doesn't clear that.
  m.rs.phase = 'running';
  m.close();
  assert.equal(m.stoppedRestore, true);
  assert.equal(m.signal!.aborted, true);
  m.rs.phase = 'done';
  m.close();
  assert.equal(m.stoppedRestore, true);
});

test('canceled and stale picker completions cannot change restore state', async t => {
  // The picker stays open until the test calls complete.
  const dir = await temp(t);
  let complete!: (p: string) => void, seen: AbortSignal | undefined;
  const m = browser(
    {},
    {
      canPick: () => true,
      pickFolder: async (_title, _start, signal) => {
        seen = signal;
        return new Promise(resolve => (complete = resolve));
      },
    },
  );
  await m.init();
  await m.loadTree(m.snaps[0]);
  await m.onKey('r');
  m.rs.dest = 1;
  await m.onKey('enter');
  assert.equal(m.rs.phase, 'picking');
  assert.match(strip(m.view()), /Select a restore location in the newly opened window\./);

  // Switching to typing cancels the picker, and its late answer is ignored.
  await m.onKey('t');
  assert.equal(seen!.aborted, true);
  complete(dir);
  await turn();
  assert.equal(m.rs.phase, 'typing');
  assert.equal(m.rs.picked, '');

  // While typing, q is text rather than quit.
  await m.onKey({ key: 'text', text: 'q' });
  assert.equal(m.exited, false);
  assert.equal(m.rs.input.values()[0], 'q');

  await m.onKey('ctrl+u');
  await m.onKey('enter');
  assert.equal(m.rs.inputErr, 'Enter the directory path to restore files into.');

  await m.onKey({ key: 'text', text: dir });
  await m.onKey('enter');
  assert.equal(m.rs.phase, 'ready');
  assert.equal(m.rs.picked, dir);
});

test('picker cancellation during destination validation cannot overwrite a typed destination', async t => {
  // The picker answers when the test calls complete, and checking its folder waits on the ready gate.
  const dir = await temp(t);
  let complete!: (p: string) => void, release!: () => void;
  const ready = new Promise<void>(resolve => (release = resolve));
  const m = browser(
    {},
    {
      canPick: () => true,
      pickFolder: async () => new Promise(resolve => (complete = resolve)),
      newRestoreFolder: async p => {
        await ready;
        return { dir: path.join(p, 'new'), resume: false };
      },
    },
  );
  await m.init();
  await m.loadTree(m.snaps[0]);
  await m.onKey('r');
  m.rs.dest = 1;
  await m.onKey('enter');
  complete(dir);
  await turn();

  // Switch to typing while the picked folder is still being checked, then let the check finish.
  await m.onKey('t');
  release();
  await turn();
  assert.equal(m.rs.phase, 'typing');
  assert.equal(m.rs.picked, '');
});

test('form edits Unicode, words, cursor positions, and pasted controls without global shortcuts', () => {
  const f = new Form([{ value: 'one two🙂' }]);
  f.key('home');
  f.key('ctrl+right');
  f.key('right');
  f.key('delete');
  assert.equal(f.values()[0], 'one wo🙂');
  f.key('end');
  f.key('backspace');
  assert.equal(f.values()[0], 'one wo');
  f.key('ctrl+w');
  assert.equal(f.values()[0], 'one');
  f.key({ key: 'text', text: 'q\nsecret\t\x1b' });
  assert.equal(f.values()[0], 'one q secret');

  // The cursor sits on x in a four-cell field. Only the emoji fits before it, because half a wide character can't
  // be drawn.
  f.fields[0] = { value: '你好🙂x', back: 1 };
  const input = inputText(f.fields[0], false, true, 4);
  assert.equal(width(input), 3);
  assert.equal(strip(input), '🙂x');

  // Truncation never overflows its width, even when a wide character doesn't fit.
  for (let w = 0; w < 8; w++) {
    assert.ok(width(truncate('中文🙂file', w)) <= w);
    assert.ok(width(truncateLeft('中文🙂file', w)) <= w);
    assert.ok(width(shortPath('/你好/🙂/file', w)) <= w);
  }
});

test('Unicode display widths match the current renderer across scripts and emoji presentation', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/tui/unicode-widths.fixture', import.meta.url), 'utf8'),
  ) as Record<string, number>;
  for (const [text, expected] of Object.entries(fixture)) assert.equal(width(text), expected, JSON.stringify(text));
});

test('TUI byte boundaries and padded years match the recorded formatter reference', () => {
  const reference = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/cli/format.json', import.meta.url), 'utf8'),
  ) as { bytes: { bytes: number; text: string }[]; times: { time: string; text: string }[] };
  for (const vector of reference.bytes) assert.equal(humanBytes(vector.bytes), vector.text, String(vector.bytes));

  // The recorded times are in UTC.
  const old = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    for (const vector of reference.times) {
      const [date, time] = vector.text.split(' '),
        year = date.slice(0, -6);
      assert.equal(dateLabel(vector.time), vector.text, vector.time);
      assert.equal(dateLabel(vector.time, 'date'), date);
      assert.equal(dateLabel(vector.time, 'time'), time);
      assert.equal(dateLabel(vector.time, 'second'), vector.text + ':00');
      assert.ok(dateLabel(vector.time, 'heading').endsWith(' ' + year));
    }
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});

test('input decoder joins split UTF-8, escape sequences, and bracketed paste', () => {
  // Input arrives in pieces, the way terminal reads can split it. Incomplete pieces wait for the rest.
  const d = new InputDecoder();
  const bytes = Buffer.from('🙂');
  assert.deepEqual(d.feed(bytes.subarray(0, 2)), []);
  assert.deepEqual(d.feed(bytes.subarray(2)), [{ key: '🙂', text: '🙂' }]);
  assert.deepEqual(d.feed('\x1b['), []);
  assert.deepEqual(d.feed('A\x1b[3~'), [
    { key: 'up', alt: false },
    { key: 'delete', alt: false },
  ]);

  // Bracketed paste arrives as one text event, even when its end marker is split.
  assert.deepEqual(d.feed('\x1b[200~pasted\n'), []);
  assert.deepEqual(d.feed('text\x1b[20'), []);
  assert.deepEqual(d.feed('1~'), [{ key: 'text', text: 'pasted\ntext' }]);

  // A lone escape could start a sequence, so it only becomes esc once the decoder is told to flush it.
  assert.deepEqual(d.feed('\x1b'), []);
  assert.deepEqual(d.flushEscape(), [{ key: 'esc' }]);
  assert.deepEqual(d.feed('\x03\x7f'), [{ key: 'ctrl+c' }, { key: 'backspace' }]);
});

test('setup resumes local keys, retries wrong phrases, keeps secrets covered, and focuses connect errors', async () => {
  const cfg = defaultConfig();
  cfg.storage.backend = 's3';
  Object.assign(cfg.storage.s3, {
    endpoint: 's3.us-west-004.backblazeb2.com',
    bucket: 'mine',
    region: 'us-west-004',
    access_key_id: 'id',
    secret_access_key: 'shh-secret',
  });

  // The local key opens the repository, so setup goes straight to review.
  const m = new SetupModel(setupDeps({ localKey: key, connect: async () => RepoState.LocalOK }), cfg, true);
  m.resize(80, 24);
  await m.onKey('enter');
  assert.equal(m.step, 'review');
  assert.equal(m.key, key);

  // Editing storage goes through the S3 list, with B2 highlighted, to its details without the secret.
  m.revCur = 0;
  await m.onKey('e');
  await m.onKey('enter');
  assert.equal(m.step, 's3Choice');
  assert.match(strip(m.view()), /\(•\) Backblaze B2/);
  await m.onKey('enter');
  assert.equal(m.step, 'details');
  assert.ok(!strip(m.view()).includes('shh-secret'));

  // A connection error about the bucket moves focus to the bucket field.
  m.deps.connect = async () => {
    throw new ConnectError('bucket', 'no bucket');
  };
  await m.connect(m.cfg.storage);
  assert.equal(m.details.focus, 1);
  assert.equal(m.err, 'no bucket');

  // The local key doesn't open the repository, so setup asks for the phrase until it's right.
  const n = new SetupModel(
    setupDeps({
      connect: async () => RepoState.LocalWrong,
      unlock: async (_s, phrase) => {
        if (phrase !== key.phrase()) throw new Error('wrong phrase');
        return key;
      },
    }),
    cfg,
    true,
  );
  n.resize(80, 24);
  await n.onKey('enter');
  assert.equal(n.step, 'unlock');

  await n.onKey({ key: 'text', text: 'one' });
  await n.onKey('enter');
  assert.match(n.err, /Entered 1 word; valid recovery phrases require 24 words\./);
  await n.onKey('ctrl+u');
  await n.onKey({ key: 'text', text: Array(24).fill('bad').join(' ') });
  await n.onKey('enter');
  assert.equal(n.err, 'wrong phrase');
  await n.onKey('ctrl+u');
  await n.onKey({ key: 'text', text: key.phrase() });
  await n.onKey('enter');
  assert.equal(n.step, 'review');
});

test('setup recognises S3 services only by endpoint host name, and other storage by backend', () => {
  const provider = (endpoint: string) => {
    const s = defaultConfig().storage;
    s.backend = 's3';
    s.s3.endpoint = endpoint;
    return providers[matchProvider(s)].name;
  };
  assert.equal(provider('s3.us-west-004.backblazeb2.com'), 'Backblaze B2');
  assert.equal(provider('https://S3.US-WEST-004.BACKBLAZEB2.COM:443/'), 'Backblaze B2');
  assert.equal(provider('s3.us-east-1.amazonaws.com'), 'Amazon S3');
  assert.equal(provider('0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'), 'Cloudflare R2');
  assert.equal(provider('http://s3.eu-central-1.wasabisys.com'), 'Wasabi');

  // A provider's domain elsewhere in the address leaves the endpoint as a generic S3 server.
  for (const endpoint of [
    'backblazeb2.com.example.net',
    'evilamazonaws.com',
    'https://minio.example.net/r2.cloudflarestorage.com',
    'wasabisys.com@minio.example.net',
    'not a host',
  ])
    assert.equal(provider(endpoint), 'Other S3-compatible', endpoint);

  // Self-hosted and local drive storage match by backend, and a backend setup doesn't know counts as Permafrost.
  const kind = (backend: string) => {
    const s = defaultConfig().storage;
    s.backend = backend;
    return providers[matchProvider(s)].name;
  };
  assert.equal(kind('sftp'), 'Self-hosted');
  assert.equal(kind('local'), 'Local drive');
  assert.equal(kind(''), 'Permafrost');
  assert.equal(kind('ftp'), 'Permafrost');
});

test('setup reads SSH addresses with ports, aliases and IPv6, and describes the new storage', () => {
  assert.deepEqual(splitAddress('me@nas.local'), { host: 'me@nas.local', port: 0 });
  assert.deepEqual(splitAddress('me@nas.local:2222'), { host: 'me@nas.local', port: 2222 });
  assert.deepEqual(splitAddress('backup-box'), { host: 'backup-box', port: 0 });
  assert.deepEqual(splitAddress('me@[fe80::1]:2222'), { host: 'me@fe80::1', port: 2222 });
  assert.deepEqual(splitAddress('fe80::1'), { host: 'fe80::1', port: 0 });
  assert.equal(joinAddress('me@nas.local', 2222), 'me@nas.local:2222');
  assert.equal(joinAddress('me@fe80::1', 2222), 'me@[fe80::1]:2222');
  assert.equal(joinAddress('nas', 0), 'nas');

  assert.equal(checkAddress('me@nas.local:2222'), '');
  assert.match(checkAddress('me nas'), /must not contain spaces/);
  assert.match(checkAddress('-oProxyCommand=sh'), /e\.g\., me@nas\.local/);
  assert.match(checkAddress('nas:70000'), /between 1 and 65535/);
  assert.match(checkAddress('nas:0'), /between 1 and 65535/);
  assert.match(checkDrivePath('relative/frost'), /absolute path/);
  assert.equal(checkDrivePath(path.join(os.tmpdir(), 'frost')), '');

  const s = defaultConfig().storage;
  s.backend = 'sftp';
  Object.assign(s.sftp, { host: 'me@nas.local', port: 2222, path: 'backups/frost' });
  assert.equal(describeStorage(s), 'Self-hosted, me@nas.local:2222, folder backups/frost');
  s.backend = 'local';
  s.local.path = '/Volumes/Backup/frost';
  assert.equal(describeStorage(s), 'Local drive, /Volumes/Backup/frost');

  // The drive path placeholder is in this system's style.
  const placeholder = providers[matchProvider(s)].fields[0].placeholder;
  assert.equal(
    placeholder,
    'like ' +
      (process.platform === 'win32'
        ? 'E:\\frost'
        : process.platform === 'darwin'
          ? '/Volumes/Backup/frost'
          : '/mnt/backup/frost'),
  );
});

test('setup groups S3 services in a second list and picks choices by number', async () => {
  const m = new SetupModel(setupDeps(), defaultConfig());
  m.resize(80, 24);
  await m.onKey('enter');
  assert.equal(m.step, 'storage');
  assert.deepEqual(
    strip(m.view())
      .split('\n')
      .filter(line => /\( \)|\(•\)/.test(line))
      .map(line => line.trim().replace(/\s{2,}/g, ' | ')),
    [
      '(•) Permafrost | recommended',
      '( ) S3-compatible | AWS, B2, R2, Wasabi, Ceph',
      '( ) Self-hosted | your server over SSH',
      '( ) Local drive | USB or internal disk',
    ],
  );
  await m.onKey('9');
  assert.equal(m.provCur, 0);
  await m.onKey('2');
  await m.onKey('enter');
  assert.equal(m.step, 's3Choice');
  await m.onKey('5');
  await m.onKey('enter');
  assert.equal(m.step, 'details');
  assert.equal(providers[m.prov].name, 'Other S3-compatible');

  // esc walks back through the S3 list to the storage list.
  await m.onKey('esc');
  assert.equal(m.step, 's3Choice');
  await m.onKey('esc');
  assert.equal(m.step, 'storage');
});

test('setup adds frost SSH key to a self-hosted server for you or by hand', async () => {
  // A server that refuses frost's key until it's added, or until a connection trusts a new host key after the key
  // was added by hand.
  const server = () => {
    const tried: { host: string; port: number; path: string; accept?: boolean }[] = [];
    const state = { added: 0, revealed: '' };
    const deps = setupDeps({
      connect: async (s, _signal, options) => {
        tried.push({ ...s.sftp, accept: options?.acceptNewHostKey });
        if (!state.added && !options?.acceptNewHostKey)
          throw new ConnectError('login', s.sftp.host + " didn't accept frost's SSH key.");
        return RepoState.New;
      },
      addKey: async () => {
        state.added++;
      },
      keyFile: () => '~/.config/frost/ssh/frost_ed25519.pub',
      reveal: file => {
        state.revealed = file;
      },
    });
    return { tried, state, deps };
  };
  const toKeyScreen = async (m: SetupModel) => {
    m.resize(80, 24);
    await m.onKey('enter');
    await m.onKey('3');
    await m.onKey('enter');
    await m.onKey({ key: 'text', text: 'me@nas.local:2222' });
    await m.onKey('enter');
    await m.onKey('enter');
  };

  // The address and folder questions, then the login refusal goes to the key screen, not an error on the form.
  const byHand = server();
  const m = new SetupModel(byHand.deps, defaultConfig());
  m.resize(80, 24);
  await m.onKey('enter');
  await m.onKey('3');
  await m.onKey('enter');
  assert.equal(m.step, 'details');
  assert.match(strip(m.view()), /Self-hosted {2}1 of 2[\s\S]*What is the server SSH address\?/);
  await m.onKey({ key: 'text', text: 'me@nas.local:2222' });
  await m.onKey('enter');
  assert.match(strip(m.view()), /Self-hosted {2}2 of 2[\s\S]*Which folder on the server\?[\s\S]*frost/);
  await m.onKey('enter');
  assert.deepEqual(byHand.tried[0], { host: 'me@nas.local', port: 2222, path: 'frost', accept: undefined });
  assert.equal(m.step, 'keyChoice');
  assert.equal(m.err, '');
  assert.match(strip(m.view()), /Add frost's SSH key to me@nas.local\./);

  // By hand: the key file is shown and can be revealed, and the next connection trusts a new host key.
  await m.onKey('down');
  await m.onKey('enter');
  assert.equal(m.step, 'keyManual');
  assert.match(strip(m.view()), /~\/\.config\/frost\/ssh\/frost_ed25519\.pub/);
  await m.onKey('o');
  assert.equal(byHand.state.revealed, '~/.config/frost/ssh/frost_ed25519.pub');
  await m.onKey('enter');
  assert.equal(byHand.tried.at(-1)!.accept, true);
  assert.equal(m.step, 'folders');
  assert.equal(m.cfg.storage.backend, 'sftp');

  // For you: ssh adds the key, then setup connects again, without trusting new host keys, and moves on.
  const forYou = server();
  const n = new SetupModel(forYou.deps, defaultConfig());
  await toKeyScreen(n);
  assert.equal(n.step, 'keyChoice');
  await n.onKey('enter');
  assert.equal(forYou.state.added, 1);
  assert.equal(forYou.tried.at(-1)!.accept, undefined);
  assert.equal(n.step, 'folders');

  // When ssh fails, the key screen says so. A key that still isn't accepted keeps the manual screen with the reason.
  const stuck = new SetupModel(
    setupDeps({
      connect: async () => {
        throw new ConnectError('login', "me@nas.local didn't accept frost's SSH key.");
      },
      addKey: async () => {
        throw new Error('ssh stopped with code 255');
      },
    }),
    defaultConfig(),
  );
  await toKeyScreen(stuck);
  await stuck.onKey('enter');
  assert.equal(stuck.step, 'keyChoice');
  assert.equal(stuck.err, "The key wasn't added: ssh stopped with code 255.");
  await stuck.onKey('down');
  await stuck.onKey('enter');
  await stuck.onKey('enter');
  assert.equal(stuck.step, 'keyManual');
  assert.equal(stuck.err, "me@nas.local didn't accept frost's SSH key.");
});

test('setup asks local drive storage for a full path', async () => {
  let tried: string | undefined;
  const m = new SetupModel(
    setupDeps({
      connect: async s => {
        tried = s.backend + ' ' + s.local.path;
        return RepoState.New;
      },
    }),
    defaultConfig(),
  );
  m.resize(80, 24);
  await m.onKey('enter');
  await m.onKey('4');
  await m.onKey('enter');
  assert.match(strip(m.view()), /Local drive[\s\S]*Which folder should store your backups\?/);
  await m.onKey({ key: 'text', text: 'backups' });
  await m.onKey('enter');
  assert.match(m.err, /^Enter an absolute path \(e\.g\., /);
  assert.equal(tried, undefined);
  await m.onKey('ctrl+u');
  const folder = path.join(os.tmpdir(), 'drive', 'frost');
  await m.onKey({ key: 'text', text: folder });
  await m.onKey('enter');
  assert.equal(tried, 'local ' + folder);
  assert.equal(m.step, 'folders');
});

test('setup cannot skip viewing the phrase and paging keeps it covered', async () => {
  const m = new SetupModel(setupDeps(), defaultConfig());
  m.resize(56, 18);
  m.key = key;
  m.step = 'phrase';
  await m.onKey('enter');
  assert.equal(m.step, 'phrase');
  assert.match(m.err, /Press \[v\]/);
  assert.ok(!strip(m.view()).includes('word17'));

  // A long error makes the page scroll, and paging must not reveal the words.
  m.err = 'Diagnostic explanation. '.repeat(50);
  await m.onKey('pgdown');
  assert.equal(m.showWords, false);
  assert.ok(!strip(m.view()).includes('word17'));

  // The words cover up again on the check step, and a wrong answer clears the field.
  await m.onKey('v');
  await m.onKey('enter');
  assert.equal(m.step, 'check');
  assert.equal(m.showWords, false);
  await m.onKey({ key: 'text', text: 'wrong' });
  await m.onKey('enter');
  assert.equal(m.check.values()[0], '');

  await m.onKey({ key: 'text', text: 'word2' });
  await m.onKey('enter');
  await m.onKey({ key: 'text', text: 'word17' });
  await m.onKey('enter');
  assert.equal(m.keyReady, true);
});

// Without a key, setup opens the key page in the browser and waits on the key field for the paste. With a
// key, nothing opens.
test('setup opens the key page for a new Permafrost key and asks for it', async () => {
  const opened: string[] = [];
  const m = new SetupModel(setupDeps({ openBrowser: url => opened.push(url) }), defaultConfig());
  m.resize(80, 24);
  await m.onKey('enter');
  await m.onKey('enter');
  assert.equal(m.step, 'permaChoice');
  await m.onKey('down');
  await m.onKey('enter');
  assert.deepEqual(opened, ['https://getfro.st/perma']);
  assert.equal(m.step, 'details');
  assert.match(
    strip(m.view()).replace(/\s+/g, ' '),
    /Obtain an access key at getfro\.st\/perma, then paste it below\./,
  );

  await m.onKey('esc');
  assert.equal(m.step, 'permaChoice');
  await m.onKey('up');
  await m.onKey('enter');
  assert.equal(opened.length, 1);
  assert.match(strip(m.view()), /No key yet\? Press \[esc\] to get one\./);
});

// A custom Permafrost server hands out keys its own way, so setup goes straight to the key field.
test('setup asks a custom Permafrost server for its key without the key page', async () => {
  const opened: string[] = [];
  const cfg = defaultConfig();
  cfg.storage.permafrost.url = 'https://permafrost.example.org';
  const m = new SetupModel(setupDeps({ openBrowser: url => opened.push(url) }), cfg);
  m.resize(80, 24);
  await m.onKey('enter');
  await m.onKey('enter');
  assert.equal(m.step, 'details');
  assert.deepEqual(opened, []);
  assert.ok(!/getfro\.st|No key yet/.test(strip(m.view())));
  await m.onKey('esc');
  assert.equal(m.step, 'storage');
});

test('setup quit confirmation is separate from typing and changes are saved only by s', async () => {
  let saves = 0;
  const m = new SetupModel(
    setupDeps({
      finish: async () => {
        saves++;
        return [];
      },
    }),
    defaultConfig(),
  );

  // On a typing step, q is text.
  m.step = 'folders';
  await m.onKey('q');
  assert.equal(m.folderIn.values()[0], 'q');
  assert.equal(m.quit, false);

  // On review, q asks to quit. Declining returns to review, where only s saves.
  m.step = 'review';
  m.key = key;
  await m.onKey('q');
  assert.equal(m.quit, true);
  await m.onKey('n');
  assert.equal(m.exited, false);
  await m.onKey('enter');
  assert.equal(saves, 0);
  await m.onKey('s');
  assert.equal(saves, 1);
  assert.equal(m.saved, true);
  assert.equal(m.step, 'done');
});

test('browser overflow dialogs paint every cell and keep the final diagnostic reachable', async () => {
  const m = browser();
  await m.init();

  // Scroll a long error to its end at several sizes. Every cell needs a background, so the TUI colour has no holes.
  m.err = new Error('Long explanation. '.repeat(100) + 'LAST-DETAIL');
  for (const [w, h] of [
    [50, 20],
    [80, 24],
    [120, 20],
  ]) {
    m.resize(w, h);
    m.errorTop = m.errorMaxTop();
    const frame = m.view();
    assert.equal(width(frame), w);
    assert.equal(height(frame), h);
    assert.match(strip(frame), /LAST-DETAIL/);
    for (const row of cells(frame)) for (const cell of row) assert.ok(cell.background);
  }

  // Empty and negative windows draw nothing.
  for (const [w, h] of [
    [0, 0],
    [80, 0],
    [0, 24],
    [-1, -1],
  ]) {
    m.resize(w, h);
    assert.equal(m.view(), '');
    const s = new SetupModel(setupDeps(), defaultConfig());
    s.resize(w, h);
    assert.equal(s.view(), '');
  }
});

test('metadata controls cannot clear the terminal or escape styled output', async () => {
  const m = browser();
  await m.init();

  // The name hides a carriage return, a clear-screen sequence and a C1 control sequence introducer (U+009B).
  const evil = 'name\r\x1b[2J\u009b31m';
  m.cfg.paths = [evil];
  m.cfg.exclude = [evil];
  m.overlay = 'settings';
  assert.ok(!/[\r\u009b]/.test(m.view()));
  assert.ok(!m.view().includes('\x1b[2J'));

  const s = new SetupModel(setupDeps(), defaultConfig());
  s.resize(80, 24);
  s.step = 'details';
  s.openDetails(0);
  s.err = evil;
  assert.ok(!/[\r\u009b]/.test(s.view()));
  assert.ok(!s.view().includes('\x1b[2J'));
});

test('icebreaker cracks ice, rescues files, ignores rot damage, and emits cues', () => {
  const a = new Arcade('', 42n);
  a.resize(40, 20);
  a.start();

  // Turn off spawning and put one frozen file in the line of fire. It takes two hits to thaw.
  a.spawn = () => {};
  const heard: string[] = [];
  a.heard = name => heard.push(name);
  a.things = [{ kind: 'frozen', ext: 'pdf', x: a.shipX - 1, y: 5, vy: 0, hp: 2 }];
  for (let shot = 0; shot < 2; shot++) {
    a.cooldown = 0;
    a.key(' ');
    for (let i = 0; i < 20 && a.bullets.length; i++) a.tick();
  }
  assert.equal(a.things[0].kind, 'thawed');
  assert.equal(a.score, 45);

  // The thawed file falls onto the ship and is rescued.
  for (let i = 0; i < 60 && a.things.length; i++) a.tick();
  assert.equal(a.rescued, 1);
  assert.equal(a.score, 95);
  assert.deepEqual(heard, ['shoot', 'crack', 'shoot', 'explosion', 'pickup']);

  // Shooting rot changes nothing.
  a.things = [{ kind: 'rot', x: a.shipX, y: 3, vy: 0 }];
  a.cooldown = 0;
  a.key(' ');
  for (let i = 0; i < 20; i++) a.tick();
  assert.equal(a.score, 95);
  assert.equal(a.things[0].kind, 'rot');
});

// Each game opens its own sound, and leaving the game or closing the browser closes it, so the audio output isn't
// held open outside the game.
test('icebreaker closes its sound when the game is left or the browser closes', async () => {
  let opened = 0;
  let closed = 0;
  const m = browser(
    {},
    {
      gameSound: () => {
        opened++;
        return {
          available: () => false,
          play: () => {},
          close: async () => {
            closed++;
          },
        };
      },
    },
  );
  await m.init();
  await m.onKey('i');
  assert.ok(m.game);
  await m.onKey('esc');
  assert.equal(m.game, undefined);
  assert.deepEqual([opened, closed], [1, 1]);
  await m.onKey('i');
  m.close();
  assert.deepEqual([opened, closed], [2, 2]);
});

test('icebreaker powers up, remembers best and mute, ignores stale ticks, and freezes in small windows', async t => {
  const file = path.join(await temp(t), 'icebreaker.json');
  const a = new Arcade(file, 42n);
  a.resize(40, 20);
  a.start();
  a.spawn = () => {};

  // Catching eight thawed files earns the first power level, which shortens the cooldown.
  for (let i = 0; i < 8; i++) {
    a.things = [{ kind: 'thawed', ext: 'pdf', x: a.shipX, y: a.h - 1, vy: 0 }];
    a.tick();
  }
  assert.equal(a.power, 1);
  a.cooldown = 0;
  a.fire();
  assert.equal(a.cooldown, 2);

  // Level 3 fires two bullets, and losing a life costs a level.
  a.power = 3;
  a.cooldown = 0;
  a.bullets = [];
  a.fire();
  assert.deepEqual(
    a.bullets.map(b => b.x),
    [a.shipX, a.shipX + 2],
  );
  a.loseLife();
  assert.equal(a.power, 2);

  // Pausing and resuming bumps the generation, so ticks scheduled before it, or for another game, do nothing.
  const old = a.gen;
  a.key('p');
  a.key('p');
  assert.equal(a.tick(old), false);
  assert.equal(a.tick(a.gen, new Arcade()), false);

  // A window too small to play in freezes the game.
  a.resize(20, 8);
  const ticks = a.ticks;
  a.tick();
  assert.equal(a.ticks, ticks);

  // Muting and quitting save the best score and the mute setting. A lower score later doesn't replace the best.
  a.score = 1234;
  a.key('m');
  a.key('esc');
  assert.equal(a.newBest, true);
  const b = new Arcade(file, 1n);
  assert.equal(b.best, 1234);
  assert.equal(b.muted, true);
  b.resize(40, 20);
  b.start();
  b.score = 10;
  b.gameOver();
  assert.equal(b.newBest, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).best, 1234);

  // The canvas clips text that starts left of it or below it.
  const c = new Canvas(3, 2);
  c.put(-1, 0, 'ABCD', 'bold');
  c.put(0, 8, 'ignored', 'text');
  assert.equal(strip(c.render()), 'BCD\n   ');
});

test('terminal restores modes, stops work on exit, and does not repaint idle frames', async t => {
  // Mocked timers let the test move time forward without waiting.
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });

  // The streams pretend to be a terminal, and setRawMode records the mode so the test can check it's restored.
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let frames = '',
    closed = false,
    views = 0;
  output.on('data', bytes => (frames += String(bytes)));

  // A model that counts its renders and exits on q.
  const model = {
    w: 0,
    h: 0,
    spin: 0,
    exited: false,
    resize(w: number, h: number) {
      this.w = w;
      this.h = h;
    },
    view() {
      views++;
      return 'frame';
    },
    onKey(e: any) {
      if (e.key === 'q') this.exited = true;
    },
    animation: () => undefined,
    close() {
      closed = true;
    },
  };

  const done = runTerminal(model, { input: input as any, output: output as any });
  assert.equal(input.isRaw, true);

  // Nothing animates and no keys arrive, so half a second passes without another render.
  t.mock.timers.tick(500);
  assert.equal(views, 1);

  // Exiting closes the model, restores the input mode, leaves the alternate screen last and removes listeners.
  input.write('q');
  await done;
  assert.equal(closed, true);
  assert.equal(input.isRaw, false);
  assert.match(frames, /\x1b\[\?1049l$/);
  assert.equal(input.listenerCount('data'), 0);
});

test('terminal paces game ticks by the clock when timers fire late, and drops a long stall', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
      return this;
    },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  output.resume();
  let ticks = 0;
  const model = {
    w: 0,
    h: 0,
    spin: 0,
    exited: false,
    resize() {},
    view: () => 'frame',
    onKey(e: any) {
      if (e.key === 'q') this.exited = true;
    },
    animation: () => 'game' as const,
    tick() {
      ticks++;
    },
  };

  // The game clock runs a quarter faster than the mocked timers, as if every timer fired late. Two timer seconds are
  // 2.5 clock seconds, so about 50 ticks, where counting timer firings would give 39.
  let jump = 0;
  const done = runTerminal(model, {
    input: input as any,
    output: output as any,
    now: () => Date.now() * 1.25 + jump,
  });
  // Mocked timers set the time before firing, so timers set while firing need time to move in small steps.
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i++) t.mock.timers.tick(1);
  };
  advance(2000);
  assert.ok(ticks >= 47 && ticks <= 50, `${ticks} ticks`);

  // After a one-second stall, one tick catches up and the next comes 50 ms later.
  const before = ticks;
  jump = 1000;
  while (ticks === before) advance(1);
  advance(1);
  assert.equal(ticks, before + 2);
  advance(30);
  assert.equal(ticks, before + 2);

  input.write('q');
  await done;
});

test('terminal uses the selected console color profile without changing model frames', async () => {
  // Each profile should turn this truecolor frame into the expected bytes.
  const frame = '\x1b[38;2;242;239;231mframe\x1b[0m';
  for (const [colorProfile, expected] of [
    ['ascii', 'frame'],
    ['ansi', '\x1b[93mframe\x1b[0m'],
    ['ansi256', '\x1b[38;5;230mframe\x1b[0m'],
    ['truecolor', frame],
  ] as const) {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        this.isRaw = raw;
        return this;
      },
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let frames = '';
    output.on('data', bytes => (frames += String(bytes)));
    const model = {
      w: 80,
      h: 24,
      spin: 0,
      exited: false,
      resize() {},
      view: () => frame,
      onKey() {
        this.exited = true;
      },
    };

    // The converted frame follows the cursor-home sequence, and the model's own frame stays truecolor.
    const done = runTerminal(model, { input: input as any, output: output as any, colorProfile });
    assert.ok(frames.includes('\x1b[H' + expected));
    assert.equal(model.view(), frame);
    if (colorProfile === 'ascii') assert.ok(!/\x1b\[[\d;]*m/.test(frames));
    input.write('q');
    await done;
    assert.equal(input.isRaw, false);
  }
});
