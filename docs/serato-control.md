# Controlling Serato DJ Pro from the server (Windows)

This page explains, in plain words, the four tools that can start, stop and check Serato DJ Pro
on Windows, and the rules they follow. The short version is in the README's
[Controlling Serato (Windows)](../README.md#controlling-serato-windows) section.

Serato is a trademark of its owner. This project is not affiliated with Serato.

## Turning them on

The tools are off by default. To use them, add `--allow-serato-control` to the server's options,
for example in your client's settings:

```
"args": ["-y", "serato-dj-mcp", "--allow-serato-control"]
```

On macOS and Linux the flag does nothing. On Windows it adds these tools:
`serato_status`, `serato_close`, `serato_open`, `serato_rescan` and `serato_analyze`.

## What each tool does

- **`serato_status`** only looks. It says whether Serato is running, its process ID, its main
  window's title, whether that window responds, whether sound is coming out of it (or that this
  cannot be told), and where Serato is installed. It also gives a hint called `looks_idle`: true
  only when Serato is running, its window responds, and its library database file did not change
  over a roughly two-second check. It is a hint, not a guarantee. It changes nothing.
- **`serato_close`** asks Serato to close, the same as clicking its close button. It waits for
  Serato to exit, then checks that the library database file has stopped changing. It needs
  `confirm: true`.
- **`serato_open`** starts Serato if it is not running and waits until its window is ready. If
  Serato is already running, it starts nothing and says so.
- **`serato_rescan`** presses Serato's **Re-Scan File Info** button (called *Rescan ID3 Tags* in
  older versions of Serato). That makes Serato re-read the tags of every file in its library, so
  changes made to files outside Serato show up in Serato. It takes only `scope: "library"`, which
  is also the only value allowed. Rescanning a single folder is not supported.

## Command line (for other programs)

The same four actions can be run without an MCP client, for scripts and other programs. It calls
the same code as the tools, so the safety rules below apply unchanged (graceful close only, audio
check, never kills Serato). Windows only.

```
node dist/control-cli.js <status|close|open|rescan> [--timeout-seconds N]
```

- `close` always passes `confirm: true`: running it is the confirmation. `rescan` uses scope
  `library`. `--timeout-seconds` applies to `close` and `open` only.
- It prints exactly one line of JSON on stdout. On success it is `{"ok":true,"result":{...}}`,
  where `result` is what the matching tool returns (for example `{"ok":true,"result":{"running":false,...}}`
  for `status`). On any failure it is `{"ok":false,"error":{"code":"...","message":"..."}}`
  (`details` is included when the tool gave some). Error codes are the tools' own, plus
  `not_supported` (not Windows) and `invalid_argument` (bad command line).
- Exit code: `0` ok, `1` failure (including Serato still running after `close`), `2` bad usage.
- `SERATO_LIBRARY_PATH` and `SERATO_DJ_EXE` are read from the environment as for the server.

## Safety rules

- **Graceful close only.** `serato_close` asks the window to close and never forces anything to
  end. Serato is never killed. If Serato does not exit in time, the result says it is still
  running and was not killed.
- **Needs your confirmation.** `serato_close` does nothing unless it is given `confirm: true`.
  Closing Serato can lose unsaved DJ work, so the assistant should ask you first.
- **Refuses while audio is playing.** Before closing, `serato_close` checks Serato's audio meter.
  If it shows sound, the close is refused and Serato is left alone.
- **The audio check has a limit.** It only sees audio that goes through the Windows mixer. Serato
  driving a DJ controller through **ASIO**, the usual setup with a controller, does not show up
  there. In that case the answer is **`unknown`**, not "silent". The close then goes ahead on your
  confirmation alone, and the result carries a warning saying so. A paused or silent deck reads as
  not playing.
- **Library files are never written.** None of the four tools changes a file in Serato's library
  folder. Serato itself does any changes, such as a rescan.
- **Only Serato is touched.** The tools work through the Serato process and its main window. They
  look at the Serato window only; they do not read or click anywhere else on the screen.

## The "Exit - are you sure?" dialog

Serato 4 does not close straight away. When asked to close, it shows an **"Exit - are you sure?"**
dialog and waits for an answer. `serato_close` then presses that dialog's **Yes** or **OK**
button, because you already confirmed the close with `confirm: true`. The dialog is never
confirmed while audio is detected.

The button is found in one of two ways: first through Windows' accessibility interface (UI
Automation), then by reading the Serato window with Windows' built-in text recognition and clicking
the button. If the dialog cannot be found, or another dialog is waiting for you, `serato_close`
reports that Serato is still running and was not killed.

## How Serato is found

**`serato_open` and the other tools** find `Serato DJ Pro.exe` in this order:

1. The file named by the `SERATO_DJ_EXE` environment variable, if that variable is set and the
   file exists.
