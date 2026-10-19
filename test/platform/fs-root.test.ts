// Tests for openRoot's rules on symlinks in the path above a root. A link is only followed when
// it and its parent folder are owned by root or the current user, and nobody else could swap it.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { directory, openRoot, readAll, trustedAncestorLink } from '../../src/platform/fs-root.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';

test('POSIX native names keep literal backslashes in files and folders', { skip: !posix }, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'frost-backslash-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = await openRoot(base);
  t.after(() => root.close());
  const nested = directory(root, 'dir\\name/child\\folder', { create: true });
  try {
    const file = nested.open('file\\name.txt', { write: true, create: true, exclusive: true });
    try {
      file.writeFile('literal backslash');
    } finally {
      file.close();
    }
  } finally {
    nested.close();
  }
  assert.equal(fs.readFileSync(path.join(base, 'dir\\name/child\\folder/file\\name.txt'), 'utf8'), 'literal backslash');
  assert.equal(fs.existsSync(path.join(base, 'dir')), false);
  assert.throws(() => directory(root, 'dir\\name/../outside', { create: true }), /escapes the target/);
});

// The current user is uid 1000. A parent writable by group or others is only safe with the sticky
// bit (0o1000), which stops other users renaming the link. An unknown uid trusts only root.
test('ancestor link trust requires a protected parent owned by root or the current user', () => {
  const uid = 1000;
  const cases = [
    { link: 1000, parent: 1000, mode: 0o755, accepted: true },
    { link: 0, parent: 0, mode: 0o755, accepted: true },
    { link: 0, parent: 1000, mode: 0o700, accepted: true },
    { link: 1000, parent: 0, mode: 0o755, accepted: true },
    { link: 1000, parent: 1000, mode: 0o775, accepted: false },
    { link: 1000, parent: 1000, mode: 0o777, accepted: false },
    { link: 1000, parent: 0, mode: 0o1777, accepted: true },
    { link: 1000, parent: 1000, mode: 0o1777, accepted: true },
    { link: 2000, parent: 0, mode: 0o1777, accepted: false },
    { link: 2000, parent: 1000, mode: 0o755, accepted: false },
    { link: 1000, parent: 2000, mode: 0o755, accepted: false },
    { link: 0, parent: 2000, mode: 0o755, accepted: false },
    { link: 1000, parent: 2000, mode: 0o1777, accepted: false },
  ];
  for (const value of cases) {
    assert.equal(
      trustedAncestorLink({ uid: value.link }, { uid: value.parent, mode: value.mode }, uid),
      value.accepted,
      JSON.stringify(value),
    );
  }
  assert.equal(trustedAncestorLink({ uid: 1000 }, { uid: 0, mode: 0o755 }, undefined), false);
  assert.equal(trustedAncestorLink({ uid: 0 }, { uid: 0, mode: 0o755 }, undefined), true);
});

// `parent/link` points at `destination`. Going through the link is fine while `parent` is 0o755,
// refused once it's world-writable, and fine again with the sticky bit.
test('native root follows owned ancestor links only in protected or sticky folders', { skip: !posix }, async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'frost-link-trust-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const parent = path.join(base, 'parent');
  const destination = path.join(base, 'destination');
  fs.mkdirSync(parent, { mode: 0o755 });
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.mkdirSync(path.join(destination, 'child'));
  fs.writeFileSync(path.join(destination, 'child', 'sentinel'), 'held target');
  const link = path.join(parent, 'link');
  fs.symlinkSync(destination, link);

  const root = await openRoot(path.join(link, 'child'));
  try {
    const file = root.open('sentinel', { read: true });
    try {
      assert.equal(readAll(file).toString(), 'held target');
    } finally {
      file.close();
    }
  } finally {
    root.close();
  }

  // A link as the last path component needs explicit trust.
  await assert.rejects(openRoot(link), /goes through a link/);
  const final = await openRoot(link, { trustedFinalLink: true });
  final.close();

  fs.chmodSync(parent, 0o777);
  await assert.rejects(openRoot(path.join(link, 'child')), /link in an untrusted folder/);
  fs.chmodSync(parent, 0o1777);
  const sticky = await openRoot(path.join(link, 'child'));
  sticky.close();
  assert.equal(fs.readFileSync(path.join(destination, 'child', 'sentinel'), 'utf8'), 'held target');
});

