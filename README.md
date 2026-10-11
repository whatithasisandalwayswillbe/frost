<div align="center">
<img src=".github/frost-icon.png" alt="frost" width="128" height="128" />
</div>

<h3 align="center">frost</h3>

<p align="center">Encrypted, incremental backups to storage you choose.</p>

<p align="center">
  <a href="https://getfro.st">Website</a> ·
  <a href="#running-locally">Development</a> ·
  <a href="docs/CHANGELOG.md">Changelog</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
<a href="https://github.com/whatithasisandalwayswillbe/frost/releases"><img src="https://img.shields.io/github/v/release/whatithasisandalwayswillbe/frost?color=1926c4&style=flat-square" alt="Latest release"></a>
<a href="https://github.com/whatithasisandalwayswillbe/frost/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/whatithasisandalwayswillbe/frost/ci.yml?branch=main&label=CI&style=flat-square" alt="CI"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-BSD--3--Clause-1926c4?style=flat-square" alt="License: BSD 3-Clause"></a>
<img src="https://img.shields.io/badge/TypeScript-5.9.3-1926c4?logo=typescript&logoColor=white&style=flat-square" alt="TypeScript 5.9.3">
<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-1926c4?style=flat-square" alt="macOS, Linux, Windows">
</p>

---

frost backs up your folders to S3-compatible storage or [Permafrost](docs/PERMAFROST.md), and encrypts everything on your machine before it's uploaded. Releases include their runtime, so you don't need to install Node.js. Backups run from your OS scheduler, and `frost browse` opens your snapshots in the terminal.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/whatithasisandalwayswillbe/frost/main/install/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/whatithasisandalwayswillbe/frost/main/install/install.ps1 | iex
```

<details>
<summary>Other ways to install</summary>

With npm or pnpm, on Node.js 22 or newer. The first `frost` command downloads and installs the signed release:

```sh
npm install -g getfrost
pnpm add -g getfrost
```

To install by hand, see [Installation](docs/CLI.md#installation), which also lists platform targets and file locations.

</details>

## Get started

Learn how to use frost at [getfro.st/help](https://getfro.st/help).

## Contributing

Contributions are welcome. Small fixes can go straight to a pull request, and anything bigger starts with an issue so we can agree on the approach first. **Read [CONTRIBUTING.md](docs/CONTRIBUTING.md) before you start.** It covers the process and the rules every change has to follow.

**Report security problems privately, never in a public issue.** [SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability) explains how.

## Learn more

| Doc | Covers |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | The source layout, backup and restore, and the repository format |
| [Security](docs/SECURITY.md) | The encryption model and what a storage provider can see |
| [Permafrost API](docs/PERMAFROST.md) | The storage protocol, for anyone running a compatible server |
| [Changelog](docs/CHANGELOG.md) | What changed in each release |

## Running locally

Use Node.js 26.10.0, the runtime pinned in `tools/runtime-lock.json`. The native filesystem bindings require Node's built-in native-call API. Tests use private temporary folders, fake desktop and scheduler commands, and loopback storage servers.

```sh
npm ci --ignore-scripts
npm run audit:dependencies
npm run format:check
npm run check
npm test
```

To run the CLI from source without touching your real setup, point it at throwaway folders:

```sh
export FROST_CONFIG_DIR=/tmp/frost-dev/config FROST_CACHE_DIR=/tmp/frost-dev/cache
node dist/src/cli/main.js <command>
```

`frost init` installs a real scheduled job when automatic backups are on, so choose "off" while developing. A build from source reports its version as `dev` and can't update itself. `npm run build` refreshes the compiled code and assets in `dist/`.

To work on the TUI without storage or a key, run `npm run demo` after building. It opens the snapshot browser on fake data. Pass flags after `--`, as in `npm run demo -- -latency 400ms`:

| Flag | Shows |
|---|---|
| `-setup` | The `frost init` screens instead of the browser |
| `-latency 400ms` | Slow storage, so you can see the loading states |
| `-empty` | A repository with no snapshots |
| `-broken` | A failed backup and a failed health check |

The demo doesn't save your settings or install scheduled jobs. Its temporary files and restores stay in the folder it prints. Tests compare CLI output and TUI cells against frozen reference fixtures.

## License

BSD 3-Clause, see [LICENSE](LICENSE).
