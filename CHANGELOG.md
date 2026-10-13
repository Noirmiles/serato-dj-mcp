# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking
changes.

## [Unreleased]

The server now runs on Windows, and can repair tracks Serato has flagged missing. Most of this is
verified on generated test libraries only; a handful of specific facts about `master.sqlite` and
the per-volume stores were also measured directly against a real Serato DJ Pro 4.0.0 install on
Windows, on 2026-10-12. The README's [Windows](README.md#windows) section says which is which.

### Added

- `preview_relocate`, and with `--allow-writes` `apply_relocate`: find and repair tracks Serato
  has flagged missing, by revalidating a file still at its recorded path, matching it under a new
  parent folder (`moved_under`), or searching for it by filename (`search_folder`). A repair
  writes the new path, clears the missing flag and sets the file size in both `master.sqlite` and
  the per-volume store (`location.sqlite` or `root.sqlite`) the track belongs to.
  `apply_relocate` backs up every store it touches alongside both library databases, the same as
  `apply_changes`, and is refused while Serato is running.
- Windows support for the server's own handling of files, paths and processes, verified on
  2026-10-12 on Windows 11 by the test suite (Node.js 22.16.0, 24.21.0 and 25.6.0) and by driving
  the built server over stdio against the demo library:
  - The library is looked for in `%LOCALAPPDATA%\Serato\Library` and in `_Serato_\Library` on
    each drive from `C:` to `Z:`, so `--library` is no longer mandatory there.
  - The cache and state directories default to `%LOCALAPPDATA%\serato-dj-mcp\Cache` and
    `%LOCALAPPDATA%\serato-dj-mcp\State`.
  - Track paths are built for a drive letter or a network share, and a path under the user
    folder is shortened to `~\...` whatever its case or slashes.
  - The check that Serato is closed reads the process name from `tasklist`, since Windows has
    no `ps`.