2. The Windows registry: the uninstall entries and the App Paths entries for Serato DJ Pro.
3. The Program Files folders: `Serato\Serato DJ Pro\Serato DJ Pro.exe`, or the same file in any
   sub-folder of `Serato\`, under either Program Files folder.

If none of these finds it, `serato_open` says so and asks you to set `SERATO_DJ_EXE` to the full
path of `Serato DJ Pro.exe`.

## How to rescan, and what has and has not been tested

`serato_rescan` tries two routes, in this order:

1. **UI Automation.** On Serato 4.0.0.2697, the version tested, Serato's window exposes nothing
   that could be found by name, so this route did not find the button.
2. **Reading the window and clicking.** The server takes a picture of the Serato window only (kept
   in memory, never saved), reads the text in it with Windows' built-in OCR, opens the Files panel
   if needed, and clicks the Re-Scan File Info button with a real mouse click. This is the route
   that works on the tested version. **Do not use the mouse while it runs**, and keep the Serato
   window uncovered.

What was tested, and what was not:

- **Tested:** the search for the button and the Files tab in the Serato window, and clicking the
  Files tab, which opened the Files panel. Serato was run and closed during that work.
- **Not tested:** the real rescan click. Pressing the button makes Serato re-read every file in the
  library, and no disposable library was available to try it on. So it is not known whether the
  click starts a scan, what Serato shows while it scans, or how reliable the result is over repeated
  runs.
- **Not tested:** the wording the tool looks for to report `verified`. `verified` is `true` only if
  a scan message was seen afterwards; `false` if the window was read and none appeared; `"unknown"`
  if it could not be read again. Because the scan message has not been seen on screen, that wording
  may not match what Serato shows.
- **Not built:** rescanning one folder.

To measure reliability, run this on Windows with Serato open and its main window visible, ideally
on a small or disposable library. Every run rescans the whole library, so the script asks before it
starts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serato-rescan-reliability.ps1 -Runs 5
```

It waits 20 seconds between runs and prints, for each run, the method used, whether the scan was
verified, and how long it took. The results are recorded in
[notes/rescan-spike-results.md](../notes/rescan-spike-results.md).

## Not done yet: per-folder rescan

Rescanning only some folders, by dragging them onto the button, is a stretch goal. It is **not
done**. Nothing was built or tested for it.

## Analysing a crate (`serato_analyze`)

`serato_analyze` makes Serato DJ Pro 5 analyse (Lucid Beatgrids) the files of **one named crate** and
waits until it is finished. Windows only, behind `--allow-serato-control`.

**Input:** `crate`, `mode` (`fixed` or `flexible`), `resolution` (`bars` or `beats`, required for
flexible, not allowed for fixed), `set_mode` (default false), `confirm`, `confirm_token`,
`timeout_seconds` (default 600, max 3600). `files` is accepted by the schema (exactly one of `files`
and `crate`), but see the decision below.

**Decision: loose file lists.** Serato analyses what is selected in its own crate view. Selecting
arbitrary files would need drag and drop or multi-select driving, which this server does not do. So a
`files` list returns `not_supported`; put the files in a crate and pass `crate`. (The command line's
`--file` flag exists only to give the same answer.)

**Two steps.** A call without `confirm: true` touches nothing in Serato. It reads the crate's tracks
from the library, runs the checks and returns a plan: `files`, `count`, `mode`, `resolution`,
`locked_files`, `over_cap`, `refusals` and a `confirm_token` (a hash of the plan). Running needs
`confirm: true` and that token; a different token is `plan_changed`, a missing one is
`confirm_token_required`.

**Safety.** Error codes: `whole_library_refused` (names such as All Audio, Library, root; the target
is always one crate), `files_missing` (a file is gone or not a local file), `audio_playing` (the same
check `serato_close` uses, at plan time and again before clicking), `mode_mismatch`,
`mode_unverifiable`, `not_supported` (not Windows, or loose files), `analyze_ui_not_found`,
`confirm_token_required`, `plan_changed`. Two things are only listed under `refusals` in the plan and
then run because the confirming call accepted them: `over_cap` (more than 50 files) and
`locked_files` (beatgrid locked, by the Markers2 `BPMLOCK` flag or the library's
`is_beatgrid_locked`; Serato may leave these unchanged).

**How it runs.** Opens Serato if needed (`serato_open`), opens Setup and either verifies the analysis
mode (`set_mode: false`) or clicks the wanted options (`set_mode: true`), closes Setup, clicks the
crate in the crate list, then clicks the Analyze Files button (opening the Files panel first if
needed). All of it by OCR of the Serato window and real mouse clicks, with the matchers in
`src/control/analyze-match.ts`. A radio button's state is graphics, so reading the current mode only
works if OCR happens to return a filled-radio glyph before the label; otherwise the answer is
`mode_unverifiable` and the caller must use `set_mode: true` or set it by hand.

**Waiting.** Before the click, each file's modification time and `serato_read_grid` result are
recorded. Every 2 seconds each file is checked again; a file counts as changed when either differs.
The wait ends when all files changed (`all_changed`), or 30 seconds pass with no further change after
at least one (`quiet`), or the timeout (`timeout`, with `timed_out: true`). Per file the result has
`changed`, `before_uses` and `after` (`serato5_uses`, `marker_count`, `first_tempo`).

**Not live-tested.** Nothing here has been run against Serato. The Setup layout, the option labels,
the position of the Analyze Files button, whether the click analyses only the selected crate, what
Serato changes in the tags and how long it takes are all assumptions. The tests use a fake platform
and fake screenshots.

### Live check (not run)

Only on copies in `C:/Development/Projects/CrateShipTest/`, and only after the coordinator says
library repair #377 is applied:

1. Put a few MP3s in a test crate of the copied library; note their `control-cli read-grid` output.
2. Stage: `control-cli analyze --crate NAME --mode flexible --resolution bars`, and read the plan.
3. Run with `--set-mode --confirm --token T`; watch Setup open, the option clicks, Setup close.
4. Check the crate was selected, the analysis button was clicked, and each file's `changed`.
5. Repeat without `--set-mode` to see whether the current mode can be read (`mode_unverifiable` is
   the likely answer).

## Planned follow-up: DJCrateTool

DJCrateTool will later call `serato_close` before it writes to a library, then `serato_open` and
`serato_rescan` afterwards. **This is a follow-up and is not done here.** Nothing in this change
connects the two projects.
