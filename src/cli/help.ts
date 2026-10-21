// The shared help screen every -h shows: wordmark, description, commands and flags. Details belong in
// docs/CLI.md.

import { readFileSync } from 'node:fs';
import { Format, tildify } from './format.js';

// Each command with its usage and summary. The parser takes command names from here too.
export const commands = [
  ['init', 'Set up frost: choose what to back up, where to store it, and how often'],
  ['backup', 'Back up now'],
  ['restore [snapshot] [paths...]', 'Get files back from a snapshot'],
  ['status', 'Show recent snapshots, schedule and backup health'],
  ['browse', 'Open the snapshot browser'],
  ['config [get|set|edit]', 'View or update configuration options without rerunning init'],
  ['key <show|verify|import>', 'Show, check or import your recovery phrase'],
  ['update', 'Update frost to the latest release'],
] as const;

// Flags that only one command takes, listed under that command's name.
const local = [
  [
    'backup',
    [
      ['-n, --dry-run', 'preview changes without transferring data'],
      ['    --path <dir>', 'back up the specified directory instead of configured directories (repeatable)'],
      ['    --exclude <pattern>', 'also exclude files matching this pattern (repeatable)'],
      ['    --no-verify', 'skip the spot check after the backup'],
    ],
  ],
  [
    'restore',
    [
      ['    --beside', 'restore files to a new directory alongside original files'],
      ['    --to <dir>', 'restore files to a new folder within the specified directory'],
      ['    --overwrite', 'restore and overwrite original files (asks first)'],
      ['-y, --yes', "don't ask before overwriting"],
    ],
  ],
  [
    'status',
    [
      ['    --verify', 'run a verification now'],
      ['-a, --all', 'list all snapshots instead of only the 10 most recent'],
    ],
  ],
  ['config', [['    --show-secrets', 'print credentials in full']]],
  ['update', [['    --check', 'check if a newer release is available']]],
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
    '   frost backs up your directories to Permafrost, S3-compatible storage, your\n   own SSH server, or a local drive. All data is encrypted locally before\n   upload. Nobody else can read your files, including storage providers\n   and the creators of frost.\n',
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