- Also measured directly against a real Serato DJ Pro 4.0.0 install on Windows, on 2026-10-12:
  `connection.database_uri` mixes separators within one `master.sqlite` (an external drive's row
  used forward slashes, the local library's rows used backslashes, both already handled); the
  main library is confirmed at `%LOCALAPPDATA%\Serato\Library`; the `lock` table's
  `owner_process_name` is `'Serato DJ Pro.exe'` while it runs and empty after a clean exit; Serato
  refuses to open `master.sqlite` on a `foreign_key_check` violation as well as an
  `integrity_check` one; and a present file is re-flagged missing if its row's `file_size` is 0.
  See [docs/serato-4x-notes.md](docs/serato-4x-notes.md#windows) for the detail.
- `npm run demo-library` works on a Windows drive.
- CI runs lint and the test suite on `windows-latest` as well.

### Changed

- `permission_denied` carries instructions for the platform it happened on; on Windows it no
  longer says to grant Full Disk Access.
- Text files check out with LF line endings on every platform (`.gitattributes`).

### Fixed

- On Windows, `stage_crate` and `apply_changes` always failed with `EPERM ... fsync`: a directory
  cannot be flushed there. The directory flush is skipped on Windows and kept everywhere else.
- On Windows, replacing the stage or manifest file while another process was reading it failed;
  it is now retried for about 300 ms.
- A snapshot was reported as failed when another server instance had published the same
  snapshot a moment earlier and still had it open, which Windows turns into a refused rename. The
  published copy is served instead.
- A temporary file that could not be deleted while a failed snapshot was being reported turned
  that report into an exception.

### Not verified

- A Serato DJ installation on Windows picking up a server write: Serato opening a crate, or
  re-displaying a track, this server wrote there.
- A `\\server\share` `database_uri`, or a `root.sqlite` whose `database_uri` names a drive other
  than the one it is installed on; only a plain drive-letter path, in either separator
  convention, has been seen.
- The Claude Desktop extension on Windows, which is still built for macOS only, and every MCP
  client on Windows other than the test client.

## [0.1.1] - 2026-09-25

Claude Desktop now sees your library's data, and the server installs from the MCP Registry, as a Claude Desktop extension, or as a Claude Code plugin.

### Added

- A Claude Desktop extension (`.mcpb`), attached to each GitHub Release from this version on and
  listed in the MCP Registry: install it by opening the file, no Node.js needed. Its settings are
  the library folder (optional), "Allow writing crates" and "Allow raw SQL", both off by default.
  macOS only ([a9ba003]).
- Each release is now published to the official MCP Registry as well as npm, as
  `io.github.Venut-Technologies/serato-dj-mcp` (the new `mcpName` in `package.json`), so MCP
  clients and catalogs that read the registry can find and install the server ([c296ac9],
  [5ed9177], [06019b9]).
- A Claude Code plugin (`.claude-plugin/plugin.json`) that starts the server with
  `npx -y serato-dj-mcp`, read-only ([0f73224]).
- [PRIVACY.md](PRIVACY.md): what the server reads, what it writes and where, and that it makes no
  network requests and sends no telemetry, with the source file behind each statement
  ([4a9783e]).

### Changed

- The README starts with what a DJ can do and ask, and installs from npm with `npx`: it said the
  package was not on npm yet, which was also what the npm page showed. It now has setup steps for
  Claude Desktop (extension or config), Claude Code, Cursor and VS Code, with install links for
  the last two, and says which of them were tried and that Windows is untested ([75c6af1]).
- The package description says what the server does for a DJ, including that it writes new
  crates after a preview, instead of only "staging" them ([c296ac9]).
- Every tool now states all four MCP hints and `openWorldHint: false`, with its title repeated
  inside `annotations`. `apply_changes` is now marked destructive: it only adds crates, but it
  writes into Serato's own database, rotates old backups out and has no undo tool, so a client
  that asks before destructive calls will ask before this one. `discard_changes` is marked
  idempotent ([60c957f]).

### Fixed

- In Claude Desktop, every tool answered with a one-line count ("crates: 3") and no data: results
  travelled only as structured content, which Claude Desktop does not pass to the model. Results
  now also travel as compact JSON text, as the MCP specification recommends, so Claude Desktop
  sees the tracks and crates themselves ([aca9ee5]).

## [0.1.0] - 2026-09-19

The first release: reading, auditing and — behind a flag — crate writing.

### Added

- Local MCP server for Serato DJ 4.x libraries, reading through a snapshot copy of the library
  database so a query never changes the library ([fb8c0a0]).
- `list_libraries`: the libraries the server can see, with version, schema version and locations.
- `search_tracks`: free text, BPM range or BPM around a value, Camelot key or harmonically
  compatible keys, genre, rating, date added, crate membership and flags; keyset pagination.
- `get_tracks` and `get_crate_tracks`: tracks by id, and the tracks of a crate in its own order.
- `list_crates`: the crates of the Serato Library space with their display paths and track counts.
- `audit_library`: tracks with no BPM, no key or an unreadable key, stale, in no crate,
  streaming-only, duplicated, or with broken paths, with an opt-in check against the disk
  ([589c6cb]).
- `run_sql` behind `--allow-raw-sql`: one read-only `SELECT` against the snapshot.
- Crate writing behind `--allow-writes`: `stage_crate`, `preview_changes`, `discard_changes` and
  `apply_changes`. Crates are staged first and applied only with Serato closed, all or nothing,
  after a backup of both library databases and with a manifest of every write ([4031b37]).

[Unreleased]: https://github.com/Venut-Technologies/serato-dj-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Venut-Technologies/serato-dj-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/Venut-Technologies/serato-dj-mcp/releases/tag/v0.1.0
[fb8c0a0]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/fb8c0a0
[589c6cb]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/589c6cb
[4031b37]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/4031b37
[60c957f]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/60c957f
[c296ac9]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/c296ac9
[5ed9177]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/5ed9177
[06019b9]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/06019b9
[4a9783e]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/4a9783e
[0f73224]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/0f73224
[aca9ee5]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/aca9ee5
[a9ba003]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/a9ba003
[75c6af1]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/75c6af1
