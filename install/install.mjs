// Installs an unpacked Frost package for the current user. It checks the package, stages it, probes the new runtime
// and app, then activates the version by writing current.json last. package.mjs copies it into every package, and
// install.sh runs it from there as `install.mjs <package folder> <launcher folder>`.
import { readFile, readdir, mkdir, mkdtemp, cp, rename, open, rm, stat, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const [sourceArg, binArg] = process.argv.slice(2);
if (!sourceArg || !binArg) throw new Error('Package folder and launcher folder are required');
const source = path.resolve(sourceArg),
  bin = path.resolve(binArg);

const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error('Invalid package version');

// The runtime must be Node 26.10 or a later 26.x release.
if (!/^v26\.(?:[1-9]\d+)\.\d+$/.test(manifest.nodeVersion || ''))
  throw new Error('Unsupported package runtime version');

// The install lock comes from the package's own scripts.
const { installationLock } = await import(
  pathToFileURL(path.join(source, 'versions', version, 'src/platform/install-lock.js')).href
);
const platform = process.platform === 'win32' ? 'windows' : process.platform,
  arch = process.arch === 'x64' ? 'amd64' : process.arch;
if (manifest.os !== platform || manifest.arch !== arch) throw new Error('Package platform mismatch');

// The app lives in the current user's data folder for each OS.
const root =
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'frost/app')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support/frost/app')
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'frost/app');

// Check the unpacked runtime and scripts before touching the install.
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
const node = await readFile(path.join(source, 'runtime/bin', runtimeName));
if (createHash('sha256').update(node).digest('hex') !== manifest.nodeSha256)
  throw new Error('Package runtime checksum mismatch');
if ((await stat(path.join(source, 'versions', version, 'src/cli/main.js'))).size === 0)
  throw new Error('Package scripts missing');

