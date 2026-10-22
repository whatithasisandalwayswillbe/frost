// Builds one release package, frost_<ver>_<os>_<arch>.tar.gz (.zip for Windows), audits it and prints its sha256 and
// name. CI and release.sh run it after a build as `package.mjs --version <vX.Y.Z> --platform <os/arch>`, with an
// optional --out <dir> (default .work/packages).
//
// The pinned Node runtime is downloaded into .work/runtimes on first use and checked against tools/runtime-lock.json
// every time. --runtime <node> uses another copy, which must match the same pin.
import { readFile, writeFile, readdir, mkdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTar, isFile, writeTar, writeZip } from './archives.mjs';
import { auditDependencies } from './dependencies.mjs';
import { extractArchive } from '../dist/src/platform/archive.js';
import { validatePackage, valid, archiveName } from '../dist/src/platform/update.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Flags come in `--name value` pairs.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, value, i, list) => {
    if (value.startsWith('--')) out.push([value.slice(2), list[i + 1]]);
    return out;
  }, []),
);
const { version, platform } = args;
if (!valid(version || '')) throw new Error('A release version is required');
const lock = JSON.parse(await readFile(new URL('./runtime-lock.json', import.meta.url), 'utf8'));
// The packaged package.json asks for the pinned runtime's release line, like the project's own engines field.
const engines = `>=${lock.version.slice(1)} <${Number(lock.version.slice(1).split('.')[0]) + 1}`;
const artifact = lock.artifacts[platform];
if (!artifact) throw new Error('No reviewed runtime for this platform');
const [os, arch] = platform.split('/');
const nodeName = os === 'windows' ? 'node.exe' : 'node';

// Downloads the pinned runtime from nodejs.org into output. The download and the executable each have a pinned hash.
// Where the host can, the upstream code signature is checked too: Authenticode for Windows targets on Windows and
// codesign for macOS targets on macOS. Elsewhere the archive audit below only checks that a signature is attached.
async function fetchRuntime(output) {
  const response = await fetch(`https://nodejs.org/download/release/${lock.version}/${artifact.file}`, {
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 << 20) throw new Error('Node archive too big');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== artifact.sha256) throw new Error('Node download differs from the pinned checksum');

  // Windows downloads are the bare node.exe. Other targets are .tar.gz archives holding <archive name>/bin/node once.
  let runtime = bytes;
  if (artifact.file.endsWith('.tar.gz')) {
    const wanted = artifact.file.replace(/\.tar\.gz$/, '') + '/bin/node';
    const found = readTar(gunzipSync(bytes, { maxOutputLength: 512 << 20 })).filter(e => e.name === wanted);
    if (found.length !== 1 || !isFile(found[0])) throw new Error('Node executable missing');
    runtime = Buffer.from(found[0].data);
  }
  if (sha256(runtime) !== artifact.nodeSha256)
    throw new Error('Node executable differs from its reviewed archive member');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, runtime);
  await chmod(output, 0o755);

  if (os === 'windows' && process.platform === 'win32') {
    // The path travels as base64 so PowerShell never parses it. Dropping PSModulePath keeps an inherited
    // PowerShell 7 module path from breaking Windows PowerShell.
    const command =
      '$s=Get-AuthenticodeSignature -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' +
      Buffer.from(output).toString('base64') +
      '"))); if($s.Status -ne "Valid"){throw "Invalid Node Authenticode signature"}';
    const env = { ...process.env };
    delete env.PSModulePath;
    const checked = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, encoding: 'utf8', env },
    );
    if (checked.status !== 0) throw new Error(checked.stderr || 'Node signature verification failed');
  } else if (os === 'darwin' && process.platform === 'darwin') {
    const checked = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', output], { encoding: 'utf8' });
    if (checked.status !== 0) throw new Error(checked.stderr || 'Node code signature verification failed');
  }
}

// The runtime: a given copy, the cached download, or a fresh download. Whichever it is must match the pin.
const runtimePath = path.resolve(
  args.runtime || path.join(root, '.work/runtimes', lock.version, platform.replace('/', '_'), nodeName),
);
let node = await readFile(runtimePath).catch(() => undefined);
if (!node && !args.runtime) {
  await fetchRuntime(runtimePath);
  node = await readFile(runtimePath);
}
if (!node || sha256(node) !== artifact.nodeSha256) throw new Error('Runtime differs from the pinned Node executable');

