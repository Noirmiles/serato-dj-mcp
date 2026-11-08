# Getting Serato to re-read a file's tags: what is known

The problem: an external tool (a tag editor, for example) changes the tags inside an audio file, and
Serato keeps showing the old values until the user asks it to re-read them.

This note is research, not a measurement. Nothing in it was run against Serato; we cannot run
Serato in the environment this was written in, and we did not open or inspect Serato's program
files. Each statement carries one of these evidence levels:

- **published by <source>**: said by a public source. We say whether we read the page ourselves or
  only saw an excerpt of it in a search result.
- **schema shows**: visible in the SQL under `tests/fixtures/schema/`. That is the schema of
  library version 202 (see [serato-4x-notes.md](serato-4x-notes.md)); it shows which columns exist,
  not what Serato does with them.
- **unverified hypothesis**: our guess. It has not been tested and must not be built on.

Serato is a trademark of its owner; this project is not affiliated with it.

## Limits of this research

- The Serato support pages (`support.serato.com`) refused automated fetching (HTTP 403). The
  support-page statements below are therefore **excerpts seen in search results**, not pages read
  in full, and the wording could differ from the live page. Re-check them in a browser before
  quoting them anywhere user-facing.
- One forum thread (Serato forum, discussion 1577169) was read in full. The others are excerpts.
- Most forum evidence is from Scratch Live and Serato DJ 1.x to 2.x, years before the 4.x library
  database. Behaviour may have changed.
- Searches for Mixxx, Lexicon, Rekordcloud and DJCU documentation on this topic found nothing
  relevant. Absence from search results is not proof that nothing exists. Holzhaus' serato-tags
  documents the tags Serato writes *inside* audio files, not how Serato decides to re-read them.

## 1. What Serato documents as the way to re-read tags

