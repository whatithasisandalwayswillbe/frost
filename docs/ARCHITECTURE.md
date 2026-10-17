# Architecture

frost runs as a TypeScript application on its bundled Node.js runtime. It has no daemon or server component. Automatic backups are OS scheduler jobs that launch the installed application.

## Source layout

| Path | Holds |
|---|---|
| `src/cli/` | The eight commands, prompts, configuration, output and terminal integration |
| `src/core/` | Keys, chunking, config, snapshots, repository objects, the manifest and storage clients |
| `src/engine/` | Backup, restore, verification and their bounded work queues |
| `src/platform/` | Native filesystem calls, locks, scheduling, updates, signatures, desktop actions and audio |
| `src/tui/` | The snapshot browser, setup, terminal renderer and development demo |
| `assets/` | The BIP39 wordlist, wordmarks and sound effects |
| `test/` | Unit, integration, security and output reference tests |
| `tools/` | Build, dependency audit, packaging, the npm package, the package smoke test and the benchmark |
| `install/` | The shell and PowerShell installers, the npm package's installer, the installer and launcher every package carries, and the release public key |
| `scripts/` | The manual release script |

`cli` connects the components. `engine` builds on `core/repo`, `core/manifest` and `core/chunker`. The repository seals objects through `core/crypto`; storage clients only handle bytes. The only runtime npm dependency is the pure JavaScript TOML parser. Node supplies HTTP, cryptography, zstd and worker threads.

## Keys

`frost init` generates a random 256-bit master key and shows it as a 24-word BIP39 phrase. Each subkey comes from HKDF-SHA256 under a separate label:

| Subkey | Used for |
|---|---|
| Encryption | XChaCha20-Poly1305 for every object |
| Chunk ID | HMAC-SHA256 that names chunks |
| Chunker | The seed for the gear table |
| Fingerprint | A short, non-secret ID shown in `status` |

The master key and phrase stay in the main process. Up to four worker threads receive derived encryption and chunk-ID keys for large jobs; a job that only computes a chunk ID gets the chunk-ID key alone. Worker inputs and copied keys are erased after use, except a chunk that only had its ID computed, which goes back to the caller. The normal crypto methods preserve caller buffers; explicit owned-buffer operations can transfer an exclusive download or chunk buffer. Erasure doesn't guarantee removal of every copy made by the runtime. [SECURITY.md](SECURITY.md) describes the threat model.

## Backup

1. frost walks configured folders and skips excluded names and paths. Missing folders are recorded in the snapshot header. Symlinks are recorded as links; sockets, devices, pipes and restore partial files are skipped. Windows stats each folder's entries in parallel on the runtime's thread pool; Linux and macOS stat them synchronously, which is cheaper there.
2. The manifest remembers each file's size, nanosecond modification time and chunk list. If the size and time match and all chunks are known, frost reuses the list without opening the file.
3. Changed files go through FastCDC. Chunks average 1 MiB, with a 256 KiB minimum and an 8 MiB maximum. The key seeds the gear table, so known files don't have a public pattern of cut points. The gear-hash scan is a small WebAssembly function that `src/core/gear.ts` assembles from its instructions at startup, with a plain JavaScript fallback.
4. Each chunk gets a keyed HMAC ID. For chunks of 512 KiB or more, crypto workers compute IDs while the main thread cuts the next chunks, and results are handled in file order. Known IDs aren't uploaded. New chunks are compressed with zstd when that saves space, encrypted and uploaded with four concurrent uploads. Uploaded IDs are recorded in batches of 64.
5. After every upload succeeds, frost compares the file list with this machine's last saved snapshot. An unchanged list saves no snapshot under the conditions below.
6. Otherwise the JSON file list is chunked and uploaded, followed by `trees/<id>` and then `snapshots/<id>`. A snapshot can't appear before its data exists.
7. Verification checks a sample and loads the newest file list. After an unchanged backup, it runs when the previous check is missing, failed or more than a day old.

A changed file is checked through its open handle and its directory entry after reading. A file that changes while it's read is retried after the walk. If it's still changing, frost keeps its previous clean copy or skips it with a warning when no copy exists. Chunks already uploaded can be reused on the next run. A change that preserves file identity, size and modification time can evade these checks.

A dry run walks, chunks and compares without uploading or saving a snapshot. It still refreshes the local chunk list when a sync is due.