// Runs only as root, since it hands the parent to uid 65534 (nobody). A link owned by root inside
// another user's folder is refused at any mode, because that user could replace it.
test(
  'native root refuses trusted links in a foreign-owned parent even with sticky protection',
  { skip: !posix || process.getuid?.() !== 0 },
  async t => {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'frost-link-owner-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const parent = path.join(base, 'foreign');
    const destination = path.join(base, 'destination');
    fs.mkdirSync(parent);
    fs.mkdirSync(destination);
    fs.mkdirSync(path.join(destination, 'child'));
    fs.writeFileSync(path.join(destination, 'child', 'sentinel'), 'unchanged');
    const link = path.join(parent, 'link');
    fs.symlinkSync(destination, link);

    // Some filesystems can't change or keep ownership. That's a test limit, so skip rather than fail.
    try {
      fs.chownSync(parent, 65534, 65534);
    } catch (error) {
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('filesystem cannot change private test ownership');
        return;
      }
      throw error;
    }
    if (fs.statSync(parent).uid !== 65534) {
      t.skip('filesystem does not retain private test ownership');
      return;
    }

    assert.equal(fs.lstatSync(link).uid, 0);
    for (const mode of [0o755, 0o1777]) {
      fs.chmodSync(parent, mode);
      await assert.rejects(openRoot(path.join(link, 'child')), /link in an untrusted folder/);
    }
    assert.equal(fs.readFileSync(path.join(destination, 'child', 'sentinel'), 'utf8'), 'unchanged');
  },
);

test('native folders list entries, rename without replacing, link and report space', async t => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'frost-entries-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = await openRoot(base);
  const sub = root.openDirectory('sub', { create: true });
  t.after(() => {
    sub.close();
    root.close();
  });
  for (const [name, text] of [
    ['a', 'one'],
    ['b', 'two'],
  ]) {
    const file = root.open(name, { write: true, create: true, exclusive: true });
    file.writeFile(text);
    file.close();
  }
  let linked = false;
  try {
    fs.symlinkSync(path.join(base, 'a'), path.join(base, 'l'));
    linked = true;
  } catch {
    /* Creating symlinks needs a privilege on Windows. */
  }

  const expected = [
    { name: 'a', kind: 'file' },
    { name: 'b', kind: 'file' },
    ...(linked ? [{ name: 'l', kind: 'link' }] : []),
    { name: 'sub', kind: 'directory' },
  ];
  const sorted = () => root.list().sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(sorted(), expected);
  // A second listing starts from the beginning again.
  assert.deepEqual(sorted(), expected);
  assert.deepEqual(sub.list(), []);

  assert.throws(() => root.rename('a', root, 'b', false), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(base, 'b'), 'utf8'), 'two');
  root.rename('a', sub, 'moved', false);
  assert.equal(fs.readFileSync(path.join(base, 'sub', 'moved'), 'utf8'), 'one');

  root.link('b', sub, 'hard');
  assert.throws(() => root.link('b', sub, 'hard'), { code: 'EEXIST' });
  assert.equal(root.lstat('b').nlink, 2);
  root.rename('b', sub, 'moved');
  assert.equal(fs.readFileSync(path.join(base, 'sub', 'moved'), 'utf8'), 'two');

  const space = root.space();
  const stats = fs.statfsSync(base);
  assert.equal(space.total, stats.blocks * stats.bsize);
  assert.ok(space.free > 0 && space.free <= space.total && space.available <= space.free);
  assert.equal(space.readOnly, false);
});
