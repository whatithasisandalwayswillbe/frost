// Renders the icebreaker game and the setup wizard at fixed sizes and compares every frame with its captured
// reference, as plain text, cell by cell and in each colour profile.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupModel, RepoState, ConnectError, type SetupDeps } from '../../src/tui/setup.js';
import { defaultConfig } from '../../src/tui/types.js';
import { Arcade } from '../../src/tui/arcade.js';
import { strip, width, height } from '../../src/tui/render.js';
import { visualCells, assertProfiles } from './ansi.js';
import { reference, setupInput } from './references.js';

// A fixed key, so phrase and fingerprint screens render the same every run.
const key = { phrase: () => Array(24).fill('abandon').join(' '), fingerprint: () => 'abcd1234abcd' };

// Setup dependencies with no real storage. Only the Permafrost access key 'good' connects, and a self-hosted
// server only takes Frost's SSH key once it was added by hand.
function deps(): SetupDeps {
  return {
    connect: async (s, _signal, options) => {
      if (s.backend === 'permafrost' && s.permafrost.token !== 'good')
        throw new Error("that access key wasn't accepted");
      if (s.backend === 'sftp' && !options?.acceptNewHostKey)
        throw new ConnectError('login', "the server didn't accept Frost's SSH key");
      return RepoState.New;
    },
    addKey: async () => {},
    keyFile: () => '~/.config/frost/ssh/frost_ed25519.pub',
    reveal: () => {},
    newKey: () => key,
    unlock: async () => key,
    finish: async () => [['config', '~/.config/frost/config.toml']],
    pickWords: () => [2, 17],
    dirExists: () => false,
    openBrowser: () => {},
  };
}

// Compares a frame with its capture in three passes. Colour profiles come first, then the plain text, which
// fails with a row-by-row diff that's easy to read, and finally every cell's colour and style.
function same(actual: string, name: string): void {
  const expected = reference(name);
  assertProfiles(actual, expected, name);

  const got = strip(actual);
  const want = strip(expected);
  if (got !== want) {
    const a = got.split('\n');
    const b = want.split('\n');
    const differences: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i])
        differences.push(`row ${i + 1}\nactual ${JSON.stringify(a[i])}\nwant   ${JSON.stringify(b[i])}`);
    assert.fail(name + '\n' + differences.join('\n'));
  }

  const ac = visualCells(actual);
  const bc = visualCells(expected);
  for (let row = 0; row < ac.length; row++)
    for (let col = 0; col < ac[row].length; col++)
      assert.deepEqual(ac[row][col], bc[row]?.[col], `${name} color at row ${row + 1}, column ${col + 1}`);
}

// Seed 7 and a fixed run of ticks, moves and shots make every phase of the game render the same.
for (const [w, h] of [
  [64, 24],
  [40, 14],
  [20, 8],
])
  test(`icebreaker matches captured frames at ${w}x${h}`, () => {
    const game = new Arcade('', 7n);
    game.resize(w, h);
    for (const phase of ['title', 'playing', 'over']) {
      if (phase === 'playing') {
        game.start();
        for (let i = 0; i < 200; i++) {
          game.tick();
          game.key('right');
          game.key(' ');
        }
      }
      if (phase === 'over') game.gameOver();
      same(game.view(), `game-${phase}-${w}`);
    }
  });

// Walks the whole first-run wizard with Permafrost storage, capturing every screen on the way.
for (const [w, h] of [
  [120, 40],
  [80, 24],
  [56, 18],
])
  test(`setup matches captured wizard frames at ${w}x${h}`, async () => {
    const suffix = String(w).padStart(3, '0');
    const name = (s: string) => 'setup-' + s + '-' + suffix;

    // Read the phrase back out of the captured phrase screen, so the generated key shows the same words.
    const refWords = new Map<number, string>();
    for (const m of strip(reference(name('10-phrase-shown'))).matchAll(/\b(\d{1,2}) ([a-z]+)\s/g))
      refWords.set(+m[1], m[2]);
    const words = Array.from({ length: 24 }, (_, i) => refWords.get(i + 1) ?? 'abandon');
    const d = deps();
    d.newKey = () => ({ ...key, phrase: () => words.join(' ') });
    const m = new SetupModel(d, defaultConfig());
    m.resize(w, h);

    // Every screen must fill the window exactly before its content is compared.
    const shot = (s: string) => {
      assert.equal(width(m.view()), w);
      assert.equal(height(m.view()), h);
      same(m.view(), name(s));
    };

    shot('01-welcome');
    await m.onKey('enter');
    shot('02-storage');
    await m.onKey('enter');
    shot('02b-permafrost-choice');
    await m.onKey('enter');
    shot('03-permafrost');

    // deps() refuses any access key except 'good'.
    await m.onKey({ key: 'text', text: 'bad-key-123' });
    shot('03b-permafrost-typing');
    await m.onKey('enter');
    shot('04-connect-failed');

    await m.onKey('ctrl+u');
    await m.onKey({ key: 'text', text: 'good' });
    await m.onKey('enter');
    shot('05-folders');

    await m.onKey({ key: 'text', text: setupInput.missingDir });
    shot('06-folders-typing');
    await m.onKey('enter');
    shot('07-folders-missing');
    await m.onKey('up');
    shot('07b-folders-choosing');

    await m.onKey('esc');
    await m.onKey('enter');
    shot('07c-skip');
    await m.onKey({ key: 'text', text: '*.iso' });
    await m.onKey('enter');
    shot('07d-skip-added');
    await m.onKey('up');
    shot('07e-skip-choosing');

    await m.onKey('esc');
    await m.onKey('enter');
    shot('08-schedule');

    await m.onKey('up');
    await m.onKey('enter');
    shot('09-phrase');

    await m.onKey('enter');
    await m.onKey('v');
    shot('10-phrase-shown');
    await m.onKey('enter');
    shot('11-check');
    await m.onKey({ key: 'text', text: 'nope' });
    await m.onKey('enter');
    shot('12-check-wrong');

    // deps().pickWords asks for the third and eighteenth words.
    await m.onKey({ key: 'text', text: words[2] });
    await m.onKey('enter');
    await m.onKey({ key: 'text', text: words[17] });
    await m.onKey('enter');
    shot('13-review');

    // An existing repository at another location adds a warning to the review screen.
    m.elsewhere = 's3://backups/frost/';
    shot('13c-review-elsewhere');
    m.elsewhere = '';

    await m.onKey('enter');
    await m.onKey('q');
    shot('13b-quit');

    await m.onKey('n');
    await m.onKey('s');
    shot('14-done');
    assert.equal(m.saved, true);
  });

