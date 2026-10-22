# Reference fixtures

These immutable records preserve command output, terminal cells, encrypted repository objects and asset bytes captured before replacement. They aren't regenerated from the implementation under test.

| Folder | Contract |
| --- | --- |
| `cli/` | 61 external commands per recorded platform, 49 connected workflows, 68 layout records, colour profiles and format boundaries |
| `tui/` | Browser, setup, restore, help and game frames, model inputs and Unicode widths |
| `core/` | Existing encrypted objects, keyed chunk boundaries, signature vectors and BIP39 vectors |
| `assets.json` | SHA-256 hashes of the original wordmarks and sound effects |
| `manifest-compression.fixture` | The compiled manifest source used as a fixed ZIP compression sample, so editing an error message doesn't change the ratio test's input |

Windows and Linux captures are recorded separately where output depends on the platform. Mac screen tests use the portable recorded Linux inputs. Platform-specific command comparisons skip when native captures are missing.

Don't update expected output to make a failed comparison pass. Fix the cause, or review an intentional behaviour change with the user first. All keys and credentials in the fixtures are public dummy test values.

## Reviewed changes

| Date | Frames | Change |
| --- | --- | --- |
| 2026-10-06 | `setup-11-check-*`, `setup-12-check-wrong-*` | The phrase check title reads "(1 of 2)" instead of using a hyphen as a dash. |
| 2026-10-06 | `10-game-title-050`, `11-game-play-050`, `12-game-over-050`, `game-*-20` | The game's window hint gives the real minimum, 36x22, instead of 34x18. |
| 2026-10-11 | `setup-25-permafrost-get-key-*` (new), `setup-27-*`, `setup-28-*`, `setup-29-*` (removed) | Setup no longer waits for the browser to send a key back. The waiting screen and its frames are gone. Choosing "I don't have a key yet" opens getfro.st/perma and goes to the key field, which frame 25 captures. |
| 2026-10-17 | CLI `config-list`, `config-list-secrets`, `config-get-unknown`, `config-set-unknown`; workflow `config-connected` | The new `schedule.catch_up`, `schedule.day` and `schedule.time` settings appear in `frost config` with their defaults and in the list of valid keys. Rows were inserted by hand; no other output changed. |
| 2026-10-19 | `setup-02-storage-*` | The storage list has four choices: Permafrost, S3-compatible, Self-hosted and Local drive. The S3 services moved to their own list, and the line under the question reads "Choose your storage below." Rows whose text didn't change keep their captured bytes. |
| 2026-10-19 | `setup-02c-s3-choice-*`, `setup-30-self-hosted-address-*`, `setup-31-self-hosted-folder-*`, `setup-32-key-choice-*`, `setup-33-key-manual-*`, `setup-34-local-drive-*` (new) | The S3 list, the self-hosted questions, the two screens for adding Frost's SSH key and the local drive question. |
| 2026-10-19 | CLI `help`, `backup-help`, `grouped-flags`, `root-help-false`, `root-help-short-group`, `init-eof`, `init-bad-choice-eof`, `config-list`, `config-list-secrets`, `config-get-unknown`, `config-set-unknown`; workflow `init-new`, `init-wrong-check-eof`, `config-connected` | The root help names all four kinds of storage. Plain `frost init` offers Self-hosted and Local drive as choices 3 and 4, and its S3 hint names Ceph instead of MinIO. The recovery phrase note says nobody can recover it, "not whoever stores your backups, not us", instead of naming a storage provider. `storage.local.path` and the `storage.sftp` settings appear in `frost config` with their defaults and in the list of valid keys. Text was replaced by hand; no other output changed. |
| 2026-10-19 | workflow `init-new`, `init-wrong-check-eof` | The plain `frost init` region question reads "blank if your server or provider doesn't use one", since Other S3-compatible now covers S3 servers people run themselves. Text was replaced by hand; no other output changed. |

The 2026-10-06 changes kept the text's length, so only those characters differ. Frame 25 is a new screen, rendered when it was added, and so are the 2026-10-19 frames marked new. All apply to the Windows and Linux captures.
