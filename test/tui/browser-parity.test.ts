// Rebuilds every captured browser state in test/fixtures/tui and checks that it renders its captured frame,
// as plain text, cell by cell and in each colour profile.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BrowserModel } from '../../src/tui/browser.js';
import { FileTree } from '../../src/tui/tree.js';
import { Form } from '../../src/tui/input.js';
import { Arcade } from '../../src/tui/arcade.js';
import { type Snapshot, type Config } from '../../src/tui/types.js';
import { strip, type Style } from '../../src/tui/render.js';
import { visualCells, assertProfiles } from './ansi.js';
import { reference, referenceDir as dir } from './references.js';

// Restore phases in the order the captures number them.
const phases = ['confirm', 'picking', 'typing', 'ready', 'running', 'done'] as const;

// Turns a captured browser state into a live BrowserModel. Captures use Go-style field names and store enums as
// numbers, so each value is mapped onto its TypeScript equivalent.
function fixtureModel(f: any): BrowserModel {
  const c = f.cfg;
  const cfg: Config = {
    paths: c.Paths ?? [],
    exclude: c.Exclude ?? [],
    // The captures predate the schedule's time, day and catch-up settings, which the browser doesn't show.
    schedule: { enabled: c.Schedule.Enabled, every: c.Schedule.Every, time: '15:00', day: 'sunday', catch_up: true },
    verify: { sample: c.Verify.Sample },
    update: { auto: c.Update.Auto },
    storage: {
      backend: c.Storage.Backend,
      s3: {
        endpoint: c.Storage.S3.Endpoint,
        region: c.Storage.S3.Region,
        bucket: c.Storage.S3.Bucket,
        prefix: c.Storage.S3.Prefix,
        access_key_id: c.Storage.S3.AccessKeyID,
        secret_access_key: c.Storage.S3.SecretAccessKey,
        insecure: c.Storage.S3.Insecure,
      },
      permafrost: { url: c.Storage.Permafrost.URL, token: c.Storage.Permafrost.Token },
      // The captures predate self-hosted and local drive storage, which the browser doesn't show either.
      sftp: { host: '', port: 0, path: 'frost' },
      local: { path: '' },
    },
  };

  // A stand-in repository that serves the captured snapshots and tree.
  const repo = {
    label: f.label,
    fingerprint: f.fingerprint,
    snapshots: async () => f.snaps ?? [],
    loadTree: async () => ({ files: Object.values(f.tree?.files ?? {}) as any[] }),
    restore: async () => ({ files: 0, bytes: 0 }),
  };
  const m = new BrowserModel(repo, cfg, f.state, undefined, { gameSound: undefined });

  // These fields carry over unchanged.
  for (const k of [
    'w',
    'h',
    'overlay',
    'overlayTop',
    'showKey',
    'loading',
    'flash',
    'snapCur',
    'marked',
    'snap',
    'dir',
    'fileCur',
    'fileTop',
    'selFiles',
    'selBytes',
    'diffFrom',
    'diffTo',
    'diffTop',
    'diffAdd',
    'diffDel',
    'diffMod',
  ] as const)
    (m as any)[k] = f[k];

  m.screen = ['home', 'snapshots', 'files', 'diff', 'restore'][f.screen] as any;
  m.snaps = f.snaps ?? [];
  m.indexSnapshots();
  m.sel = new Set(Object.keys(f.sel ?? {}));
  if (f.tree)
    m.tree = new FileTree({ ...f.snap, paths: f.tree.roots }, { files: Object.values(f.tree.files) as any[] });
  m.changes = (f.changes ?? []).map((c: any) => ({ path: c.Path, kind: c.Kind, old: c.Old, new: c.New }));

  // Restore state, then any captured errors.
  Object.assign(m.rs, f.rs);
  m.rs.paths = f.rs.paths ?? [];
  m.rs.tops = f.rs.tops ?? [];
  m.rs.phase = phases[f.rs.phase];
  m.rs.input = new Form(f.restoreInput ? [f.restoreInput] : []);
  m.rs.res = { files: f.rs.res.Files, dirs: f.rs.res.Dirs, bytes: f.rs.res.Bytes, unfinished: f.rs.res.Unfinished };
  if (m.rs.phase === 'running') m.spin = 1;
  if (f.error) m.err = new Error(f.error);
  if (f.restoreErr) m.rs.err = new Error(f.restoreErr);
  if (f.besideErr) m.rs.besideErr = new Error(f.besideErr);
  if (f.overErr) m.rs.overErr = new Error(f.overErr);

  // The hidden game, when the capture has it open.
  if (f.game) {
    const a = new Arcade('', 1n);
    Object.assign(a, f.game);
    a.phase = ['title', 'playing', 'paused', 'over'][f.game.phase] as any;
    a.things = f.game.things.map((t: any) => ({ ...t, kind: ['frozen', 'thawed', 'rot'][t.kind] }));
    // Spark styles, indexed by the number each capture stores.
    const styles: Style[] = [
      'base',
      'bold',
      'bold',
      'text',
      'dim',
      'faded',
      'bold',
      'goodBold',
      'error',
      'dim',
      'warnBold',
    ];
    a.sparks = f.game.sparks.map((s: any) => ({ ...s, st: styles[s.st] }));
    m.game = a;
  }
  return m;
}

// Dates render in local time, and the captured frames expect this zone.
process.env.TZ = 'Africa/Nairobi';

// Each .json state has a matching .ans frame beside it.
for (const file of readdirSync(dir).filter(s => s.endsWith('.json')))
  test('browser matches captured frame ' + file.slice(0, -5), () => {
    const f = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const m = fixtureModel(f);
    const oldNow = Date.now;

    // Ages count from now, so render at the capture's time or a second after its newest snapshot or verification.
    Date.now = () =>
      f.renderedAt ??
      Math.max(...(f.snaps ?? []).map((s: Snapshot) => Date.parse(s.time)), Date.parse(f.state.verify.time)) + 1000;
    try {
      const actual = m.view();
      const expected = reference(file.slice(0, -5));
      const a = strip(actual).split('\n');
      const b = strip(expected).split('\n');

      // Plain text first, so a failure shows a readable row-by-row diff.
      if (a.join('\n') !== b.join('\n')) {
        const diffs: string[] = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++)
          if (a[i] !== b[i]) diffs.push(`row ${i + 1}\nactual ${JSON.stringify(a[i])}\nwant   ${JSON.stringify(b[i])}`);
        assert.fail(file + '\n' + diffs.join('\n'));
      }

      // Then every cell's colour and style, then the conversions to other colour profiles.
      const ac = visualCells(actual);
      const bc = visualCells(expected);
      for (let row = 0; row < ac.length; row++)
        for (let col = 0; col < ac[row].length; col++)
          assert.deepEqual(ac[row][col], bc[row]?.[col], `${file} color at row ${row + 1}, column ${col + 1}`);
      assertProfiles(actual, expected, file);
    } finally {
      Date.now = oldNow;
    }
  });
