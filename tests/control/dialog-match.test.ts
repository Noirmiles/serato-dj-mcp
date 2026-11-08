import { describe, expect, it } from "vitest";
import { findConfirmButton, hasExitDialogText } from "../../src/control/dialog-match.js";
import { line } from "./ocr-lines.js";

describe("exit dialog matching", () => {
  it("detects the dialog text and finds the Yes button", () => {
    const lines = [
      line("Serato DJ Pro", 0, 0),
      line("Exit - are you sure?", 400, 300),
      line("Yes No", 420, 360),
    ];
    expect(hasExitDialogText(lines)).toBe(true);
    const b = findConfirmButton(lines);
    expect(b).toMatchObject({ x: 420, y: 360 });
  });

  it("accepts OK and ignores windows without dialog text", () => {
    expect(
      findConfirmButton([line("Quit Serato?", 0, 0), line("OK Cancel", 10, 40)]),
    ).toMatchObject({ x: 10, y: 40 });
    expect(hasExitDialogText([line("Library Files Prepare", 0, 0)])).toBe(false);
    expect(findConfirmButton([line("Library", 0, 0)])).toBeNull();
  });
});
