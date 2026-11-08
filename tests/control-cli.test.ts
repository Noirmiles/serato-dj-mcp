import { describe, expect, it } from "vitest";
import { parseControlArgs, runControlCli } from "../src/control-cli.js";
import { FakePlatform } from "./control/fake.js";

const run = (argv: string[], f = FakePlatform.running(), platform: NodeJS.Platform = "win32") =>
  runControlCli(argv, {
    platform,
    makeCtx: () => ({ platform: f, sleep: f.sleep, now: f.now }),
  });

describe("parseControlArgs", () => {
  it("accepts each command", () => {
    for (const c of ["status", "close", "open", "rescan"]) {
      expect(parseControlArgs([c])).toEqual({ command: c });
    }
  });

  it("reads --timeout-seconds in both spellings for close and open", () => {
    expect(parseControlArgs(["close", "--timeout-seconds", "45"])).toEqual({
      command: "close",
      timeoutSeconds: 45,
    });
    expect(parseControlArgs(["--timeout-seconds=9", "open"])).toEqual({
      command: "open",
      timeoutSeconds: 9,
    });
  });

  it("rejects bad usage", () => {
    for (const argv of [
      [],
      ["bogus"],
      ["status", "extra"],
      ["close", "--timeout-seconds"],
      ["close", "--timeout-seconds", "x"],
      ["close", "--timeout-seconds", "1.5"],
      ["close", "--timeout-seconds", "-3"],
      ["status", "--timeout-seconds", "5"],
      ["rescan", "--timeout-seconds", "5"],
      ["close", "--timeout-seconds", "1", "--timeout-seconds", "2"],
      ["close", "--force"],
    ]) {
      expect(parseControlArgs(argv), argv.join(" ")).toHaveProperty("usage");
    }
  });
});

describe("runControlCli", () => {
  it("bad usage is one JSON line, exit 2, and touches nothing", async () => {
    const f = FakePlatform.running();
    const r = await run(["nope"], f);
    expect(r.exitCode).toBe(2);
    expect(r.line).not.toContain("\n");
    expect(JSON.parse(r.line)).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(f.calls).toEqual([]);
  });

  it("not Windows: not_supported, exit 1, platform untouched", async () => {
    const f = FakePlatform.running();
    const r = await run(["status"], f, "linux");
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line)).toMatchObject({ ok: false, error: { code: "not_supported" } });
    expect(f.calls).toEqual([]);
  });

  it("status success: ok true with the handler's result, exit 0", async () => {
    const r = await run(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.line).not.toContain("\n");
    const j = JSON.parse(r.line);
    expect(j.ok).toBe(true);
    expect(j.result).toMatchObject({ running: true });
  });

  it("close passes confirm: true and closes gracefully", async () => {
    const f = FakePlatform.running();
    const r = await run(["close", "--timeout-seconds", "10"], f);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.line).result).toMatchObject({ was_running: true, exited: true });
    expect(f.calls.some((c) => c.startsWith("requestClose"))).toBe(true);
  });

  it("a handler error (audio playing) maps to ok false, exit 1", async () => {
    const r = await run(["close"], FakePlatform.running({ audio: true }));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line)).toMatchObject({ ok: false, error: { code: "audio_playing" } });
  });

  it("rescan with Serato not running is a serato_not_running failure", async () => {
    const r = await run(["rescan"], new FakePlatform());
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line).error.code).toBe("serato_not_running");
  });

  it("a throw while building the context becomes control_failed, exit 1", async () => {
    const r = await runControlCli(["status"], {
      platform: "win32",
      makeCtx: () => {
        throw new Error("boom");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line)).toEqual({
      ok: false,
      error: { code: "control_failed", message: "boom" },
    });
  });

  it("an out-of-range timeout is reported by the handler, exit 1", async () => {
    const r = await run(["close", "--timeout-seconds", "0"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.line).error.code).toBe("invalid_argument");
  });
});
