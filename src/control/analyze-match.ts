import type { OcrLine } from "./platform.js";
import { type Box, findInLine, fold, levenshtein } from "./rescan-match.js";

/**
 * OCR matchers for driving Serato 5's analysis: the Setup button, the Lucid
 * Beatgrid options, a crate in the crate list and the "Analyze Files" button.
 * Same approach as rescan-match.ts: folded text plus a small edit distance.
 * The screen layout these look for is NOT verified on a real Serato 5.
 */

/** A matcher for `label`: folded text within ~20% edits (exact for short labels). */
export const labelMatcher = (label: string) => {
  const t = fold(label);
  const allowed = t.length < 6 ? 0 : Math.floor(t.length * 0.2);
  return (text: string) => levenshtein(fold(text), t) <= allowed;
};

/** Box of the tightest run of 1-4 words reading as `label`, or null. */
export function findLabel(lines: OcrLine[], label: string): Box | null {
  const test = labelMatcher(label);
  for (const l of lines) {
    const b = findInLine(l, test);
    if (b) return b;
  }
  return null;
}

const ANALYZE = ["Analyze Files", "Analyse Files"].map(labelMatcher);
export const findAnalyzeButton = (lines: OcrLine[]): Box | null => {
  for (const l of lines) {
    const b = findInLine(l, (t) => ANALYZE.some((m) => m(t)));
    if (b) return b;
  }
  return null;
};

export const findSetupButton = (lines: OcrLine[]) => findLabel(lines, "Setup");
export const findCloseButton = (lines: OcrLine[]) => findLabel(lines, "Close");
export const findCrateLabel = (lines: OcrLine[], name: string) => findLabel(lines, name);

export type AnalyzeMode = "fixed" | "flexible";
export type AnalyzeResolution = "bars" | "beats";

export const modeLabel = (m: AnalyzeMode) => (m === "fixed" ? "Fixed" : "Flexible");
export const resolutionLabel = (r: AnalyzeResolution) => (r === "bars" ? "Bars" : "Beats");

/** Crate names that mean "everything": never allowed as a target. */
export const isWholeLibraryName = (name: string) =>
  ["all", "allaudio", "allsongs", "allfiles", "library", "root", "seratolibrary"].includes(
    name.toLowerCase().replace(/[^a-z]/g, ""),
  );

/** A filled-radio glyph as OCR tends to return it, as a word of its own. */
const SELECTED = /^[([]?[●◉•*][)\]]?$/;

/**
 * The analysis setting visible in the Setup panel, if it can be told. A radio's
 * state is graphics, so this only works when OCR reads a filled-radio glyph as
 * a word right before the label ("● Flexible"). Not seen on real Serato 5:
 * null (cannot tell) is the expected answer and callers must treat it so.
 */
export function detectAnalyzeMode(
  lines: OcrLine[],
): { mode: AnalyzeMode; resolution: AnalyzeResolution | null } | null {
  const picked = (label: string) => {
    const test = labelMatcher(label);
    return lines.some((l) =>
      l.words.some((w, i) => i > 0 && test(w.text) && SELECTED.test(l.words[i - 1]?.text ?? "")),
    );
  };
  const mode = picked("Flexible") ? "flexible" : picked("Fixed") ? "fixed" : null;
  if (mode === null) return null;
  const resolution = picked("Bars") ? "bars" : picked("Beats") ? "beats" : null;
  return { mode, resolution };
}
