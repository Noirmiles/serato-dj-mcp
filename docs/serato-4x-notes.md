# What we measured about the Serato DJ 4.x library

These are observations from Serato DJ Lite 4.0.9, with library schema 202, on macOS. Nothing
here comes from Serato's own documentation or source — it is what we saw the files and the
process do.

Every measurement says which library it was taken on, because the two are not equally strong
evidence. **A working library** is one Serato actually uses, with its own tracks and crates: a
measurement there is the real thing, and the only way to see Serato itself react to a write.
**A disposable copy** is a byte copy of that whole library folder, written to instead of the
original: safe, and enough for anything that does not need Serato running. Where a write was made
to a working library, it was backed up byte for byte first and restored afterwards.

## Two databases

- `master.sqlite` (WAL mode) is the aggregate database the Serato GUI opens. It is the only one
  of the two that has a `lock` table, the history tables, and every location.
- `root.sqlite` (rollback journal, journal mode DELETE) is the boot disk's own store. Of Serato's
  own files, it is the only one this server writes to (via `apply_changes`); the server also
  writes its own snapshot, stage, manifest, lock files and backups elsewhere (see README's
  Privacy section).
- Serato opens `root.sqlite` attached under the name `db1`, which is why its own triggers are
  declared `ON db1.<table>`. That trigger text cannot be executed against a fresh database opened
  as the main connection.
- `root.sqlite` has its own `master` table (`master.sqlite` has no table by that name). Its
  `last_sync_secret` column holds a value that does not fit in a JavaScript number (measured
  2026-09-14), so running `SELECT *` over it throws.

## Crates

- A crate is a row in the `container` table with `type = 1` whose `parent_id` points at the root
  container of the `Serato Library` space.
- That root container is found by `parent_id = 0`, never by name: its name is generated, and a
  user-created crate can share that exact name while having a different `type`.
- `container` carries a UNIQUE constraint on `(parent_id, name COLLATE NOCASE, type)`, so
  `sErAtO dEmO tRaCkS` collides with `Serato Demo Tracks`.
- `container_asset` has no unique constraint on `(container_id, space_asset_id)`.
- A crate nested inside another crate is deleted by Serato the next time it syncs — written to a
  working library and reproduced twice.
- An empty crate is deleted by Serato too: on 2026-09-16, on a working library, a start of Serato
  logged `Sync: Cleaned up 1 empty containers` and removed one.

## Revisions

- `serato.revision` is a single, library-wide counter. Each `space` row also carries its own
  revision.
- Triggers on the space tables assign `space.revision := serato.revision`, and only do so when
  the space's current value is lower than `serato.revision`.
- A write must therefore bump `serato.revision` first, then insert the container row, then its
  `container_asset` rows. Done in the other order, the rows land in the file but Serato never
  shows them.
- Measured on a working library on 2026-09-16: both counters moved 72 → 73, and the crate was
  visible in the Serato GUI after a restart.
- The same write path, run twice on a disposable copy of that library the same day, moved
  `serato.revision` 72 → 73 → 74 with the space revision following it each time. Serato was never
  started against that copy, so it shows the write and not what Serato does with it.

## Is Serato running

- The `lock` table has no key, and its row survives an unclean exit: a row for pid 73438
  stayed for ten days after that process was killed.
- Liveness therefore has to be confirmed against the operating system: `kill(pid, 0)` — where an
  `EPERM` result means the process exists and belongs to another user — together with the process
  name from `ps -o comm=`, which on macOS prints the full executable path rather than a bare
  name.
- Reading `root.sqlite` while Serato is running was measured on a working library on 2026-09-16:
  three consecutive stagings of 50 tracks each took 8 to 41 ms, and Serato's own log for those
  seconds carried no `SQLITE_BUSY`, no "database is locked" and no I/O error. Three short reads
  are not a load test, but they are what this server does.

## WAL behaviour

- Opening a read-only connection to a WAL-mode database whose `-wal`/`-shm` sidecar files are
  missing creates an empty `-wal` file and a 32 KB `-shm` file, and leaves them behind. Serato
  does the same thing; it is how SQLite reads a WAL database.
- The `sqlite3` CLI run with `-readonly` refuses to open that same file, failing with `CANTOPEN`
  (error 14), while Node's `node:sqlite` opens it without complaint.
- Serato checkpoints the database and removes the sidecar files when it quits cleanly.

## How a write becomes visible

- Serato aggregates `root.sqlite` into `master.sqlite` on startup: on a working library, 3 seconds
  for a five-track crate on 2026-09-16, and around 6 seconds in an earlier run on the same
  library. A copy cannot show this, because it needs Serato to start against the library.
- Serato then exports the legacy crate file itself, at `~/Music/_Serato_/Subcrates/<name>.crate`
  — 1456 bytes for that crate. This server never writes that file.
- Serato's own log names each step of the process: `Sync: Added/Updated 5 container entries`,
  `Sync: Finished.`, `Dbv2: Exporting DBv2 library`.

## Tonality

- `key_value` is Serato's own parse of the key: an index into the Camelot wheel. The text `key`
  column holds whatever the file's tags said.
- Across 118 real tracks, 39 had `key_value` set, and 114 had one of the two (`key_value` or the
  text `key`). The gap is Open Key notation (`6m`, `12d`): Serato's own parser stores `-1` in
  `key_value` for that notation while leaving the text column alone.

## History

- `history_session` and `history_entry` exist in `master.sqlite` in every library, whether or not
  it has ever been used.