Compression uses zstd level 1 with up to 8 MiB of history within each object. Fast match finding is the default. Code delimiters and repetition checks in bounded samples, plus small ZIP, gzip and Flate PDF headers, select double-fast match finding with shorter matches, using one full compression pass. Repeated code templates keep the fast match finder. Other objects up to 64 KiB can try both match finders and keep the smaller result; already compact and incompressible outputs skip that retry. Objects up to nine bytes are stored directly. All file bytes are preserved, including PDF offsets, source whitespace, metadata and existing compression. Output uses the same raw or zstd format that earlier versions read, and compression is only kept when it saves space.

Decompression sizes its output buffers from the frame header, capped at 8 MiB plus 16 KiB, to avoid collecting small blocks. Frames without a recorded size use 16 KiB buffers. The decoded output limit also covers concatenated frames.

### Unchanged backups

The manifest records a saved snapshot's ID, paths, SHA-256 file-list digest and two 64-bit hashes per entry. A backup saves no snapshot only when:

- The configured paths match the record.
- The complete SHA-256 digests match.
- The recorded snapshot is the newest one the manifest knows about.
- Its header still exists in storage.

Any uncertainty saves a snapshot. The per-entry hashes only count additions, changes and removals for output; they never decide whether to skip a snapshot. A folder's modification time is left out of the digest. Folder permissions and additions or removals still count, and a file's modification time counts even when its bytes are unchanged.

Verification, `status` and the browser refresh known snapshots. Another machine's newer snapshot can remain unknown until that refresh.

## Repository format

The repository layout version is `2`; the sealed blob version is `1`.

| Object key | Content |
|---|---|
| `frost.repo` | Format version, repository ID and creation time |
| `chunks/<ab>/<abcdef...>` | File data and file lists, named by HMAC chunk ID |
| `snapshots/<id>` | Time, host, paths, stats, missing folders and capped warning lists |
| `trees/<id>` | Ordered file-list chunk IDs and the list's total length |

Every object is sealed as `version(1) | nonce(24) | ciphertext`. The object's storage key is AEAD associated data. The backend's S3 folder prefix isn't part of that key, so a whole repository can move between folders. Renaming an object inside the repository breaks authentication.

Headers stay small, so the browser and `status` can list snapshots without loading trees. File lists are stored as chunks and deduplicated like file data. The tree index authenticates their order and total size. A future prune must count file-list chunks as referenced.

`frost.repo`, trees and headers use conditional creates (`If-None-Match: *`). Concurrent clients can't overwrite repository metadata. Snapshot IDs contain two BIP39 words and 42 random bits in hex, 64 random bits in total.

Decompressed objects are capped at 256 MiB. Chunk downloads are capped at 8 MiB plus encryption overhead; S3 metadata allows the larger object limit. Permafrost keeps its 16 MiB response limit. Header warning lists hold at most 100 entries while preserving full counts.

## Manifest

`manifest-<repo>.jsonl` in the cache directory holds uploaded chunk IDs, per-file metadata, snapshot headers and backup, verification and comparison state. Each journal transaction carries a format, sequence number and SHA-256 checksum. Transactions are flushed before they become visible in memory. A write failure stops later mutations.

Opening the journal discards an incomplete final line. A damaged complete transaction fails closed and asks for a cache rebuild. Compaction writes and flushes a fresh journal before replacing the old one through the held directory handle. Journals over 1 GiB or with multiple hardlinks are refused, and appending rechecks the link count.

A persistent `.lock` file is locked by the operating system for the manifest's lifetime. Marker contents don't establish ownership. Locks release when the handle closes or the process exits; unavailable kernel locking fails closed. Separate cache folders and other machines have separate locks, so repository metadata still needs conditional creates.

The chunk list is refreshed when it's empty, more than seven days old, checked at a different storage location, or invalidated by a missing chunk. The location includes the provider's endpoint, bucket and folder, or the Permafrost server and account. `status --verify` always refreshes it. A future prune must force every machine to sync before its next backup.

Losing the manifest costs a storage listing and a full source-file read. Restore works without it. `storage-<config>.json` separately records the last repository location without credentials so errors can identify a changed setting.

## Restore

The tree, selected paths and destination types are checked before writing. Chunks download with eight concurrent requests across the selection. Nearby repeated chunks download once. Every chunk is authenticated and checked against its HMAC ID.

Each regular file is written to a private `.frost-partial-<hash>` beside its destination, checked against its recorded size, flushed and renamed into place. The old file isn't deleted before replacement. Symlinks are created after regular files; directory modes and times are applied last, deepest first. Restores are atomic per file, not across the whole selection.

