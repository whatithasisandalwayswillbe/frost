// Checks CLI layouts: native separators in live progress, when root help shows the wordmark, and recorded backup,
// snapshot, phrase and error blocks in every colour profile.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Context } from '../../src/cli/context.js';
import { printBackup, printDryRun, runBackup } from '../../src/cli/backup.js';
import { printSnapshots } from '../../src/cli/status.js';
import { phraseGrid } from '../../src/cli/key.js';
import { rootHelp } from '../../src/cli/help.js';
import { Format, ago } from '../../src/cli/format.js';
import type { ColorProfile } from '../../src/cli/terminal.js';
import { defaultConfig } from '../../src/core/config.js';
import { shorten, short, emptyStats, type Snapshot } from '../../src/core/snapshot.js';
import { Engine, type BackupResult } from '../../src/engine/index.js';

// One recorded layout. The name picks a scenario in the last test, and profile picks the colour profile.
interface Reference {
  name: string;
  profile: ColorProfile;
  output: string;
}

// A fake engine reports one progress line for a POSIX path and then fails, so only the live line is printed.
test('live backup paths use native separators', async () => {
  let output = '';
  const ctx = new Context({
    input: '',
    write: s => {
      output += s;
    },
    error: () => {},
    outputTTY: true,
    width: 0,
    colors: false,
  });

  const e = {
    repo: { backend: { toString: () => 'memory' } },
    backup: async (options: {
      progress?: (p: { path: string; files: number; bytes: number; newBytes: number; uploadedBytes: number }) => void;
    }) => {
      options.progress?.({ path: '/source/文件.txt', files: 1, bytes: 1, newBytes: 1, uploadedBytes: 0 });
      throw new Error('stop');
    },
  } as unknown as Engine;
  ctx.openApp = async () => ({ cfg: defaultConfig(), engine: e, close: async () => {} });

  await assert.rejects(
    runBackup(ctx, { paths: [], exclude: [], dryRun: false, noVerify: false, scheduled: false, logFile: '' }),
    /stop/,
  );
  assert.ok(output.includes(process.platform === 'win32' ? '\\source\\文件.txt' : '/source/文件.txt'));
});

// Tests run from dist/test/cli, so '../../assets' is the copy packaged into dist. The wordmark needs its first row
// plus a three-space indent to fit.
test('root help loads the packaged wordmark only when it fits', () => {
  const mark = readFileSync(new URL('../../assets/wordmarks/frost-wordmark.txt', import.meta.url), 'utf8').trimEnd();
  const rows = mark.split('\n');
  const threshold = 3 + [...rows[0]].length;

  for (const width of [0, 20, threshold, threshold + 1, 120]) {
    let output = '';
    rootHelp(
      new Format(s => {
        output += s;
      }),
      '/config',
      width,
    );
    assert.equal(
      output.startsWith('\n' + rows.map(row => '   ' + row + '\n').join('') + '\n'),
      width > threshold,
      String(width),
    );
    assert.ok(output.includes('frost <command> [flags]'));
    assert.ok(output.includes('key <show|verify|import>'));
    if (width <= threshold) assert.ok(!output.includes(rows[0]));
  }
});

