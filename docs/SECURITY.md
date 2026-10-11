# Security

frost encrypts your backups on your machine, with a key only you hold, before anything is uploaded. The storage provider, the Permafrost operator and the frost authors can't read them. This page explains how, and where that protection stops.

## Reporting a vulnerability

Please don't open a public issue. Report it privately on GitHub instead, from the repository's **Security** tab, with **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker gains. We'll acknowledge the report within a week, keep you updated, and credit you in the release notes unless you'd rather not be named. Please give us a reasonable chance to ship a fix before going public.

A vulnerability is anything that lets someone other than the key holder read backed-up data or metadata, forge or silently change backups, recover the key, or make a restore write outside its target. CLI bugs that don't touch any of those are ordinary issues.

## Encryption

| Piece | Choice |
|---|---|
| Master key | 256 bits from the OS CSPRNG, generated locally by `frost init` |
| Recovery phrase | The master key as 24 BIP39 words. The phrase encodes the key directly, with no PBKDF2 step |
| Subkeys | HKDF-SHA256 from the master key, one label per purpose |
| Encryption | XChaCha20-Poly1305, with a random 192-bit nonce per object |
| Associated data | The object's storage key, like `chunks/ab/ab12...` |
| Chunk names | HMAC-SHA256 of the plaintext under a dedicated subkey |
| Chunk boundaries | FastCDC with a gear table derived from the key |
| Compression | zstd, before encryption, only when it makes the data smaller |

Everything inside a backup object is encrypted, including file contents, file names and snapshot metadata. Object names, snapshot IDs, ciphertext sizes and storage listings are visible to the provider. Setup also writes and deletes a small plaintext probe object to check the storage works, and it holds no file data.

The key is never sent to the storage provider, Permafrost or the frost authors, and there's no key escrow. Storage services use their own credentials and may need an account.

**If you lose the recovery phrase and the machine, your backups are gone.**

## What a storage provider can see

The provider (an S3 host or Permafrost) can see:

- How many objects you have, how big they are, and when they were uploaded.
- Which objects are chunks, snapshot headers or file-list indexes, from the key prefix. The file lists themselves are stored as chunks.
- When you back up and restore, and from which IP address.
- How much new data each backup uploads, which hints at how much changed.
- When your files changed. A backup that finds nothing changed saves no snapshot, so new snapshots only appear after something changed.
- Snapshot IDs, which are random and carry no information.

A small file fits in a single chunk, so the provider can see roughly how big it is after compression, but not what it is or what it's called. A large file is split into chunks of varying size, so it never shows up as one object of its size, though a backup's total upload is visible.

Chunk names are keyed HMACs, not plain hashes, so a provider can't hash a known file to check whether you have it. The keyed chunker stops the same check through patterns of chunk sizes.

Compressing before encrypting means an object's size depends a little on how compressible its content is. For backups of your own files this reveals very little, but it isn't nothing.

## Integrity

Every object is authenticated. Decryption fails if a single bit changes, if the wrong key is used, or if an object is moved to a different name, because the name is the associated data. On restore and verify, each chunk's plaintext is also hashed again and compared with its ID.

Authentication stops a provider forging content without the key. It doesn't stop a provider deleting or withholding objects.

The spot check after a backup downloads a random sample of chunks. It runs after every backup that saves a snapshot, and at least once a day otherwise. It catches missing or damaged data early, but damage to chunks it didn't sample can go unnoticed.

## Threat model

frost protects against:

- A storage provider or Permafrost operator reading your data.
- An attacker who gets a copy of the bucket.
- Someone on the network between you and the storage. Connections use TLS, and every object is authenticated anyway. TLS is off for an `http://` S3 endpoint, an S3 endpoint without a scheme when `storage.s3.insecure` is enabled, or an `http://` Permafrost URL on localhost. An explicit S3 scheme takes precedence over `storage.s3.insecure`.
- Tampering, truncation or swapping of stored objects, which frost detects and never silently accepts.
- A restore escaping its target through `..` paths or symlinked parents. Restores retain native directory handles and check every path first.
- An in-place restore being redirected through another user's link. POSIX ancestor links and their parents must belong to root or you, with protected parent permissions. Windows refuses ancestor links and junctions.
- Corrupted, swapped or tampered frost downloads. Each release's `checksums.txt` is signed with the release key (`checksums.txt.sig`). The install script checks that signature against the public key in the repository (`install/release-signing.pub`), then checks the archive against the checksums. `frost update` does the same, as [Updates](#updates) describes.

frost doesn't protect against:

- **Someone with access to your machine.** The key file sits unencrypted in your config directory so scheduled backups can run without you. POSIX permissions restrict it to your user; Windows uses the profile's inherited ACLs. Anyone who can read it, or run code as you, can read your backups. Use full disk encryption and a screen lock.
- **Losing data.** A provider can delete or withhold your objects. Verification can detect this, and restoring the affected files fails, but frost can't prevent it. Keep a second, independent copy of anything irreplaceable.
- **Rollback.** A provider could hide the newest snapshots and serve only older ones. A machine that has already seen those snapshots reports them missing once, but a new machine, or one that never saw them, can't tell. Every snapshot that is served is still authentic.
- **Traffic analysis.** Backup timing and sizes are visible, as listed above.
- **A compromised local runtime or application.** Code running as you can read the key file and change frost's scripts. Native filesystem confinement doesn't isolate frost from your own account or an administrator.

