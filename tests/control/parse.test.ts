import { describe, expect, it } from "vitest";
import {
  parseAudio,
  parseBool,
  parseInstallPath,
  parseProcess,
  parseWindow,
} from "../../src/control/parse.js";
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
