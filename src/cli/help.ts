// The shared help screen every -h shows: wordmark, description, commands and flags. Details belong in
// docs/CLI.md.

import { readFileSync } from 'node:fs';
import { Format, tildify } from './format.js';

// Each command with its usage and summary. The parser takes command names from here too.
export const commands = [
  ['init', 'Set up frost: what to back up, where, and how often'],
  ['backup', 'Back up now'],
  ['restore [snapshot] [paths...]', 'Get files back from a snapshot'],
  ['status', 'Show recent snapshots, schedule and backup health'],
  ['browse', 'Open the snapshot browser'],
  ['config [get|set|edit]', 'Read or change settings without rerunning init'],
  ['key <show|verify|import>', 'Show, check or import your recovery phrase'],
  ['update', 'Update frost to the latest release'],
] as const;

// Flags that only one command takes, listed under that command's name.
const local = [
  [
    'backup',
    [
      ['-n, --dry-run', 'show what would be uploaded without uploading anything'],
      ['    --path <dir>', 'back up this directory instead of the configured ones (repeatable)'],
      ['    --exclude <pattern>', 'also skip files matching this pattern (repeatable)'],
      ['    --no-verify', 'skip the spot check after the backup'],
    ],
  ],
  [
    'restore',
    [
      ['    --beside', 'restore into a new folder next to the originals'],
      ['    --to <dir>', 'restore into a new folder inside this directory'],
      ['    --overwrite', "restore over the originals, replacing what's there (asks first)"],
      ['-y, --yes', "don't ask before overwriting"],
    ],
  ],
  [
    'status',
    [
      ['    --verify', 'run a verification now'],
      ['-a, --all', 'list every snapshot, not just the latest 10'],
    ],
  ],
  ['config', [['    --show-secrets', 'print credentials in full']]],
  ['update', [['    --check', "only say whether there's a newer release"]]],
] as const;

export function rootHelp(fmt: Format, configDir: string, width = 0): void {
  fmt.write('\n');

  // The wordmark only shows when the terminal is wide enough for it.
  const mark = readFileSync(new URL('../../assets/wordmarks/frost-wordmark.txt', import.meta.url), 'utf8').trimEnd();
  const rows = mark.split('\n');
  if (mark && width > 3 + [...rows[0]].length) {
    rows.forEach(l => fmt.write('   ' + fmt.rail(l) + '\n'));
    fmt.write('\n');
  }

  fmt.write(
    "   frost backs up your directories to Permafrost, S3-compatible storage, your\n   own server over SSH or a local drive. Everything is encrypted on this\n   machine before it's uploaded. Nobody else can read your files, not\n   whoever stores them and not the frost authors.\n",
  );

  const flags = [
    ['    --config-dir <dir>', 'use a different config directory (default ' + tildify(configDir) + ')'],
    ['-h, --help', 'show this help'],
    ['-v, --version', "show frost's version"],
  ];

  // Every description starts in the same column, across all the lists.
  const w = Math.max(
    ...commands.map(r => r[0].length),
    ...flags.map(r => r[0].length),
    ...local.flatMap(s => s[1].map(r => r[0].length)),
  );

  const b = fmt.block();
  b.open('frost <command> [flags]');
  b.gap();
  const line = (row: readonly string[]) => b.line(row[0].padEnd(w) + '    ' + row[1]);
  commands.forEach(line);
  b.gap();
  b.section('flags');
  b.gap();
  flags.forEach(line);
  local.forEach(([name, rows]) => {
    b.gap();
    b.line(name + ':');
    rows.forEach(line);
  });
  b.gap();
  b.close();
}
