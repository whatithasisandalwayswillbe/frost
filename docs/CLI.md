# CLI reference

frost has eight commands. Every one takes `--config-dir <dir>` to use a different config directory, and `-h` (`--help`) to show frost's help, which lists every command and flag. `frost --version` prints the version.

## Installation

Releases include the Node.js runtime, scripts and assets. You don't need Node.js or npm on the machine you back up, unless you install with npm or pnpm.

On macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/whatithasisandalwayswillbe/frost/main/install/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/whatithasisandalwayswillbe/frost/main/install/install.ps1 | iex
```

Both installers check the release signature and archive checksum, install the application in your user profile, and put a `frost` launcher in a folder on your `PATH`.

| Installer | Needs | Default launcher folder |
|---|---|---|
| `install.sh` | `curl` or `wget`, and `ssh-keygen` from OpenSSH 8.1 or newer | `/usr/local/bin` when writable, otherwise `~/.local/bin`. Git Bash on Windows uses `~/bin` |
| `install.ps1` | Windows PowerShell 5.1 or PowerShell 7 | `%LocalAppData%\frost\bin`, which it adds to your user `PATH` |

`install.ps1` checks the signature with the release's own `node.exe`, once Windows confirms the OpenJS Foundation signed it. `install.sh` also runs in Git Bash on Windows, and WSL installs the Linux package.

Set `FROST_INSTALL_DIR` to choose another launcher folder, or `FROST_VERSION` to install a specific release. In PowerShell, set them before running the installer, as in `$env:FROST_VERSION = 'v0.1.0'`. `install.ps1` leaves `PATH` alone for a folder you choose. Changing the launcher folder doesn't move the application folder.

| Platform | Archive architectures | Application folder |
|---|---|---|
| macOS | `amd64`, `arm64` | `~/Library/Application Support/frost/app` |
| Linux | `amd64`, `arm64` | `${XDG_DATA_HOME:-~/.local/share}/frost/app` |
| Windows | `amd64`, `arm64` | `%LocalAppData%\frost\app` |

There is no Linux ARMv7 package. The runtime stays in `runtime/bin/node` (`node.exe` on Windows); a small launcher loads the active version. Keep the complete application folder together.

### npm and pnpm

```sh
npm install -g getfrost
pnpm add -g getfrost
```

The `getfrost` package needs Node.js 22 or newer, and has no dependencies or install scripts. Its `frost` command installs frost the first time it runs. It downloads the release matching the package's version, checks its signature and checksum with frost's own updater code, and runs the release's installer into the application folder above. Every later command runs the installed frost, which updates itself as usual, and an older `getfrost` never replaces a newer frost.

The installer's launchers go in `frost/bin` beside the application folder, but the package's `frost` is the one on your `PATH`. Removing the package leaves the application folder in place.

### Manual installation

Download the archive for your platform from the [latest release](https://github.com/whatithasisandalwayswillbe/frost/releases/latest), and [verify it](SECURITY.md#verifying-a-download-by-hand) before running anything from it. Extract it into a new folder.

On macOS or Linux, run this inside the extracted folder, changing the launcher folder if needed:

```sh
./runtime/bin/node install.mjs "$PWD" "$HOME/.local/bin"
```

On Windows, run this in PowerShell inside the extracted folder:

```powershell
.\runtime\bin\node.exe .\install.mjs "$PWD" "$env:LOCALAPPDATA\frost\bin"
```

Add the launcher folder to your `PATH` if it isn't there already. Windows includes `frost.cmd` for Command Prompt and PowerShell, and `frost` for Git Bash. macOS and Linux use `frost`. To run an extracted package without installing it, use its launcher directly and leave all its files together.

## `frost init`

In a terminal, `frost init` opens a full-screen setup that asks one thing at a time:

| Step | What it asks |
|---|---|
| Storage | Permafrost (an access key, or get one in the browser), or an [S3-compatible service](#storage-compatibility). Presets fill in provider-specific questions |
| Folders | Full paths (`~` works). Nothing is picked for you. A folder that's already on the list, or inside one that is, isn't added twice. A folder that doesn't exist yet is skipped until it does |
| Skip | Names or patterns to leave out. Starts with the `exclude` defaults, which you can remove |
| Schedule | How often to back up automatically, or off |
| Recovery phrase | For new storage, your key's 24 words, hidden until you press `[v]`, then two of them to check your copy. For storage that already has backups, the phrase for those backups |
| Review | Everything on one screen. Change any line, then press `[s]` to save |

Setup connects right after the storage step and checks it can read, list, write and delete a test object, including [conditional writes](#storage-compatibility). If that fails, it goes back to the answer that caused it and keeps the rest. If the key on this machine doesn't open the backups already in that storage, it asks for their recovery phrase. If this machine's backups are somewhere else and the new storage is empty, it asks before starting a separate set of backups there.

Picking Permafrost asks whether you have an access key. If you don't, frost opens [getfro.st/perma](https://getfro.st/perma) in your browser, and you paste the key it gives you. With a custom Permafrost server, setup only asks for the key.

Saving writes `config.toml` and the key file and installs the scheduled job. Run `frost init` again any time to review or change your settings.

The full-screen setup doesn't ask for a Permafrost server or a folder inside an S3 bucket, and keeps whatever's already set. Use `frost config edit` for a new server or prefix, accept its warning, save and run `frost init` again. `frost config set` requires an existing repository at the new location. For a fresh custom-server setup, prepare `config.toml` as described in the [Permafrost help](https://getfro.st/help/storage/permafrost).

With piped input, `init` asks plain questions, one per line. It offers a generic S3 option instead of the provider presets and asks for the folder inside the bucket. Getting a Permafrost key works there too.

If Permafrost rejects your access key or refuses an upload, commands that access your backups stop with an error that gives Permafrost's reason. Run `frost init` again to set up a working key.

### Storage compatibility

frost needs atomic conditional PUTs (`If-None-Match: *`) to prevent machines from overwriting each other's backup metadata. Setup checks that a second create fails without changing the original object. A preset saves typing; it doesn't certify a provider. frost also checks a new storage location before accepting it through `frost config set`.

| Provider | Conditional PUT support |
|---|---|
| Amazon S3 | [Documented](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) |
| Cloudflare R2 | [Documented](https://developers.cloudflare.com/r2/api/s3/api/) |
| MinIO | [Implemented in the server](https://github.com/minio/minio/blob/master/cmd/object-handlers.go). Your installed version must pass setup's check |
| Backblaze B2 | Unverified. Its [PUT reference](https://www.backblaze.com/apidocs/s3-put-object) doesn't list `If-None-Match` |
| Wasabi | Unverified. Its [API reference](https://docs.wasabi.com/apidocs/operations-on-objects) doesn't establish support for conditional PUTs |
| Garage | Unsupported, according to its [maintainer](https://news.ycombinator.com/item?id=46329908) |

These findings were checked against documentation and source on 2 October 2026, without live cloud-account tests. Setup refuses storage that rejects or ignores conditional creates. Changing credentials can't fix missing provider support.

## `frost backup`

Backs up the configured folders now. Only data that changed since the last run is uploaded, and `backup` says how many files were added, changed and removed since the last snapshot. If nothing changed, it saves no new snapshot and says it's already backed up.

A change is a file or folder added or removed, or a file whose contents, size, permissions or modification time changed. A folder's modification time alone doesn't count, because temporary and excluded files change it all the time.

| Flag | Does |
|---|---|
| `-n`, `--dry-run` | Say what changed and list the files with new data and the total, without uploading anything or saving a snapshot |
| `--path <dir>` | Back up this folder instead of the configured ones. Repeatable |
| `--exclude <pattern>` | Also skip this pattern for this run. Repeatable |
| `--no-verify` | Skip the spot check after the backup |

After a backup that saves a snapshot, frost downloads `verify.sample` random chunks and checks them. When nothing changed, it only checks if the last check is more than a day old or found a problem, and shows the last result otherwise. If any check fails, `backup` exits with `1`.

With Permafrost, `backup` ends with a `storage` warning when the server has something to say about the account, such as storage that's nearly full.

In a terminal, `backup` asks before it starts when a scheduled backup starts within the next hour, or finished within the last hour. For schedules under 4 hours apart, the window is a quarter of the interval. Enter goes ahead and `n` cancels. A finished scheduled backup only counts when it worked and no backup has run by hand since. There's no question for a dry run, with `--path` or `--exclude`, or when input doesn't come from a terminal.

Only one backup or restore uses your backups at a time. If another is running, `backup` stops and says so, and names a scheduled backup when that's what's running.

### What's backed up

frost backs up regular files, folders and symlinks, with their permissions and modification times. A symlink is stored as the link itself, and hard-linked files are backed up and restored as separate files. frost skips sockets, devices, pipes and the `.frost-partial-...` files a stopped restore leaves behind, and it doesn't keep owners, ACLs or extended attributes.

### When something goes wrong

| What happens | What frost does |
|---|---|
| A file or folder inside a backed-up folder can't be read (permissions, deleted mid-run, kept only in iCloud on macOS) | Skips it and lists it. The snapshot is still saved, and `status` shows how many were skipped |
| A configured folder isn't there (an unplugged drive, a moved folder) | Skips it and backs up the rest. `backup` and `status` name it |
| None of the configured folders are there, or one exists but can't be read | Fails the whole backup, so it doesn't look fine while saving nothing |
| A file changes while it's read (a database in use, a running VM's disk, a download) | Reads it again at the end of the backup. If it's still changing, the snapshot keeps its previous copy, and `backup` and `status` list it. A file that was never backed up cleanly is skipped |

frost doesn't take filesystem or database snapshots. Back up a file that's always busy while it's closed or stopped.

Backups don't list every object in storage. frost trusts its local record of what's uploaded and checks it against storage once a week, after a check finds something missing, or when the storage isn't where it was last checked.

On macOS, frost doesn't download files that iCloud keeps only online. They're skipped and listed like other files that can't be read.

macOS also protects some folders. A backup you run in a terminal gets access through the terminal app (Terminal, iTerm and so on). Scheduled backups run the bundled runtime, `~/Library/Application Support/frost/app/runtime/bin/node`. macOS asks about it the first time it reads `~/Desktop`, `~/Documents` or `~/Downloads`, and refuses it access to other protected folders like `~/Library/Mail` and `~/Library/Safari` without asking. To cover them all, add the runtime under System Settings > Privacy & Security > Full Disk Access. The permission carries over when frost updates.

## `frost restore [snapshot] [paths...]`

Restores files from a snapshot. With no arguments in a terminal, it opens the [snapshot browser](#frost-browse).

### Picking a snapshot

frost shows a snapshot's ID as two words and 4 more characters, like `maple-absurd-3f1c`. When two IDs would look the same, it shows more characters for both. If an ID you type matches more than one snapshot, frost asks for more of it. The full ID has 11 characters after the words. It names the snapshot's objects in storage, and the command that [carries on a restore](#interrupted-restores) uses it.

| You type | You get |
|---|---|
| `latest` | The newest snapshot |
| `maple-absurd-3f1c` or `maple` | The snapshot with that ID, or the only one whose ID starts with what you typed |
| `3 days ago`, `12h`, `2w`, `1 month ago` | The newest snapshot at or before that time |
| `yesterday`, `today` | The newest snapshot by the end of that day |
| `2026-09-20`, `2026-09-20 14:30` | The newest snapshot at or before that day or minute, in local time |

Paths limit the restore to those files or folders and everything inside them. Without paths, the whole snapshot is restored.

### Where files go

Pick exactly one:

| Flag | In the browser | Does |
|---|---|---|
| `--beside` | New folder beside originals | Restores into a new `frost-restore-<id>` folder next to the originals |
| `--to <dir>` | New folder elsewhere | Restores into a new `frost-restore-<id>` folder inside `<dir>`, which must exist |
| `--overwrite` | Overwrite original files | Restores back where the files came from, replacing what's there. Asks first |

`-y`, `--yes` skips the question before overwriting.

In a new folder, what you restore keeps its own name, relative to the folder the selection shares:

| You restore | `--beside` gives |
|---|---|
| `~/Documents/taxes` | `~/Documents/frost-restore-<id>/taxes/...` |
| `~/notes.txt` | `~/frost-restore-<id>/notes.txt` |
| `~/Documents/a` and `~/Pictures/b` | `~/frost-restore-<id>/Documents/a` and `.../Pictures/b` |

Without paths, the selection is the snapshot's backed-up folders. `--beside` doesn't work when the selection only shares the top of a drive, when that folder isn't on this computer (a snapshot from another machine), or when you can't write to it. Backing up your whole home folder, for example, would put the new folder in `/Users` or `/home`. Use `--to` in those cases.

A new folder never overwrites anything. Its name always uses the ID with 4 characters, and if that name is taken, frost adds `-1`, `-2` and so on.

Every chunk is decrypted and checked against its ID before it's written, and chunks download in parallel. Each file is written to a hidden `.frost-partial-...` file and renamed into place when it's complete, so a failed restore never leaves a half-written file where a real one was.

### Overwriting

`--overwrite` needs a snapshot from a computer with the same kind of paths (macOS and Linux, or Windows). It follows links above a file only when the link and its parent belong to you or to root, and the parent is protected from writes by other users. Owned sticky folders can protect owned entries. A link in an untrusted folder is refused, and on Windows any link or junction there is refused. frost checks this before asking, and the browser greys out "Overwrite original files" and says why.

Originals that already match the snapshot are checked and skipped, so they aren't downloaded. Overwriting needs room for the new copy of a file next to the old one until it's renamed into place.

### Interrupted restores

If a restore stops (a lost connection, Ctrl+C, the machine sleeping), frost prints the command that carries on. It's the same restore with the snapshot's full ID in place of `latest` or a time, so a backup in between doesn't change which snapshot it means.

On Windows, paths with shell expansion characters get a PowerShell command; the message says when to use PowerShell.

The new run carries on in the same folder. Files already there are checked and skipped, and the file it was writing continues from its last good chunk. Until the restore finishes, the folder holds a `.frost-restore` marker and the unfinished file's `.frost-partial-...`. `--overwrite` carries on the same way.

## `frost status`

Shows the version, the storage and key fingerprint, the last backup and whether it worked, when the next one is due, the latest verification result, how updates are set up, and the 10 most recent snapshots. With Permafrost, a `storage` row shows how much the account uses of its limit, and leads with the server's warning when it has one.

When there are more than 10, a line below the list shows how many older snapshots aren't shown, like `+90` for 100 snapshots.

| Flag | Does |
|---|---|
| `--verify` | Run a fresh verification first. It checks `verify.sample` random chunks (20 if that's `0`) and compares the local chunk list with everything in storage |
| `-a`, `--all` | List every snapshot |

If snapshots this machine knew about have gone from storage, `status` says so once. `status --verify` exits with `1` when verification fails, so you can run it from your own scheduler to verify on a different schedule from backups.

## `frost browse`

Opens the snapshot browser.

| Screen | Keys |
|---|---|
| Home | `[enter]` browse snapshots, `[r]` refresh |
| Snapshots | `[enter]` open, `[d]` compare with the previous snapshot, `[m]` mark one, then `[d]` on another to compare those two |
| Files | `[enter]` open a folder, `[←]` go up, `[space]` select, `[a]` select or unselect everything here, `[c]` clear the selection, `[r]` restore the selection (or the highlighted item) |
| Restore | `[1]` `[2]` `[3]` pick where files go, `[enter]` restore or choose a folder, `[y]` confirm overwriting, `[c]` change the folder, `[esc]` cancel |
| Everywhere | `[h]` help, `[s]` settings, `[v]` show or hide the key fingerprint (hidden by default), `[esc]` back, `[q]` quit |

Arrow keys or `j`/`k` move, `pgup`/`pgdn` page, and `g`/`G` jump to the top and bottom. Help, settings and long errors scroll the same way when they don't fit. `[esc]` dismisses an error. Long restore confirmations and results scroll with `[pgup pgdn]`, which never starts a restore or dismisses its result.

"New folder elsewhere" opens your system's folder picker (Finder, Explorer, or zenity, qarma or matedialog on Linux), then shows where everything will land so you can restore, change the folder or cancel. Over SSH, or on Linux without a picker, you type the folder instead. Press `[t]` while the picker is open to type it anyway.

After a successful restore, the browser shows the result in Finder, Explorer or your Linux file manager. A single restored file is shown selected (on Linux, its folder opens). Otherwise the deepest folder holding everything restored opens. Nothing opens over SSH, without a display, or when the restore fails.

## `frost update`

Installs the latest frost release in the application folder.

| Flag | Does |
|---|---|
| `--check` | Only say whether there's a newer release |

frost checks the release's signed checksums, downloads the package for your platform and checks its SHA-256. It stages the scripts and bundled runtime, tests their versions, then activates the new scripts. The runtime keeps its fixed path, and identical runtime bytes aren't replaced. Config, keys and backups stay in their own folders. [SECURITY.md](SECURITY.md#updates) describes the checks and interruption limits.

It never installs a pre-release, or anything older than what you're running. frost installed with npm or pnpm updates itself this way too.

It can't update in these cases:

| When | Do instead |
|---|---|
| frost was built from source | Rebuild it with `npm run build`, or use the installer |
| You can't write to its application folder | Reinstall with the installer as your own user |

### Automatic updates

After a scheduled backup, frost checks for a new release at most once every 20 hours and installs it the same way. The check runs whether or not the backup worked, and a failed check or install never fails the backup. The result shows in `frost status` and the browser's settings, and in the [scheduled run log](#files) where there is one.

With `update.auto` set to `false`, the check still runs and `frost status` says when a release is out, but nothing is installed until you run `frost update`. Without scheduled backups there's no background check at all.

## `frost config`

| Usage | Does |
|---|---|
| `frost config` | Print every setting. Credentials are masked unless you add `--show-secrets` |
| `frost config get <key>` | Print one setting. Lists print one item per line, and secrets need `--show-secrets` |
| `frost config set <key> <value...>` | Change one setting and show what changed. Lists take one value per item |
| `frost config edit [editor]` | Open a copy of `config.toml` in the editor you name, `$VISUAL` or `$EDITOR`, or nano, vim or vi (Notepad on Windows). When you close it, frost lists what changed and saves the copy once you type `yes`. A file that doesn't parse goes back to the editor |

Changing a `schedule` setting with `set` or `edit` updates the OS scheduled job straight away.

On macOS and Windows, replacing the job while a scheduled backup is running would stop that backup, so the change waits. `set`, `edit` and `frost init` save it, say the job updates once the running backup finishes, and start a background frost process that applies it as soon as the backup is done, however long that takes. Later changes share the same process, which checks every 15 seconds and prints nothing. If `config.toml` is gone by then because frost was uninstalled, it removes the job. A systemd timer or crontab line can be replaced during a backup, so on Linux nothing waits.

### Editing `config.toml` directly

You can also change `config.toml` in any editor. Every command reads its settings from the file when it runs, so most changes take effect on the next run. Two settings need more than that, and frost handles them the next time any command except `init` and `config get` runs:

| You change | What frost does |
|---|---|
| A `schedule` setting | Updates or removes the scheduled job to match, and prints `config.toml changed. Scheduled job updated: daily.` or `Scheduled job removed.`. If the new value is wrong or the scheduler refuses, it says so on every command until it's fixed. A change made while a scheduled backup runs waits for it, as `set` does |
| Where backups go | Runs the checks `frost config edit` would, the first time a command uses the new location, and prints any problem as a warning. A location that doesn't open fails with the usual explanation |

On Linux, a scheduled run updates its job too. A launchd or Task Scheduler job can't replace itself while it runs, so it waits for the next command. Until then, scheduled runs already follow the new settings: they decide whether a backup is due from `config.toml`, and do nothing while `schedule.enabled` is `false`.

### Settings

| Key | Default | Meaning |
|---|---|---|
| `paths` | | Folders to back up |
| `exclude` | `.DS_Store`, `Thumbs.db`, `*.tmp`, `*.swp`, `node_modules`, `.cache` | A bare name or pattern matches anywhere. A pattern with a `/` is a full path (`~` works) and matches that path and everything under it |
| `schedule.enabled` | `true` | Run backups automatically |
| `schedule.every` | `daily` | `hourly`, `2h`, `3h`, `4h`, `6h`, `8h`, `12h`, `daily` or `weekly` |
| `schedule.time` | `15:00` | The local time backups run, as `HH:MM` on a 24-hour clock. Shorter intervals count from it, so `6h` from `15:00` runs at 03:00, 09:00, 15:00 and 21:00 |
| `schedule.day` | `sunday` | The day weekly backups run, `sunday` to `saturday` |
| `schedule.catch_up` | `true` | Run a backup missed while the computer was off or asleep once it's back. See [Missed runs](#missed-runs) |
| `verify.sample` | `20` | Chunks downloaded and checked after a backup that saves a snapshot, and at least once a day otherwise. `0` turns the check off |
| `update.auto` | `true` | Install new releases after scheduled backups. `false` only tells you about them |
| `storage.backend` | | `s3` or `permafrost` |
| `storage.s3.endpoint` | | Like `s3.us-east-1.amazonaws.com`. A full `https://` URL also works, and an `http://` one turns off TLS |
| `storage.s3.region` | | Blank if your provider doesn't use one |
| `storage.s3.bucket` | | Must already exist |
| `storage.s3.prefix` | `frost` | The folder inside the bucket that holds everything. Empty for the top level |
| `storage.s3.access_key_id` | | |
| `storage.s3.secret_access_key` | | |
| `storage.s3.insecure` | `false` | Use plain HTTP when the endpoint has no scheme. Only for local testing |
| `storage.permafrost.url` | | Blank for the default server, `https://permafrost.wihiaawb.com`. Otherwise an `https://` URL (`http://` only for localhost) |
| `storage.permafrost.token` | | |