A new restore folder holds a `.frost-restore` marker until completion. The marker and each partial file are locked while in use. A resumed restore checks existing bytes by chunking them and comparing keyed IDs, skips complete files and retains matching leading chunks in partial files. Names alone are never trusted. Overwrite restores use the same checks.

Partial files must have one hardlink. A matching destination with multiple hardlinks is replaced before changing its permissions or timestamps, so another name for that file stays untouched. Reusing checked bytes also requires unchanged file identity, size, modification time and change time.

### Native filesystem operations

`src/platform/fs-root*` opens and retains directory handles. Subsequent opens, renames, removals, metadata operations and locks resolve relative to those handles. Restore rejects traversal, duplicate destinations (compared without case on Windows and macOS, and without Unicode normalisation on macOS), linked parents, Windows devices and alternate data streams. There is no ordinary path-based fallback when a native binding or lock is unavailable.

The bindings use Node's built-in native-call API and fixed signatures for known OS libraries. POSIX uses directory-relative system calls; Windows uses native file handles and no-follow opens. Native metadata preserves nanosecond timestamps, with Windows' 100 ns resolution.

An overwrite restore resolves trusted ancestor links before retaining its root. POSIX permits links owned by root or the current user only when the parent is also trusted and isn't writable by other users, except for protected sticky directories. Windows refuses ancestor links and junctions. Nothing below the retained restore root follows a directory link. Restored symlinks keep their original targets, including targets outside the restored folder.

The browser releases the manifest lock before restoring and creates an engine with only the repository.

## Verification

Verification refreshes snapshot headers, samples chunk IDs from the manifest, downloads them with eight concurrent requests and checks authentication and keyed IDs. It loads the newest file list and checks that every referenced chunk is known. Missing chunks invalidate the local list so the next backup can upload them again from available source files.

Results are saved for `status` and the browser. A previously known snapshot that disappears counts as a failure once, then is forgotten. Sampling doesn't prove every snapshot is restorable.

## Scheduling

`src/platform/schedule.ts` builds launchd, systemd, cron and Task Scheduler definitions. Installed jobs run the fixed bundled runtime with `launch.mjs` and the scheduled backup arguments. Tests inject command runners and compare escaped definitions without changing real jobs or lingering.

The Windows task uses UTF-16 XML, frost's author and description, an interactive user and least privilege. Scheduled log writes retain a native file handle and reject links or changed entries. [CLI.md](CLI.md#scheduled-jobs) owns job names, intervals, logging and removal behavior.

## Packaging and updates

A release archive contains:

```text
runtime/bin/node[.exe]
runtime/LICENSE
versions/vX.Y.Z/src/
versions/vX.Y.Z/assets/
versions/vX.Y.Z/node_modules/@iarna/toml/
versions/vX.Y.Z/package.json
manifest.json
current.json
launch.mjs
install.mjs
frost
frost.cmd
LICENSE
README.md
```

The runtime stays at a fixed path. `current.json` selects immutable versioned scripts. `manifest.json` binds the release version, platform and runtime checksum. The demo, tests, source maps and development dependencies aren't shipped.

The release tag is the only source of the version. `tools/package.mjs` writes it into the packaged CLI and into `versions/vX.Y.Z/package.json`, then reads it back from the finished archive. The version in the project's `package.json` is a placeholder, and a source build reports `dev`.

`tools/runtime-lock.json` pins official runtime archives, executable bytes and the runtime license, and a package is built for each target it lists. The dependency audit compares every installed npm file with recorded archive hashes and rejects additions, missing files, install hooks, links, native add-ons and executables. Packaging uses deterministic member ordering and archive metadata.

The updater verifies the signed checksum list, downloads an archive of at most 128 MiB and extracts at most 384 MiB in memory. Extraction rejects traversal, duplicate names, links, devices, unsafe Windows names and damaged archive checksums. Only the known runtime, version scripts and assets are accepted. The staged runtime and CLI must report the expected versions before activation.

An installed frost applies these checks to every later release, so they can't be tightened for a release that older installs must read. They accept ahead of use instead: Node 26.10 or newer with no ceiling, and a few file types no release ships yet. A release the installed frost can't read says to reinstall with the installer.