- A library that has never played a track has zero rows in both tables, and every
  `asset.dj_play_count` is 0 (measured 2026-09-18). That is why this server has no history tools
  yet: what `played`, `deck`, and an in-progress session actually mean cannot be confirmed
  without a library that has real sessions in it.

## Schema drift

- The schema carries a `user_version`; 202 is the version used by Serato DJ Lite 4.0.9.
- `master.sqlite` ships 51 migration scripts of its own, so this project treats an unrecognised
  schema version as a warning, never as a refusal.

## Windows

Everything above was measured on macOS. On Windows very little about Serato itself has been
measured, and this section keeps the two apart.

### Measured about Serato

A per-drive store, `location.sqlite`, that Serato created in `<drive>:\_Serato_\Library` on a
Windows machine, read on 2026-10-12 (Serato version not known). Then, separately, a real Serato
DJ Pro 4.0.0 install on Windows 11, library schema 202, measured 2026-10-12 -- `master.sqlite` and
`root.sqlite` this time, not just a per-drive store.

- Its schema `user_version` is 202. `location.sqlite`'s journal mode is `delete`; `master.sqlite`'s
  is `wal` -- the same split as `root.sqlite`/`master.sqlite` on macOS.
- `asset.portable_id` is relative to its volume's root, written with forward slashes and no
  leading slash: a file at `D:\Some Folder\Artist - Title.mp3` is `Some Folder/Artist - Title.mp3`.
  Confirmed again from the real `master.sqlite`'s own rows, not just the per-drive store.
- The main library is at `%LOCALAPPDATA%\Serato\Library` (`master.sqlite` and `root.sqlite` live
  there) -- confirmed against an installation, not just cited from Serato's support article
  "Backing up and moving your library".
- `connection.database_uri` mixes separators within one `master.sqlite`: the row for an external
  drive reads `D:/_Serato_/Library/location.sqlite` (forward slashes), while the two rows for the
  local library read `C:\Users\<user>\...\root.sqlite` and `...\spotify.sqlite` (backslashes).
  `volumeRootFromDatabaseUri` (`src/paths.ts`) and `storePathFromUri` (`src/apply/location.ts`)
  accept either separator for exactly this reason -- a parser that assumed one would have missed
  the other half of the same file's rows. A `\\server\share` uri and a `root.sqlite` whose
  `database_uri` names a different drive than the one it is installed on are still unseen.
- The `lock` table carries exactly one row while Serato runs: `owner_process_name` is
  `'Serato DJ Pro.exe'`, `owner_process_id` the PID of that process. The table is empty after a
  clean exit. A crash (the process killed rather than quit) leaves that row behind -- the same
  staleness macOS showed for pid 73438 (see "Is Serato running" above), now seen on Windows too.
  The server's own `tasklist`-based comparison (ignoring a directory, a trailing `.exe` and case,
  and matching any live process whose image name starts with `serato`) was written against this
  name.
- `master.sqlite` is authoritative for what Serato displays, and is kept in sync with every
  per-volume store: a relocate repair written to both a store and `master.sqlite` reads back as
  found in the Serato GUI.
- On open, Serato runs BOTH `PRAGMA integrity_check` AND `PRAGMA foreign_key_check` against
  `master.sqlite`, and refuses to open the library if either reports a problem. `foreign_key_check`
  catches an orphaned row that a plain `integrity_check` passes clean -- which is why
  `src/apply/relocate.ts` runs both before every commit, not integrity_check alone. A refusal of
  this kind leaves a `master.sqlite.failed_integrity_check` marker file beside it.
- A file that is present on disk is re-flagged missing on the next launch if its asset row's
  `file_size` is 0, even though `is_missing` was already 0 -- the reason `apply_relocate` writes a
  real `file_size` into every repair rather than only clearing `is_missing`.

### Not measured about Serato

- **Everything about a write other than a relocate repair.** That Serato on Windows picks up a
  *new crate* written to `root.sqlite` the way it does on macOS, where it exports the crate file,
  and what it does with a crate name that Windows does not allow as a file name
  (`? * " < > |` and others).
- **A `\\server\share` `database_uri`, and a `root.sqlite` whose `database_uri` names a drive
  other than the one it is installed on.** Only a plain drive-letter path, in either separator
  convention, has been seen.

### Measured about Windows itself

On Windows 11 with Node.js 25.6.0, on 2026-10-12. These are about the operating system and
SQLite, and they are why the code differs there.

- `fsync` of a directory is impossible: `fsyncSync` on a read-only descriptor, of a directory or
  a file, fails with `EPERM`.
- A file that another handle has open cannot be renamed onto (`EPERM`), and a database another
  connection has open cannot be deleted (`EPERM`). A file merely open for reading by Node can be
  deleted.
- `chmod` does not stop a read, and a read-only directory does not stop a file in it being
  deleted.
- A database that an access rule forbids reading, or that another process holds for its exclusive
  use, can still be `stat`ed; opening it fails with "unable to open database file" after about
  1.4 seconds.
- An exclusive SQLite transaction is refused to a second process with `SQLITE_BUSY` and is free
  within a millisecond of its holder being killed.
- In WAL mode, the first read from another process after a write changes the bytes of `-shm`,
  later reads do not, and no read moves its modification time. The main file and `-wal` are not
  touched by a read, as on macOS.
- `tasklist /FI "PID eq <pid>" /FO CSV /NH` took 139 ms, prints the image name in full, and for
  an unknown pid prints a sentence in the system's language and exits with 0.
