// Self-update. latest() finds the newest GitHub release and release() checks its signed checksums, and
// installRelease() downloads, verifies, stages and activates it under the installation lock.
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifySSHSig, releaseKey } from './signature.js';
import { extractArchive, type ArchiveEntry } from './archive.js';
import { run, type Runner } from './command.js';
import { installationRoot, runtimePath } from './runtime.js';
import { installationDirectory, installationLock } from './install-lock.js';
export { errBusy } from './install-lock.js';
export { releaseKey } from './signature.js';

export const repo = 'whatithasisandalwayswillbe/frost';
export const baseURL = 'https://github.com/' + repo + '/releases';
export const errDevBuild = new Error(
  'this Frost build comes from source and cannot update itself. Rebuild from source or reinstall via the official package: https://github.com/' +
    repo +
    '#install',
);
export const errNoRelease = new Error('no Frost release has been published yet');

// Release tags are vX.Y.Z with an optional pre-release suffix and no build metadata.
const versionRe = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
export const valid = (s: string): boolean => versionRe.test(s);

const compare = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

// Compares digit strings of any length without parsing them. Once leading zeros are gone, the
// shorter string is smaller, and equal lengths compare as text.
function numberOrder(a: string, b: string): number {
  a = a.replace(/^0+/, '');
  b = b.replace(/^0+/, '');
  return compare(a.length.toString().padStart(16, '0'), b.length.toString().padStart(16, '0')) || compare(a, b);
}

// True when a has higher semver precedence than b. A release beats its pre-releases, numeric
// identifiers sort below alphanumeric ones, and when the shared identifiers match, the longer
// list wins.
export function newer(a: string, b: string): boolean {
  const x = versionRe.exec(a);
  const y = versionRe.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const n = numberOrder(x[i], y[i]);
    if (n) return n > 0;
  }

  const preA = (x[4] || '').slice(1);
  const preB = (y[4] || '').slice(1);
  if (preA === preB) return false;
  if (!preA || !preB) return !preA;
  const as = preA.split('.');
  const bs = preB.split('.');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const numA = /^\d+$/.test(as[i]);
    const numB = /^\d+$/.test(bs[i]);
    const n = numA && numB ? numberOrder(as[i], bs[i]) : numA ? -1 : numB ? 1 : compare(as[i], bs[i]);
    if (n) return n > 0;
  }
  return as.length > bs.length;
}

// The release target for this machine. An x64 process on an Apple silicon Mac (under Rosetta)
// gets the arm64 build.
export async function platform(runner: Runner = run): Promise<{ os: string; arch: string }> {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  let arch: string = process.arch === 'x64' ? 'amd64' : process.arch === 'arm' ? 'armv7' : process.arch;
  if (os === 'darwin' && arch === 'amd64') {
    try {
      if ((await runner('sysctl', ['-n', 'hw.optional.arm64'])).stdout.trim() === '1') arch = 'arm64';
    } catch {}
  }
  return { os, arch };
}

