import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/control/platform.js";
import {
  findFilesTab,
  findRescanButton,
  hasScanIndicator,
  matchesRescanLabel,
} from "../../src/control/rescan-match.js";
import { line } from "./ocr-lines.js";

describe("matchesRescanLabel", () => {
  it.each([
    "Re-Scan File Info",
    "Re-Scan File lnfo",
    "Re-Scan File |nfo",
    "re-scan file info",
    "RE-SCAN FILE INFO",
    "Rescan File Info",
    "Re Scan File Info",
    "ReScanFileInfo",
    "Re-Scan Fiie Info",
    "Rescan ID3 Tags",
    "Rescan lD3 Tags",
    "Re-scan ID3 Tag",
    "RESCAN  ID3   TAGS",
    "Re-scan hfo", // seen from the real OCR engine on a real Serato 4 window
  ])("accepts %s", (s) => expect(matchesRescanLabel(s)).toBe(true));

  it.each([
    "Analyze Files",
    "Relocate Lost Files",
    "Re-scan",
    "Files",
    "Prepare",
    "",
    "Re-Cue Track",
    "Scan",
  ])("rejects %j", (s) => expect(matchesRescanLabel(s)).toBe(false));
});

describe("findRescanButton", () => {
  it("returns the box of just the matching words in a merged line", () => {
    const l = line("Re-scan hfo Relocate Lost Files", 328, 746);
    const box = findRescanButton([line("Search", 10, 10), l]);
    expect(box).not.toBeNull();
    expect(box?.x).toBe(328);
    expect(box?.y).toBe(746);
    // Covers "Re-scan hfo" only, not the neighbouring button's words.
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThan(328 + 90);
  });
  it("returns null when absent", () => {
    const lines: OcrLine[] = [line("Analyze Files", 5, 5), line("History", 50, 5)];
    expect(findRescanButton(lines)).toBeNull();
  });
});

describe("findFilesTab", () => {
  it("takes an exact Files word", () => {
    const box = findFilesTab([line("Files Prepare History", 1500, 480)]);
    expect(box?.x).toBe(1500);
  });
  it("takes a noisy Fjes on the tab row, not the one in Analyze Files", () => {
    const lines = [
      line("Anaryze Fjes", 361, 483),
      line("Fjes", 1513, 483),
      line("History", 1619, 483),
    ];
    expect(findFilesTab(lines)?.x).toBe(1513);
  });
  it("does not take a noisy word with no tab row to anchor it", () => {
    expect(findFilesTab([line("Anaryze Fjes", 361, 483)])).toBeNull();
  });
  it("is null when there is nothing", () => {
    expect(findFilesTab([line("Search", 1, 1)])).toBeNull();
  });
});

describe("hasScanIndicator", () => {
  it("sees progress and finished messages", () => {
    expect(hasScanIndicator(["x", "Scanning files..."])).toBe(true);
    expect(hasScanIndicator(["Scan complete"])).toBe(true);
  });
  it("ignores the button's own label and ordinary text", () => {
    expect(hasScanIndicator(["Re-scan File Info", "Relocate Lost Files", "58,465 songs"])).toBe(
      false,
    );
  });
});
