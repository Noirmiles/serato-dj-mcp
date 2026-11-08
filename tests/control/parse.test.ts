import { describe, expect, it } from "vitest";
import {
  parseAudio,
  parseBool,
  parseClick,
  parseInstallPath,
  parseOcr,
  parseProcess,
  parseUiaRescan,
  parseUiaText,
  parseWindow,
} from "../../src/control/parse.js";
import { WINDOW_SCRIPTS } from "../../src/control/window-scripts.js";
import { encodeScript, SCRIPTS, WindowsSeratoPlatform } from "../../src/control/windows.js";

describe("PowerShell output parsing", () => {
  it("parses a process, tolerating noise and a one-element array", () => {
    const j = '{"pid":4242,"name":"Serato DJ Pro","path":"C:\\\\X\\\\Serato DJ Pro.exe"}';
    expect(parseProcess(`banner\r\n${j}\r\n`)).toEqual({
      pid: 4242,
      name: "Serato DJ Pro",
      path: "C:\\X\\Serato DJ Pro.exe",
    });
    expect(parseProcess(`[${j}]`)?.pid).toBe(4242);
    expect(parseProcess('{"pid":1,"name":"n","path":null}')?.path).toBeNull();
  });

  it("returns null for empty or malformed process output", () => {
    expect(parseProcess("")).toBeNull();
    expect(parseProcess("{not json")).toBeNull();
    expect(parseProcess('{"pid":"x"}')).toBeNull();
  });

  it("parses a window and treats handle 0 as none", () => {
    expect(parseWindow('{"handle":"263540","title":"Serato DJ Pro","responding":true}')).toEqual({
      handle: "263540",
      title: "Serato DJ Pro",
      responding: true,
    });
    expect(parseWindow('{"handle":"0","title":"","responding":true}')).toBeNull();
    expect(parseWindow("")).toBeNull();
  });

  it("parses booleans and install paths", () => {
    expect(parseBool('{"ok":true}', "ok")).toBe(true);
    expect(parseBool('{"ok":false}', "ok")).toBe(false);
    expect(parseBool("garbage", "ok")).toBe(false);
    expect(parseInstallPath('{"path":"C:\\\\P\\\\Serato DJ Pro.exe"}')).toBe(
      "C:\\P\\Serato DJ Pro.exe",
    );
    expect(parseInstallPath('{"path":null}')).toBeNull();
    expect(parseInstallPath("")).toBeNull();
  });

  it("maps audio output so that anything unclear is unknown, never false", () => {
    expect(parseAudio('{"audio":"playing"}')).toBe(true);
    expect(parseAudio('{"audio":"silent"}')).toBe(false);
    expect(parseAudio('{"audio":"no_session"}')).toBe("unknown");
    expect(parseAudio('{"audio":"error"}')).toBe("unknown");
    expect(parseAudio("")).toBe("unknown");
    expect(parseAudio("Exception ...")).toBe("unknown");
  });
});

