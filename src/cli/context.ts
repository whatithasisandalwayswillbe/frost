// The Context every command runs with: output and input streams, terminal facts, prompts and the hooks
// that tests replace. `openApp` opens the config, key, storage and manifest for commands that need them.

import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../core/config.js';
import { Key } from '../core/crypto.js';
import { Repo, errNotInitialized, errWrongKey } from '../core/repo.js';
import { Manifest } from '../core/manifest.js';
import { MissingRootError, newBackend, type Backend } from '../core/storage.js';
import { sshProgram } from '../core/sftp.js';
import { ensureKey, installArgs } from '../core/sshkey.js';
import { Engine } from '../engine/index.js';
import * as schedule from '../platform/schedule.js';
import * as update from '../platform/update.js';
import * as desktop from '../platform/desktop.js';
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Format, type Writer } from './format.js';
import { Prompter } from './prompt.js';
import { code } from '../engine/types.js';
import { version } from './version.js';
import { terminalProfile, type ColorProfile } from './terminal.js';
import { enableANSI, type ConsoleState } from '../platform/console.js';
import { rememberStorage, cantOpen } from './known.js';
import { bootTime, rememberInstall, scheduledDue } from './runs.js';

export const errNoKey = new Error('no key on this machine, run `frost init` or `frost key import`');
export const errBusy = new Error("a backup or restore is already running, try again when it's done");

// What a command gets from `openApp`. `close` releases the manifest and its lock.
interface App {
  cfg: config.Config;
  engine: Engine;
  close: () => Promise<void>;
}

// Everything that reaches outside the process: storage, the scheduler, editors, the browser, updates and the
// clock. Tests replace these so they never touch the real machine.
export interface Hooks {
  enableANSI: () => ConsoleState;
  backend: (storage: config.Storage) => Backend;
  syncSchedule: (cfg: config.Config) => Promise<void>;
  scheduleKind: () => Promise<string>;
  scheduleInstalled: () => Promise<boolean>;
  scheduledDue: (now: Date) => Promise<boolean>;
  syncLater: () => number | undefined;
  bootTime: () => number;
  clock: () => Date;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  newKey: () => Key;
  pickWords: () => [number, number];
  openEditor: (command: string[], file: string) => Promise<void>;
  openBrowser: (url: string) => Promise<void>;
  reveal: (file: string) => Promise<void>;
  // frost's own SSH key for self-hosted storage, made on first use, as its public authorized_keys line.
  sshKey: () => Promise<string>;
  // Runs ssh in the terminal to add a line to the server's authorized_keys. ssh asks for the password itself.
  sshInstall: (host: string, port: number, line: string) => Promise<void>;
  latestRelease: (signal?: AbortSignal) => Promise<update.Release>;
  installRelease: (release: update.Release, root: string, signal?: AbortSignal) => Promise<void>;
  selfPath: () => string | Promise<string>;
  canReplace: (root: string) => Promise<void>;
  scheduledLog?: (
    path: string,
  ) => Promise<{ write(data: string | Buffer): Promise<{ bytesWritten: number }>; close(): Promise<void> }>;
  browser?: (ctx: Context) => Promise<void>;
  setup?: (ctx: Context, cfg: config.Config, existing: boolean, local?: Key) => Promise<void>;
}

// The script frost runs itself with. An installed package uses its launcher, which always runs the active
// version. A source build uses this main.js directly.
const frostScript = () =>
  process.env.FROST_APP_ROOT
    ? path.join(process.env.FROST_APP_ROOT, 'launch.mjs')
    : fileURLToPath(new URL('./main.js', import.meta.url));

// The command for the background process that applies a schedule change once a running scheduled backup
// finishes. It inherits the environment, which holds the config and cache folders.
export const syncLaterCommand = (): [string, string[]] => [
  process.execPath,
  [frostScript(), 'config', '--after-backup'],
];

