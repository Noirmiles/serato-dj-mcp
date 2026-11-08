# serato_rescan: spike and reliability results

Environment: Windows 11 (build 10.0.26200), Serato DJ Pro **4.0.0.2697** (installed, started and
closed during this work), Windows PowerShell 5.1, 1920x1080 display at 100% scale. The library it
opened is the machine owner's real working library (tens of thousands of tracks). No track, crate
or other library content is recorded here.

## Reliability of serato_rescan: NOT MEASURED

**The button was never pressed, so there is no success rate, no `verified` observation and no
duration for a rescan.** Serato was available, but pressing Re-Scan File Info makes it re-read the
tags of every file in a very large real library, and no disposable library was available. Running
it five times unattended on someone's working library was not a call for an automated build step to
make. This is a decision, not a tool failure. The following are therefore **unmeasured**: whether
the real click starts a scan, what Serato shows while scanning (so whether the scan-message wording
in `hasScanIndicator` matches anything real), `verified` true/false rates, and rescan duration.

**Command for Myles to run on his laptop** (Serato running, main window visible, ideally on a small
or disposable library; every run rescans the whole library; do not touch the mouse during a run):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serato-rescan-reliability.ps1 -Runs 5
```

It asks before starting (`-Yes` skips that), waits 20 s between runs (`-GapSeconds`), and prints per
run `method`, `verified`, `duration`, then successes out of N. Paste its output into the table below.

| Serato version | Method that worked | Pressed / N | Verified true / N | Date |
|---|---|---|---|---|
| (not measured) | | | | |

## Measured: the UI Automation spike (`scripts/serato-uia-spike.ps1`)

Run against the running Serato 4.0.0.2697:

- Serato's main window is a Qt 6 / QML window, class `serato::gui::MainQtView`, supporting only
  `ValuePattern` and `WindowPattern`.
- Fresh start: the control-view tree had **exactly 1 node, the window itself**. No children.
  Rescan-button candidates: 0. Files-label candidates: 0.
- Later in the same session, after the Files tab had been opened with a synthesised click, the tree
  had 2 nodes: the window and one **unnamed** QML `Button` (class `Button_QMLTYPE_175`, rectangle
  around the Files tab, `InvokePattern` available). Still 0 candidates by name or AutomationId. Why
  the extra node appeared (Qt creating accessibles lazily after interaction, or something else) was
  not investigated.
- Conclusion for this version: **UIA cannot find the Re-Scan File Info button by name or
  AutomationId.** The UIA strategy stays in the tool because other versions or Qt settings may
  expose it, but on 4.0.0.2697 the OCR route is the one that is used.
- The first Serato process had exited on its own before the next step of the session; the cause is
  unknown and was not investigated.

## Measured: OCR route (`Windows.Media.Ocr`, window rectangle only)

- OCR of the whole Serato window (3x bicubic upscale, in memory, never saved) took about 2.6 to
  3.2 s and returned about 190 lines.
- The UI's small text is read badly: the **Files tab came back as "Fjes"**, "Analyze Files" as
  "Anaryze Fjes", and the button **"Re-scan File Info" as "Re-scan hfo"**, in a line merged with the
  neighbouring button ("Re-scan hfo Rebcate Lost FJes"). The matcher was extended from these real
  strings (token rule: "Re-scan" plus a word near "info"/"file"; Files tab accepted by fuzzy match
  only on the same row as, and left of, the Prepare/History tabs). Colour inversion before OCR was
  tried and made no consistent difference, so it is not used.
- With the Files panel open the matcher located the button at roughly x 328 to 396, y 746 to 754
  (screen pixels, this layout and resolution only).
- Opening the Files panel worked: the Files tab was found by OCR and clicked with `SetCursorPos` +
  `mouse_event`, and the panel (a folder browser with the rescan and relocate buttons at its
  bottom) appeared. This is the one end-to-end click that was measured.
- Window capture needs Serato in front. In one early capture another window overlapped Serato and
  the capture included that window's text; that is why the tool brings Serato to the front first
  and **refuses to capture if it cannot** (one such refusal was seen in about 15 OCR calls).
- Side finding: asking Serato to close (`CloseMainWindow`, what `serato_close` does) showed an
  **"Exit - are you sure?" dialog** and Serato kept running until Yes was clicked (done through the
  OCR click route; it then exited cleanly after roughly 40 s). `serato_close` as it stands would
  report "still running, NOT killed" in that situation.

## Not attempted

- **Per-folder rescan** (dragging a folder onto the button) was not attempted. It would need a drag
  from a Files-panel folder row to the button with synthesised mouse events and a way to verify it;
  nothing was spiked. `serato_rescan` accepts only `scope: "library"`.