// Never package dependencies that fail the audit.
await auditDependencies(root);

// Archive entries are collected in memory, then written once at the end.
const entries = [];
const add = (name, data, mode = 0o644) =>
  entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode });

// Adds every file under dir that passes filter, in name order. Symlinks are refused.
async function collect(dir, prefix, filter = () => true) {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const source = path.join(dir, e.name);
    const name = prefix + '/' + e.name;
    if (e.isSymbolicLink()) throw new Error('Package source contains a symlink');
    if (e.isDirectory()) await collect(source, name, filter);
    else if (filter(e.name)) add(name, await readFile(source));
  }
}

// versions/<version>/ holds the compiled JavaScript (minus the demo), the assets and the TOML parser.
const build = path.join(root, 'dist');
await collect(path.join(build, 'src'), `versions/${version}/src`, n => n.endsWith('.js') && n !== 'demo.js');
if (!entries.some(e => e.name.endsWith('/src/cli/main.js'))) throw new Error('Build the Frost CLI before packaging');

// A source build reports `dev`, and package.json's version is a placeholder. Packages get the release version written
// into the CLI here, and the audit below reads it back.
const versionModule = entries.find(e => e.name.endsWith('/src/cli/version.js'));
if (!versionModule) throw new Error('CLI version module is missing');
const stamp = `export const version = ${JSON.stringify(version)};\n`;
versionModule.data = Buffer.from(stamp);

await collect(path.join(build, 'assets'), `versions/${version}/assets`);
await collect(
  path.join(root, 'node_modules/@iarna/toml'),
  `versions/${version}/node_modules/@iarna/toml`,
  n => n.endsWith('.js') || n === 'package.json' || n === 'LICENSE',
);
add(
  `versions/${version}/package.json`,
  JSON.stringify({ name: 'frost', version: version.slice(1), type: 'module', engines: { node: engines } }) + '\n',
);

// The runtime and its license sit beside the versions, shared by all of them.
add('runtime/bin/' + nodeName, node, 0o755);
const nodeLicense = await readFile(new URL('./node-LICENSE', import.meta.url));
if (sha256(nodeLicense) !== lock.licenseSha256) throw new Error('Node license differs from its reviewed version');
add('runtime/LICENSE', nodeLicense);

// manifest.json describes the package for the installer and updater. current.json names the active version, and
// launch.mjs reads it at startup to import that version's main.js. install.sh runs install.mjs from the package.
add(
  'manifest.json',
  JSON.stringify({ version, nodeVersion: lock.version, nodeSha256: sha256(node), os, arch }, null, 2) + '\n',
);
add('current.json', JSON.stringify({ version }) + '\n');
add('install.mjs', await readFile(path.join(root, 'install/install.mjs')));
add('launch.mjs', await readFile(path.join(root, 'install/launch.mjs')));

// Launchers for running straight from the unpacked folder, for sh and for cmd.
add(
  'frost',
  '#!/bin/sh\nset -eu\ncase "$0" in */*) frost_path=${0%/*} ;; *) frost_path=. ;; esac\nfrost_dir=$(CDPATH= cd -- "$frost_path" && pwd)\nexec "$frost_dir/runtime/bin/' +
    nodeName +
    '" "$frost_dir/launch.mjs" "$@"\n',
  0o755,
);
add(
  'frost.cmd',
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0runtime\\bin\\node.exe" "%~dp0launch.mjs" %*\r\n',
);
add('LICENSE', await readFile(path.join(root, 'LICENSE')));
add(
  'README.md',
  'Run Frost from this folder, or install it with the Frost installer. The runtime stays at runtime/bin/node.\n',
);

// Sort by name bytes, not locale, so the archive doesn't depend on the build machine.
entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
const name = archiveName(version, os, arch);
const archive = os === 'windows' ? writeZip(entries) : writeTar(entries);

// Audit what was written, read back the way the updater reads it: the updater's own layout checks, the pinned runtime
// and its license, no development or native add-on files, and a runtime built for the target with a signature attached.
const unpacked = extractArchive(name, archive);
validatePackage(unpacked, version, { os, arch });
if (unpacked.find(e => e.name === `versions/${version}/src/cli/version.js`)?.data.toString() !== stamp)
  throw new Error('Package does not report its release version');
