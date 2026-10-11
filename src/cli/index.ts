// Command-line parsing and dispatch. `execute` runs one command and turns errors into the exit code
// and error line that main.ts and the tests see.

import * as config from '../core/config.js';
import { APIError } from '../core/storage.js';
import { Context, type ContextOptions } from './context.js';
import { commands, rootHelp } from './help.js';
import { runBackup } from './backup.js';
import { runRestore } from './restore.js';
import { runStatus } from './status.js';
import { runConfig } from './config.js';
import { runKey } from './key.js';
import { runUpdate } from './update.js';
import { runInit } from './init.js';

export { Context, type ContextOptions };

interface Parsed {
  command: string;
  args: string[];
  flags: Map<string, string[]>;
}

// Flags each command accepts. A bool flag takes no value, a value flag takes one and an array flag can repeat.
const defs: Record<string, Record<string, 'bool' | 'value' | 'array'>> = {
  '': {},
  init: {},
  backup: {
    'dry-run': 'bool',
    path: 'array',
    exclude: 'array',
    'no-verify': 'bool',
    scheduled: 'bool',
    'log-file': 'value',
  },
  restore: { beside: 'bool', to: 'value', overwrite: 'bool', yes: 'bool' },
  status: { verify: 'bool', all: 'bool' },
  browse: {},
  config: { 'show-secrets': 'bool' },
  key: {},
  update: { check: 'bool' },
};

// Flags every command accepts.
const global: Partial<Record<string, 'bool' | 'value' | 'array'>> = {
  help: 'bool',
  version: 'bool',
  'config-dir': 'value',
  'cache-dir': 'value',
};

const aliases: Record<string, string> = { h: 'help', v: 'version', n: 'dry-run', y: 'yes', a: 'all' };

// Parses argv with the rules and error wording of the cobra and pflag libraries, which the CLI fixtures
// record.
export function parse(argv: string[]): Parsed {
  const names = new Set(commands.map(c => c[0].split(' ')[0]));
  let command = '';
  let args: string[] = [];
  let passthrough = false;
  const flags = new Map<string, string[]>();

  // The first pass finds the command word, so an unknown command is reported before any flag error. A
  // flag that isn't a global bool is taken to use the next word as its value.
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (token.startsWith('-') && token !== '-') {
      const name = token.startsWith('--') ? token.slice(2).split('=')[0] : aliases[token[1]];
      const type = global[name];
      if (type !== 'bool' && !token.includes('=')) i++;
      continue;
    }
    if (!names.has(token)) throw new Error(`unknown command ${JSON.stringify(token)} for "frost"`);
    break;
  }

  // The second pass reads the flags and arguments. Everything after `--` is an argument.
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--' && !passthrough) {
      passthrough = true;
      continue;
    }

    if (!passthrough && token.startsWith('-') && token !== '-') {
      let name: string, inline: string | undefined;
      if (token.startsWith('--')) {
        const eq = token.indexOf('=');
        name = token.slice(2, eq < 0 ? undefined : eq);
        inline = eq < 0 ? undefined : token.slice(eq + 1);
      } else {
        // A shorthand flag must be global or belong to this command. -v only works before a command.
        const letter = token[1];
        name = aliases[letter] ?? '';
        if (!name || !((name in global && !(command && name === 'version')) || name in (defs[command] ?? {})))
          throw new Error(`unknown shorthand flag: '${letter}' in ${token}`);

        // `-n=false` carries a value, and `-ny` is read as `-n -y`.
        if (token.length > 2) {
          if (token[2] === '=') inline = token.slice(3);
          else {
            argv = [...argv.slice(0, i + 1), '-' + token.slice(2), ...argv.slice(i + 1)];
          }
        }
      }

      const type = (name === 'version' && command ? undefined : global[name]) ?? defs[command]?.[name];
      if (!type) throw new Error('unknown flag: --' + name);
      if (type === 'bool') {
        // Accepts the same spellings as Go's strconv.ParseBool, and reports errors in its words.
        const value = inline ?? 'true';
        const short = Object.entries(aliases).find(([, long]) => long === name)?.[0];
        const label = (short ? '-' + short + ', ' : '') + '--' + name;
        if (!/^(true|false|1|0|t|f|TRUE|FALSE|T|F|True|False)$/.test(value))
          throw new Error(
            `invalid argument ${JSON.stringify(value)} for ${JSON.stringify(label)} flag: strconv.ParseBool: parsing ${JSON.stringify(value)}: invalid syntax`,
          );
        flags.set(name, [/^(true|1|t)$/i.test(value) ? 'true' : 'false']);
      } else {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new Error('flag needs an argument: --' + name);
        flags.set(name, type === 'array' ? [...(flags.get(name) ?? []), value] : [value]);
      }
    } else if (!command) {
      if (!names.has(token)) throw new Error(`unknown command ${JSON.stringify(token)} for "frost"`);
      command = token;
    } else args.push(token);
  }

  return { command, args, flags };
}