### Moving your backups

| You want to | Do this |
|---|---|
| Move them to another folder or bucket | Move the whole folder (`frost.repo`, `chunks/`, `snapshots/` and `trees/`), then point frost at it with `frost config set`. Nothing uploads again |
| Start a separate set of backups somewhere else | Run `frost init` and point it at the empty location. The old backups stay where they are, but frost only shows the new ones |
| Go back to backups you moved away from | Set the old location again |

Moving only `frost.repo` doesn't move your backups. `frost config set` checks a new location before saving it, and refuses one with no frost repository or a different key. It also refuses a copy with no snapshots when the old location still has snapshots for the same repository. `frost config edit` shows them as warnings before you save, so it can still make a change `set` refuses. A location changed in `config.toml` directly gets the same warnings the first time it's used, as [Editing `config.toml` directly](#editing-configtoml-directly) describes. If frost can't find your backups, the error and `frost status` say where they were last opened and how to get back to them.

### Environment variables

| Variable | Overrides |
|---|---|
| `FROST_S3_ACCESS_KEY_ID`, `AWS_ACCESS_KEY_ID` | `storage.s3.access_key_id` |
| `FROST_S3_SECRET_ACCESS_KEY`, `AWS_SECRET_ACCESS_KEY` | `storage.s3.secret_access_key` |
| `FROST_PERMAFROST_TOKEN` | `storage.permafrost.token` |
| `FROST_CONFIG_DIR` | The config directory, same as `--config-dir` |
| `FROST_CACHE_DIR` | The cache directory |

Values from the environment are never written to `config.toml`.

## `frost key <show | verify | import>`

| Action | Does |
|---|---|
| `show` | Prints the recovery phrase after you type `show` to confirm |
| `verify` | Asks for a phrase and says whether it's valid, whether it matches this machine's key, and whether it opens your backups |
| `import` | Puts an existing phrase on this machine, after a reinstall for example. If storage is configured, it checks the phrase opens it first |

## Files

| What | macOS and Linux | Windows |
|---|---|---|
| Config | `~/.config/frost/config.toml` | `%AppData%\frost\config.toml` |
| Key | `~/.config/frost/key` | `%AppData%\frost\key` |
| Manifest (a cache) | `~/.cache/frost/manifest-<repo>.jsonl` | `%LocalAppData%\frost\manifest-<repo>.jsonl` |
| Where backups last opened, one per config folder | `~/.cache/frost/storage-<config>.json` | `%LocalAppData%\frost\storage-<config>.json` |
| Update check | `~/.cache/frost/update.json` | `%LocalAppData%\frost\update.json` |
| The scheduled job's schedule and install time, and when the last full backup ran, one per config folder | `~/.cache/frost/schedule-<config>.json` | `%LocalAppData%\frost\schedule-<config>.json` |
| Scheduled run log, with launchd, cron and Task Scheduler | `~/.cache/frost/frost.log` | `%LocalAppData%\frost\frost.log` |

On macOS and Linux, frost respects `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`. With systemd, scheduled runs log to the journal instead (`journalctl --user -u frost-backup`). On Windows, frost appends backup output, failures and update results to the log itself, including with tasks installed by an older version. Logs larger than 1 MiB are emptied before the next run.

The manifest is disposable. Removing it rebuilds the cache from storage and rereads source files on the next backup. Its persistent `.lock` file prevents concurrent cache writers; deleting a lock file isn't a way to stop a running process. [Installation](#installation) lists application folders.

## Scheduled jobs

| OS | Scheduler | Where |
|---|---|---|
| macOS | launchd | `~/Library/LaunchAgents/io.github.whatithasisandalwayswillbe.frost.plist` |
| Linux with systemd | systemd user timer | `~/.config/systemd/user/frost-backup.{service,timer}` |
| Linux without systemd | cron | A line in your crontab tagged `# frost-backup` |
| Windows | Task Scheduler | A task named `frost backup` |

The job invokes the bundled runtime and launcher to run `frost backup --scheduled`, which logs plain lines instead of a progress bar and then checks for [updates](#automatic-updates). Every scheduler starts backups at `schedule.time` in local time: daily, weekly on `schedule.day`, or for shorter intervals at that time and every interval before and after it. systemd starts each run up to 5 minutes late, at random. The Windows task runs only while you're signed in, doesn't start on battery and stops if the computer is unplugged.

macOS lists the job under System Settings > General > Login Items & Extensions as Node.js Foundation, the publisher of the bundled runtime. Switching it off there stops scheduled backups, and `frost status` says the job is missing. frost loads the job again whenever it reinstalls it, after a schedule change for example, even though the switch still shows off. To stop scheduled backups, run `frost config set schedule.enabled false`.

With systemd, frost tries to turn on lingering for your user (`loginctl enable-linger`) if it can confirm lingering is off. Lingering lets the timer run while you're logged out too. If frost can't enable it, backups may stop after logout. When removing the timer, frost turns lingering off only if it recorded enabling it.

Jobs keep the config and cache directories used when they're installed, including environment overrides. Run `frost init` again after changing those directories, or to update an older job that didn't keep them.

If the job goes missing, `frost status` says so, and `frost config set schedule.enabled true` puts it back.

### Missed runs

With `schedule.catch_up` on, a backup missed while the computer was off or asleep runs once it's back. However many runs it missed, it backs up once.

| Scheduler | Starts a missed backup |
|---|---|
| launchd | When the Mac wakes, or at login after it was off |
| systemd | When the machine wakes, or when the timer starts again after it was off: at boot with lingering, otherwise at login |
| Task Scheduler | As soon as it can once the computer is back and you're signed in |
| cron | Within 15 minutes. With catch-up on, cron starts frost every 15 minutes and frost decides |

Every scheduled run checks `schedule-<config>.json` in the cache folder first. It exits without a log line or update check when a full backup has already started for the latest run time, whether scheduled or by hand, or when the job was installed after that time. A run that starts more than 10 minutes late is catching up, and with `schedule.catch_up` off frost skips it. That includes the runs launchd and systemd always start on wake. If frost can't read its settings or that file, it backs up.

A scheduled run that can't reach storage, often because the computer has only just woken, tries again for about 5 minutes. If another backup or a restore is using your backups, it waits up to an hour for it to finish.

## Exit codes

frost exits with `0` on success and `1` on any error, including a backup or `status --verify` whose verification finds a problem.
