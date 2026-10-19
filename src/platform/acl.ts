// Owner-only folders on Windows. POSIX modes don't apply there, and a file inherits its folder's permissions,
// which can include other accounts. OpenSSH refuses a private key that another account can read.

import path from 'node:path';
import { checked, run, type Runner } from './command.js';

const system = (name: string) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);

// Replaces a folder's permissions with full control for the current account alone, inherited by everything in
// it, including files already there. Does nothing outside Windows, where modes do this job.
export async function ownerOnlyFolder(
  folder: string,
  runner: Runner = run,
  platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') return;
  const account = await checked(runner, system('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-[\d-]+)"/.exec(account)?.[1];
  if (!sid) throw new Error("couldn't find this account's security ID");
  await checked(runner, system('icacls.exe'), [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/q']);
}