// frost.cmd puts these paths in double quotes, so a quote, % or line break could break out of them.
if (process.platform === 'win32' && /["%\r\n]/.test(root))
  throw new Error('Install path cannot be quoted safely in a Windows launcher');

// Only one install or update may change the app folder at a time.
const unlock = await installationLock(root);
let stage;

// Temporary launchers to remove if the install stops part way.
const launcherStaging = new Set();

const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";

// Creates a new file and flushes it to disk. Temporary launchers are tracked for cleanup.
const syncWrite = async (file, data, mode, launcher = false) => {
  const fd = await open(file, 'wx', mode);
  if (launcher) launcherStaging.add(file);
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
};

// Flushes a directory so renames inside it survive a crash. Windows can't open a directory for this, so it's skipped.
const syncDir = async dir => {
  if (process.platform !== 'win32') {
    const fd = await open(dir, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
};

// Flushes every directory in a tree, deepest first, and refuses links and special files.
async function syncTreeDirectories(dir) {
  if (process.platform === 'win32') return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTreeDirectories(path.join(dir, entry.name));
    else if (!entry.isFile()) throw new Error('Package contains a link or special file');
  }
  await syncDir(dir);
}

// Runs a program for at most 30 seconds and returns its trimmed output.
const probe = (program, args) =>
  new Promise((resolve, reject) =>
    execFile(program, args, { timeout: 30000, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );

const destinationVersion = path.join(root, 'versions', version),
  destinationNode = path.join(root, 'runtime/bin', runtimeName);
let oldRuntime;
try {
  // Stage inside the app folder, so every later rename stays on one filesystem.
  stage = await mkdtemp(path.join(root, '.frost-install-'));
  await cp(path.join(source, 'versions', version), path.join(stage, version), { recursive: true, dereference: false });

  // Refuses links and special files in the staged copy, and flushes every file.
  async function verifyTree(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Package contains a symlink');
      if (entry.isDirectory()) await verifyTree(file);
      else if (entry.isFile()) {
        const fd = await open(file, 'r+');
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
      } else throw new Error('Package contains a special file');
    }
  }
  await verifyTree(path.join(stage, version));

  // The staged runtime and app must both start and report the manifest's versions before anything is replaced.
  const stagedNode = path.join(stage, runtimeName);
  await syncWrite(stagedNode, node, 0o755);
  const runtimeVersion = await probe(stagedNode, ['--version']);
  if (runtimeVersion !== manifest.nodeVersion)
    throw new Error(`the new runtime says ${JSON.stringify(runtimeVersion)}, expected ${manifest.nodeVersion}`);
  const applicationVersion = await probe(stagedNode, [path.join(stage, version, 'src/cli/main.js'), '--version']);
  if (applicationVersion.split(/\s+/).at(-1) !== version)
    throw new Error(`the new binary says ${JSON.stringify(applicationVersion)}, expected ${version}`);

  // Confirm the lock is still held before changing the install.
  await unlock.check();
  await mkdir(path.dirname(destinationVersion), { recursive: true, mode: 0o700 });

  // Hashes each file's path, size and bytes in name order. Links and special files are refused.
  async function treeDigest(dir) {
    if (!(await lstat(dir)).isDirectory()) throw new Error('Installed version is not a directory');
    const hash = createHash('sha256');
    const walk = async (folder, prefix = '') => {
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
      )) {
        const relative = prefix + entry.name,
          file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file, relative + '/');
        else if (entry.isFile()) {
          const data = await readFile(file);
          hash.update(Buffer.from(relative.length + ':' + relative + ':' + data.length + ':'));
          hash.update(data);
        } else throw new Error('Installed version contains a link or special file');
      }
    };
    await walk(dir);
    return hash.digest('hex');
  }

  // Installed versions never change. A copy of this version that's already installed must match the package
  // exactly, and stays in place. Otherwise the staged copy moves in.
  let exists = false;
  try {
    await lstat(destinationVersion);
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (exists) {
    if ((await treeDigest(destinationVersion)) !== (await treeDigest(path.join(stage, version))))
      throw new Error('Installed scripts differ from this package');
    await syncTreeDirectories(destinationVersion);
  } else {
    await syncTreeDirectories(path.join(stage, version));
    await rename(path.join(stage, version), destinationVersion);
  }
  await syncDir(path.dirname(destinationVersion));

  // The runtime path is fixed. A runtime with the same bytes stays untouched; any other is replaced.
  await mkdir(path.dirname(destinationNode), { recursive: true, mode: 0o700 });
  const existingNode = await readFile(destinationNode).catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return undefined;
  });
  if (!existingNode || createHash('sha256').update(existingNode).digest('hex') !== manifest.nodeSha256) {
    // Windows can't replace a running .exe but can rename it. The old runtime moves aside first, and comes back if
    // the new one can't take its place.
    if (process.platform === 'win32' && existingNode) {
      oldRuntime = destinationNode + '.' + randomUUID() + '.old';
      await rename(destinationNode, oldRuntime);
    }
    try {
      await rename(path.join(stage, runtimeName), destinationNode);
    } catch (e) {
      if (oldRuntime) await rename(oldRuntime, destinationNode);
      throw e;
    }
  }
  await syncDir(path.dirname(destinationNode));

  // Replace the runtime license, launch.mjs and manifest.json through flushed temporary files.
  const license = path.join(stage, 'node-LICENSE');
  await syncWrite(license, await readFile(path.join(source, 'runtime/LICENSE')), 0o644);
  await rename(license, path.join(root, 'runtime/LICENSE'));
  for (const name of ['launch.mjs', 'manifest.json']) {
    const temp = path.join(stage, name);
    await syncWrite(temp, await readFile(path.join(source, name)), 0o600);
    await rename(temp, path.join(root, name));
  }
  await syncDir(path.join(root, 'runtime'));
  await syncDir(root);

  // The launchers in the bin folder run the fixed runtime with launch.mjs. Windows gets frost.cmd as well as the
  // sh launcher, which uses forward slashes there.
  await mkdir(bin, { recursive: true });
  const shellPath = value => (process.platform === 'win32' ? value.replaceAll('\\', '/') : value);
  const shellLauncher = `#!/bin/sh\nexec ${shellQuote(shellPath(destinationNode))} ${shellQuote(shellPath(path.join(root, 'launch.mjs')))} "$@"\n`;
  const temporaryLauncher = path.join(bin, '.frost-install-' + path.basename(stage));
  if (process.platform === 'win32') {
    const temporaryCmd = temporaryLauncher + '.cmd';
    await syncWrite(
      temporaryCmd,
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${destinationNode}" "${path.join(root, 'launch.mjs')}" %*\r\n`,
      0o644,
      true,
    );
    await syncWrite(temporaryLauncher, shellLauncher, 0o755, true);
    await rename(temporaryCmd, path.join(bin, 'frost.cmd'));
    launcherStaging.delete(temporaryCmd);
    await rename(temporaryLauncher, path.join(bin, 'frost'));
    launcherStaging.delete(temporaryLauncher);
  } else {
    await syncWrite(temporaryLauncher, shellLauncher, 0o755, true);
    await rename(temporaryLauncher, path.join(bin, 'frost'));
    launcherStaging.delete(temporaryLauncher);
  }
  await syncDir(bin);

  // Activate the version by writing current.json last. Until it lands, launch.mjs keeps starting the previous one.
  await unlock.check();
  await syncWrite(path.join(stage, 'current.json'), JSON.stringify({ version }) + '\n', 0o600);
  await rename(path.join(stage, 'current.json'), path.join(root, 'current.json'));
  await syncDir(root);

  // A running old runtime can't be deleted yet. Frost removes leftover .old runtimes when it next starts.
  if (oldRuntime) await rm(oldRuntime).catch(() => {});
  console.log('Installed ' + path.join(bin, process.platform === 'win32' ? 'frost.cmd' : 'frost'));
} finally {
  // Clean up temporary files, and always release the lock.
  try {
    for (const file of launcherStaging) await rm(file).catch(() => {});
    if (stage) await rm(stage, { recursive: true, force: true });
  } finally {
    await unlock();
  }
}
