// Replays a recorded session of commands, in order, against one in-memory repository and compares each command's
// output and error. Some records change files or hooks first, and later commands see the state earlier ones left.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Context, run } from '../../src/cli/index.js';
import type { Hooks } from '../../src/cli/context.js';
import { tildify } from '../../src/cli/format.js';
import { Key } from '../../src/core/crypto.js';
import { chunkKey } from '../../src/core/repo.js';
import { short } from '../../src/core/snapshot.js';
import * as update from '../../src/platform/update.js';
import { Memory } from '../support.js';
import { copyCLI } from '../copy.js';

// One recorded command, with its typed input, the version it ran as, and its output and error.
interface Record {
  name: string;
  args: string[];
  input: string;
  output: string;
  error: string;
  version: string;
}

test(
  'connected command workflows match recorded native output and errors',
  {
    skip:
      !['win32', 'linux'].includes(process.platform) &&
      'Native command captures are recorded only for Windows and Linux.',
  },
  async t => {
    const references = JSON.parse(
      readFileSync(
        new URL('../../../test/fixtures/cli/workflow-' + process.platform + '.json', import.meta.url),
        'utf8',
      ),
    ) as Record[];

    // Private folders for the source, config, cache and restore target.
    const parent = await mkdtemp(path.join(os.tmpdir(), 'frost-cli-workflow-'));
    const src = path.join(parent, 'src');
    const conf = path.join(parent, 'config');
    const cache = path.join(parent, 'cache');
    const target = path.join(parent, 'target');
    const endpoint = 'http://localhost:9000';
    for (const dir of [src, conf, cache, target]) await mkdir(dir, { mode: 0o700 });
    await writeFile(path.join(src, 'todo.txt'), 'buy milk', { mode: 0o600 });
    await writeFile(path.join(src, 'junk.tmp'), 'skip', { mode: 0o600 });

    // Clear VISUAL and EDITOR, so config edit picks the platform's default editor whatever this machine has set.
    const saved = {
      config: process.env.FROST_CONFIG_DIR,
      cache: process.env.FROST_CACHE_DIR,
      visual: process.env.VISUAL,
      editor: process.env.EDITOR,
    };
    process.env.FROST_CONFIG_DIR = conf;
    process.env.FROST_CACHE_DIR = cache;
    process.env.VISUAL = '';
    process.env.EDITOR = '';

    // The recordings used S3 storage, so the memory backend reports S3 addresses.
    const memory = new Memory();
    const key = Key.fromMaster(Buffer.alloc(32));
    memory.toString = () => 's3://backups/frost/';
    memory.place = 's3://localhost:9000/backups/frost/';
    const hooks: Partial<Hooks> = {
      backend: () => memory,
      syncSchedule: async () => {},
      scheduleKind: async () => 'test scheduler',
      scheduleInstalled: async () => true,
      // Every scheduled run is due. The decision has its own tests.
      scheduledDue: async () => true,
      // A fixed clock keeps the next-backup row from depending on when the test runs.
      clock: () => new Date(2026, 9, 17, 12, 0),
      // No background process ever starts in tests.
      syncLater: () => undefined,
      bootTime: () => 0,
      newKey: () => key,
      pickWords: () => [2, 17],
      openBrowser: async () => {
        throw new Error('no browser in tests');
      },
      latestRelease: async () => {
        throw new Error('no network in tests');
      },
      installRelease: async () => {
        throw new Error('no updates in tests');
      },
    };

    // Snapshot IDs come from randomBytes(8). During backup commands a counter replaces it, so IDs, and output that
    // shows them, are the same every run. syncBuiltinESMExports passes the patch on to modules that import it by
    // name.
    const originalRandom = crypto.randomBytes;
    let generatingID = false,
      sequence = 0;
    crypto.randomBytes = ((size: number, ...args: unknown[]) => {
      if (generatingID && size === 8 && !args.length) {
        const n = BigInt(++sequence),
          buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE((n << 48n) | n);
        return buffer;
      }
      return Reflect.apply(originalRandom, crypto, [size, ...args]);
    }) as typeof crypto.randomBytes;
    syncBuiltinESMExports();

    // Put randomBytes and the environment back, then remove the folders.
    t.after(async () => {
      crypto.randomBytes = originalRandom;
      syncBuiltinESMExports();
      for (const [name, value] of Object.entries({
        FROST_CONFIG_DIR: saved.config,
        FROST_CACHE_DIR: saved.cache,
        VISUAL: saved.visual,
        EDITOR: saved.editor,
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(parent, { recursive: true, force: true });
      key.destroy();
    });

    // ids lists snapshot IDs in the order they first appear, so normalize can number them.
    const ids: string[] = [];
    const actual: Record[] = [];

    // Runs fn with a quiet Context that shares the test's hooks.
    const withApp = async (fn: (ctx: Context) => Promise<void>) => {
      await fn(new Context({ input: '', write: () => {}, error: () => {}, hooks }));
    };

    // Rewrites the manifest's last backup record as a run with warnings, or as a failure, for status to report.
    const mutateBackup = async (failure = false) =>
      withApp(async ctx => {
        const app = await ctx.openApp();
        try {
          await app.engine.manifest!.putMeta(
            'last_backup',
            failure
              ? { time: new Date().toISOString(), error: 'storage refused' }
              : {
                  time: new Date().toISOString(),
                  snapshot_id: app.engine.lastBackup()!.snapshot_id,
                  skipped: 12,
                  kept: 2,
                  missing: [path.join(src, 'missing')],
                },
          );
        } finally {
          await app.close();
        }
      });

    // Fills the placeholders in recorded args and input with this run's paths.
    const expand = (value: string) =>
      value
        .replaceAll('<src>', src)
        .replaceAll('<config>', conf)
        .replaceAll('<cache>', cache)
        .replaceAll('<target>', target)
        .replaceAll('<parent>', parent)
        .replaceAll('<endpoint>', endpoint);

    for (const record of references) {
      // Some records need files or hooks changed before they run. Changes carry over to the records after them.
      switch (record.name) {
        case 'backup-dry-changes':
          await writeFile(path.join(src, 'todo.txt'), 'buy oat milk');
          await writeFile(path.join(src, 'new.txt'), 'hello', { mode: 0o600 });
          break;
        case 'backup-deletion':
          await rm(path.join(src, 'new.txt'));
          break;
        case 'status-warning':
          await mutateBackup();
          break;
        case 'status-failed':
          await mutateBackup(true);
          break;
        case 'status-schedule-missing':
          hooks.scheduleInstalled = async () => false;
          break;
        case 'config-reinstall-failed':
          hooks.syncSchedule = async () => {
            throw new Error('scheduler refused');
          };
          break;
        case 'config-edit-reject':
          hooks.syncSchedule = async () => {};
          hooks.scheduleInstalled = async () => true;
          hooks.openEditor = async (_args, file) => {
            const raw = await readFile(file, 'utf8');
            await writeFile(file, raw.replace('every = "daily"', 'every = "6h"'));
          };
          break;
        case 'config-edit-unchanged':
          hooks.openEditor = async () => {};
          break;
        case 'status-verification-failed':
          // Corrupt the first chunk of a file in the newest snapshot.
          await withApp(async ctx => {
            const app = await ctx.openApp();
            try {
              const tree = await app.engine.repo.loadTree(ids.at(-1)!);
              const file = tree.files.find(f => f.type === 'file' && f.chunks?.length)!;
              await memory.put(chunkKey(file.chunks![0]), Buffer.from('broken'));
            } finally {
              await app.close();
            }
          });
          break;
        case 'update-check':
          hooks.selfPath = () => '/opt/frost/bin/frost';
          hooks.canReplace = async () => {};
          hooks.latestRelease = async () => ({
            version: 'v0.2.0',
            archive: 'frost_x.tar.gz',
            page: 'https://example.com/v0.2.0',
            sum: Buffer.alloc(32),
          });
          hooks.installRelease = async () => {};
          break;
        case 'update-unwritable':
          hooks.canReplace = async () => {
            throw new Error('installation is read-only');
          };
          break;
        case 'update-install-failed':
          hooks.canReplace = async () => {};
          hooks.installRelease = async () => {
            throw new Error('installation refused');
          };
          break;
        case 'update-none':
          hooks.latestRelease = async () => {
            throw update.errNoRelease;
          };
          break;
        case 'update-current':
          hooks.latestRelease = async () => ({ version: 'v0.1.0', archive: '', page: '', sum: Buffer.alloc(32) });
          break;
        case 'update-fetch-failed':
          hooks.latestRelease = async () => {
            throw new Error('release server refused');
          };
          break;
        case 'update-path-failed':
          hooks.selfPath = () => {
            throw new Error('installation missing');
          };
          break;
      }

      // Run the command, keeping its output and the message of any error it throws.
      let output = '',
        error = '';
      const ctx = new Context({
        input: expand(record.input),
        write: s => {
          output += s;
        },
        error: () => {},
        hooks,
        version: record.version,
      });
      generatingID = record.args[0] === 'backup';
      try {
        await run(record.args.map(expand), ctx);
      } catch (failure) {
        error = (failure as Error).message;
      } finally {
        generatingID = false;
        await ctx.closePrompts();
      }
      actual.push({ ...record, output, error });

      // Note the newest snapshot ID. Before init there's no app to open, so failures are ignored.
      await withApp(async ctx => {
        let app;
        try {
          app = await ctx.openApp();
          const id = app.engine.lastBackup()?.snapshot_id;
          if (id && !ids.includes(id)) ids.push(id);
        } catch {
        } finally {
          await app?.close();
        }
      });
    }

    // Swaps paths, snapshot IDs, dates, times and ages for placeholders. Each path is tried in native, forward
    // slash and ~ forms.
    const normalize = (value: string) => {
      for (const [from, to] of [
        [src, '<src>'],
        [conf, '<config>'],
        [cache, '<cache>'],
        [target, '<target>'],
        [parent, '<parent>'],
        [endpoint, '<endpoint>'],
      ])
        for (const form of [from, from.replaceAll('\\', '/'), tildify(from), tildify(from.replaceAll('\\', '/'))])
          value = value.replaceAll(form, to);
      ids.forEach((id, i) => {
        value = value.replaceAll(id, `<snapshot${i + 1}>`).replaceAll(short(id), `<snapshot${i + 1}>`);
      });
      return value
        .replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, '<date>')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g, '<time>')
        .replace(/(?:moments|\d+[mhd]) ago/g, '<age> ago')
        .replace(/~in \d+[mhd]/g, '~in <duration>');
    };

    // Collect every mismatch, so one run reports them all.
    const differences: string[] = [];
    for (let i = 0; i < references.length; i++) {
      const expected = references[i];
      const observed = actual[i];
      try {
        assert.equal(normalize(observed.output), copyCLI(expected.output), expected.name + ' output');
        assert.equal(normalize(observed.error), copyCLI(expected.error), expected.name + ' error');
      } catch (error) {
        differences.push((error as Error).message);
      }
    }
    assert.deepEqual(differences, []);
  },
);
