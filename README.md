# serato-dj-mcp

[![npm](https://img.shields.io/npm/v/serato-dj-mcp.svg)](https://www.npmjs.com/package/serato-dj-mcp)
[![CI](https://github.com/Venut-Technologies/serato-dj-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Venut-Technologies/serato-dj-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Ask Claude about your Serato DJ library: find tracks that mix harmonically by BPM and Camelot
key, browse your crates, audit the library for duplicates and missing files, and have new crates
built for you, shown to you before anything is written. It works through the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP), the standard way AI apps such as
Claude Desktop, Claude Code, Cursor and VS Code connect to tools on your computer: this is a small
local server that answers from your library and sends nothing anywhere itself.

**Status: experimental.** Pre-1.0 and actively developed: a minor version may change
behaviour or break compatibility, a patch never does.

> [!IMPORTANT]
> **Not affiliated with, endorsed by, or supported by Serato.** Serato and Serato DJ are
> trademarks of their respective owner. This project reads a reverse-engineered database layout
> and can stop working after any Serato update.

## What you can ask

Once the server is connected, you talk to your assistant as usual:

- "Find tracks between 122 and 126 BPM in 8A or 9A that I added this year."
- "Give me tracks that mix harmonically out of 8A, around 124 BPM."
- "Show me what's in my *Warm Up* crate, in order."
- "Audit my library: duplicates, missing files, tracks that aren't in any crate."
- "Which tracks in my library have no BPM or no key?"

With crate writing switched on:

- "Build a crate called *Friday Opening* from the twenty tracks you just found, and show me the
  list before writing anything." Then, once you have closed Serato: "Apply the staged crate."
- "Add those five tracks to my existing *Warm Up* crate." Tracks already in it are skipped.

The assistant does the searching; the server answers from your library and, when asked, writes
only what you approved.

## Install

**Works on macOS.** Tested with Serato DJ Lite 4.0.9 on macOS; the test suite runs in CI on macOS,
Linux and Windows with Node.js 22.16 and 24. **On Windows the server has only been run against
generated test libraries, never against a Serato installation** — see
[Compatibility](#compatibility) for what that covers and what it does not.
The Claude Desktop extension and the Claude Code setup below were tried by hand on macOS; the
Cursor and VS Code setups follow those editors' documentation and have not been tried.

Every setup starts the server read-only. Crate writing is a separate switch, described
[below](#read-only-by-default-writes-on-request).

### Claude Desktop

**As an extension (no Node.js needed).** Download `serato-dj-mcp-<version>.mcpb` from the
[latest release](https://github.com/Venut-Technologies/serato-dj-mcp/releases/latest) (attached
from version 0.1.1 on) and open it; Claude Desktop shows what it contains and installs it. Its
settings let you point it at a library folder and switch on crate writing or raw SQL; all three
can stay as they are.

**Or by hand**, with [Node.js](https://nodejs.org) 22.16 or newer installed: open Settings →
Developer → Edit Config and add the server to `claude_desktop_config.json`, then restart Claude
Desktop.

```json
{
  "mcpServers": {
    "serato": {
      "command": "npx",
      "args": ["-y", "serato-dj-mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add serato -- npx -y serato-dj-mcp
```

Add `--scope user` before `serato` to have it in every project. The repository is also a Claude
Code plugin that starts the same command.

### Cursor

[Add to Cursor](https://cursor.com/install-mcp?name=serato&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlcmF0by1kai1tY3AiXX0%3D),
or add the same `mcpServers` entry as for Claude Desktop to `~/.cursor/mcp.json`. The link opens
`cursor://anysphere.cursor-deeplink/mcp/install?name=serato&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNlcmF0by1kai1tY3AiXX0=`,
which asks Cursor to add `{"command":"npx","args":["-y","serato-dj-mcp"]}` under the name `serato`.

### VS Code

[Install in VS Code](https://vscode.dev/redirect/mcp/install?name=serato&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22serato-dj-mcp%22%5D%7D),
or from a terminal:

```sh
code --add-mcp '{"name":"serato","type":"stdio","command":"npx","args":["-y","serato-dj-mcp"]}'
```

### Options for any client

Add options after `serato-dj-mcp` in `args`, for example
`"args": ["-y", "serato-dj-mcp", "--allow-writes"]`:

- `--library <path>` — the Serato library folder (the one holding `master.sqlite`). Not needed on
  macOS, where the library in `~/Library/Application Support/Serato` and on mounted drives is
  found automatically. On Windows the server looks in `%LOCALAPPDATA%\Serato\Library` and in
  `_Serato_\Library` on each drive from `C:` to `Z:`; that has not been tried with a real
  library, so if yours is not found, pass the folder here. In a JSON config file a Windows path
  needs its backslashes doubled (`"C:\\Users\\you\\AppData\\Local\\Serato\\Library"`) or written
  as forward slashes.
- `--allow-writes` — crate writing, see below.
- `--allow-raw-sql` — adds `run_sql`, read-only SQL for developers.
- `--allow-serato-control` — Windows only: adds `serato_status`, `serato_close`, `serato_open`, `serato_rescan` and `serato_analyze`,
  see [Controlling Serato (Windows)](#controlling-serato-windows).

All options are listed under [Options](#options).

`node:sqlite` is an experimental Node API and prints a warning to stderr; that is expected and
harmless, because the MCP protocol travels over stdout.

### From source, for developers

```sh
git clone https://github.com/Venut-Technologies/serato-dj-mcp.git
cd serato-dj-mcp
npm ci
npm run build
```

Then use `"command": "node"` with `"args": ["/absolute/path/to/serato-dj-mcp/dist/index.js"]`, or
`claude mcp add serato -- node /absolute/path/to/serato-dj-mcp/dist/index.js`.

What the server reads, writes and sends is in [PRIVACY.md](PRIVACY.md): it makes no network
requests and has no telemetry.

## Compatibility

| | |
|---|---|
| **Serato DJ 4.x and DJ Pro 5.x** | Supported for reading and searching. 4.x was developed and tested against Serato DJ Lite 4.0.9 (library schema 202). Other 4.x schema versions are read with a `schema_unknown` warning. DJ Pro 5.x (schema 203) is read, but has not been tested against a real library. Serato DJ Pro 4.x is expected to use the same library format but has not been tested. |
| **Serato DJ 3.x** | Detected and reported, not read (it keeps a binary `database V2` instead of SQLite). |
| **macOS** | Supported. This is where the project is developed, and CI runs on it. |
| **Windows** | Experimental: verified on generated libraries only, never with Serato. See [Windows](#windows) below. |
| **Linux** | Serato does not run on Linux; the test suite runs there in CI on synthetic fixtures. |
| **Node.js** | 22.16 or newer, because `backup()` from `node:sqlite` lands there. Not assumed: CI runs the whole suite on 22.16 and on 24, on macOS, Ubuntu and Windows. |
| **Claude Desktop extension** | Runs in Claude Desktop's own Node.js, not yours. Checked by hand on 2026-09-24 with Claude Desktop 2.7032.0 on macOS, whose built-in Node.js is 24.21: installed, then `list_libraries` and `list_crates` answered with the library's data. |

Everything this server assumes about the Serato library is written down in
[docs/serato-4x-notes.md](docs/serato-4x-notes.md), with the measurement behind each claim.

### Windows

**Verified** on 2026-10-12, on Windows 11: the whole test suite passes with Node.js 25.6.0,
24.21.0 and 22.16.0, and with 25.6.0 the built server was driven over stdio by an MCP client
against the generated demo library (`npm run demo-library`) — `list_libraries`, `list_crates`,
`search_tracks`, `audit_library` with and without the disk check, and with `--allow-writes` a
crate through `stage_crate`, `preview_changes` and `apply_changes`. That exercises the server's
own handling of Windows paths, files, locks and processes. One fact comes from a real library: in
a per-drive store (`location.sqlite`, schema 202) that Serato created on a Windows drive, a
track's path is recorded relative to the drive, with forward slashes.

**Not verified — treat each as an assumption:**

- **A Serato DJ installation on Windows.** The server has never read a library Serato wrote on
  Windows' own disk, and has never written a crate that Serato on Windows then opened.
- **Where Serato keeps its library.** `%LOCALAPPDATA%\Serato\Library` is taken from Serato's
  support article on backing up a library, not from an installation.
- **How Serato records each drive.** Track paths are built from a `database_uri` column whose
  Windows form has not been seen. The server assumes a plain path such as
  `D:\_Serato_\Library\location.sqlite`, with either kind of slash. If the real form differs,
  tracks are listed without a full path, the on-disk check of `audit_library` skips them with a
  `location_root_unknown` warning, and `stage_crate` may refuse with `library_disk_unknown`.
- **The "is Serato running" check.** It compares the process name `tasklist` reports with the
  name in Serato's lock table, whose Windows form has not been seen either. Names are compared
  without `.exe` and without regard to case, any running program whose name starts with "Serato"
  counts if the lock table points at it, and a process that cannot be identified refuses the
  write. Whether Serato on Windows fills that table as it does on macOS is unknown: **quit Serato
  yourself before `apply_changes`, and keep your own backup of the library.**
- **The Claude Desktop extension**, which is built for macOS only. On Windows use the `npx` setup.
- **Any MCP client on Windows.** The server was driven by a test client; Claude Desktop, Claude
  Code, Cursor and VS Code were not tried there.

Two differences from macOS that are by design: the cache and state directories default to
`%LOCALAPPDATA%\serato-dj-mcp\Cache` and `%LOCALAPPDATA%\serato-dj-mcp\State`, and a path under
your user folder is shortened to `~\...`. Looking for libraries asks each drive letter whether it
has a `_Serato_\Library` folder; a mapped network drive whose server does not answer can make
that slow, and `--library` skips the search.

## Read-only by default, writes on request

**By default the server never writes to Serato's files.** Every read goes through a snapshot
copy of the library database in `--cache-dir`, so a question from the assistant cannot change your
library, whether Serato is open or not.

Two flags widen that, and each registers extra tools only when it is given — a tool that does not
exist cannot be called by mistake:

- `--allow-raw-sql` adds `run_sql`: read-only `SELECT` against the snapshot, returning raw rows.
- `--allow-writes` adds `stage_crate`, `stage_add_to_crate`, `preview_changes`, `apply_changes`
  and `discard_changes`.
  Writing is split in two: crates are *staged* first, which never touches the library, and are
  *applied* only when you confirm and Serato is closed. Both databases are backed up before every
  write. The details are in [Writing to the library](#writing-to-the-library).

## Tools

- `list_libraries` — the libraries this server can see, with version, schema
  version and locations. Paths here are not redacted, so you can copy one into
  `--library`.
- `search_tracks` — search by free text, BPM, key, genre, rating, date added, crate
  membership and flags. Tonality is Camelot; a track whose key Serato itself could not
  parse is still matched, and `key_source` says where the key came from. Paginated with an
  opaque cursor; the default page is 25 tracks and nine fields.
- `get_tracks` — fetch tracks by the ids `search_tracks` returned. Unknown ids come back in
  `missing` rather than being dropped.
- `list_crates` — the crates in the Serato Library space, with their display path and how many
  distinct tracks each holds. Smart crates, space roots and Serato's other internal spaces
  (such as the Prepare panel) are not listed.
- `get_crate_tracks` — the tracks of one crate, in the crate's own order. Only crates in the
  Serato Library space can be given.
- `audit_library` — diagnose the library. Every check runs by default and reports a count plus
  up to ten example track ids: tracks with no BPM, with no key at all, with a key Serato itself
  cannot display, marked stale, in no crate, streaming-only, duplicated, and with broken paths.
  `duplicates` reports groups instead of loose ids, because which track duplicates which is the
  part you can act on. `broken_paths` reads Serato's own missing flag by default; pass
  `check_filesystem: true` to also look on disk, which is opt-in because a stat against a
  disconnected drive blocks for seconds. A drive that is not mounted is reported as such rather
  than having all its tracks declared missing.
- `serato_inspect` — how the library is laid out, for diagnosing an install that behaves
  unexpectedly (Windows especially): which of `master.sqlite`, `root.sqlite` and `location.sqlite`
  exist, the snapshot's journal mode and schema `user_version`, its table names, row counts of
  `container`, `container_asset` and `asset`, whether the `lock` table exists and has rows, and
  up to 5 samples of stored track paths with their drive letter and separator style. Everything
  about `master.sqlite` comes from the snapshot copy (so the `lock` answer is as of the snapshot);
  `root.sqlite` and `location.sqlite` are only checked for existence, never opened. Paths are not
  redacted.
- `get_track_markers` — the cue points, saved loops, track colour and BPM-lock flag Serato stored
  in a track's own audio file (the `Serato Markers2` tag), for a track id from `search_tracks`.
  Reads MP3 and AIFF (ID3v2 `GEOB`) and FLAC (`SERATO_MARKERS_V2`); positions are milliseconds,
  colours `#rrggbb`. A missing file, another format (M4A, Ogg, WAV, ...) or a file without the tag
  returns empty lists and a warning rather than an error. The file is only read, never written;
  the older `Serato Markers_` tag, which Serato prefers when both exist, is not read. Tested on
  synthetic byte fixtures only, written from the published format notes: not yet compared with
  files written by Serato itself.
- `serato_read_grid` — the beat grid Serato stored in audio files: the Serato DJ Pro 5 `Serato Tempo
  Map` tag and the older `Serato BeatGrid` tag, with which one Serato 5 uses. Read-only; takes a list
  of file paths. Also on the command line: `node dist/control-cli.js read-grid <path>...`.
- `run_sql` — one read-only `SELECT` against a snapshot copy. Registered only
  with `--allow-raw-sql`, because it returns raw rows with no path redaction.

With `--allow-writes`:

- `stage_crate` — stage a new crate from track ids. Nothing is written yet; the response lists
  every staged track by title and artist, so check it.
- `stage_add_to_crate` — stage appending tracks (by track id) to an existing top-level crate, named
  as in `list_crates`. Same flow as `stage_crate`: nothing is written until `apply_changes`. Tracks
  go at the end of the crate in the order given; tracks the crate already holds are skipped (the
  response says how many), because the database itself would accept a track twice. Refused if the
  crate does not exist. One staged change per crate name.
- `preview_changes` — show what is staged, with `format: "detail"` down to each track.
- `apply_changes` — write everything staged, all or nothing. Refused while Serato is running.
- `discard_changes` — drop one staged crate, or all of them.

With `--allow-serato-control`, on Windows only:

- `serato_status` — is Serato DJ Pro running: process name, path and pid, main-window title and
  whether it responds, audio state, discovered install path, and `looks_idle`.
- `serato_close` — gracefully close Serato (needs `confirm: true`), see below.
- `serato_open` — start Serato and wait until its window is ready.
- `serato_rescan` — press Serato's Re-Scan File Info button (whole library), see below.
- `serato_analyze` — have Serato DJ Pro 5 analyse (Lucid Beatgrids) one named crate, in two steps
  (plan, then confirm with a token), and wait until the files' tags change. A loose `files` list
  returns `not_supported` (use a crate), and verifying the analysis mode usually needs
  `set_mode: true`. Not live-tested; see
  [docs/serato-control.md](docs/serato-control.md#analysing-a-crate-serato_analyze).

## Controlling Serato (Windows)

`--allow-serato-control` registers four tools, and only when the server runs on Windows; on any
other system the flag registers nothing. None of them writes a Serato file. A plain-language guide
to these tools and their safety rules is in [docs/serato-control.md](docs/serato-control.md). They run Windows
PowerShell 5.1 (`powershell.exe`, part of Windows, nothing to install) with built-in .NET, and
talk to Serato only through its process and its main window.

- `serato_close` asks the main window to close, as the close button does, waits up to
  `timeout_seconds` (default 30, max 120) for the process to exit, then checks that the
  `_Serato_database V2` file has not changed in size or modification time for about 2 seconds. It
  never force-terminates Serato. Serato DJ Pro 4 answers a close request with an "Exit - are you
  sure?" dialog and keeps running until someone clicks Yes; since `confirm: true` was given and the
  audio check has already passed, `serato_close` then presses that dialog's Yes/OK button (UI
  Automation first, else OCR of the Serato window only, then a click; never the full screen). If
  the dialog is not found, or Serato does not exit (another dialog is waiting for you), the error
  says it is still running and was NOT killed. The dialog is never confirmed while audio is
  detected. It is refused while Serato is making
  sound.
- Audio detection reads the peak meter of Serato's Windows audio session (core audio,
  `IAudioMeterInformation`) over about half a second. **Limit:** it only sees audio that goes
  through the Windows mixer. Serato on an ASIO driver, the usual setup with a DJ controller, has no
  such session, and the answer is `"unknown"`; the close then proceeds on your confirmation alone
  and says so in a warning. A paused or silent deck reads as not playing.
- `looks_idle` in `serato_status` is a hint, not a guarantee: Serato running, window responding,
  `database V2` unchanged over a 2 second poll. Serato 4 may keep its state in `master.sqlite`
  instead, in which case that file's silence proves little.
- `serato_open` finds `Serato DJ Pro.exe` from the `SERATO_DJ_EXE` environment variable if set,
  otherwise the registry (uninstall and App Paths keys) and the Program Files folders, starts it
  and waits until the window responds and has a title. If it is not found, set `SERATO_DJ_EXE`.
- `serato_rescan` (`scope: "library"`, the only value) presses **Re-Scan File Info** (older Serato:
  Rescan ID3 Tags) in the Files panel so Serato re-reads every file's tags. It writes no library file;
  Serato does the work, which can take long on a big library. It tries UI Automation first. Serato 4
  draws its own UI and exposes no such element (checked on 4.0.0.2697), so in practice it falls back
  to OCR: it brings Serato to the front, reads a screenshot of **the Serato window only** (never the
  whole screen; kept in memory) with Windows' built-in OCR, opens the Files panel if the button is not
  visible, and clicks the button with a real mouse click. **Do not use the mouse while it runs**, and
  keep Serato uncovered. The result says `method` (`uia` or `ocr`) and `verified` (`true` only if a
  scan message was seen afterwards, `false` if the window was re-read and none appeared,
  `"unknown"` if it could not be re-read). Rescanning a single folder is **not supported**. Not yet
  measured: a real rescan click, what Serato shows while scanning, and reliability over repeated
  runs; see [notes/rescan-spike-results.md](notes/rescan-spike-results.md), which also has the
  command to measure it.

Status: the PowerShell scripts were run against a real Windows PowerShell 5.1 for process, window and
install discovery with Serato not running, and the audio enumeration was run to the point of finding
no session; closing and opening a real Serato, and a positive audio reading, have **not** been
verified. The tool logic is tested against a fake platform.

## Options

`--library <path>`, `--root <dir>` (repeatable), `--cache-dir <dir>`,
`--state-dir <dir>`, `--allow-raw-sql`, `--allow-writes`, `--allow-serato-control`, `--help`,
`--version`. `SERATO_LIBRARY_PATH` is an alternative to `--library`;
the flag wins. `SERATO_DJ_EXE` is the full path of `Serato DJ Pro.exe` for `serato_open`. An unknown option is an error, not a no-op.

## Writing to the library

Writes need `--allow-writes` and happen in two steps, because Serato must be closed while its
database is written and the model usually works while it is open. `stage_crate` can run at any
time; `apply_changes` refuses while Serato is running. Start Serato afterwards and the new crates
appear within a few seconds. On a Serato 5 library (schema 203 or later), writing crates is currently refused (`write_refused`, reason `serato5_unmapped_crate`), because Serato 5 needs a `master.sqlite` entry for each crate and this server does not write one yet.

What a write does: it creates new crates at the top level of the Serato Library, in
`root.sqlite`, or appends tracks to the end of an existing top-level crate there, and nothing
else. Appending only inserts rows; it never reorders, removes or edits a crate's existing tracks,
never deletes a crate, never edits a track, never touches `master.sqlite`, `database V2` or the `Subcrates` folder — Serato regenerates
those itself.

Before every write both databases are backed up under
`<state-dir>/backups/<library-id>/<timestamp>/` (default state-dir:
`~/Library/Application Support/serato-dj-mcp`, on Windows
`%LOCALAPPDATA%\serato-dj-mcp\State`), and the last ten are kept. A backup is taken on
every `apply_changes` attempt that reaches the backup step, including attempts that are then
refused inside the transaction (a name conflict, for example) — so "the last ten" means the last
ten *attempts*, not ten successful writes, and the newest one may already contain the write you
are trying to undo.

**There is no undo tool.** To undo a specific write, first find the right backup: use the
`backup_paths` returned by that `apply_changes` call, or open
`<state-dir>/manifests/<library-id>.jsonl` and take the `backup_paths` of the line whose
`"commit_state"` is `"committed"`. `<library-id>` is the `uuid` reported by `list_libraries`. Then,
with that pair of paths in hand:

1. Quit Serato.
2. In the library folder, delete `root.sqlite-journal` if present, and delete
   `master.sqlite-wal` and `master.sqlite-shm`.
3. Copy the backed-up `root.sqlite` and `master.sqlite` into the library folder, replacing the
   current ones.
4. Delete `~/Music/_Serato_/Subcrates/<crate name>.crate` — Serato exported it after it synced
   the crate, and copying the databases back does not remove it. (That is where the file is on
   macOS. Where Serato on Windows exports it has not been checked.)

Restoring these files also rolls back anything Serato itself recorded in the library after that
backup was taken.

Nested crates are not supported: a crate created this way inside another crate is deleted by
Serato when it next syncs, so every crate goes to the top level.

## Privacy

The same, as a standalone policy with the source file behind each statement:
[PRIVACY.md](PRIVACY.md).

- **Everything runs on your computer.** The server is a local process your MCP client starts. It
  sends no telemetry, has no analytics, and makes no network requests. The only other program it
  runs is `ps` (on Windows, `tasklist`), to check whether Serato is running before a write.
- **What it reads:** Serato's library databases, always read-only except for `apply_changes`;
  with `audit_library`'s `check_filesystem: true`, the file metadata of your tracks on disk.
- **What it writes, and where:**
  - `--cache-dir` (default `~/Library/Caches/serato-dj-mcp`, on Windows
    `%LOCALAPPDATA%\serato-dj-mcp\Cache`) holds a snapshot copy of your library database. Safe to
    delete at any time.
  - `--state-dir` (default `~/Library/Application Support/serato-dj-mcp`, on Windows
    `%LOCALAPPDATA%\serato-dj-mcp\State`) holds staged crates, a manifest of every write, lock
    files, and backups of your library databases. Only used with `--allow-writes`. Deleting it
    deletes those backups.
  - With `--allow-writes`, `apply_changes` writes new crates, and tracks appended to existing crates, into Serato's `root.sqlite`.
- **What leaves your computer is up to your MCP client.** Tool results — track titles, artists,
  crate names, file paths — go to your assistant, and from there to whichever model provider the
  client uses. Track paths under your home folder are shortened to `~`; `list_libraries`,
  `run_sql` and the backup paths returned by `apply_changes` are full paths. Check your client's
  data policy if that matters to you.

## Limitations

Read this before deciding what to trust.

- **Serato DJ 3.x is not supported.** It is recognised and reported as
  `version: "3.x"`, but nothing reads it — it stores a binary `database V2`
  rather than SQLite. No tool will return data from a 3.x library.
- **Reads go through a snapshot**, so an answer reflects the library as of the
  last snapshot, not the current instant. A snapshot is reused for up to two
  seconds, so while Serato is writing an answer can be that far behind. Only
  the current snapshot of each library is kept in `--cache-dir`; older ones
  are deleted as soon as a newer one is published.
- **Two audit checks rest on column semantics this project has not confirmed.** `stale` reads
  `is_stale` and `streaming_only` reads `third_party_type`; both were zero on every track of the
  reference library, so their counts are reported without any claim about what they mean.
- **`rating` and the streaming flag are passed through uninterpreted.** `rating` was NULL or 0 on
  all 118 tracks of the reference library, so the top of the scale is unconfirmed. No meaning
  beyond the raw column value is claimed for the streaming flag.
- **`analysis_flags` bit 2 is claimed, though the rest of the field is not.**
  It is read as "Serato ran its own analysis" — not the same as "has a BPM",
  since a BPM can come from the file's tags — and exposed as
  `flags.analyzed`, which `search_tracks` can filter on. Measured 2026-09-06
  on 118 tracks: 106 have bit 2 set, of which 104 have a BPM; twelve have it
  clear — six sound effects and six tracks whose BPM came from tags rather
  than Serato's own analysis.
- **Free-text search is not Serato's search.** Serato normalises text with a function only
  its own process has, so `q` matches both the normalised columns and the raw ones and can
  differ from what the application would find.
- **A page taken while Serato is writing can straddle two snapshots.** Pagination is keyset,
  so it continues from the same position on the newer copy and says so in
  `warnings: snapshot_advanced`; a few rows may be repeated or skipped at the seam.
- **Crate writing is new and experimental.** The write protocol was worked out against a live
  Serato DJ Lite 4.0.9 library, but it has not been exercised across Serato updates, on large
  libraries, or on libraries spread over external drives. Keep your own backups as well.
- **Writes are narrow on purpose.** `apply_changes` creates new top-level crates and nothing
  else: no nested crates, no smart crates, no renaming, reordering or deleting crates, no edits
  to tracks, cue points or other metadata.
- **A crate can only hold tracks from the library's own disk.** Streaming tracks, and tracks that
  live in another drive's Serato store, are refused by `stage_crate`, naming each one.
- **Serato must be closed to apply, and restarted to see the result.** New crates show up in
  Serato, and in this server's read tools, only after Serato has started and synced.
- **Staging reads Serato's live database.** `stage_crate` reads `root.sqlite` while Serato may be
  running. Measured on 2026-09-16: three stagings of 50 tracks each, 8 to 41 ms apiece, with
  nothing in Serato's own log for those seconds. That is evidence, not a guarantee — a busier
  library, or a Serato in the middle of its own write, has not been tried.
- **There is no undo tool.** Undoing a write means restoring the backups by hand, as described
  above.

## Principles

What this server guarantees about your library, and what it refuses to do, is stated in
[PRINCIPLES.md](PRINCIPLES.md) — each guarantee with the code that enforces it and the tests that
would fail if it stopped being true.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for them.

## Contributing

Issues and pull requests are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). Maintained by [Venut Technologies](mailto:hello@venut.tech).

Serato and Serato DJ are trademarks of their respective owner. This project is independent and is
not affiliated with, endorsed by, or supported by Serato.