function defaultHooks(): Hooks {
  return {
    enableANSI,
    backend: newBackend,

    // The install time is recorded first, so a run the install starts straight away, like launchd's at load,
    // doesn't count as catching up.
    syncSchedule: async cfg => {
      if (!cfg.schedule.enabled) await schedule.remove();
      else {
        const times = config.times(cfg.schedule);
        await mkdir(config.cacheDir(), { recursive: true, mode: 0o700 });
        await rememberInstall(new Date());
        await schedule.install({
          binary: process.execPath,
          script: frostScript(),
          ...times,
          catchUp: cfg.schedule.catch_up,
          configDir: path.resolve(config.dir()),
          cacheDir: path.resolve(config.cacheDir()),
          logFile: path.resolve(config.cacheDir(), 'frost.log'),
        });
      }
    },
    scheduleKind: schedule.kind,
    scheduleInstalled: schedule.installed,
    scheduledDue,

    // Detached from this process and its terminal, so it outlives both, with no window and no output.
    // Returns its process id.
    syncLater: () => {
      const [command, args] = syncLaterCommand();
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
      return child.pid;
    },
    bootTime,
    clock: () => new Date(),
    wait: async (ms, signal) => {
      await delay(ms, undefined, { signal });
    },
    newKey: Key.new,

    // Two different positions in the 24-word phrase, in order, to quiz after showing a new phrase.
    pickWords: () => {
      let a = Math.floor(Math.random() * 24);
      let b = a;
      while (a === b) b = Math.floor(Math.random() * 24);
      return [Math.min(a, b), Math.max(a, b)];
    },

    // Runs the editor without a shell, so nothing in the command or file name gets interpreted.
    openEditor: async (editor, file) => {
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor[0], [...editor.slice(1), file], {
          stdio: 'inherit',
          windowsHide: true,
          shell: false,
        });
        child.once('error', reject);
        child.once('exit', n => (n ? reject(new Error('exit status ' + n)) : resolve()));
      });
    },
    openBrowser: desktop.openBrowser,
    reveal: desktop.reveal,
    sshKey: () => ensureKey(),

    // The line goes in on standard input, while ssh talks to the terminal for the password and, the first
    // time, the server's fingerprint.
    sshInstall: (host, port, line) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(sshProgram(), installArgs(host, port), {
          stdio: ['pipe', 'inherit', 'inherit'],
          windowsHide: false,
        });
        child.once('error', error =>
          reject(code(error) === 'ENOENT' ? new Error("the OpenSSH client (ssh) isn't installed") : error),
        );
        child.once('close', status =>
          status === 0 ? resolve() : reject(new Error('ssh stopped' + (status === null ? '' : ' with code ' + status))),
        );
        child.stdin.on('error', () => {});
        child.stdin.end(line + '\n');
      }),
    latestRelease: signal => update.latest({ signal, userAgent: 'frost/' + version }),
    installRelease: (rel, root, signal) => update.installRelease(rel, root, { signal }),
    selfPath: update.executable,
    canReplace: update.canReplace,
  };
}

// Anything left out falls back to the real process streams and terminal.
export interface ContextOptions {
  input?: string | NodeJS.ReadableStream;
  write?: Writer;
  error?: Writer;
  colors?: boolean;
  colorProfile?: ColorProfile;
  ansiOK?: boolean;
  inputTTY?: boolean;
  outputTTY?: boolean;
  errorTTY?: boolean;
  width?: number;
  signal?: AbortSignal;
  hooks?: Partial<Hooks>;
  version?: string;
}

export class Context {
  private prompts: Prompter[] = [];
  fmt: Format;
  input: NodeJS.ReadableStream;
  error: Writer;
  ansiOK: boolean;
  inputTTY: boolean;
  outputTTY: boolean;
  errorTTY: boolean;
  width: number;
  hooks: Hooks;
  version: string;
  signal?: AbortSignal;