| What | Evidence |
|---|---|
| A **Re-Scan File Info** (older name: **Rescan ID3 Tags**) button forces Serato to re-read file tags. | published by Serato support, article "Re-scan ID3 tags" (https://support.serato.com/hc/en-us/articles/227561687, Spanish version `/hc/es/articles/227561687-Volver-a-examinar-las-etiquetas-ID3`). Excerpt only. A search summary paraphrased it as a function that "forces the software to read all file tags, for use if you have edited or modified tags outside of the software", and said the article is written for Serato DJ Lite. We could not confirm the exact sentence. |
| The button lives in the **Files** panel, at the bottom. | published by Serato forum users (e.g. https://serato.com/forum/discussion/35852, https://serato.com/forum/discussion/1705932) and by the older Scratch Live and Rane manuals. Excerpts. |
| You can rescan everything, or **drag a selection of tracks, crates, files, folders or drives onto the button** to rescan only those. | published by Serato support (same article, excerpt: "you can drop a selection of tracks or crates directly onto the button, if you do not wish to rescan your entire library") and by the Rane SL1/SL3 manuals (https://www.manualslib.com/manual/1631513/Rane-Sl1.html?page=26). |
| Serato DJ 4.0 added a **right-click menu** for tracks and crates. Trade-press coverage lists "rescan metadata" among its entries. | published by trade press (https://musictech.com/news/gear/serato-dj-4-0-update/ and others found via search; excerpt only). Serato's own article (https://support.serato.com/hc/en-us/articles/14359483189135-Navigating-and-Managing-your-Library) was not readable, so the exact label and which tags it re-reads are **not confirmed**. |
| Tags edited *inside* Serato's library grid are written to the file. | published by Serato support, "Editing ID3 Tags" (https://support.serato.com/hc/en-us/articles/227561607-Editing-ID3-Tags). Excerpt only; says filename, length, size, bit rate and sampling are read from the file and cannot be edited in the library. |

We found **no** Serato-published statement about: a "Read ID3 tags from file" preference, an
"Update library" setting, or Serato re-reading tags on its own at startup or when a file changes.
The searches surfaced none, and no source claims them. Treat all three as **unknown**, not as
"absent".

### What users report about the button (published by forum users, not by Serato)

- It works for MP3 in the common case: one user says rescanned tags were kept, and that
  re-analysing a file afterwards can overwrite edits made outside Serato
  (https://serato.com/forum/discussion/150819, excerpts).
- It has gaps: a 2009 thread quotes a Serato representative saying Scratch Live reads a WAV's tags
  at import, and re-tagging then rescanning does not update them, so the file must be re-imported
  (https://serato.com/forum/discussion/600377, excerpt). A Serato 2.3.1 bug report says the track
  number was not updated by a rescan (https://serato.com/forum/discussion/1220981, excerpt). One
  user found MP4 video tags were not refreshed (https://serato.com/forum/discussion/560981,
  excerpt).
- Re-analysing files can make Serato rewrite tags itself
  (https://serato.com/forum/discussion/793137, excerpt), so rescanning after an external edit is
  safer than analysing.
- The pre-4.x library kept per-track data in files under `_Serato_/Metadata` (published by
  Holzhaus' serato-tags, https://github.com/Holzhaus/serato-tags/blob/main/docs/fileformats.md).
  That is a different store from the 4.x `master.sqlite` this project reads.

Net: the only documented, supported way is manual: the user clicks the button, or uses the 4.0
right-click menu. Whether either re-reads *every* tag field on 4.x is not established.

## 2. Is there a trigger an external tool can pull?

**Nothing published says so.** Serato does not publish a specification for its database or its
tag frames (a forum post in https://serato.com/forum/discussion/1518138 says Serato chooses not to
publish an API; excerpt). Everything below is therefore from the schema and is hypothesis.

Columns that plausibly track file state, from `tests/fixtures/schema/master-202.sql` (`asset`
table, also present in `root-202.sql` apart from the `*_norm` columns, `key_value`, `location_id`
and `external_id`):

| Column | Schema shows | Hypothesis (**unverified**) |
|---|---|---|
| `asset.file_size` (INTEGER, nullable) | exists in `asset`, `history_entry`, and the `root.sqlite` asset | Serato may compare it with the file on disk to notice a change. A tag edit usually changes the size, so a mismatch could be a cheap change signal. Unverified. |
| `asset.time_modified` (INTEGER, default now) | exists | Could be the *file's* modification time or the *row's*. The default `strftime('%s','now')` suggests a row timestamp. Unverified which. |
| `asset.time_added` | exists | Almost certainly when the track entered the library. Not a file-state column. |
| `asset.is_stale` (INTEGER, default 0) | exists; a partial index `asset__stale ON asset (location_id, is_stale) WHERE is_stale <> 0` exists | The index is built for finding stale rows quickly per location, which implies Serato queries them in bulk. "Stale" could mean "file changed, re-read me", or "file no longer found". Unverified, and the index shows only that it is queried, not what sets it. |
| `asset.is_missing`, `is_corrupt`, `corrupt_description` | exist | Probably file-presence and file-readability flags. Not a rescan trigger on their face. |
| `asset.analysis_flags` | exists | Probably which analyses have run. Clearing it might provoke re-analysis, which is the thing forum users warn can rewrite tags. Do not try. |
| `asset.revision` (`root.sqlite` only) | exists | The per-row revision counter that drives sync into `master.sqlite` (see serato-4x-notes.md, "Revisions"). Bumping it makes Serato notice a *row*; it does not by itself make Serato re-read the *file*. Unverified. |
| `location.last_sync_time`, `location.last_sync_secret` | exist in `master.sqlite` | Likely a per-drive "synced up to here" marker. Unverified. |
| `updated_location`, `removed_asset` tables and the triggers that fill them | exist; `removed_asset (location_id, portable_id)` is filled when an asset row is deleted | Show that Serato tracks changed locations and deleted assets as a work queue. Deleting a cached asset row might make Serato re-import the file on the next sync. Unverified, and risky (crates reference assets). |

Things that are **not** in the schema: no column for a content hash, a tag checksum, or the file's
own modification time under an obvious name. The file's mtime is the usual way programs notice
external edits, but we have no evidence Serato uses it.

Candidate triggers, ranked by how safe they would be to try (all **unverified hypotheses**):

1. Do nothing in the database; tell the user to use the right-click menu or the Files-panel button.
   Documented, safe, manual.
2. Set `asset.is_stale` to 1 for the affected rows in a disposable copy and see whether Serato
   re-reads them on start.
3. Change `asset.file_size` to a wrong value (e.g. 0) so Serato sees a mismatch on start.
4. Delete the `asset` row (cascades to `space_asset` and so crate membership). Destructive; only
   ever on a copy.

This server's rules still apply: today it writes only new top-level crates into `root.sqlite`
(PRINCIPLES.md, principle 7). Writing any `asset` column would be a new category of write and would
need a person's explicit decision and its own safety design. Nothing here proposes building it.

## 3. Proposed black-box experiment

Goal: find out, by watching only the library files and the Serato window, whether any of the
candidate signals makes Serato re-read tags without the user clicking anything. Modelled on
[serato-4x-notes.md](serato-4x-notes.md): every result says which library it was taken on.

**Use a disposable copy.** Stage everything below on a byte copy of the whole library folder, with
Serato closed while copying. Serato will be started against that copy, so the copy must be the
folder Serato actually opens (which on a default install means swapping folders; see the support
article "Backing up and moving your library"). Alternative: a spare user account or machine. Do not
experiment on the working library. If it must be the working library, first do the byte-for-byte
backup described in serato-4x-notes.md.

**Test files.** Three small synthetic tracks, each added to a throwaway crate, ideally one each of
MP3, FLAC and WAV (forum reports say formats differ). Use made-up titles ("Rescan Test A") so no
real library content ends up in the notes.

**Procedure for each trigger T in {control, T1, T2, T3}:**

1. Close Serato. Copy the library folder to a fresh disposable copy. Record the SHA-256 of the
   three audio files and of `master.sqlite` and `root.sqlite`.
2. Start Serato once against the copy; let it settle; note the visible title, artist, comment and
   key for each test track. Quit Serato cleanly (clean quit removes `-wal`/`-shm`).
3. With a tag editor, change title, artist, comment and key in each file. Record the new file
   size and modification time (`stat`) and the new SHA-256.
4. Apply T to the copy's databases while Serato is closed:
   - control: nothing.
   - T1: `UPDATE asset SET is_stale = 1 WHERE ...` in `master.sqlite`.
   - T2: `UPDATE asset SET file_size = 0 WHERE ...` in `master.sqlite`.
   - T3: touch only the files' modification time to now, leaving the databases alone.
   Record the databases' SHA-256 afterwards.
5. Start Serato. Without clicking Rescan, note what the library grid shows for the four fields.
   Keep Serato's log for the session (serato-4x-notes.md used it to name sync steps).
6. Quit Serato cleanly. Dump the four fields plus `file_size`, `time_modified`, `is_stale`,
   `analysis_flags` for the three tracks from `master.sqlite` (read through a snapshot, per
   PRINCIPLES.md principle 1).
7. Then use the documented route (right-click menu, or drag onto the Files-panel button) and
   record what changes, as the positive control. If the documented route does not update a field,
   that field is out of reach for any trigger and the experiment can stop there.

**What to measure and write down, per file, per trigger:**

- Did each of the four fields update, with no click (yes / no)? After the documented rescan?
- Did the row's `file_size`, `time_modified`, `is_stale`, `analysis_flags` and `revision` change,
  and to what? Specifically whether `time_modified` equals the file's mtime or the wall clock.
- Did Serato rewrite the audio file (compare SHA-256 against step 3)? This is the risk forum
  users describe, and a trigger that causes it is disqualified.
- Did anything else change (crate membership, cue points, beat grids)? Count rows in
  `container_asset` before and after.
- How long start-up took, and what the log said.

**How to restore.** Delete the disposable copy and the extra audio files, and put the original
library folder back under Serato. If a working library was touched, restore the byte backup taken
in step 1 and check the SHA-256 of `master.sqlite` and `root.sqlite` matches. Then check Serato
starts and the crate list looks as before.

**How to read the results.** One trigger that updates the fields without rewriting audio files
across all three formats, repeatably across three runs, would be a *measured* mechanism for a
future feature. Anything less stays a hypothesis. Record the Serato version, operating system and
schema `user_version` with the results; behaviour on Windows especially is unmeasured (see
serato-4x-notes.md, "Windows").

## Update: driving the button (serato_rescan)

The `serato_rescan` tool presses the Files-panel button through UI Automation or OCR plus a
synthesised click. What was and was not measured on Serato 4.0.0.2697 is in
[../notes/rescan-spike-results.md](../notes/rescan-spike-results.md). It does not change the
conclusions above: nothing writes `asset` rows, and Serato itself does the re-reading.

## Recommendation until something is measured

Do not write to `asset` rows. If a feature is wanted, the honest version is a message to the user:
"Serato does not re-read changed files by itself. In Serato, right-click the tracks (or drag them
onto the Re-Scan File Info / Rescan ID3 Tags button in the Files panel) to refresh them." That is
documented, safe, and consistent with principle 3 of the project (nothing reaches the library
without a person choosing it).

## Sources

- Serato support, Re-scan ID3 tags: https://support.serato.com/hc/en-us/articles/227561687 (excerpt only)
- Serato support, Editing ID3 Tags: https://support.serato.com/hc/en-us/articles/227561607-Editing-ID3-Tags (excerpt only)
- Serato support, Navigating and Managing your Library: https://support.serato.com/hc/en-us/articles/14359483189135-Navigating-and-Managing-your-Library (excerpt only)
- Serato support, Library Files Panel: https://support.serato.com/hc/en-us/articles/360001447735-Library-Files-Panel (excerpt only; did not mention the rescan button)
- Serato forum: discussions 35852, 150819, 560981, 600377, 793137, 1220981, 1518138, 1705932 (excerpts); 1577169 (read in full; no Serato staff reply, contrary to what a search summary suggested)
- Rane SL1/SL3 manuals (Scratch Live): https://www.manualslib.com/manual/1631513/Rane-Sl1.html?page=26
- Holzhaus serato-tags: https://github.com/Holzhaus/serato-tags/blob/main/docs/fileformats.md
- Trade press on Serato DJ 4.0: https://musictech.com/news/gear/serato-dj-4-0-update/
- Our schema: `tests/fixtures/schema/master-202.sql`, `tests/fixtures/schema/root-202.sql`
