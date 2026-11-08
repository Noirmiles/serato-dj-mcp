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

On macOS and Linux the flag does nothing. On Windows it adds these four tools:
`serato_status`, `serato_close`, `serato_open` and `serato_rescan`.

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

## Planned follow-up: DJCrateTool

DJCrateTool will later call `serato_close` before it writes to a library, then `serato_open` and
`serato_rescan` afterwards. **This is a follow-up and is not done here.** Nothing in this change
connects the two projects.
