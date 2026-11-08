import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { seratoRescan } from "../../src/tools/serato-rescan.js";
import { FakePlatform } from "./fake.js";
import { line, shot } from "./ocr-lines.js";

const run = (f: FakePlatform, raw: unknown = {}) =>
  seratoRescan(raw, { platform: f, sleep: f.sleep, now: f.now });

const withButton = shot(line("Re-scan hfo Relocate Lost Files", 328, 746));
const withTab = shot(line("Fjes", 1513, 483), line("History", 1619, 483));
const code = (r: unknown) => (isSeratoError(r) ? r.error.code : undefined);

describe("serato_rescan", () => {
  it("UIA success: no OCR, no click by the tool, verified from UIA text", async () => {
    const f = FakePlatform.running();
    f.uia = {
      found: true,
      elementCount: 90,
      name: "Re-Scan File Info",
      automationId: "",
      action: "invoke",
    };
    f.uiaText = [
      ["a", "b", "c", "d", "e"],
      ["a", "b", "c", "d", "e", "Scanning 12 of 900"],
    ];
    const r = await run(f);
    expect(r).toMatchObject({
      scope: "library",
      method: "uia",
      action: "invoke",
      verified: true,
      opened_files_panel: false,
    });
    expect(f.calls.some((c) => c.startsWith("ocrWindow") || c.startsWith("click"))).toBe(false);
  });

  it("UIA finds nothing, OCR finds the button and clicks its centre", async () => {
    const f = FakePlatform.running();
    f.ocrs = [withButton];
    f.onClick = (fk) => {
      fk.ocrs = [shot(line("Scanning library", 20, 20))];
    };
    const r = await run(f);
    expect(r).toMatchObject({
      method: "ocr",
      action: "click",
      verified: true,
      opened_files_panel: false,
    });
    expect(f.clicks).toHaveLength(1);
    const c = f.clicks[0];
    expect(c?.x).toBeGreaterThanOrEqual(328);
    expect(c?.x).toBeLessThan(328 + 90);
    expect(c?.y).toBeGreaterThanOrEqual(746);
    expect(c?.y).toBeLessThanOrEqual(754);
  });

  it("opens the Files panel first when the button is not visible", async () => {
    const f = FakePlatform.running();
    let clicks = 0;
    f.ocrs = [withTab];
    f.onClick = (fk) => {
      clicks++;
      fk.ocrs = [clicks === 1 ? withButton : shot(line("Scan finished", 5, 5))];
    };
    const r = await run(f);
    expect(r).toMatchObject({ method: "ocr", opened_files_panel: true, verified: true });
    expect(f.clicks).toHaveLength(2);
    expect(f.clicks[0]?.x).toBeGreaterThanOrEqual(1513);
  });

  it("errors, clicking nothing, when neither UIA nor OCR can find it", async () => {
    const f = FakePlatform.running();
    f.ocrs = [shot(line("Search", 5, 5))];
    const r = await run(f);
    expect(code(r)).toBe("rescan_button_not_found");
    expect(f.clicks).toHaveLength(0);
  });

  it("errors when the Files tab was clicked but the button is still not there", async () => {
    const f = FakePlatform.running();
    f.ocrs = [withTab];
    const r = await run(f);
    expect(code(r)).toBe("rescan_button_not_found");
    expect(f.clicks).toHaveLength(1);
  });

  it("errors with the OCR reason when OCR itself fails", async () => {
    const f = FakePlatform.running();
    f.uia = new Error("boom");
    f.ocrs = [new Error("could not bring the Serato window to the front, so it was not captured")];
    const r = await run(f);
    expect(code(r)).toBe("rescan_button_not_found");
    if (!isSeratoError(r)) throw new Error("unexpected");
    expect(r.error.message).toContain("not captured");
    expect(r.error.message).toContain("boom");
    expect(f.clicks).toHaveLength(0);
  });

  it("reports verified: false when the window is re-read and shows nothing", async () => {
    const f = FakePlatform.running();
    f.ocrs = [withButton];
    const r = await run(f);
    expect(r).toMatchObject({ method: "ocr", verified: false });
  });

  it("reports verified: 'unknown' when the window cannot be re-read", async () => {
    const f = FakePlatform.running();
    f.ocrs = [withButton];
    f.onClick = (fk) => {
      fk.ocrs = [new Error("window not captured")];
    };
    const r = await run(f);
    expect(r).toMatchObject({ method: "ocr", verified: "unknown" });
  });

  it("is 'unknown' when a scan message was already showing before the click", async () => {
    const f = FakePlatform.running();
    f.ocrs = [shot(line("Scanning library", 1, 1), line("Re-scan hfo", 328, 746))];
    const r = await run(f);
    expect(r).toMatchObject({ verified: "unknown" });
  });

  it("errors, suggesting serato_open, when Serato is not running", async () => {
    const f = new FakePlatform();
    const r = await run(f);
    expect(code(r)).toBe("serato_not_running");
    if (!isSeratoError(r)) throw new Error("unexpected");
    expect(r.error.message).toContain("serato_open");
    expect(f.calls.some((c) => /^(uia|ocr|click)/.test(c))).toBe(false);
  });

  it("errors when the window is not ready", async () => {
    const f = FakePlatform.running({ window: null });
    expect(code(await run(f))).toBe("serato_window_not_ready");
  });

  it("rejects an unsupported scope", async () => {
    const r = await run(FakePlatform.running(), { scope: "folder" });
    expect(code(r)).toBe("invalid_argument");
  });
});
