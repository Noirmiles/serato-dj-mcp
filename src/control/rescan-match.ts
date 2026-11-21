import type { OcrLine, OcrWord } from "./platform.js";

/**
 * Finding Serato's "Re-Scan File Info" button in OCR output, and telling a
 * scan-in-progress message from ordinary window text.
 *
 * OCR on small UI text is noisy: a capital I or a lower-case l comes back for
 * the other, hyphens and spaces come and go, case is unreliable. So labels are
 * compared in a folded form (lower case, letters and digits only, I / l / 1 / |
 * all read as one letter) and allowed a small edit distance. Newer Serato calls
 * the button "Re-Scan File Info"; older versions say "Rescan ID3 Tags".
 */

/** The button labels, as written on the button. */
export const RESCAN_LABELS = ["Re-Scan File Info", "Rescan ID3 Tags"] as const;

/** PowerShell/.NET regex for the UIA name or id of the button (case-insensitive). */
export const RESCAN_UIA_PATTERN = "re-?s*scans*(files*info|id3s*tags?)";

export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9|]/g, "")
    .replace(/[l1|]/g, "i");
}

const TARGETS = RESCAN_LABELS.map(fold);

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Looser rule for the worst OCR output seen on a real Serato 4 window, where
 * "Re-scan File Info" came back as "Re-scan hfo": a first word within one edit
 * of "rescan", followed by a word close to "info", "file", "id3" or "tags".
 */
function matchesRescanTokens(text: string): boolean {
  const tokens = text.trim().split(/\s+/).map(fold).filter(Boolean);
  const [first, ...rest] = tokens;
  if (first === undefined || levenshtein(first, "rescan") > 1) return false;
  return rest.some((t) =>
    ["info", "file", "id3", "tags", "tag"].some(
      (k) => levenshtein(t, fold(k)) <= (k.length > 3 ? 2 : 0),
    ),
  );
}

/** True when `text` is (a noisy reading of) one of the rescan button labels. */
export function matchesRescanLabel(text: string): boolean {
  if (matchesRescanTokens(text)) return true;
  const f = fold(text);
  if (f.length < 8) return false;
  return TARGETS.some((t) => {
    if (f.includes(t)) return true;
    const allowed = Math.max(1, Math.floor(t.length * 0.15));
    for (const len of [t.length - 1, t.length, t.length + 1]) {
      for (let i = 0; i + len <= f.length; i++) {
        if (levenshtein(f.slice(i, i + len), t) <= allowed) return true;
      }
    }
    return false;
  });
}

export type Box = { x: number; y: number; width: number; height: number };

function union(words: OcrWord[]): Box {
  const x = Math.min(...words.map((w) => w.x));
  const y = Math.min(...words.map((w) => w.y));
  const r = Math.max(...words.map((w) => w.x + w.width));
  const b = Math.max(...words.map((w) => w.y + w.height));
  return { x, y, width: r - x, height: b - y };
}

/** The tightest run of 1 to 4 consecutive words in a line that reads as the button. */
export function findInLine(line: OcrLine, test: (text: string) => boolean): Box | null {
  const ws = line.words;
  let best: OcrWord[] | null = null;
  for (let i = 0; i < ws.length; i++) {
    for (let n = 1; n <= 4 && i + n <= ws.length; n++) {
      const run = ws.slice(i, i + n);
      if (test(run.map((w) => w.text).join(" ")) && (!best || run.length < best.length)) best = run;
    }
  }
  return best ? union(best) : null;
}

/** Box of the rescan button in OCR output, or null. */
export function findRescanButton(lines: OcrLine[]): Box | null {
  for (const l of lines) {
    const b = findInLine(l, matchesRescanLabel);
    if (b) return b;
  }
  return null;
}

function wordBox(w: OcrWord): Box {
  return { x: w.x, y: w.y, width: w.width, height: w.height };
}

/**
 * Box of the "Files" tab, or null. A word reading exactly "Files" wins. Small
 * UI text often comes back as "Fjes" or "Fies", so otherwise a word within two
 * edits of "Files" is accepted only when it sits on the same row as, and to
 * the left of, a "Prepare" or "History" word (the tab strip is Files, Prepare,
 * History). That keeps the "Files" inside the "Analyze Files" button from
 * being taken for the tab.
 */
export function findFilesTab(lines: OcrLine[]): Box | null {
  const words = lines.flatMap((l) => l.words);
  const files = fold("files");
  const exact = words.find((w) => fold(w.text) === files);
  const anchors = words.filter((w) => {
    const f = fold(w.text);
    return levenshtein(f, fold("history")) <= 1 || levenshtein(f, fold("prepare")) <= 1;
  });
  const onTabRow = (w: OcrWord) =>
    anchors.some((a) => Math.abs(a.y - w.y) <= 6 && w.x < a.x && a.x - w.x < 400);
  if (exact && (anchors.length === 0 || onTabRow(exact))) return wordBox(exact);
  const fuzzy = words.find((w) => levenshtein(fold(w.text), files) <= 2 && onTabRow(w));
  if (fuzzy) return wordBox(fuzzy);
  return exact ? wordBox(exact) : null;
}

/** Words that mean a scan is running or has just finished. The button's own
 *  label is removed first, because it contains "scan". */
const PROGRESS =
  /\b(scanning|rescanning|re-scanning|reading (tags|file info)|updating (library|file info)|scan (complete|completed|finished|done)|scanned)\b/i;

export function hasScanIndicator(texts: string[]): boolean {
  return texts.some((t) => !matchesRescanLabel(t) && PROGRESS.test(t));
}
