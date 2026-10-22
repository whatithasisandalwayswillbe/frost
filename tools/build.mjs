// Builds Frost into dist/: deletes the old output, compiles with tsc, then copies assets/.
// `npm run build` runs it. tools.test.ts imports cleanBuild.
import { cp, lstat, realpath, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

// Deletes <root>/dist, so compiled files whose source was removed don't linger. A symlinked or junctioned dist/ is
// refused, so this can't delete a folder outside the project.
export async function cleanBuild(root = project) {
  const workspace = await realpath(root);
  const output = path.resolve(workspace, 'dist');

  let info;
  try {
    info = await lstat(output);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Build output must be a directory inside the project');
  await rm(output, { recursive: true, force: true });
}

// Build only when run as a script, not when a test imports this module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanBuild();
  const tsc = path.join(project, 'node_modules/typescript/bin/tsc');
  const compiled = spawnSync(process.execPath, [tsc, '-p', path.join(project, 'tsconfig.json')], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (compiled.status !== 0) process.exit(compiled.status ?? 1);
  await cp(path.join(project, 'assets'), path.join(project, 'dist/assets'), { recursive: true });
}