const bool = (p: Parsed, name: string) => p.flags.get(name)?.[0] === 'true';
const string = (p: Parsed, name: string) => p.flags.get(name)?.[0] ?? '';

// Parses argv and runs the command. Errors are thrown for `execute` to print.
export async function run(argv: string[], ctx = new Context()): Promise<void> {
  const p = parse([...argv]);
  if (bool(p, 'help') || (!p.command && !bool(p, 'version'))) {
    rootHelp(ctx.fmt, config.dir(), ctx.width);
    return;
  }
  if (bool(p, 'version')) {
    ctx.fmt.write('frost version ' + ctx.version + '\n');
    return;
  }

  // The config module reads these folders from the environment.
  if (string(p, 'config-dir')) process.env.FROST_CONFIG_DIR = string(p, 'config-dir');
  if (string(p, 'cache-dir')) process.env.FROST_CACHE_DIR = string(p, 'cache-dir');

  if (['init', 'backup', 'status', 'browse', 'update'].includes(p.command) && p.args.length)
    throw new Error(`unknown command ${JSON.stringify(p.args[0])} for "frost ${p.command}"`);
  if (p.command === 'key' && p.args.length !== 1) throw new Error(`accepts 1 arg(s), received ${p.args.length}`);

  switch (p.command) {
    case 'init':
      return runInit(ctx);
    case 'backup':
      return runBackup(ctx, {
        paths: p.flags.get('path') ?? [],
        exclude: p.flags.get('exclude') ?? [],
        dryRun: bool(p, 'dry-run'),
        noVerify: bool(p, 'no-verify'),
        scheduled: bool(p, 'scheduled'),
        logFile: string(p, 'log-file'),
      });
    case 'restore':
      return runRestore(ctx, p.args, {
        beside: bool(p, 'beside'),
        to: string(p, 'to'),
        overwrite: bool(p, 'overwrite'),
        yes: bool(p, 'yes'),
      });
    case 'status':
      return runStatus(ctx, bool(p, 'verify'), bool(p, 'all'));
    case 'browse':
      // The TUI only loads when it's needed.
      if (ctx.hooks.browser) return ctx.hooks.browser(ctx);
      return (await import('./tui.js')).runBrowser(ctx);
    case 'config':
      return runConfig(ctx, p.args, bool(p, 'show-secrets'));
    case 'key':
      return runKey(ctx, p.args[0]);
    case 'update':
      return runUpdate(ctx, bool(p, 'check'));
  }
}

// Replaces a rejected Permafrost key, even one buried in an error's causes, with advice on fixing it. The
// server's own reason comes first when it gave one.
function plainError(err: unknown): unknown {
  if (err instanceof APIError && err.status === 401)
    return new Error(
      'the Permafrost access key was rejected' +
        (err.detail ? ': ' + err.detail + '.' : ', it may be wrong or expired.') +
        ' Run `frost init` and set up storage again to get a working one',
    );
  if ((err as Error)?.cause) {
    const mapped = plainError((err as Error).cause);
    if (mapped !== (err as Error).cause) return mapped;
  }
  return err;
}

// Runs one command and returns its exit code, printing any error it throws.
export async function execute(argv = process.argv.slice(2), options: ContextOptions = {}): Promise<number> {
  const ctx = new Context(options);

  // Windows consoles need ANSI sequences switched on. The original console mode comes back at the end.
  const console = ctx.hooks.enableANSI();
  ctx.setANSI(ctx.ansiOK && console.ansiOK);

  try {
    await run(argv, ctx);
    return 0;
  } catch (err) {
    // When stdout and stderr share a terminal, the error closes the open block with └. Otherwise it
    // stands on its own.
    const closes = ctx.fmt.blockOpen && ctx.outputTTY && ctx.errorTTY;
    ctx.error((closes ? '' : '\n') + ctx.fmt.errorLine(plainError(err), closes) + '\n\n');
    return 1;
  } finally {
    try {
      await ctx.closePrompts();
    } finally {
      console.restore();
    }
  }
}