// Must match the names the release script and installer use.
export function archiveName(version: string, os: string, arch: string): string {
  return `frost_${version.replace(/^v/, '')}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

// Finds name in sha256sum output ("<hex>  <name>", or "*<name>" in binary mode). The first
// matching line decides, and a malformed hash there returns undefined.
export function lookup(sums: Buffer, name: string): Buffer | undefined {
  for (const line of sums.toString().split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length === 2 && f[1].replace(/^\*/, '') === name)
      return /^[a-fA-F0-9]{64}$/.test(f[0]) ? Buffer.from(f[0], 'hex') : undefined;
  }
}

export interface Release {
  version: string;
  archive: string;
  page: string;
  sum: Buffer;
}

// Tests override the transport, key, platform, backoff and probe. allowHTTP is for loopback
// test servers only.
export interface UpdateOptions {
  baseURL?: string;
  trustedKey?: string;
  userAgent?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  runner?: Runner;
  backoff?: number;
  platform?: { os: string; arch: string };
  allowHTTP?: boolean;
  probe?: (node: string, entry: string, version: string) => Promise<void>;
}

// GET with up to three attempts and growing backoff. Redirects are followed by hand (up to 10)
// so none can leave https. Network errors, 5xx and 429 are retried, but https and redirect
// errors and aborts aren't. With manual, a redirect comes back unfollowed.
async function request(url: string, options: UpdateOptions, manual = false): Promise<Response> {
  const transport = options.fetch ?? fetch;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await delay(attempt * attempt * (options.backoff ?? 1000), undefined, { signal: options.signal });
    try {
      let target = new URL(url);
      if (target.protocol !== 'https:' && !(options.allowHTTP && target.protocol === 'http:'))
        throw new Error('release URL must use https');
      for (let hop = 0; hop < 10; hop++) {
        // Each hop gets its own 60 second timeout on top of the caller's signal.
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(60_000)]);
        const response = await transport(target, {
          redirect: 'manual',
          headers: { 'User-Agent': options.userAgent ?? 'frost' },
          signal,
        });
        if (manual || response.status < 300 || response.status >= 400) {
          if (response.status >= 500 || response.status === 429) {
            await response.body?.cancel();
            throw new Error(`${response.status} ${response.statusText}`);
          }
          return response;
        }
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('redirect has no location');
        const next = new URL(location, target);
        if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('redirected away from https');
        target = next;
      }
      throw new Error('too many redirects');
    } catch (e) {
      if (options.signal?.aborted || /https|redirect/.test((e as Error).message)) throw e;
      last = e;
    }
  }
  throw last;
}

// Downloads a 200 response into memory. limit applies to the declared length and to the bytes
// actually received.
export async function download(url: string, limit: number, options: UpdateOptions = {}): Promise<Buffer> {
  const response = await request(url, options);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${response.status} ${response.statusText}`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('too big');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) throw new Error('empty response');
  for await (const b of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += b.length;
    if (size > limit) throw new Error('too big');
    chunks.push(Buffer.from(b));
  }
  return Buffer.concat(chunks, size);
}

// GitHub's /releases/latest redirects to /releases/tag/<tag>, so the tag comes from the Location
// header. release() then checks that tag's signed checksums.
export async function latest(options: UpdateOptions = {}): Promise<Release> {
  const base = options.baseURL ?? baseURL;
  const response = await request(base + '/latest', options, true);
  await response.body?.cancel();
  if (response.status === 404) throw errNoRelease;
  if (response.status < 300 || response.status >= 400)
    throw new Error(`checking for the latest release: ${response.status} ${response.statusText}`);
  const location = response.headers.get('location');
  if (!location) throw errNoRelease;
  const tag = new URL(location, base).pathname.split('/releases/tag/')[1];
  if (!tag) throw errNoRelease;
  if (!valid(tag)) throw new Error(`the latest release has an odd tag ${JSON.stringify(tag)}`);
  return release(tag, options);
}

// Finds this platform's archive in one release. checksums.txt must carry a valid release signature
// before its sum for the archive is trusted.
export async function release(tag: string, options: UpdateOptions = {}): Promise<Release> {
  if (!valid(tag)) throw new Error(`${JSON.stringify(tag)} isn't a release version`);
  const base = options.baseURL ?? baseURL;
  const assetBase = base + '/download/' + encodeURIComponent(tag) + '/';
  const sums = await download(assetBase + 'checksums.txt', 65536, options);
  const sig = await download(assetBase + 'checksums.txt.sig', 65536, options);
  verifySSHSig(options.trustedKey ?? releaseKey, sums, sig);
  const target = options.platform ?? (await platform(options.runner));
  const archive = archiveName(tag, target.os, target.arch);
  const sum = lookup(sums, archive);
  if (!sum) throw new Error(`${tag} has no build for ${target.os}/${target.arch}`);

  // Record a private copy, so installRelease only takes releases from here and ignores any later
  // change to the returned object.
  const checked = { version: tag, archive, page: base + '/tag/' + encodeURIComponent(tag), sum };
  verified.set(checked, { ...checked, sum: Buffer.from(sum) });
  return checked;
}

// Releases that release() checked, mapped to the copy installRelease uses.
const verified = new WeakMap<Release, Release>();

// Names the package manager that owns a path, or '' when it isn't managed. Those installs must
// update through their package manager.
export function managed(exe: string): string {
  const p = exe.replaceAll('\\', '/');
  if (p.startsWith('/nix/store/')) return 'Nix';
  if (p.startsWith('/snap/')) return 'Snap';
  if (p.startsWith('/usr/bin/') || p.startsWith('/bin/')) return "your system's package manager";
  return '';
}

