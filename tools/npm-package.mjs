// Builds the getfrost npm package, which gives npm and pnpm a frost command. It holds install/npm.mjs and copies of the
// compiled updater modules it imports, and installs frost's signed release on first use. release.sh runs it after a
// build as `npm-package.mjs --version <vX.Y.Z> --out <dir>`.
import { access, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { valid } from '../dist/src/platform/update.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// The updater modules lib/npm.mjs imports, and everything they import in turn. The native filesystem bindings load
// only when called, so these import on any supported Node.js.
export const modules = [
  'update.js',
  'signature.js',
  'archive.js',
  'command.js',
  'runtime.js',
  'install-lock.js',
  'fs-root.js',
  'fs-root-types.js',
  'fs-root-posix.js',
  'fs-root-windows.js',
  'ffi-loader.js',
];

// The oldest Node.js major the package runs on. CI runs its tests on the first release of it.
export const nodeFloor = 22;

// The bin checks the Node.js version before it loads anything that needs a newer one.
const bin = `#!/usr/bin/env node
// The frost command from the getfrost package. lib/npm.mjs installs frost on first use and runs it.
const [major] = process.versions.node.split('.').map(Number);
if (major < ${nodeFloor}) {
  console.error('getfrost: installing frost requires Node.js v${nodeFloor} or newer (detected version: ' + process.version + ')');
  process.exitCode = 1;
} else {
  import('./lib/npm.mjs')
    .then(({ main }) => main())
    .catch(error => {
      console.error('getfrost: ' + error.message);
      process.exitCode = 1;
    });
}
`;

const readme = `# getfrost

Installs and runs [frost](https://getfro.st), encrypted, incremental backups to storage you choose.

\`\`\`sh
npm install -g getfrost
\`\`\`

The first \`frost\` command downloads the signed frost release for your computer, checks its signature and installs it in your user profile. Every command after that runs the installed frost, which keeps itself up to date. It needs Node.js ${nodeFloor} or newer.

Learn how to use frost at [getfro.st/help](https://getfro.st/help).
`;

// Writes the package into out, which must be empty or missing, and returns its package.json.
export async function buildPackage(version, out) {
  if (!valid(version) || version.includes('-')) throw new Error('A stable release version is required');
  await mkdir(path.join(out, 'lib'), { recursive: true });
  if ((await readdir(out)).some(name => name !== 'lib') || (await readdir(path.join(out, 'lib'))).length)
    throw new Error('The npm package folder must be empty');

  const manifest = {
    name: 'getfrost',
    version: version.slice(1),
    description: 'Encrypted, incremental backups to storage you choose. Installs and runs frost.',
    homepage: 'https://getfro.st',
    repository: { type: 'git', url: 'git+https://github.com/whatithasisandalwayswillbe/frost.git' },
    license: 'BSD-3-Clause',
    type: 'module',
    bin: { frost: 'frost.mjs' },
    files: ['frost.mjs', 'lib/', 'LICENSE', 'README.md'],
    engines: { node: `>=${nodeFloor}` },
    os: ['darwin', 'linux', 'win32'],
    cpu: ['x64', 'arm64'],
  };
  await writeFile(path.join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(out, 'frost.mjs'), bin, { mode: 0o755 });
  await writeFile(path.join(out, 'README.md'), readme);
  await copyFile(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  await copyFile(path.join(root, 'install/npm.mjs'), path.join(out, 'lib/npm.mjs'));
  for (const name of modules) {
    const source = path.join(root, 'dist/src/platform', name);
    await access(source).catch(() => {
      throw new Error(`Build frost before packaging: ${name} is missing`);
    });
    await copyFile(source, path.join(out, 'lib', name));
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, i, list) => {
      if (value.startsWith('--')) pairs.push([value.slice(2), list[i + 1]]);
      return pairs;
    }, []),
  );
  if (!args.out) throw new Error('--out is required');
  await buildPackage(args.version || '', path.resolve(args.out));
}
