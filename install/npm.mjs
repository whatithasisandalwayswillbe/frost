// The frost command in the getfrost npm package. frost runs on its own bundled runtime, so on first use this installs
// the signed release for its own version into frost's usual app folder, then hands every command to that install.
// It runs on whatever Node.js npm or pnpm uses, and checks the release with copies of frost's updater modules in
// lib/, so the signature, checksum and package checks are the updater's own. tools/npm-package.mjs builds the package
// and copies this file to lib/npm.mjs.
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { baseURL, download, newer, platform, release, valid, validatePackage } from './update.js';
import { extractArchive } from './archive.js';
import { installationRoot, runtimePath } from './runtime.js';

// The installed version, when current.json names one whose scripts and runtime are both there.
async function installedVersion(root) {
  try {
    const { version } = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8'));
    if (!valid(version)) return undefined;
    await stat(path.join(root, 'versions', version, 'src', 'cli', 'main.js'));
    await stat(runtimePath(root));
    return version;
  } catch {
    return undefined;
  }
}

// Runs a program with this terminal and resolves with its exit code. install.mjs prints to stdout, which goes to
// stderr here so the command's own output stays clean.
function runInstaller(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 2, 'inherit'], windowsHide: true });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}

// Downloads, verifies and unpacks the release, then runs its install.mjs with its own runtime, the way install.sh
// does. The launchers install.mjs writes go in frost/bin beside the app folder; this package's frost is the one on
// PATH.
async function install(version, root, options, log) {
  const target = options.platform ?? (await platform(options.runner));
  const checks = { ...options, platform: target };
  log(`Downloading frost ${version} for ${target.os}/${target.arch}`);
  const signed = await release(version, checks);
  log('Signature ok');
  const archive = await download(
    (options.baseURL ?? baseURL) + '/download/' + encodeURIComponent(version) + '/' + signed.archive,
    128 * 1024 * 1024,
    checks,
  );
  const sum = createHash('sha256').update(archive).digest();
  if (!timingSafeEqual(sum, signed.sum)) throw new Error(`checksum mismatch for ${signed.archive}`);
  log('Checksum ok');
  const entries = extractArchive(signed.archive, archive);
  validatePackage(entries, version, target);

  const stage = await mkdtemp(path.join(options.temp ?? os.tmpdir(), 'frost-npm-'));
  try {
    for (const entry of entries) {
      const file = path.join(stage, ...entry.name.split('/'));
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, entry.data, { mode: entry.mode });
    }
    const node = runtimePath(stage, target.os === 'windows' ? 'win32' : target.os);
    const launchers = path.join(path.dirname(root), 'bin');
    const code = await (options.runInstaller ?? runInstaller)(node, [
      path.join(stage, 'install.mjs'),
      stage,
      launchers,
    ]);
    if (code !== 0) throw new Error('package install failed');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// process.execve replaces this process with frost, so signals and the exit code are frost's own. Before Node 26.1 a
// failed execve aborted the process instead of throwing, so older versions start frost as a child instead.
function canExec() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (
    process.platform !== 'win32' && typeof process.execve === 'function' && (major > 26 || (major === 26 && minor >= 1))
  );
}

// Runs the installed frost with this terminal. The terminal sends Ctrl+C to frost as well, so this process ignores it
// and waits. Other signals are passed on, and frost's exit code or signal becomes this process's.
function handoff(node, script, args) {
  if (canExec()) process.execve(node, [node, script, ...args]);
  return new Promise((resolve, reject) => {
    const child = spawn(node, [script, ...args], { stdio: 'inherit' });
    const ignore = () => {};
    const forward = signal => () => child.kill(signal);
    const handlers = [['SIGINT', ignore], ...['SIGTERM', 'SIGHUP'].map(signal => [signal, forward(signal)])];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const stop = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.on('error', error => {
      stop();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      stop();
      if (signal && process.platform !== 'win32') process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
      resolve(code ?? 1);
    });
  });
}

// Installs this package's frost when the app folder has no frost or an older one, then runs the command. Tests pass
// the updater's options (baseURL, trustedKey, allowHTTP, platform, backoff) and replace the app folder, version,
// installer, handoff and log.
export async function main(args = process.argv.slice(2), options = {}) {
  const version =
    options.version ?? 'v' + JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const root = options.root ?? installationRoot();
  const log = options.log ?? (line => process.stderr.write(line + '\n'));
  const current = await installedVersion(root);
  if (!current || newer(version, current)) await install(version, root, options, log);
  if (!(await installedVersion(root))) throw new Error(`frost isn't installed in ${root}`);
  return (options.handoff ?? handoff)(runtimePath(root), path.join(root, 'launch.mjs'), args);
}
