# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking
changes.

## [Unreleased]

The server now runs on Windows. That is verified on generated test libraries only: it has not
been run against a Serato installation on Windows, and the README's
[Windows](README.md#windows) section lists what is still an assumption.

### Added

- `dist/control-cli.js` (Windows only): `node dist/control-cli.js <status|close|open|rescan> [--timeout-seconds N]`
  runs the `serato_*` logic directly, without MCP, and prints one JSON line (`{"ok":true,"result":...}` or
  `{"ok":false,"error":{...}}`); exit code 0 ok, 1 failure, 2 bad usage. See docs/serato-control.md.
- `serato_close` now handles Serato DJ Pro 4's "Exit - are you sure?" dialog: after the close request, if
  Serato is still running it presses the dialog's Yes/OK button (UI Automation, else window-scoped OCR
  click). Still never kills; reports "still running, NOT killed" if the dialog is not found. Never
  confirmed when audio is playing.

- `serato_rescan` (with `--allow-serato-control`, Windows only): presses Serato DJ Pro's Re-Scan File
  Info button for the whole library. UI Automation first, then an OCR fallback (built-in
  `Windows.Media.Ocr` on a screenshot of the Serato window only, then a synthesised mouse click,
  opening the Files panel if needed). Reports `method` and `verified` (`true`/`false`/`"unknown"`).
  Checked on Serato 4.0.0.2697: UIA exposes nothing, OCR locates the button and the Files tab, and a
  click on the Files tab works; the rescan click itself and its reliability are **not measured**
  (see `notes/rescan-spike-results.md`). Per-folder rescan is not supported. New scripts:
  `scripts/serato-uia-spike.ps1`, `scripts/serato-rescan-reliability.ps1`.
- `--allow-serato-control` (Windows only): registers `serato_status`, `serato_close` and
  `serato_open`. Status reports the process, main window, audio state and install path;
  `looks_idle` is a polled hint. Close is graceful only (`confirm: true`, refused while audio is
  detected, confirms Serato's "Exit - are you sure?" dialog after the close request, never force-terminates, reports "still running, NOT killed" on timeout, then checks
  `database V2` is stable). Open launches from `SERATO_DJ_EXE` or a discovered install and waits for
  the window. Backed by Windows PowerShell 5.1 behind a `SeratoPlatform` interface; writes no
  library file. Scripts checked on real PowerShell with Serato not running only; tool logic is
  tested with a fake platform.
- `stage_add_to_crate` (with `--allow-writes`): stage appending tracks to an existing top-level
  crate, through the same stage, `preview_changes`, `apply_changes` flow as `stage_crate` — backup
  first, `serato.revision` bumped before the `container_asset` rows, refused while Serato runs.
  Tracks the crate already holds are skipped (de-duplicated in code, since `container_asset` has no
  unique constraint) and reported. `preview_changes` and `apply_changes` results mark appends with
  `mode: "append"`. The stage file gains an optional `mode` field, so existing stage files still
  load. Tested on generated fixtures only; not yet checked against Serato picking up an appended
  crate.
- `get_track_markers`, a read-only tool returning a track's cue points (index, position in ms,
  colour, name), saved loops (start, end, locked, name), track colour and BPM-lock flag from the
  `Serato Markers2` tag in the audio file: MP3 and AIFF (ID3v2 `GEOB`) and FLAC
  (`SERATO_MARKERS_V2`). Unsupported formats, missing files and missing tags give a warning, not
  an error. Never writes to audio files. Tested on synthetic fixtures built from the published
  format notes only; not yet compared with files written by Serato.
- `serato_inspect`, a read-only tool reporting the library's layout: which of `master.sqlite`,
  `root.sqlite` and `location.sqlite` exist, journal mode and `user_version` of the snapshot,
  table names, row counts, the state of the `lock` table and up to 5 stored-path samples with
  their drive-letter and separator style. Tested on generated fixtures only; not yet run against
  a Serato installation on Windows.
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
- `npm run demo-library` works on a Windows drive.
- A read-only parser for the tag-length-value records of Serato 3.x `database V2` and legacy
  `.crate` files (`src/legacy/`), with `parseCrateFile` for crates. It is not wired into any tool
  and writes nothing. Tested only against generated files, not files Serato wrote; it fails
  closed on anything it does not recognise, under the new error code `malformed_file`.
- CI runs lint and the test suite on `windows-latest` as well.
- Serato 5 libraries (schema `user_version` 203) are read: the version is known, so it no longer
  gets a `schema_unknown` warning. Serato 4 (202) is unchanged.
- `get_track_markers` decodes Markers2 `CUELOOP` entries into a new `cue_loops` list (index,
  start_ms, end_ms, locked, name), the same shape as `loops`. The layout is assumed to match `LOOP`;
  not yet verified on Serato 5 files.

### Changed

- `permission_denied` carries instructions for the platform it happened on; on Windows it no
  longer says to grant Full Disk Access.
- Text files check out with LF line endings on every platform (`.gitattributes`).
- `list_libraries` and discovery label a library `5.x` when its schema is 203 or later, and `4.x`
  otherwise. The server accepts either.
- Master `connection` rows for Serato 5's `spotify.sqlite` and `remote_libraries.sqlite` are
  recognised as non-volume stores and skipped.
- `apply_changes` refuses on Serato 5 libraries (`user_version` >= 203) with `write_refused`, reason
  `serato5_unmapped_crate`. Serato 5 needs a `master.sqlite` `location_container` mapping for every
  crate in `root.sqlite` and disconnects the library ("Failed to determine an external container's
  corresponding entry in the master database") when one is missing. This server does not write
  `master.sqlite` yet. `stage_crate` warns about this (warning code `apply_unsupported_serato5`) and
  still stages the crate. Serato 4 apply is unchanged.
- BPM is read from the database only. Serato 5's new "Serato Tempo Map" tag does not affect this
  server.

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

- A Serato DJ installation on Windows: reading a library it wrote, and Serato opening a crate
  this server wrote.
- The form of `connection.database_uri` and of the `lock` table's process name on Windows; both
  are assumed, and the code and tests say where.
- The Claude Desktop extension on Windows, which is still built for macOS only, and every MCP
  client on Windows other than the test client.
- Serato 5 (DJ Pro 5.0): reading a real Serato 5 library, and the `CUELOOP` layout in
  `Serato Markers2`.

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