// The app root to update.
export const executable = () => path.resolve(process.env.FROST_APP_ROOT || installationRoot());

// Refuses package-manager installs, then proves the root opens through the trusted walk and is
// writable by creating and removing a probe file.
export async function canReplace(root: string): Promise<void> {
  const pm = managed(root);
  if (pm) throw new Error(`${root} was installed via ${pm}; use that package manager to update Frost`);
  const directory = await installationDirectory(root, true);
  const probe = '.frost-update-probe-' + randomUUID();
  try {
    const file = directory.open(probe, { write: true, create: true, exclusive: true, mode: 0o600 });
    try {
      file.close();
    } finally {
      directory.remove(probe);
    }
  } finally {
    directory.close();
  }
}

// Creates a new file (never overwrites one) and flushes it before closing.
async function syncedWrite(file: string, data: Buffer | string, mode = 0o600): Promise<void> {
  const fd = await open(file, 'wx', mode);
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

// Flushes a folder so renames inside it are durable. Windows has no folder flush, so it's
// skipped there.
async function syncDir(dir: string): Promise<void> {
  if (process.platform !== 'win32') {
    const fd = await open(dir, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
}

// Flushes every folder in a tree, deepest first, and refuses links and special files.
async function syncTreeDirectories(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTreeDirectories(path.join(dir, entry.name));
    else if (!entry.isFile()) throw new Error('installed release contains a link or special file');
  }
  await syncDir(dir);
}

interface PackageManifest {
  version: string;
  nodeVersion: string;
  nodeSha256: string;
  os: string;
  arch: string;
}

// The oldest runtime Frost runs on is Node 26.10, which added the native-call API its filesystem
// bindings use. A later release may ship a newer runtime, so this sets a floor and no ceiling.
const runtimeRe = /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export function supportedRuntime(version: string): boolean {
  const m = runtimeRe.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  return major > 26 || (major === 26 && Number(m[2]) >= 10);
}

// The file types a package may hold under versions/<version>/, besides LICENSE files. Installed
// copies apply this to every later release, so it already accepts types that none uses yet.
const packageFiles = /\.(js|mjs|json|txt|md|wav|ogg|mp3)$/;

// Checks an extracted package against its manifest. The manifest must name this version and
// target, the runtime must match its recorded hash, and every other file must be a known
// top-level file or plain script, data or sound under versions/<version>/. Native code is refused.
//
// An installed Frost runs this on every later release, so a rule added here can only be relied
// on once the installs that predate it are gone. Loosen rules before any release needs them.
export function validatePackage(
  entries: ArchiveEntry[],
  version: string,
  target: { os: string; arch: string },
): PackageManifest {
  const manifestEntry = entries.find(e => e.name === 'manifest.json');
  if (!manifestEntry) throw new Error('manifest.json not found in the archive');
  const m = JSON.parse(manifestEntry.data.toString()) as PackageManifest;
  if (
    m.version !== version ||
    m.os !== target.os ||
    m.arch !== target.arch ||
    !supportedRuntime(m.nodeVersion) ||
    !/^[a-f0-9]{64}$/.test(m.nodeSha256)
  )
    throw new Error('package manifest mismatch');

  const runtime = entries.find(e => e.name === 'runtime/bin/' + (target.os === 'windows' ? 'node.exe' : 'node'));
  if (!runtime || createHash('sha256').update(runtime.data).digest('hex') !== m.nodeSha256)
    throw new Error('runtime checksum mismatch');
  if (!entries.some(e => e.name === `versions/${version}/src/cli/main.js`))
    throw new Error('Frost scripts not found in the archive');

  for (const entry of entries) {
    if (
      entry.name === runtime.name ||
      entry.name === 'runtime/LICENSE' ||
      entry.name === 'manifest.json' ||
      ['launch.mjs', 'install.mjs', 'frost', 'frost.cmd', 'current.json', 'LICENSE', 'README.md'].includes(entry.name)
    )
      continue;
    if (!entry.name.startsWith(`versions/${version}/`)) throw new Error('unexpected package path');
    if (
      (!packageFiles.test(entry.name) && !entry.name.endsWith('/LICENSE')) ||
      /\.(node|exe|dll|so|dylib)$/i.test(entry.name)
    )
      throw new Error('unexpected package code');
  }
  return m;
}

// Moves the staged runtime to the fixed runtime path. A byte-identical runtime stays put and the
// staged copy is dropped. POSIX renames over the old one.
export async function replaceRuntime(staged: string, target: string): Promise<void> {
  const existing = await readFile(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
    return undefined;
  });
  if (
    existing &&
    timingSafeEqual(
      createHash('sha256').update(existing).digest(),
      createHash('sha256')
        .update(await readFile(staged))
        .digest(),
    )
  ) {
    await rm(staged);
    return;
  }
  if (process.platform !== 'win32') {
    await rename(staged, target);
    await syncDir(path.dirname(target));
    return;
  }

  // Windows can't replace a running executable but can rename it. Move the old runtime aside,
  // move the new one in, and put the old one back if that fails. Each rename gets five tries.
  const old = target + '.' + randomUUID() + '.old';
  const retry = async (op: () => Promise<void>) => {
    let last;
    for (let i = 0; i < 5; i++) {
      try {
        await op();
        return;
      } catch (e) {
        last = e;
        await delay((i + 1) * 200);
      }
    }
    throw last;
  };
  let moved = false;
  try {
    await retry(() => rename(target, old));
    moved = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  try {
    await retry(() => rename(staged, target));
  } catch (e) {
    if (moved) await retry(() => rename(old, target));
    throw e;
  }
  // A runtime that's still running can't be deleted yet. cleanup() removes it later.
  if (moved) await rm(old).catch(() => {});
}

// True when an existing version folder holds exactly the package's files with the same bytes,
// and nothing else.
async function matchesVersion(dir: string, entries: ArchiveEntry[], prefix: string): Promise<boolean> {
  if (!(await lstat(dir)).isDirectory()) return false;
  const expected = new Map(
    entries.filter(e => e.name.startsWith(prefix)).map(e => [e.name.slice(prefix.length), e.data]),
  );
  const walk = async (folder: string, relative = ''): Promise<boolean> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = relative + entry.name;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(file, name + '/'))) return false;
      } else if (entry.isFile()) {
        const data = expected.get(name);
        if (!data) return false;
        if (
          !timingSafeEqual(
            createHash('sha256')
              .update(await readFile(file))
              .digest(),
            createHash('sha256').update(data).digest(),
          )
        )
          return false;
        expected.delete(name);
      } else return false;
    }
    return true;
  };
  return (await walk(dir)) && expected.size === 0;
}

