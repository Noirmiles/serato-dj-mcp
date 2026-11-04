# Serato library formats and behaviour: what is known, and how well

This is a reference for everything Serato reads and writes for its library. This project is not
affiliated with Serato. It is written in our own words from public third-party documentation and
from our own measurements; nothing here comes from Serato's own source, and no Serato program was
disassembled or decompiled to produce it.

## How to read the evidence labels

Every statement carries one of three labels.

- **measured**: we saw it ourselves. Only things already recorded in
  [serato-4x-notes.md](serato-4x-notes.md) are labelled this way, and that file says on which
  library and when. This document does not add measurements.
- **published by <source>**: a third party wrote it down. The source is named and its URL is in
  [Sources](#sources). We have not checked these claims against a Serato installation. Several
  of the sources say themselves that parts of their work are guesses, and those caveats are kept.
- **unverified**: we believe it or the code assumes it, but neither a measurement nor a public
  document backs it.

A "published" claim is weaker than a measured one, and the third-party projects are older than
Serato DJ 4.x (see the dates in [Sources](#sources)). Where a claim is about 3.x and 4.x
behaviour differing, it is flagged.

Sources, by short name: **Holzhaus-tags** (Holzhaus's serato-tags repository documentation),
**serato-tools** (the bvandrc/serato-tools project: README, docs folder, and the field lists in
its source), **Mixxx-db** (the Mixxx wiki page on the Serato database format), **Mixxx-meta**
(the Mixxx wiki page on Serato metadata), **triseratops** (Holzhaus's Rust library).

## Where things live

| Thing | Location | Evidence |
|---|---|---|
| Main library, macOS | `~/Library/Application Support/Serato/Library` | measured (serato-4x-notes, discovery code) |
| Main library, Windows | `%LOCALAPPDATA%\Serato\Library` | unverified (taken from a Serato support article, not from an installation; see serato-4x-notes, "Windows") |
| Per-drive library | `<drive>/_Serato_/Library` (4.x) | measured on macOS and, for `location.sqlite`, on Windows |
| 3.x library folder | `<drive>/_Serato_` holding `database V2`, `Subcrates/`, `SmartCrates/` | published by Mixxx-db for `_Serato_/Subcrates` and by serato-tools for `database V2`, `Subcrates`, `SmartCrates` |

Mixxx-db says the `Subcrates` location is certain for removable drives and that it was unclear
what happens on the computer's primary drive. serato-tools tells its users to close Serato before
editing, because Serato keeps the library in memory and saves it over changes made while it is
open (published by serato-tools). The same warning is the reason this project writes only while
Serato is closed.

## 1. Serato 4.x: SQLite stores

The 4.x stores are SQLite files. What was measured is written down in
[serato-4x-notes.md](serato-4x-notes.md); this section only summarises it and does not repeat the
detail.

- **`master.sqlite`** (WAL mode): the aggregate database the Serato GUI opens; the only one with a
  `lock` table, the history tables and every location. measured.
- **`root.sqlite`** (rollback journal): the boot disk's own store, attached by Serato as `db1`.
  Crates written to it appear in `master.sqlite` after Serato next starts and syncs. measured.
- **`location.sqlite`** (one per drive, in `<drive>/_Serato_/Library`): schema `user_version` 202,
  journal mode `delete`, `asset.portable_id` relative to the drive root with forward slashes,
  no `connection` and no `lock` table. measured, on one Windows file whose writing Serato version
  is unknown.
- **Schema version** 202 is what Serato DJ Lite 4.0.9 uses; `master.sqlite` ships 51 migration
  scripts, so an unknown version is a warning, not a refusal. measured.
- **Crates** are `container` rows with `type = 1` under the root container, which is found by
  `parent_id = 0`; nested and empty crates are deleted by Serato; the write order is revision
  counter, container, then `container_asset`. measured.
- **Legacy export:** after syncing, Serato itself writes `~/Music/_Serato_/Subcrates/<name>.crate`
  and logs `Dbv2: Exporting DBv2 library`. measured on macOS (a 1456-byte file for a five-track
  crate). This is the only evidence of how the 4.x and 3.x worlds meet; see
  [Open questions](#open-questions).
- **Everything else about the 4.x tables** (column meanings beyond those in the notes, other
  tables, the other 50-odd migrations): no source. Third-party projects found for this
  work document the 3.x files and the audio tags, not the 4.x SQLite schema. unverified.

## 2. Serato 3.x: the `database V2` file

A single binary file named `database V2` in `_Serato_`. Its tag-length-value layout is the same
one the crate files use (section 3). The track fields below are published only by serato-tools,
from the field list in its source code, whose meanings come from code comments and names, not
from a prose document; no Holzhaus-tags or Mixxx page documents this file. Treat every meaning
as published by serato-tools, unconfirmed.

### Record structure

Each record is a 4-byte ASCII tag, a 4-byte big-endian length, then that many payload bytes.
published by Mixxx-db (for crates) and serato-tools (for the same layout in the database).

The first letter of the tag decides how the payload is read. published by serato-tools (as its
parser implements it):

| Prefix | Payload |
|---|---|
| `o`, `r` | a nested sequence of records |
| `t`, `p` | text, UTF-16 big-endian; `p` is a path |
| `u` | unsigned 32-bit big-endian integer |
| `s` | unsigned 16-bit big-endian integer |
| `b` | one byte, 0 or 1 (a boolean) |
| `vrsn` | exact tag, not a prefix; text |

**Disagreement between sources:** Mixxx-db describes `s*` as a signed 32-bit integer and `b*`
as a "byte value". serato-tools implements `s*` as unsigned 16-bit and accepts only 0 or 1 for
`b*`. Neither is confirmed by a Serato document. unverified which is right. The `s` prefix does
not appear in any field list below, so it matters only to a reader that must skip unknown tags.

### Header and track record

- `vrsn`: the file's version text. serato-tools tests with `2.0/Serato Scratch LIVE Database`.
  published by serato-tools.
- `otrk`: one track, a nested record holding the fields below. published by serato-tools.

Track fields (all published by serato-tools, meanings from names or code comments):

| Tag | Type | Meaning |
|---|---|---|
| `ttyp` | text | file type; meaning not documented |
| `pfil` | path | the file, relative to the drive root |
| `tsng` | text | title |
| `tart` | text | artist |
| `talb` | text | album |
| `tgen` | text | genre |
| `tlen` | text | length |
| `tbit` | text | bitrate |
| `tsmp` | text | sample rate |
| `tsiz` | text | file size (name only) |
| `tbpm` | text | BPM |
| `tkey` | text | key |
| `tgrp` | text | grouping |
| `tlbl` | text | label/publisher |
| `tcmp` | text | composer |
| `ttyr` | text | year |
| `tcom` | text | comment |
| `trmx` | text | remixer |
| `tadd` | text | date added, text form |
| `uadd` | u32 | date added, numeric form |
| `utme` | u32 | "time"; meaning not documented |
| `utkn` | u32 | track number |
| `udsc` | u32 | disc number |
| `utpc` | u32 | play count |
| `ulbl` | u32 | track colour as 0xRRGGBB |
| `bbgl` | bool | beatgrid locked |
| `bcrt` | bool | marked corrupt by Serato |
| `tcor` | text | corrupt reason |
| `bmis` | bool | missing |
| `bstm` | bool | has stems |
| `bply` | bool | played; a code comment says it is set on the last played track only |
| `biro` | bool | read-only |
| `bovc` | bool | overview built |

Further tags the same source lists but labels unknown or guesses: `bitu`, `buns`, `bwlb`, `blop`,
`bkrk`, `bwll` (default false on every track), `bhrt` (default true), and `ufsb` ("maybe the file
size in bytes when Serato last read the file"). published by serato-tools, flagged by it as
guesses. Tags seen in other write-ups but not in anything read for this document, such as
`sbav`, are not documented here: unverified.

Not documented in any source read: column-list records at the head of `database V2` (if any),
how track order is kept, how Serato treats a record with a tag it does not know, and whether the
file has a checksum. unverified.

## 3. Legacy `.crate` files

One file per crate in `_Serato_/Subcrates/`, named `<CrateName>.crate`. The crate's name is not
stored inside the file. published by Mixxx-db. The file uses the record structure from section 2.

| Tag | Type | Meaning | Evidence |
|---|---|---|---|
| `vrsn` | text | `1.0/Serato ScratchLive Crate` | published by Mixxx-db and serato-tools |
| `osrt` | nested | sort setting: `tvcn` (column name, e.g. `key`) and `brev` (reverse order flag) | published by Mixxx-db, meanings hedged there; `brev` meaning from serato-tools |
| `ovct` | nested | one displayed column: `tvcn` (column name such as `song`, `artist`, `bpm`) and `tvcw` (width, text, `0` in the examples) | published by Mixxx-db and serato-tools |
| `otrk` | nested | one track, containing `ptrk` | published by Mixxx-db |
| `ptrk` | path | the track, relative to the drive root, e.g. `Music/<folder>/<file>.mp3` | published by Mixxx-db and serato-tools |

Mixxx-db says there "appear to be" fields that give the order of the title, artist, key and BPM
columns; which tags those are is not documented. Mixxx-db's page was last edited in March 2019.

For a crate on the boot disk, whether `ptrk` is relative to the filesystem root or the user's
home, and how it is written on Windows (drive letter, separator), is not documented in any source
read: unverified.

serato-tools also names a crate at `Subcrates/Serato Stems/Stems.crate` (published by
serato-tools, no prose).

### Smart crates (`.scrate`)

Files in `_Serato_/SmartCrates/`, extension `.scrate`. No prose document exists; the layout below
comes from the field definitions in serato-tools' source, read for names and types only.
published by serato-tools, unconfirmed.

- `vrsn`: `1.0/Serato ScratchLive Smart Crate`; the crate tags from section 3 also appear.
- `rurt`: one rule. `rlut`: live-update setting. `rart`: match-all setting. Both settings hold
  a `brut` boolean.
- Inside a rule: `urkt` (u32, the field to test), `trft` (text, the comparison), and one value
  tag chosen by the comparison: `trpt` (text), `trtt` (text, used for time comparisons) or `urpt`
  (u32).
- Field IDs given: added 25, album 8, artist 7, BPM 15, comment 17, composer 22, filename 4,
  genre 9, grouping 19, key 51, label 21, plays 79, remixer 20, song 6, year 23.
- Comparison codes given: contains, does not contain, is, is not (string); before, after (string
  and time forms); at least, at most (unsigned integer). The code's suffix (`str`, `time`,
  `uint`) picks the value tag, and the source notes the type follows the comparison, not the
  value: an artist rule set to 100 is stored as the text `100`.

How 4.x stores smart crates is not documented in any source read, and the notes do not cover it:
unverified.

## 4. Tags Serato writes into audio files

Serato 3.x and 4.x keep per-track analysis (cues, loops, beatgrid, colour, gain) in the audio
file itself, as well as in the library. Everything in this section is published by Holzhaus-tags
unless another source is named; it was written for Serato DJ Pro 2.x and later versions may have
changed it. Holzhaus-tags itself calls several parts "mostly done", and its README marks
`Serato Offsets_` as not started. Whether Serato 4.x writes these tags the same way is
unverified.

### Containers

| Format | Where | Names |
|---|---|---|
| MP3, AIFF | ID3 `GEOB` frames, MIME type `application/octet-stream` | `Serato Overview`, `Serato Analysis`, `Serato Autotags`, `Serato Markers_`, `Serato Markers2`, `Serato BeatGrid`, `Serato Offsets_` (MP3 only) |
| FLAC | Vorbis comments | `SERATO_ANALYSIS`, `SERATO_AUTOGAIN`, `SERATO_BEATGRID`, `SERATO_MARKERS_V2`, `SERATO_OVERVIEW`, `SERATO_RELVOL`, `SERATO_VIDEO_ASSOC` |
| MP4, M4A | free-form `----` atoms with mean `com.serato.dj` | `analysisVersion`, `autgain`, `beatgrid`, `markers`, `markersv2`, `overview`, `relvol`, `videoassociation` |
| Ogg Vorbis | Vorbis comments | `serato_analysis_ver`, `serato_overview`, `serato_beatgrid`, `serato_markers`, `serato_markers2` |
| AAC | XML in a `Metadata` folder inside `_Serato_` | no detail given |

Differences worth knowing:

- **ID3 version.** One page says ID3v2.4, but its own sample dump is a v2.3 file. Mixxx-meta says
  v2.3. Which Serato writes is unverified.
- **FLAC and MP4 base64.** The value is base64 without padding. Holzhaus-tags says the decoded
  FLAC content is the GEOB-style content: the text `application/octet-stream`, a NUL, the tag
  name (e.g. `Serato Markers2`), a NUL, and then the payload. For MP4 it says the decoded data
  matches the FLAC form. FLAC and MP4 `markers`/`markersv2` carry a line feed after every 72
  characters; the other MP4 values none. The documents are unclear whether the Markers2 payload
  inside is base64 a second time; treat as unverified.
- **Names are not parallel.** FLAC `SERATO_AUTOGAIN` is MP4 `autgain` (spelt so); FLAC
  `SERATO_ANALYSIS` is MP4 `analysisVersion`. Ogg has no autotags/gain name in the document.
- **Ogg Vorbis.** Holzhaus-tags states that the data format "seems [to] differ significantly" from
  the other formats and gives no layout. Mixxx-meta marks Ogg Markers2 as unclear.
- **MP4 `markers`.** Serato reads only the first five cue points and all loops from it; the field
  is fixed length and should be filled even when no cue or loop is used.
- **`Serato Offsets_`** is MP3-only; serato-tools says it appeared on about 1% of a sample of
  MP3s and its body is an undecoded table, thought (unconfirmed) to index MP3 frames for
  seeking. Header: two bytes (`01 02`, meaning unknown), a 20-byte NUL-terminated ASCII bitrate,
  a 20-byte NUL-terminated ASCII sample rate, body from offset 42. published by serato-tools.
- **`Serato RelVolAd`/relvol.** Only the container names above are published (published by
  Holzhaus-tags); there is no byte layout in any source read. unverified.

### Payloads (ID3 form; the same bytes are carried in the other containers as above)

Multi-byte numbers are big-endian in every hex example in the sources, although one write-up's
prose says little-endian; the examples are the better evidence. published by Holzhaus-tags.

- **`Serato Analysis`**: two bytes, major and minor version, probably the Serato version that
  analysed the track (example `02 01`). "Probably" is the source's word.
- **`Serato Autotags`**: two header bytes (`01 01`), then three NUL-terminated ASCII strings:
  BPM (example `115.00`), auto gain (example `-3.257`) and gain in dB (example `0.000`). The
  write-up admits uncertainty about further strings.
- **`Serato Overview`**: header `01 05`, then 16-byte rows of one-byte "frequency information"
  (waveform overview); the example totals 3842 bytes. What the 16 values mean is not explained.
- **`Serato BeatGrid`**: header `01 00`, a 32-bit marker count, then markers, then one footer byte
  of unknown meaning (serato-tools says a freshly analysed track writes 0 and Serato accepts it).
  A non-terminal marker is a 32-bit float position followed by a 32-bit count of beats to the
  next marker; the last marker, always terminal, is a float position followed by a float BPM.
- **`Serato Markers_`**: header `02 05`, a 32-bit entry count, then fixed 22-byte entries, then a
  four-byte track colour. Holds the first five cues and nine loops (14 entries in the example).
  An entry has start-set and end-set flags (0 = set, `7f` = unset), positions and a colour in a
  4-byte encoding that spreads 24 bits over 7-bit bytes, a type (1 cue, 3 loop) and a locked
  flag; a 6-byte block of each entry is unlabelled. Cue and loop names are not stored here.
  The source's own table calls the position width both 24 and 32 bits.
- **`Serato Markers2`**: header `01 01`, then base64 text, with a line feed every 72 characters,
  padded with NUL to at least 470 bytes. The base64 can come out one byte too long; appending
  `A` before decoding is the documented workaround (the reason is unknown). The decoded content
  starts `01 01`, ends with one `00`, and between them is a series of entries: a NUL-terminated
  ASCII type name, a 32-bit length, then the data.
  - `BPMLOCK`: one boolean, beatgrid locked.
  - `COLOR`: a zero byte and a 3-byte RGB track colour.
  - `CUE`: a zero, an index byte, position in milliseconds (32-bit), a zero, a 3-byte RGB colour,
    two bytes of zero, then a NUL-terminated UTF-8 name.
  - `LOOP`: a zero, an index, start and end in milliseconds, four bytes of unknown purpose (`ff`
    in the example), a 4-byte ARGB colour, a locked flag and a NUL-terminated UTF-8 name; the
    offsets in the source's own table are not fully consistent for these bytes.
  - `FLIP`: index, enabled flag, name, loop flag, a count and sub-entries, each a type byte, a
    32-bit length and data: type 0 is a jump (two 64-bit floats, seconds), type 1 is a
    playback/censor span (three 64-bit floats, the third a speed, -1.0 meaning censor). The last
    sub-entry is always a jump. serato-tools keeps FLIP undecoded.
- **Which wins.** Holzhaus-tags and triseratops both say Serato prefers `Serato Markers_` to
  `Serato Markers2` when both are present.
- **Colours.** The track colour shown in the library differs from the stored value by a fixed
  offset, with three exceptions, and hot-cue colours shown vary by Serato edition (Intro shows the
  stored colour, Lite has four fixed colours, Pro an 18-colour palette). published by
  Holzhaus-tags (colors page).
- **Mixxx import.** Mixxx 2.3 imports beatgrids, hot cues, saved loops (as hot cue starts),
  track colour and BPM lock from these tags, and not the overview or Flip. published by
  Mixxx-meta and the Mixxx 2.3 announcement.

## 5. History

### Serato 4.x

`history_session` and `history_entry` exist in `master.sqlite` in every library. A library that
never played a track has zero rows in both and every `asset.dj_play_count` is 0. measured
(2026-09-18, in serato-4x-notes). What a row's columns mean
(`played`, `deck`, an in-progress session) has not been confirmed; that is why this server has no
history tool. No third-party source read documents these tables.

### Serato 3.x

`_Serato_/History/Sessions/*.session` files and a `history.database` file. unverified: neither the
file layout nor the tag names appear in any public document read for this work. The serato-tools
project field list mentions only the play-count (`utpc`) and played (`bply`) flags in the
library, not a session format.

## Open questions

Not confirmed by measurement or by a public source:

1. **Serato 4 on Windows.** Where the main library lives, what `master.sqlite` and `root.sqlite`
   hold (e.g. `connection.database_uri`), whether the `lock` table is written, and what happens
   to a crate name Windows forbids as a file name. See serato-4x-notes, "Windows".
2. **Does Serato 4 still read `.crate` files, or only write them?** Measured: after syncing it
   writes one. Not measured: whether a `.crate` dropped into `Subcrates/` is imported, whether a
   modified one is read back, and whether the 3.x `database V2` is still consumed in 4.x or only
   exported.
3. **Path base in `ptrk`/`pfil`** for the boot disk, and on Windows.
4. **4.x tags in audio files.** Whether Serato 4.x still writes, reads, or changes `Serato
   Markers2` and the other tags, and how it merges them with the SQLite store. Every payload
   document predates 4.x.
5. **`database V2` fields.** Meanings of `ttyp`, `utme`, the guessed `b*` flags and `ufsb`; the
   `s*` prefix width; unknown-tag handling; any checksum.
6. **Smart crates in 4.x.** Whether they are stored in SQLite, and whether `.scrate` is still
   produced.
7. **History.** The 4.x column meanings, and the whole 3.x `.session` and `history.database`
   layouts.
8. **Offsets_, RelVol, Overview, FLIP.** Undecoded or undocumented in the sources read.
9. **ID3 version** Serato writes (2.3 or 2.4), and the Ogg Vorbis data layout.
10. **Endianness.** The sources agree in their hex examples (big-endian) but one write-up's prose
    says little-endian.

## Sources

All read for this document; none is by Serato.

- Holzhaus-tags: <https://github.com/Holzhaus/serato-tags> (README), and its docs:
  [fileformats](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/fileformats.md),
  [serato_markers2](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/serato_markers2.md),
  [serato_markers_](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/serato_markers_.md),
  [serato_beatgrid](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/serato_beatgrid.md),
  [serato_autotags](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/serato_autotags.md),
  [serato_overview](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/serato_overview.md),
  [serato_analysis](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/serato_analysis.md),
  [writeup](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/writeup.md),
  [colors](https://raw.githubusercontent.com/Holzhaus/serato-tags/main/docs/colors.md).
  Its docs are CC BY-SA 4.0, so nothing is copied here.
- serato-tools: <https://github.com/bvandrc/serato-tools> and
  <https://pypi.org/project/serato-tools/>; docs
  [fileformats](https://github.com/bvandrc/serato-tools/blob/main/docs/fileformats.md),
  [serato_markers2](https://github.com/bvandrc/serato-tools/blob/main/docs/serato_markers2.md),
  [serato_offsets_](https://github.com/bvandrc/serato-tools/blob/main/docs/serato_offsets_.md),
  [MYSTERIES](https://github.com/bvandrc/serato-tools/blob/main/docs/MYSTERIES.md); field
  definitions read in its source for names and types only:
  [bin_file_base](https://github.com/bvandrc/serato-tools/blob/main/src/serato_tools/utils/bin_file_base.py),
  [crate_base](https://github.com/bvandrc/serato-tools/blob/main/src/serato_tools/utils/crate_base.py),
  [crate](https://github.com/bvandrc/serato-tools/blob/main/src/serato_tools/crate.py),
  [smart_crate](https://github.com/bvandrc/serato-tools/blob/main/src/serato_tools/smart_crate.py),
  [database_v2](https://github.com/bvandrc/serato-tools/blob/main/src/serato_tools/database_v2.py).
- Mixxx-db: <https://github.com/mixxxdj/mixxx/wiki/Serato-Database-Format> (crates; edited 2019).
- Mixxx-meta: <https://github.com/mixxxdj/mixxx/wiki/Serato-Metadata-Format> (edited 2020);
  Mixxx 2.3 announcement: <https://mixxx.org/news/2021-02-08-new-in-2-3-serato-support>.
- triseratops: <https://github.com/Holzhaus/triseratops>; its Markers2 page:
  <https://docs.rs/crate/triseratops/0.0.2/target-redirect/i686-unknown-linux-gnu/src/triseratops/tag/markers2.rs.html>
  (read only as a search summary, not in full).
- Our own measurements: [serato-4x-notes.md](serato-4x-notes.md).