Other parts of an install are fixed the same way. An update replaces the version folder, the runtime, `manifest.json` and `current.json`, but not `launch.mjs` or the launchers on PATH, so only the installer renews those. Every install keeps starting the CLI at `versions/<version>/src/cli/main.js` through the `launch.mjs` it was installed with, and reads a new release's version as the last word of `main.js --version`. `install/launch.mjs` is small on purpose and `test/platform/launcher.test.ts` pins its behavior. Anything that has to change belongs in `main.js`, which ships with each version. If `launch.mjs` itself ever has to change, the updater must first learn to replace it. An install then gets the new launcher on the update after the one that brings that code, and later still if it skips releases.

Three things install a package: `install/install.sh`, `install/install.ps1` and the `getfrost` npm package. Each checks the signed checksums, then runs the package's own `install.mjs` with the package's runtime, so every install has the same layout and the updater owns it afterwards. `install.ps1` has no SSH signature check from Windows, so it runs a verifier embedded in the script on the archive's `node.exe`, after the checksum matches and Windows reports a valid OpenJS Foundation Authenticode signature.

`tools/npm-package.mjs` builds `getfrost` from `install/npm.mjs` and copies of `update.js` and the compiled modules it imports. The native filesystem bindings load only when called, so these modules import on the user's Node.js 22 or newer, and CI runs the package's tests on Node.js 22.0.0. The package installs the release matching its own version when the application folder has no frost or an older one, then starts the installed `launch.mjs` with the installed runtime. It replaces itself through `process.execve` on POSIX with Node.js 26.1 or newer, and runs a child process otherwise. It relies only on the fixed runtime path, `launch.mjs`, `current.json`'s `version` and `versions/<version>/src/cli/main.js`, so those stay fixed for it too. `release.sh --release` publishes it after the GitHub release, because it downloads that release.

Installer and updater share a persistent OS installation lock. POSIX installation ancestry must belong to root or the current user and exclude unsafe writable parents. The root handle is retained and its identity checked after probes and before activation. Windows refuses links and checks root identity; default profile ACLs provide the permission boundary.

Files are flushed before activation. POSIX also flushes staged directories from the leaves upward, then the version parent, runtime directories and installation root. The installer stages its PATH launcher exclusively on the destination drive. An existing version is reused only when its complete contents match. An identical runtime stays in place.

`current.json` is replaced last. Runtime and package metadata changes aren't one atomic transaction with that pointer. On Windows a changed running runtime is moved aside before replacement, with rollback on a reported failure. Process termination between those renames can leave the fixed runtime path absent. Directory flushing establishes write ordering; measured power-loss recovery remains a validation task.

[SECURITY.md](SECURITY.md#updates) owns release trust and verification. [CLI.md](CLI.md#installation) owns installation locations and user commands. Releases are manual; there is no publishing workflow.

## TUI

`src/tui/` holds the browser, setup state machines, renderer and hidden game. Async commands carry cancellation and attempt identity, so stale picker and game results are ignored. Closing the program cancels outstanding work and restores terminal state.

Windows folder selection runs in a separate bundled-runtime process and calls the system's Explorer dialog directly through COM. This keeps the modal dialog off the terminal thread and lets cancellation stop the helper.

The browser indexes subtree counts and sizes once per tree, caches date headings and reuses downloaded headers on refresh. It reads manifest state up front, then releases the lock so a scheduled backup can run while the browser is open.

`src/tui/render.ts` defines the palette and cell layout. `src/cli/format.ts` keeps CLI styles foreground-only. Frozen output fixtures check text, spacing, foreground, background and emphasis across window sizes. The development demo uses fake storage and never installs a scheduler job.

## Storage backends

`src/core/storage.ts` defines the storage contract:

```typescript
interface Backend {
  put(key: string, data: Buffer, signal?: AbortSignal): Promise<void>;
  putNew(key: string, data: Buffer, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Buffer>;
  getOwned?(key: string, signal?: AbortSignal): Promise<Buffer>;
  list(prefix: string, signal?: AbortSignal): Promise<string[]>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  toString(): string;
  location?(): string;
}
```

`putNew` atomically creates an absent key and throws `errExists` otherwise. A missing `get` throws `errNotFound`; deleting an absent key succeeds. `getOwned` is optional and must return a fresh exclusive buffer that frost may erase or detach. Without it, frost preserves the backend's returned buffer. `location` identifies the complete storage destination; otherwise `toString` serves that purpose.

Every backend must pass the conformance cases in `test/core/storage.test.ts`, including concurrent conditional creates and owned-buffer isolation. S3 uses SigV4 and an in-process fake service. Permafrost uses the reference contract in [PERMAFROST.md](PERMAFROST.md). Production requests have response limits, cancellation and bounded retries.