// Each record names a scenario. Most print a backup or dry run result built from base() and adjusted for the case.
test(
  'recorded command layouts preserve rows, color sequences and overflow',
  {
    skip:
      !['win32', 'linux'].includes(process.platform) &&
      'Native command captures are recorded only for Windows and Linux.',
  },
  async () => {
    const references = JSON.parse(
      readFileSync(new URL('../../../test/fixtures/cli/layout-' + process.platform + '.json', import.meta.url), 'utf8'),
    ) as Reference[];

    // base() returns a fresh backup result at a fixed time, so each scenario can change its own copy.
    const stamp = '2006-01-02T03:04:05Z';
    const base = (): BackupResult => ({
      snapshot: {
        id: 'maple-absurd-3f1c9a0b2e7',
        time: stamp,
        host: 'reference',
        paths: ['/source/photos'],
        stats: {
          ...emptyStats(),
          files: 1234,
          dirs: 2,
          bytes: 2250,
          new_bytes: 1250,
          new_chunks: 3,
          uploaded_bytes: 750,
        },
      },
      compared: true,
      unchanged: false,
      changes: { files: { added: 2, changed: 1, removed: 3 }, folders: { added: 1, changed: 2, removed: 1 } },
      planned: [],
    });

    // Dates print in UTC, as they were recorded.
    const old = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const differences: string[] = [];
      for (const record of references) {
        let output = '';
        const f = new Format(
          s => {
            output += s;
          },
          true,
          record.profile,
        );
        const b = f.block();
        const r = base();
        const name = record.name;

        // This case prints live progress for a long path with wide characters.
        if (name === 'progress-long') {
          const ctx = new Context({
            input: '',
            write: s => {
              output += s;
            },
            error: () => {},
            outputTTY: true,
            width: 0,
            colors: true,
          });
          ctx.fmt = f;
          const e = {
            repo: { backend: { toString: () => 'memory' } },
            backup: async (options: {
              progress?: (p: {
                path: string;
                files: number;
                bytes: number;
                newBytes: number;
                uploadedBytes: number;
              }) => void;
            }) => {
              options.progress?.({
                path: '/source/文件/🧊/' + 'long-'.repeat(15) + 'end.txt',
                files: 1234,
                bytes: 2250,
                newBytes: 1250,
                uploadedBytes: 0,
              });
              throw new Error('stop');
            },
          } as unknown as Engine;
          ctx.openApp = async () => ({ cfg: defaultConfig(), engine: e, close: async () => {} });
          await assert.rejects(
            runBackup(ctx, { paths: [], exclude: [], dryRun: false, noVerify: false, scheduled: false, logFile: '' }),
            /stop/,
          );
        } else if (name.startsWith('snapshots-')) {
          // snapshots-<count>-<all> lists that many snapshots an hour apart. all asks for every one to be shown.
          const [, length, all] = name.split('-');
          const snaps: Snapshot[] = [];
          for (let i = 0; i < Number(length); i++)
            snaps.push({
              ...r.snapshot,
              id: 'maple-absurd-3f1c' + i.toString(16).padStart(7, '0'),
              time: new Date(Date.parse(stamp) - i * 3600_000).toISOString(),
            });
          b.open('Frost', 'dev  memory');
          b.gap();
          printSnapshots(b, snaps, shorten(snaps), all === 'true');
        } else if (name === 'phrase-grid') {
          b.open('recovery phrase');
          b.gap();
          b.line(phraseGrid(f, 'abandon '.repeat(23) + 'art'));
          b.close(f.dim('key fingerprint dummy'));
        } else if (name === 'error-block') {
          // This case prints a warning row with blank lines, then an error that closes the open block.
          b.open('restore', 'maple-absurd-3f1c');
          b.warnRow('notice', f.caution('cannot read\nsecond row\n\nlast row'));
          f.write(f.closeLine(f.error('error:') + ' storage refused\n\ntry again') + '\n\n');
        } else {
          // Adjust the shared result for this backup or dry run case.
          switch (name) {
            case 'backup-none':
              r.snapshot.stats.new_bytes = 0;
              r.snapshot.stats.new_chunks = 0;
              r.snapshot.stats.uploaded_bytes = 0;
              break;
            case 'backup-warnings':
              r.snapshot.missing = ['/source/missing', '/source/bad\x1bname'];
              r.snapshot.stats.skipped = 12;
              r.snapshot.stats.kept = 13;
              r.snapshot.warnings = Array.from(
                { length: 12 },
                (_, i) => 'cannot read /source/item' + String(i).padStart(2, '0') + '\t',
              );
              r.snapshot.kept = Array.from({ length: 13 }, (_, i) => '/source/kept' + String(i).padStart(2, '0'));
              break;
            case 'backup-repaired':
            case 'backup-unchanged':
            case 'dry-unchanged':
              r.unchanged = true;
              if (name === 'backup-unchanged') r.snapshot.stats.new_chunks = 0;
              break;
            case 'backup-kept-unchanged':
              r.unchanged = true;
              r.snapshot.stats.kept = 1;
              r.snapshot.kept = ['/source/忙しい.txt'];
              break;
            case 'dry-planned':
              r.planned = [
                { path: '/source/🧊.txt', size: 0, newBytes: 1000 },
                { path: '/source/z.txt', size: 0, newBytes: 250 },
                { path: '/source/文件.txt', size: 0, newBytes: 0 },
                { path: '/source/\t.txt', size: 0, newBytes: 0 },
              ];
              break;
          }

          if (name.startsWith('dry-')) {
            b.open('dry run', 'memory');
            printDryRun(b, r, shorten([r.snapshot]));
          } else {
            b.open('backup', 'memory');
            b.gap();
            printBackup(b, r);
            b.gap();
            b.close(
              r.unchanged
                ? f.good('Already backed up.') +
                    ' No changes detected since snapshot ' +
                    f.bold(short(r.snapshot.id)) +
                    ', saved ' +
                    ago(stamp) +
                    '.'
                : f.good('Saved snapshot ') + f.bold(short(r.snapshot.id)) + '.',
            );
          }
        }

        // Ages depend on today's date, so they're replaced before comparing. Every mismatch is collected, so one
        // run reports them all.
        try {
          assert.equal(output.replace(/\d+d ago/g, '<age> ago'), record.output, record.profile + ' ' + record.name);
        } catch (error) {
          differences.push((error as Error).message);
        }
      }
      assert.deepEqual(differences, []);
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
  },
);
