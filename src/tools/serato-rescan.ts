import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { type ControlCtx, clock, controlFailed } from "../control/context.js";
import type { OcrWindow, SeratoPlatform } from "../control/platform.js";
import {
  type Box,
  findFilesTab,
  findRescanButton,
  hasScanIndicator,
} from "../control/rescan-match.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";

export const seratoRescanInput = z.strictObject({
  scope: z.enum(["library"]).optional(),
});

export const seratoRescanDescription =
  "Press the 'Re-Scan File Info' button (older Serato: 'Rescan ID3 Tags') in Serato DJ Pro's Files " +
  "panel so Serato re-reads the tags of every file in its library (Windows only, needs " +
  "--allow-serato-control, Serato must be running; use serato_open first). scope is 'library' " +
  "(the default and the only value: rescanning one folder is not supported). The server never " +
  "writes library files; Serato itself updates its library, which can take a long time on a " +
  "large one. It first looks for the button through UI Automation; if Serato exposes no such " +
  "element (Serato 4 draws its own UI, so this is expected) it reads a screenshot of the Serato " +
  "window only with Windows' built-in OCR, opens the Files panel if needed, brings Serato to the " +
  "front and clicks the button with a real mouse click, so do not use the mouse while it runs. " +
  "'method' says which route worked. 'verified' is true only if a scan-in-progress or finished " +
  "message was seen afterwards, false if the window was read and none appeared (a quick scan may " +
  "finish between reads), and 'unknown' if the window could not be read again.";

export const seratoRescanOutput = z.object({
  scope: z.literal("library"),
  method: z.enum(["uia", "ocr"]),
  action: z.enum(["invoke", "click"]),
  verified: z.union([z.boolean(), z.literal("unknown")]),
  verification_note: z.string(),
  opened_files_panel: z.boolean(),
  duration_ms: z.number(),
  warnings: z.array(warningSchema).optional(),
});

export type SeratoRescanResult = Omit<z.infer<typeof seratoRescanOutput>, "warnings">;

/** Scan-in-progress text is looked for for up to this long after the click. */
const VERIFY_POLLS = 4;
const VERIFY_GAP_MS = 1500;
const PANEL_SETTLE_MS = 1500;

const centre = (b: Box) => ({
  x: Math.round(b.x + b.width / 2),
  y: Math.round(b.y + b.height / 2),
});

/** All the text we can read from the window: UIA names if UIA sees a real tree,
 *  else a fresh OCR. null when neither could be read. */
async function readText(p: SeratoPlatform, pid: number): Promise<string[] | null> {
  const uia = await p.uiaWindowText(pid).catch(() => null);
  if (uia && uia.length >= 5) return uia;
  try {
    return (await p.ocrWindow(pid)).lines.map((l) => l.text);
  } catch {
    return null;
  }
}

async function verify(
  p: SeratoPlatform,
  pid: number,
  before: string[] | null,
  sleep: (ms: number) => Promise<void>,
): Promise<{ verified: boolean | "unknown"; note: string }> {
  if (before === null) {
    return { verified: "unknown", note: "The window could not be read before the click." };
  }
  if (hasScanIndicator(before)) {
    return {
      verified: "unknown",
      note: "A scan message was already on screen before the click, so a new one cannot be told apart.",
    };
  }
  let readOnce = false;
  for (let i = 0; i < VERIFY_POLLS; i++) {
    await sleep(VERIFY_GAP_MS);
    const after = await readText(p, pid);
    if (after === null) continue;
    readOnce = true;
    if (hasScanIndicator(after)) {
      return {
        verified: true,
        note: "A scan-in-progress or finished message appeared after the click.",
      };
    }
  }
  return readOnce
    ? {
        verified: false,
        note:
          "The window was re-read and no scan message appeared. The click may not have registered, " +
          "or a small scan finished between reads. Check Serato.",
      }
    : { verified: "unknown", note: "The window could not be read after the click." };
}

export async function seratoRescan(
  raw: unknown,
  ctx: ControlCtx,
): Promise<(SeratoRescanResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(seratoRescanInput, raw);
  if (isSeratoError(args)) return args;
  const { sleep, now } = clock(ctx);
  const p = ctx.platform;
  const started = now();
  const done = (
    r: Omit<SeratoRescanResult, "scope" | "duration_ms">,
  ): SeratoRescanResult & { warnings?: Warning[] } =>
    ok({ scope: "library" as const, ...r, duration_ms: now() - started });

  try {
    const proc = await p.findProcess();
    if (!proc) {
      return err(
        "serato_not_running",
        "Serato DJ Pro is not running, so there is nothing to rescan. Start it with serato_open.",
      );
    }
    const win = await p.getMainWindow(proc.pid);
    if (!win || win.title.trim() === "") {
      return err(
        "serato_window_not_ready",
        "Serato is running but has no main window yet (still starting, or closing). Try again " +
          "shortly; serato_status shows its state.",
      );
    }
    const pid = proc.pid;
    const before = await readText(p, pid);

    // 1. UI Automation.
    let uiaNote = "";
    try {
      const u = await p.uiaRescan(pid);
      if (u.found) {
        const v = await verify(p, pid, before, sleep);
        return done({
          method: "uia",
          action: u.action,
          verified: v.verified,
          verification_note: v.note,
          opened_files_panel: false,
        });
      }
      uiaNote = `UI Automation saw ${u.elementCount} element(s) and no rescan button.`;
    } catch (e) {
      uiaNote = `UI Automation failed: ${e instanceof Error ? e.message : String(e)}.`;
    }

    // 2. OCR on the Serato window only.
    let shot: OcrWindow;
    try {
      shot = await p.ocrWindow(pid);
    } catch (e) {
      return err(
        "rescan_button_not_found",
        `${uiaNote} The OCR fallback could not read the window: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let button = findRescanButton(shot.lines);
    let openedPanel = false;
    if (!button) {
      const tab = findFilesTab(shot.lines);
      if (!tab) {
        return err(
          "rescan_button_not_found",
          `${uiaNote} OCR read the Serato window but found neither the Re-Scan File Info ` +
            "button nor a Files tab. Open the Files panel in Serato, make sure the window is " +
            "not covered or minimised, and try again.",
        );
      }
      const t = centre(tab);
      await p.clickWindowPoint(pid, t.x, t.y);
      openedPanel = true;
      await sleep(PANEL_SETTLE_MS);
      shot = await p.ocrWindow(pid);
      button = findRescanButton(shot.lines);
      if (!button) {
        return err(
          "rescan_button_not_found",
          `${uiaNote} The Files tab was clicked but OCR still did not find the Re-Scan File ` +
            "Info button. The Files panel may be laid out differently from what was expected; " +
            "nothing was rescanned.",
        );
      }
    }
    const c = centre(button);
    await p.clickWindowPoint(pid, c.x, c.y);
    const v = await verify(p, pid, before, sleep);
    return done({
      method: "ocr",
      action: "click",
      verified: v.verified,
      verification_note: v.note,
      opened_files_panel: openedPanel,
    });
  } catch (e) {
    return controlFailed("could not rescan", e);
  }
}