## Updates

`frost update`, and scheduled backups unless `update.auto` is `false`, install the latest release package. A release must pass these checks:

| Check | Stops |
|---|---|
| `checksums.txt.sig` is an SSH signature, namespace `file`, by frost's pinned release key | A tampered or swapped release, or a hijacked GitHub account or CDN |
| The archive's SHA-256 matches its line in the signed `checksums.txt` | A tampered or corrupted download |
| The archive's name in that file carries the release's version, and that version is newer than yours | Rolling you back to an older signed release. Pre-releases are never picked |
| The package manifest matches its release and platform, and binds the runtime's SHA-256 | A mismatched runtime or package |
| Archive members use permitted paths and types and stay within size limits | Traversal, links, device paths and excessive extraction |
| The staged runtime and application run and report their expected versions | Activating a package that fails its startup probes |

Both installation and updates fail closed when signature verification fails. The shell installer requires `ssh-keygen` from OpenSSH 8.1 or newer before running the bundled installer. The updater verifies SSH signatures directly through Node's cryptography API. It accepts the release key in `src/platform/signature.ts`; the same key is in `install/release-signing.pub` and `install/install.sh`.

The archive includes the runtime, versioned scripts and assets. The only native executable shipped is the pinned official Node.js runtime. Windows runtime bytes retain their upstream Authenticode signature; the signed checksum list also covers frost's scripts.

Installer and updater hold an OS installation lock, flush staged files and run version probes before changing the active-version pointer. POSIX also flushes directories in order. An existing version must match the package's complete bytes before it can be reused. These checks don't make every installation change one atomic transaction.

On Windows, replacing a changed running runtime requires moving the old executable aside. A reported replacement failure rolls it back, but termination between those renames can leave the fixed runtime path absent. Package metadata can also be written before the active scripts change. Reinstalling the verified package repairs an interrupted activation. [ARCHITECTURE.md](ARCHITECTURE.md#packaging-and-updates) describes the commit order and limits.

Set `update.auto` to `false` to review each release before installing it. frost still tells you when one is out.

## Local files

| File | Holds | Permissions when created |
|---|---|---|
| `key` | Your recovery phrase, in plain text | `0600` on POSIX |
| `config.toml` | Settings and storage credentials | `0600` on POSIX |
| `manifest-*.jsonl` | Chunk IDs, file paths, sizes and modification times | `0600` on POSIX |
| `storage-*.json` | Last storage settings without credentials, and repository ID | `0600` on POSIX |
| `update.json` | Latest update check, release and error | `0600` on POSIX |
| `frost.log` | Scheduled output, including unreadable paths | `0600` when frost creates it; scheduler redirection follows the scheduler's permissions |

[CLI.md](CLI.md#files) lists locations and logging behavior. The manifest holds file paths in plain text and never leaves the machine. Windows files inherit user-profile permissions rather than Unix modes. Existing permissions aren't a substitute for protecting your account, and custom shared folders can weaken that boundary.

The runtime uses Node's experimental native-call API for fixed OS filesystem and locking functions, and on macOS for the I/O policy that stops backups downloading files kept only in iCloud. There are no downloaded native add-ons or executable helpers. Missing native support fails closed. The API isn't a sandbox, and its runtime and bindings need continued platform validation.

Restore replaces files one at a time, after checking their data and size. If a later file fails, earlier replacements stay. Restored symlinks keep their original targets, which can point outside the restore folder.

## Verifying a download by hand

The install script does this for you. To check an archive yourself, download it with `checksums.txt` and `checksums.txt.sig` from the same release, and [`install/release-signing.pub`](../install/release-signing.pub) from the repository. Set `archive` to the downloaded filename, then run:

```sh
(
  set -e
  archive='frost_X.Y.Z_linux_amd64.tar.gz'
  printf 'frost-release %s\n' "$(cat release-signing.pub)" > allowed_signers
  ssh-keygen -Y verify -f allowed_signers -I frost-release -n file -s checksums.txt.sig < checksums.txt
  selected_checksum=$(awk -v archive="$archive" '$2 == archive { line = $0; count++ } END { if (count != 1) exit 1; print line }' checksums.txt)
  printf '%s\n' "$selected_checksum" | shasum -a 256 -c -
)
```

The commands stop if the signature is wrong or the signed list doesn't contain exactly one entry for your archive. The first check should print `Good "file" signature`, and the second `OK` for your archive.

## Recommendations

- Keep the recovery phrase offline, on paper or in a password manager you trust.
- Run `frost key verify` now and then to make sure the phrase you wrote down is the right one.
- Give the S3 credentials access to one bucket only.
- Watch `frost status`, and look into a health problem straight away.