describe("Windows backend (scripts stubbed)", () => {
  it("drives the parsers from script output", async () => {
    const seen: string[] = [];
    const p = new WindowsSeratoPlatform({
      env: {},
      run: async (script) => {
        seen.push(script);
        if (script.includes("CloseMainWindow")) return '{"ok":true}';
        if (script.includes("SeratoAudio")) return '{"audio":"playing"}';
        if (script.includes("MainWindowHandle"))
          return '{"handle":"9","title":"T","responding":false}';
        return '{"pid":5,"name":"Serato DJ Pro","path":null}';
      },
    });
    expect((await p.findProcess())?.pid).toBe(5);
    expect(await p.getMainWindow(5)).toEqual({ handle: "9", title: "T", responding: false });
    expect(await p.requestClose(5)).toBe(true);
    expect(await p.detectAudioPlaying(5)).toBe(true);
    expect(seen.length).toBe(4);
  });

  it("reports unknown audio when the script itself fails", async () => {
    const p = new WindowsSeratoPlatform({
      env: {},
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(await p.detectAudioPlaying(5)).toBe("unknown");
  });

  it("refuses a non-integer pid before building any script", () => {
    expect(() => SCRIPTS.window(Number.NaN)).toThrow();
    expect(() => SCRIPTS.requestClose(-1)).toThrow();
  });

  it("encodes scripts as base64 UTF-16LE", () => {
    const enc = encodeScript("Write-Output 1");
    expect(Buffer.from(enc, "base64").toString("utf16le")).toContain("Write-Output 1");
  });

  it("uses the SERATO_DJ_EXE override when it exists", async () => {
    const p = new WindowsSeratoPlatform({
      env: { SERATO_DJ_EXE: process.execPath },
      run: async () => {
        throw new Error("should not be reached");
      },
    });
    expect(await p.findInstallPath()).toBe(process.execPath);
  });
});

describe("window-driving output parsing", () => {
  it("parses UIA results", () => {
    expect(parseUiaRescan('{"found":false,"count":1}')).toEqual({ found: false, elementCount: 1 });
    expect(
      parseUiaRescan(
        '{"found":true,"count":9,"name":"Re-Scan File Info","id":"","action":"invoke"}',
      ),
    ).toMatchObject({ found: true, action: "invoke", name: "Re-Scan File Info" });
    expect(() => parseUiaRescan("nothing")).toThrow();
    expect(parseUiaText('{"names":["a","b"]}')).toEqual(["a", "b"]);
    expect(parseUiaText("x")).toBeNull();
  });
  it("parses OCR output, tolerating one-element arrays, and surfaces errors", () => {
    const w = '{"text":"Files","x":1,"y":2,"w":3,"h":4}';
    const one = parseOcr(
      `{"left":0,"top":0,"width":10,"height":10,"lines":{"text":"Files","words":${w}}}`,
    );
    expect(one.lines[0]?.words[0]).toEqual({ text: "Files", x: 1, y: 2, width: 3, height: 4 });
    expect(parseOcr('{"left":0,"top":0,"width":10,"height":10,"lines":[]}').lines).toEqual([]);
    expect(() => parseOcr('{"error":"no foreground"}')).toThrow("no foreground");
  });
  it("parses click results", () => {
    expect(() => parseClick('{"ok":true}')).not.toThrow();
    expect(() => parseClick('{"ok":false,"error":"outside"}')).toThrow("outside");
  });
  it("builds window scripts that carry only validated numbers and no process-ending call", () => {
    for (const s of [
      WINDOW_SCRIPTS.uiaRescan(12),
      WINDOW_SCRIPTS.uiaText(12),
      WINDOW_SCRIPTS.ocr(12),
      WINDOW_SCRIPTS.click(12, 5, 6),
    ]) {
      expect(s).not.toMatch(/Stop-Process|\.Kill\(|taskkill/i);
    }
    expect(() => WINDOW_SCRIPTS.click(12, 1.5, 6)).toThrow();
    expect(() => WINDOW_SCRIPTS.ocr(-1)).toThrow();
  });
});

describe("confirmExitDialog (Windows backend, scripts stubbed)", () => {
  it("uses the UIA result when it pressed the button, without any OCR", async () => {
    const seen: string[] = [];
    const p = new WindowsSeratoPlatform({
      env: {},
      run: async (s) => {
        seen.push(s);
        return '{"clicked":true,"name":"Yes"}';
      },
    });
    expect(await p.confirmExitDialog(5)).toBe("clicked");
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("InvokePattern");
  });

  it("falls back to window-scoped OCR and clicks the Yes word", async () => {
    const seen: string[] = [];
    const word = (t: string, x: number, y: number) => ({ text: t, x, y, w: 20, h: 10 });
    const p = new WindowsSeratoPlatform({
      env: {},
      run: async (s) => {
        seen.push(s);
        if (s.includes("CopyFromScreen")) {
          return JSON.stringify({
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
            lines: [
              { text: "Exit - are you sure?", words: [word("Exit", 400, 300)] },
              { text: "Yes No", words: [word("Yes", 410, 360), word("No", 460, 360)] },
            ],
          });
        }
        if (s.includes("$cx")) return '{"ok":true}';
        return '{"clicked":false}';
      },
    });
    expect(await p.confirmExitDialog(5)).toBe("clicked");
    expect(seen.some((s) => s.includes("$cx = 420; $cy = 365"))).toBe(true);
  });

  it("is not_found when nothing matches or OCR fails", async () => {
    const p = new WindowsSeratoPlatform({
      env: {},
      run: async (s) =>
        s.includes("CopyFromScreen")
          ? '{"error":"could not bring the Serato window to the front"}'
          : '{"clicked":false}',
    });
    expect(await p.confirmExitDialog(5)).toBe("not_found");
  });
});
