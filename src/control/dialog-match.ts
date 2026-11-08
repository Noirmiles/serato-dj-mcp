import type { OcrLine, OcrWord } from "./platform.js";
import type { Box } from "./rescan-match.js";
import { fold } from "./rescan-match.js";

/**
 * Recognising Serato's "Exit - are you sure?" confirmation, which appears when
 * the main window is asked to close, and finding its Yes / OK button.
 */

/** Text of the confirmation dialog. */
export const EXIT_DIALOG_TEXT = /exit|are you sure|quit/i;

/** PowerShell/.NET regexes for the UIA dialog text and its confirm button name. */
export const EXIT_DIALOG_UIA_PATTERN = "exit|are you sure|quit";
export const CONFIRM_BUTTON_UIA_PATTERN = "^&?(yes|ok)$";

export function hasExitDialogText(lines: OcrLine[]): boolean {
  return lines.some((l) => EXIT_DIALOG_TEXT.test(l.text));
}

/**
 * Box of the Yes / OK button: a word that reads "Yes" or "OK" (OCR-folded: "0K"
 * is not accepted, "Ves"/"Yes" with one edit is), taken from the line nearest
 * below the dialog text when there are several. Null if none.
 */
export function findConfirmButton(lines: OcrLine[]): Box | null {
  const textLine = lines.findIndex((l) => EXIT_DIALOG_TEXT.test(l.text));
  const isConfirm = (w: OcrWord) => {
    const f = fold(w.text);
    return f === "yes" || f === "ok" || f === "oki";
  };
  const candidates = lines
    .map((l, i) => ({ i, w: l.words.find(isConfirm) }))
    .filter((c): c is { i: number; w: OcrWord } => c.w !== undefined);
  if (candidates.length === 0) return null;
  const after = candidates.find((c) => c.i >= textLine) ?? candidates[0];
  if (!after) return null;
  const { x, y, width, height } = after.w;
  return { x, y, width, height };
}