// Captures the screens off the main path: unlocking an existing repository, choosing B2 from the S3 list and getting
// a Permafrost key.
for (const [w, h] of [
  [120, 40],
  [80, 24],
  [56, 18],
])
  test(`setup matches captured existing-key and key page frames at ${w}x${h}`, async () => {
    const suffix = String(w).padStart(3, '0');
    const name = (s: string) => 'setup-' + s + '-' + suffix;

    // The saved config's local key doesn't open the repository, so setup asks for the phrase.
    const cfg = defaultConfig();
    cfg.storage.backend = 'permafrost';
    cfg.storage.permafrost.token = 'good';
    const existing = new SetupModel({ ...deps(), localKey: key, connect: async () => RepoState.LocalWrong }, cfg, true);
    existing.resize(w, h);
    same(existing.view(), name('20-welcome-existing'));
    await existing.onKey('enter');
    same(existing.view(), name('21-unlock'));
    await existing.onKey({ key: 'text', text: 'word word word' });
    same(existing.view(), name('22-unlock-typing'));

    const b2 = new SetupModel(deps(), defaultConfig());
    b2.resize(w, h);
    await b2.onKey('enter');
    await b2.onKey('down');
    await b2.onKey('enter');
    same(b2.view(), name('02c-s3-choice'));
    await b2.onKey('down');
    await b2.onKey('enter');
    same(b2.view(), name('23-b2'));

    const perma = new SetupModel(deps(), defaultConfig());
    perma.resize(w, h);
    await perma.onKey('enter');
    await perma.onKey('enter');
    await perma.onKey('down');
    same(perma.view(), name('24-permafrost-no-key'));

    // Without a key, the key field says where to get one.
    await perma.onKey('enter');
    same(perma.view(), name('25-permafrost-get-key'));
  });

// Captures self-hosted storage, from its two questions to both screens for adding Frost's SSH key, and the local
// drive question with a path typed in, since its placeholder depends on the system.
for (const [w, h] of [
  [120, 40],
  [80, 24],
  [56, 18],
])
  test(`setup matches captured self-hosted and local drive frames at ${w}x${h}`, async () => {
    const suffix = String(w).padStart(3, '0');
    const name = (s: string) => 'setup-' + s + '-' + suffix;
    const shot = (m: SetupModel, s: string) => {
      assert.equal(width(m.view()), w);
      assert.equal(height(m.view()), h);
      same(m.view(), name(s));
    };

    const ssh = new SetupModel(deps(), defaultConfig());
    ssh.resize(w, h);
    await ssh.onKey('enter');
    await ssh.onKey('3');
    await ssh.onKey('enter');
    shot(ssh, '30-self-hosted-address');
    await ssh.onKey({ key: 'text', text: 'me@nas.local' });
    await ssh.onKey('enter');
    shot(ssh, '31-self-hosted-folder');
    await ssh.onKey('enter');
    shot(ssh, '32-key-choice');
    await ssh.onKey('down');
    await ssh.onKey('enter');
    shot(ssh, '33-key-manual');

    const drive = new SetupModel(deps(), defaultConfig());
    drive.resize(w, h);
    await drive.onKey('enter');
    await drive.onKey('4');
    await drive.onKey('enter');
    await drive.onKey({ key: 'text', text: '/mnt/backup/frost' });
    shot(drive, '34-local-drive');
  });
