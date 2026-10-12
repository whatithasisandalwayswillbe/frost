// Builds a command that can be pasted into a shell without expanding its arguments.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function frostCommand(args: string[], platform: NodeJS.Platform = process.platform): string {
  // Older PowerShell drops empty arguments, strips double quotes and misreads a trailing backslash
  // inside quotes. Restore paths are normalized first; settings with these forms use the editor.
  if (platform === 'win32' && args.some(s => !s || /["\r\n]/.test(s) || (/\s/.test(s) && s.endsWith('\\'))))
    throw new Error('use frost config edit for this value');
  if (platform === 'win32' && args.some(s => /[$`%!&|<>^()]/.test(s))) {
    const script = process.env.FROST_APP_ROOT
      ? path.join(process.env.FROST_APP_ROOT, 'launch.mjs')
      : fileURLToPath(new URL('./main.js', import.meta.url));
    return '& ' + [process.execPath, script, ...args].map(s => "'" + s.replaceAll("'", "''") + "'").join(' ');
  }
  const quote =
    platform === 'win32'
      ? (s: string) => (/^[\w.:\\/-]+$/.test(s) ? s : '"' + s + '"')
      : (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'");
  return ['frost', ...args.map(quote)].join(' ');
}
