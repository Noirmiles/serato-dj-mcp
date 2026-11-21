import { describe, expect, it } from "vitest";
import {
  detectAnalyzeMode,
  findAnalyzeButton,
  findCrateLabel,
  findSetupButton,
  isWholeLibraryName,
  labelMatcher,
} from "../../src/control/analyze-match.js";
import { line } from "./ocr-lines.js";

describe("analyze matchers", () => {
  it("finds the Analyze Files button through OCR noise, and both spellings", () => {
    expect(findAnalyzeButton([line("Analyze Files", 5, 7)])).toMatchObject({ y: 7 });
    expect(findAnalyzeButton([line("Analyse Fi1es", 5, 7)])).not.toBeNull();
    expect(findAnalyzeButton([line("Relocate Lost Files", 5, 7)])).toBeNull();
  });

  it("finds Setup exactly, not near-words", () => {
    expect(findSetupButton([line("SETUP", 1, 1)])).not.toBeNull();
    expect(findSetupButton([line("Setups", 1, 1)])).toBeNull();
  });

  it("finds a crate by name, multi-word, tolerating one wrong letter", () => {
    expect(findCrateLabel([line("House Gigs 2026", 40, 9)], "House Gigs 2026")).not.toBeNull();
    expect(findCrateLabel([line("House Glgs 2026", 40, 9)], "House Gigs 2026")).not.toBeNull();
    expect(findCrateLabel([line("Techno", 40, 9)], "House")).toBeNull();
  });

  it("short labels must match exactly", () => {
    expect(labelMatcher("Bars")("Bars")).toBe(true);
    expect(labelMatcher("Bars")("Bats")).toBe(false);
  });

  it("detects the selected mode only from a filled-radio glyph", () => {
    expect(
      detectAnalyzeMode([line("● Flexible", 0, 0), line("Fixed", 0, 20), line("● Beats", 0, 40)]),
    ).toEqual({
      mode: "flexible",
      resolution: "beats",
    });
    expect(detectAnalyzeMode([line("◉ Fixed", 0, 0), line("Flexible", 0, 20)])).toEqual({
      mode: "fixed",
      resolution: null,
    });
    expect(detectAnalyzeMode([line("Fixed", 0, 0), line("Flexible", 0, 20)])).toBeNull();
  });

  it("recognises whole-library names", () => {
    for (const n of ["All Audio", "all", "ALL SONGS", "Library", "root", "Serato Library"]) {
      expect(isWholeLibraryName(n), n).toBe(true);
    }
    expect(isWholeLibraryName("Gigs")).toBe(false);
  });
});