if (!unpacked.some(e => e.name === 'runtime/LICENSE')) throw new Error('Node license is missing');
if (
  unpacked.some(
    e =>
      /\.(?:ts|go|map|node|wasm|dll|so|dylib)$/.test(e.name) ||
      /(?:\/demo\.js|\/test\/|\/typescript\/|\/undici-types\/|\/@types\/)/.test(e.name),
  )
)
  throw new Error('Package contains development or native add-on code');
checkRuntimeHeaders(unpacked.find(e => e.name === 'runtime/bin/' + nodeName).data);

const out = path.resolve(args.out || path.join(root, '.work/packages'));
await mkdir(out, { recursive: true });
await writeFile(path.join(out, name), archive);
console.log(`${sha256(archive)}  ${name}`);

// Reads the runtime's executable headers to check its architecture and that a signature is attached. This only
// checks presence; fetchRuntime verifies the signature itself where the host can.
function checkRuntimeHeaders(runtime) {
  if (os === 'windows') {
    // A PE file starts with "MZ", and the offset at 0x3c points to the "PE\0\0" header and its machine type.
    const offset = runtime.readUInt32LE(0x3c);
    if (
      runtime.subarray(0, 2).toString() !== 'MZ' ||
      runtime.readUInt32LE(offset) !== 0x4550 ||
      runtime.readUInt16LE(offset + 4) !== (arch === 'amd64' ? 0x8664 : 0xaa64)
    )
      throw new Error('Runtime architecture mismatch');

    // The PE32+ optional header follows the 24-byte PE header, and its data directories start at 112. Directory 4
    // locates the Authenticode certificate table; a nonzero offset and size mean one is attached.
    const optional = offset + 24;
    if (!(runtime.readUInt32LE(optional + 112 + 4 * 8) > 0 && runtime.readUInt32LE(optional + 116 + 4 * 8) > 0))
      throw new Error('Runtime has no Authenticode signature');
  } else if (os === 'darwin') {
    // The runtime must be a 64-bit Mach-O for x86_64 or ARM64.
    if (
      runtime.readUInt32LE(0) !== 0xfeedfacf ||
      runtime.readUInt32LE(4) !== (arch === 'amd64' ? 0x1000007 : 0x100000c)
    )
      throw new Error('Runtime architecture mismatch');

    // Walk the load commands to LC_CODE_SIGNATURE (0x1d). Its superblob (0xfade0cc0) must have a CMS signature slot
    // (0x10000) holding a non-empty blob wrapper (0xfade0b01). An ad hoc signature has no such blob.
    let signed = false;
    let offset = 32;
    for (let i = 0; i < runtime.readUInt32LE(16); i++) {
      const cmd = runtime.readUInt32LE(offset);
      const size = runtime.readUInt32LE(offset + 4);
      if (size < 8 || offset + size > runtime.length) throw new Error('Invalid Mach-O runtime');
      if (cmd === 0x1d) {
        const start = runtime.readUInt32LE(offset + 8);
        const length = runtime.readUInt32LE(offset + 12);
        if (start + length <= runtime.length && runtime.readUInt32BE(start) === 0xfade0cc0) {
          const count = runtime.readUInt32BE(start + 8);
          for (let entry = 0; entry < count && 12 + (entry + 1) * 8 <= length; entry++) {
            const index = start + 12 + entry * 8;
            const blob = start + runtime.readUInt32BE(index + 4);
            if (
              runtime.readUInt32BE(index) === 0x10000 &&
              blob + 8 <= start + length &&
              runtime.readUInt32BE(blob) === 0xfade0b01 &&
              runtime.readUInt32BE(blob + 4) > 8
            )
              signed = true;
          }
        }
      }
      offset += size;
    }
    if (!signed) throw new Error('Runtime has no Mach-O code signature');
  } else if (
    // Linux runtimes must be 64-bit little-endian ELF for x86-64 (62) or AArch64 (183). There's no signature.
    runtime.subarray(0, 4).toString('hex') !== '7f454c46' ||
    runtime[4] !== 2 ||
    runtime[5] !== 1 ||
    runtime.readUInt16LE(18) !== (arch === 'amd64' ? 62 : 183)
  )
    throw new Error('Runtime architecture mismatch');
}