  constructor(opts: ContextOptions = {}) {
    this.input = typeof opts.input === 'string' ? Readable.from([opts.input]) : (opts.input ?? process.stdin);

    // A stream passed in by a caller is never treated as a terminal unless the caller says so.
    this.inputTTY = opts.inputTTY ?? (opts.input === undefined && !!process.stdin.isTTY);
    this.outputTTY = opts.outputTTY ?? (opts.write === undefined && !!process.stdout.isTTY);
    this.errorTTY = opts.errorTTY ?? (opts.error === undefined && !!process.stderr.isTTY);

    // `colors: true` forces full colour. Otherwise the terminal decides.
    const profile = opts.colorProfile ?? (opts.colors === true ? 'truecolor' : terminalProfile(this.outputTTY));
    this.fmt = new Format(
      opts.write ??
        (s => {
          process.stdout.write(s);
        }),
      opts.colors ?? profile !== 'ascii',
      profile,
    );
    this.ansiOK = opts.ansiOK ?? true;
    this.setANSI(this.ansiOK);
    this.error =
      opts.error ??
      (s => {
        process.stderr.write(s);
      });
    this.width = opts.width ?? (this.outputTTY ? process.stdout.columns : 0);
    this.hooks = { ...defaultHooks(), ...opts.hooks };
    this.version = opts.version ?? version;
    this.signal = opts.signal;
  }

  // Without working ANSI sequences, output drops all styling.
  setANSI(usable: boolean): void {
    this.ansiOK = usable;
    if (!usable) {
      this.fmt.colors = false;
      this.fmt.profile = 'ascii';
    }
  }

  // Prompters are tracked so `closePrompts` can detach them from the input when the command ends.
  prompt(): Prompter {
    const prompt = new Prompter(this.fmt, this.input, this.inputTTY, this.signal);
    this.prompts.push(prompt);
    return prompt;
  }

  async closePrompts(): Promise<void> {
    for (const prompt of this.prompts) await prompt.closeInput();
    this.prompts = [];
  }

  // The key file holds the recovery phrase.
  async loadKey(): Promise<Key> {
    let phrase: string;
    try {
      phrase = await readFile(config.keyPath(), 'utf8');
    } catch (e) {
      if (code(e) === 'ENOENT') throw errNoKey;
      throw e;
    }
    try {
      return Key.fromPhrase(phrase);
    } catch (e) {
      throw new Error(`key file ${config.keyPath()} is damaged: ${(e as Error).message}`, { cause: e });
    }
  }

  async saveKey(key: Key): Promise<void> {
    await mkdir(config.dir(), { recursive: true, mode: 0o700 });
    await config.writePrivate(config.keyPath(), key.phrase() + '\n');
  }

  // Opens the repository and its manifest. If the storage has no repository or a different key, the error
  // says where this machine's backups were last seen. `lockWait` is how long to wait for another frost
  // process to finish with the manifest.
  async openApp(lockWait = 1000): Promise<App> {
    const cfg = await config.load();
    const key = await this.loadKey();
    const backend = this.hooks.backend(cfg.storage);

    let repo: Repo;
    try {
      repo = await Repo.open(backend, key, this.signal);
    } catch (e) {
      const msg = (e as Error).message;
      // A missing folder already names itself, like a drive that isn't connected.
      if (e instanceof MissingRootError) throw e;
      if (e === errNotInitialized)
        throw await cantOpen(`${backend} has no frost repository`, cfg.storage, backend, true);
      if (e === errWrongKey)
        throw await cantOpen(
          `the key on this machine doesn't match the backups in ${backend} (check it with \`frost key verify\`)`,
          cfg.storage,
          backend,
          false,
        );
      throw new Error(`connecting to ${backend}: ${msg}`, { cause: e });
    }
    await rememberStorage(cfg.storage, backend, repo.info.id);

    // The manifest's lock keeps a second frost process out of this repository's cache.
    let manifest: Manifest;
    try {
      manifest = await Manifest.open(
        path.join(config.cacheDir(), 'manifest-' + repo.info.id + '.jsonl'),
        lockWait,
        this.signal,
      );
    } catch (e) {
      if ((e as Error).message.includes('another frost process')) throw errBusy;
      throw e;
    }

    return {
      cfg,
      engine: new Engine(repo, manifest),
      close: async () => {
        await manifest.close();
      },
    };
  }
}
