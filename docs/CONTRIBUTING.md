# Contributing

Thanks for helping. Report security problems privately, never as issues ([SECURITY.md](SECURITY.md#reporting-a-vulnerability) explains how).

## What's likely to be accepted

The changes most likely to be accepted are:

- Bug fixes
- Fixes for a specific OS, filesystem or scheduler
- Fixes for SSH servers, NAS systems, filesystems and S3-compatible services that don't work yet
- Faster or lighter backups, restores and verification
- Tests for behaviour that isn't covered yet
- Documentation fixes

Some changes need agreement in an issue before you write any code: anything that touches encryption, the storage format or dependencies, a new command or storage backend, and any change to how the TUI looks. frost keeps a small, fixed set of commands, so a new feature usually belongs as a flag or an action on an existing one.

If you're not sure a change fits, ask in an issue, or pick one labelled [`help wanted`](https://github.com/whatithasisandalwayswillbe/frost/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22), [`good first issue`](https://github.com/whatithasisandalwayswillbe/frost/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) or [`bug`](https://github.com/whatithasisandalwayswillbe/frost/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug). To take on an issue, leave a comment on it, and a maintainer will assign it to you unless someone's already working on it.

> [!NOTE]
> Pull requests that ignore these guidelines will likely be closed.

## How it works

1. For a small fix, open a pull request against `main`.
2. For anything that needs agreement, open an issue first, and wait for the approach to be agreed before you open a pull request.
3. Once CI passes and a maintainer has reviewed it, the pull request is squash merged.

You don't need to touch the changelog. The maintainer writes it when merging.

## Setup

Clone the repository with `git clone https://github.com/whatithasisandalwayswillbe/frost`, then follow [Running locally](../README.md#running-locally) in the README. If you've already installed a scheduled job while developing, remove it with `frost config set schedule.enabled false`.

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the code is laid out.

## Rules

- New behaviour comes with a test.
- Never log, print or send the key or phrase, except in `frost key show` and `frost init`.
- A repository format change needs a version bump in `src/core/repo.ts` and a migration. Blob and local cache formats also need explicit compatibility handling.
- A change to the Permafrost API changes [PERMAFROST.md](PERMAFROST.md) and the reference server tests in `test/core/storage.test.ts` together.
- Tests use private temporary folders and loopback servers. Inject scheduler, desktop, editor and updater dependencies; never change a real scheduled job, open an external app, go online or replace the running test application.
- Keep runtime and dependency versions pinned. Native filesystem operations fail closed; don't add a path-based fallback.
- A change to what a package contains, or to the runtime it ships, must still pass `validatePackage` as installed copies run it. [ARCHITECTURE.md](ARCHITECTURE.md#packaging-and-updates) has the details.
- Keep docs, help text, output and comments short and plain, with no em dashes.
- "frost" is always lowercase, even at the start of a sentence.

## Before you open a pull request

Run the same checks CI runs, from the repository root:

```sh
npm ci --ignore-scripts
npm run audit:dependencies
npm run format:check
npm run check
npm test
npm audit
```

`npm run format` formats the code with Prettier.

Check shell changes with `bash -n` and shellcheck. Never run `scripts/release.sh`, including `--dry-run` or `--setup-key`; only the maintainer runs it.

For a TUI change, try `npm run demo` after building, at small and large window sizes. The design needs agreement before it changes. Keep the demo and frozen output fixtures working.

CI is configured to check formatting, build, type-check and test on Linux, macOS and Windows. Dependency checks compare installed files with pinned archive hashes and run npm's vulnerability audit. Packaging checks cover each pinned release runtime; workflow configuration doesn't establish native execution on every architecture. Releases remain manual.

## Pull requests

### Keep it focused

- Keep each pull request small and about one thing.
- Explain the problem, and why your change fixes it.
- Check that the behaviour doesn't already exist.
- For a change to the TUI, include before and after screenshots.
- For a logic change, say what you tested and how a reviewer can check it.
- If it fixes an issue, say so with `Fixes #123`.

### Keep it brief

Long, AI-generated pull request descriptions and issues will be ignored. Write a short explanation in your own words. If you can't explain the change briefly, the pull request is probably too big.

Using AI tools to help write code is fine, but you need to understand every line you submit and be able to answer questions about it.

### Title it plainly

The title becomes the commit message when the pull request is squash merged. Make it a short, plain summary of the change, like `Skip missing folders during backup`.

## Issues

Before opening an issue, check the docs at [getfro.st/help](https://getfro.st/help) and the existing issues. A bug report needs your frost version (`frost --version`), your OS, the kind of storage you use (with the server, NAS or provider), the command you ran and what it printed. Leave out your recovery phrase and storage credentials. `frost config` masks credentials unless you ask it not to.

## Storage

Every kind of storage needs a way to create an object only when its name is free, atomically. [CLI.md](CLI.md#storage-compatibility) lists how each kind does it and the S3 findings. If setup fails, open an issue with the server, filesystem or service, and the error `frost init` shows.

A new storage backend needs an issue first. It implements the `Backend` interface in `src/core/storage.ts` and passes the contract tests, as [ARCHITECTURE.md](ARCHITECTURE.md#storage-backends) describes.
