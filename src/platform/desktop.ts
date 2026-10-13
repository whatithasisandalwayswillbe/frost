// Opens links and folders, reveals files, launches an editor and shows a native folder picker.
// Tests pass a runner so nothing real opens.
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { run, type Runner } from './command.js';
import { loadFFI, type FFIType } from './ffi-loader.js';

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
  options.signal?.throwIfAborted();
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? run;
  let result;

  if (platform === 'win32') {
    if (title.includes('\0') || startDir.includes('\0')) throw new Error('invalid folder picker text');
    // The bundled runtime opens the modal dialog off the terminal thread and closes it on cancellation.
    const script = `
      import { pickWindowsFolder } from ${JSON.stringify(import.meta.url)};
      try {
        let input = '';
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) input += chunk;
        const { title, start } = JSON.parse(input);
        process.stdout.write(pickWindowsFolder(title, start));
      } catch (error) {
        process.stderr.write(error.message);
        process.exitCode = 2;
      }
    `;
    result = await runner(
      process.execPath,
      ['--input-type=module', '-e', script],
      JSON.stringify({ title, start: startDir }),
      options.signal,
    );
    // Cancellation succeeds with no selection. Every nonzero exit is a failure and triggers the typed fallback.
    if (result.code) throw new Error(result.stderr || 'folder picker failed');
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

const pickerMemory = new Set<Buffer[]>();

// Called in the child above. IFileOpenDialog supplies Explorer's full folder view through fixed Windows APIs.
export function pickWindowsFolder(title: string, start: string): string {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('unsupported Windows folder picker ABI');
  const ffi = loadFFI();
  const def = (returns: FFIType, ...args: FFIType[]) => ({ return: returns, arguments: args });
  const ole = ffi.dlopen('ole32.dll', {
    CoInitializeEx: def('int32', 'pointer', 'uint32'),
    CoUninitialize: def('void'),
    CoCreateInstance: def('int32', 'pointer', 'pointer', 'uint32', 'pointer', 'pointer'),
    CoTaskMemFree: def('void', 'pointer'),
  }).functions;
  const shell = ffi.dlopen('shell32.dll', {
    SHCreateItemFromParsingName: def('int32', 'pointer', 'pointer', 'pointer', 'pointer'),
  }).functions;
  const automation = ffi.dlopen('oleaut32.dll', {
    DispCallFunc: def('int32', 'pointer', 'uint64', 'int32', 'uint16', 'uint32', 'pointer', 'pointer', 'pointer'),
  }).functions;
  const memory = ffi.dlopen('kernel32.dll', {
    lstrlenW: def('int32', 'pointer'),
    RtlMoveMemory: def('void', 'pointer', 'pointer', 'uint64'),
  }).functions;
  const fixed = (size: number) => Buffer.from(new ArrayBuffer(size));
  const wide = (value: string) => {
    if (value.includes('\0')) throw new Error('invalid folder picker text');
    return Buffer.from(value + '\0', 'utf16le');
  };
  const check = (status: number, operation: string) => {
    if (status & 0x80000000) throw new Error(`${operation} failed (0x${(status >>> 0).toString(16)})`);
  };
  // DispCallFunc bridges COM's vtable using 24-byte VARIANTs: type at 0, value at 8. Pointers use VT_UI8,
  // flags use VT_UI4, and HRESULT returns use VT_I4. All slots and offsets below use the 64-bit Windows ABI.
  const call = (object: bigint, slot: number, args: (number | bigint | Buffer)[] = [], returns = 3): number => {
    const types = fixed(args.length * 2),
      pointers = fixed(args.length * 8),
      result = fixed(24);
    const values = args.map((arg, i) => {
      const value = fixed(24),
        type = typeof arg === 'number' ? 19 : 21;
      value.writeUInt16LE(type);
      types.writeUInt16LE(type, i * 2);
      if (typeof arg === 'number') value.writeUInt32LE(arg >>> 0, 8);
      else value.writeBigUInt64LE(typeof arg === 'bigint' ? arg : ffi.getRawPointer(arg), 8);
      pointers.writeBigUInt64LE(ffi.getRawPointer(value), i * 8);
      return value;
    });
    const retained = [types, pointers, result, ...values, ...args.filter((arg): arg is Buffer => Buffer.isBuffer(arg))];
    pickerMemory.add(retained);
    try {
      check(
        Number(automation.DispCallFunc(object, BigInt(slot * 8), 4, returns, args.length, types, pointers, result)),
        'DispCallFunc',
      );
      return result.readUInt32LE(8);
    } finally {
      pickerMemory.delete(retained);
    }
  };
  const release = (object: bigint) => call(object, 2, [], 19);
  const output = (operation: string, action: (out: Buffer) => number): bigint => {
    const out = fixed(8);
    check(action(out), operation);
    const pointer = out.readBigUInt64LE();
    if (!pointer) throw new Error(`${operation} returned no result`);
    return pointer;
  };
  // CLSID_FileOpenDialog, IID_IFileOpenDialog and IID_IShellItem in native GUID byte order.
  const clsid = Buffer.from('9c5a1cdc8ae8de4da5a160f82a20aef7', 'hex');
  const dialogIID = Buffer.from('88727cd5add46847be029d969532d960', 'hex');
  const itemIID = Buffer.from('1e6d824318e7ee42bc55a1e261c37bfe', 'hex');
  check(Number(ole.CoInitializeEx(null, 2)), 'CoInitializeEx');
  let dialog = 0n;
  try {
    dialog = output('CoCreateInstance', out => Number(ole.CoCreateInstance(clsid, null, 1, dialogIID, out)));
    const options = fixed(4);
    check(call(dialog, 10, [options]), 'GetOptions');
    // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR.
    check(call(dialog, 9, [options.readUInt32LE() | 0x868]), 'SetOptions');
    check(call(dialog, 17, [wide(title)]), 'SetTitle');
    if (start) {
      let item = 0n;
      try {
        item = output('SHCreateItemFromParsingName', out =>
          Number(shell.SHCreateItemFromParsingName(wide(start), null, itemIID, out)),
        );
        check(call(dialog, 12, [item]), 'SetFolder');
      } catch {
        // Windows uses its default folder if the starting location is no longer available.
      } finally {
        if (item) release(item);
      }
    }
    const shown = call(dialog, 3, [0n]);
    if (shown === 0x800704c7) return '';
    check(shown, 'Show');
    const item = output('GetResult', out => call(dialog, 20, [out]));
    try {
      const text = output('GetDisplayName', out => call(item, 5, [0x80058000, out]));
      try {
        const length = Number(memory.lstrlenW(text));
        if (length <= 0 || length > 32767) throw new Error('invalid folder picker result');
        const buffer = fixed(length * 2);
        memory.RtlMoveMemory(buffer, text, BigInt(buffer.length));
        return buffer.toString('utf16le');
      } finally {
        ole.CoTaskMemFree(text);
      }
    } finally {
      release(item);
    }
  } finally {
    try {
      if (dialog) release(dialog);
    } finally {
      ole.CoUninitialize();
    }
  }
}