// Installs a release from latest() or release() into root while holding the installation lock.
export async function installRelease(
  rel: Release,
  root = installationRoot(),
  options: UpdateOptions = {},
): Promise<void> {
  const checkedRelease = verified.get(rel);
  if (!checkedRelease) throw new Error("release wasn't checked, use Latest");
  rel = checkedRelease;
  await canReplace(root);
  root = await realpath(root);
  const unlock = await installationLock(root);
  let stage: string | undefined;
  try {
    // Stage inside root so the final moves are renames on one filesystem.
    stage = await mkdtemp(path.join(root, '.frost-update-'));
    const archive = await download(
      (options.baseURL ?? baseURL) + '/download/' + encodeURIComponent(rel.version) + '/' + rel.archive,
      128 * 1024 * 1024,
      options,
    );
    const sum = createHash('sha256').update(archive).digest();
    if (!timingSafeEqual(sum, rel.sum)) throw new Error(`${rel.archive} failed checksum verification; update aborted`);
    const entries = extractArchive(rel.archive, archive);
    const target = options.platform ?? (await platform(options.runner));
    // A release this Frost can't read is signed and fine, so say how to get past it.
    let manifest: PackageManifest;
    try {
      manifest = validatePackage(entries, rel.version, target);
    } catch (e) {
      throw new Error(
        `${(e as Error).message}. This Frost installation may not support the ${rel.version} package format. Reinstall Frost: https://github.com/${repo}#install`,
        { cause: e },
      );
    }
    for (const e of entries) {
      const file = path.join(stage, ...e.name.split('/'));
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await syncedWrite(file, e.data, e.mode);
    }

    // Probe the staged runtime and scripts before anything in root changes. Both must report
    // the versions the signed package promised.
    const node = runtimePath(stage, target.os === 'windows' ? 'win32' : (target.os as NodeJS.Platform));
    const entry = path.join(stage, 'versions', rel.version, 'src', 'cli', 'main.js');
    if (options.probe) await options.probe(node, entry, rel.version);
    else {
      const runtime = await (options.runner ?? run)(node, ['--version'], undefined, AbortSignal.timeout(30_000));
      if (runtime.code || runtime.stdout.trim() !== manifest.nodeVersion)
        throw new Error(
          `the new runtime says ${JSON.stringify(runtime.stdout.trim())}, expected ${manifest.nodeVersion}`,
        );
      const r = await (options.runner ?? run)(node, [entry, '--version'], undefined, AbortSignal.timeout(30_000));
      if (r.code || r.stdout.trim().split(/\s+/).at(-1) !== rel.version)
        throw new Error(`the new binary says ${JSON.stringify(r.stdout.trim())}, expected ${rel.version}`);
    }
    options.signal?.throwIfAborted();

    // Check the root is still the folder that was locked before anything moves into it.
    await unlock.check();

    // Move the version folder into place. An existing copy is kept only if it matches the
    // signed package exactly.
    await mkdir(path.join(root, 'versions'), { recursive: true, mode: 0o700 });
    const destination = path.join(root, 'versions', rel.version);
    let exists = false;
    try {
      await lstat(destination);
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (exists) {
      if (!(await matchesVersion(destination, entries, `versions/${rel.version}/`)))
        throw new Error('installed release scripts differ from the signed package');
      await syncTreeDirectories(destination);
    } else {
      const stagedVersion = path.join(stage, 'versions', rel.version);
      await syncTreeDirectories(stagedVersion);
      await rename(stagedVersion, destination);
    }
    await syncDir(path.join(root, 'versions'));

    // Replace the runtime, its license and the package manifest. These moves aren't atomic with
    // the switch below.
    const destinationRuntime = runtimePath(root, target.os === 'windows' ? 'win32' : (target.os as NodeJS.Platform));
    await mkdir(path.dirname(destinationRuntime), { recursive: true, mode: 0o700 });
    await replaceRuntime(node, destinationRuntime);
    await syncDir(path.dirname(destinationRuntime));
    const license = entries.find(e => e.name === 'runtime/LICENSE');
    if (license) {
      const staged = path.join(stage, '.node-LICENSE');
      await syncedWrite(staged, license.data, 0o644);
      await rename(staged, path.join(root, 'runtime/LICENSE'));
    }
    await rename(path.join(stage, 'manifest.json'), path.join(root, 'manifest.json'));
    await syncDir(path.join(root, 'runtime'));
    await syncDir(root);

    // Check the root again right before the commit. Writing current.json through a temporary
    // file and a rename switches launch.mjs to the new version in one step.
    await unlock.check();
    const current = path.join(root, '.current-' + randomUUID() + '.json');
    await syncedWrite(current, JSON.stringify({ version: manifest.version }) + '\n');
    await rename(current, path.join(root, 'current.json'));
    await syncDir(root);
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      await unlock();
    }
  }
}

export interface State {
  checked?: string;
  latest?: string;
  error?: string;
  installed?: string;
  from?: string;
  installed_at?: string;
}

// Update-check state. A missing or unreadable file, or anything that isn't an object, reads as {}.
export async function loadState(file: string): Promise<State> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

// Writes through a flushed temporary file and a rename, so a crash leaves the old state or the new.
export async function saveState(file: string, state: State): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const stage = file + '.' + randomUUID() + '.tmp';
  try {
    await syncedWrite(stage, JSON.stringify(state, null, 2) + '\n');
    await rename(stage, file);
    await syncDir(path.dirname(file));
  } finally {
    await rm(stage, { force: true });
  }
}

// Deletes runtimes a Windows update moved aside. One that's still running stays until a later call.
export async function cleanup(root: string): Promise<void> {
  const dir = path.dirname(runtimePath(root));
  const base = path.basename(runtimePath(root));
  for (const name of await readdir(dir).catch(() => [])) {
    if (name.startsWith(base + '.') && name.endsWith('.old')) await rm(path.join(dir, name)).catch(() => {});
  }
}
