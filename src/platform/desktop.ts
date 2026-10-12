// Opens links and folders, reveals files, launches an editor and shows a native folder picker.
// Tests pass a runner so nothing real opens.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { run, type Runner } from './command.js';

export const errCanceled = new Error('no folder chosen');

// GUI actions need a local desktop. They're off over SSH, and Linux needs an X11 or Wayland display.
export function available(env = process.env, platform = process.platform): boolean {
  return (
    !(env.SSH_CONNECTION || env.SSH_TTY) &&
    (platform === 'win32' || platform === 'darwin' || !!(env.DISPLAY || env.WAYLAND_DISPLAY))
  );
}

interface DesktopOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runner?: Runner;
  signal?: AbortSignal;
}

// Windows uses url.dll's FileProtocolHandler through rundll32, so no shell parses the target.
export function openCommand(target: string, platform = process.platform): [string, string[]] {
  if (target.includes('\0')) throw new Error('invalid path');
  return platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
    : platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]];
}

// Explorer parses its own command line, so /select gets the quoted path verbatim. xdg-open
// can't select a file, so Linux opens the parent folder.
export function revealCommand(file: string, platform = process.platform): [string, string[]] {
  if (file.includes('\0')) throw new Error('invalid path');
  return platform === 'win32'
    ? ['explorer', ['/select,"' + file + '"']]
    : platform === 'darwin'
      ? ['open', ['-R', file]]
      : ['xdg-open', [path.dirname(file)]];
}

// With an injected runner, waits for it and checks the exit code. Otherwise starts the program
// detached so it outlives frost, and resolves once it has spawned.
async function start(command: [string, string[]], options: DesktopOptions, verbatim = false): Promise<void> {
  if (options.runner) {
    const r = await options.runner(...command);
    if (r.code) throw new Error(r.stderr || r.stdout);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0], command[1], {
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export const openBrowser = (target: string, options: DesktopOptions = {}) =>
  start(openCommand(target, options.platform), options);
export const openFolder = openBrowser;
export const open = openBrowser;
export const reveal = (file: string, options: DesktopOptions = {}) =>
  start(revealCommand(file, options.platform), options, (options.platform ?? process.platform) === 'win32');

// Without $VISUAL or $EDITOR, opens the platform's default text editor. Otherwise splits the
// command into words, honouring simple quotes without a shell, and waits for the editor to exit.
export async function openEditor(
  file: string,
  editor = process.env.VISUAL || process.env.EDITOR,
  options: DesktopOptions = {},
): Promise<void> {
  if (!editor) {
    await start(
      (options.platform ?? process.platform) === 'win32'
        ? ['notepad.exe', [file]]
        : (options.platform ?? process.platform) === 'darwin'
          ? ['open', ['-t', file]]
          : ['xdg-open', [file]],
      options,
    );
    return;
  }
  const words = editor.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(s => s.replace(/^(['"])(.*)\1$/, '$2'));
  if (!words?.length) throw new Error('empty editor');
  const result = await (options.runner ?? run)(words[0], [...words.slice(1), file]);
  if (result.code) throw new Error(result.stderr || result.stdout);
}

// Windows and macOS always have a folder picker. Linux needs zenity or a compatible fork.
export async function canPick(options: DesktopOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (!available(options.env, platform)) return false;
  if (platform === 'win32' || platform === 'darwin') return true;
  for (const program of ['zenity', 'qarma', 'matedialog']) {
    try {
      if (!(await (options.runner ?? run)(program, ['--version'])).code) return true;
    } catch {}
  }
  return false;
}

// Shows a native folder picker and returns the chosen path. Cancelling, or an empty answer,
// throws errCanceled.
export async function pickFolder(title: string, startDir = '', options: DesktopOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? run;
  let result;

  if (platform === 'win32') {
    // A WinForms dialog needs an STA thread. The title and start folder travel as base64, and
    // the script as -EncodedCommand, so nothing needs quoting.
    const ps =
      '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' +
      Buffer.from(title).toString('base64') +
      '")); $d.SelectedPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' +
      Buffer.from(startDir).toString('base64') +
      '")); if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}else{exit 1}; $d.Dispose()';
    result = await runner(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      undefined,
      options.signal,
    );
  } else if (platform === 'darwin') {
    // AppleScript string literals escape backslashes and double quotes. A start folder that doesn't
    // exist makes choose folder fail before the dialog opens, so it's left out then.
    const quote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const start = startDir && (await stat(startDir).catch(() => undefined))?.isDirectory() ? startDir : '';
    result = await runner(
      'osascript',
      [
        '-e',
        `POSIX path of (choose folder with prompt ${quote(title)}${start ? ' default location (POSIX file ' + quote(start) + ')' : ''})`,
      ],
      undefined,
      options.signal,
    );
  } else {
    // Try each zenity-compatible picker until one exists.
    for (const program of ['zenity', 'qarma', 'matedialog']) {
      try {
        result = await runner(
          program,
          ['--file-selection', '--directory', '--title=' + title, ...(startDir ? ['--filename=' + startDir] : [])],
          undefined,
          options.signal,
        );
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    if (!result) throw new Error('no folder picker available');
  }

  const chosen = platform === 'win32' ? result.stdout : result.stdout.replace(/\r?\n$/, '');
  if (result.code || !chosen) throw errCanceled;
  return chosen;
}
