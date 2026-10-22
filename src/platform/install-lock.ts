// Opens the installation folder through trusted, retained handles and holds the OS lock that
// keeps the installer and updater from running at the same time.
import path from 'node:path';
import {
  backend,
  existing,
  openRoot,
  sameFile,
  trustedAncestorLink,
  type RootDirectory,
  type RootFile,
} from './fs-root.js';

export const errBusy = new Error('another Frost update is already running');

// Opens (and optionally creates) the installation folder as a retained handle. Windows refuses
// any link on the way. On POSIX every component, not only links, must pass the trusted ancestor
// check, and the folder itself must belong to root or us and not be writable by group or others.
export async function installationDirectory(name: string, create = false): Promise<RootDirectory> {
  if (process.platform === 'win32') return openRoot(name, { create, mode: 0o700 });
  const native = await backend();
  const uid = process.getuid?.();
  let absolute = path.resolve(name);
  let volume = path.parse(absolute).root;
  let current = volume;
  let links = 0;
  let parts = absolute.slice(volume.length).split(path.sep).filter(Boolean);
  let directory = native.openRoot(volume);

  try {
    while (parts.length) {
      const component = parts.shift()!;
      const parent = directory.stat();
      const info = existing(directory, component);
      // A missing entry stands in as ours, so only its parent is checked.
      if (!trustedAncestorLink(info ?? { uid: uid ?? 0 }, parent, uid))
        throw new Error(path.join(current, component) + ' is in an untrusted installation folder');

      // Trusted links are followed by restarting the walk at the target's volume root.
      if (info?.isSymbolicLink()) {
        if (++links > 40) throw new Error('too many links in ' + name);
        absolute = path.resolve(current, directory.readlink(component));
        volume = path.parse(absolute).root;
        parts = [...absolute.slice(volume.length).split(path.sep).filter(Boolean), ...parts];
        directory.close();
        directory = native.openRoot(volume);
        current = volume;
        continue;
      }

      // Recheck the opened folder, so a swap between lstat and open is caught.
      const next = directory.openDirectory(component, { create, mode: 0o700 });
      try {
        const opened = next.stat();
        if (!trustedAncestorLink(opened, parent, uid) || (info && !sameFile(info, opened)))
          throw new Error(path.join(current, component) + ' changed while opening the installation folder');
      } catch (error) {
        next.close();
        throw error;
      }
      directory.close();
      directory = next;
      current = path.join(current, component);
    }

    // Unlike its ancestors, the installation folder gets no sticky-bit exception.
    const info = directory.stat();
    if ((info.uid !== 0 && info.uid !== uid) || info.mode & 0o022)
      throw new Error(name + ' is an untrusted installation folder');
    return directory;
  } catch (error) {
    directory.close();
    throw error;
  }
}

// Calling the lock releases it. check() confirms the path still names the folder that was locked.
interface InstallationLock {
  (): Promise<void>;
  check(): Promise<void>;
}

// Takes a strict exclusive lock on .frost-update.lock inside the installation root and keeps
// the root handle open until release. A lock held elsewhere throws errBusy.
export async function installationLock(root: string): Promise<InstallationLock> {
  const directory = await installationDirectory(root, true);
  const original = directory.stat();
  let file: RootFile | undefined;
  try {
    file = directory.open('.frost-update.lock', { read: true, write: true, create: true, mode: 0o600 });
    file.lock(true);
  } catch (error) {
    try {
      file?.close();
    } finally {
      directory.close();
    }
    if (['EBUSY', 'EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw errBusy;
    throw error;
  }

  const held = file;
  return Object.assign(
    async () => {
      // Closing the file releases the OS lock.
      try {
        held.close();
      } finally {
        directory.close();
      }
    },
    {
      // Reopens the root by path and compares its identity with the folder that was locked.
      check: async () => {
        if (!directory.stat().isDirectory()) throw new Error('installation root changed while installing');
        const current = await installationDirectory(root);
        try {
          if (!sameFile(original, current.stat())) throw new Error('installation root changed while installing');
        } finally {
          current.close();
        }
      },
    },
  );
}
