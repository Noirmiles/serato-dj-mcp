import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { seratoClose } from "../../src/tools/serato-close.js";
import { FakePlatform } from "./fake.js";

const run = (f: FakePlatform, raw: unknown) =>
  seratoClose(raw, { platform: f, sleep: f.sleep, now: f.now });
const code = (r: unknown) => (isSeratoError(r) ? r.error.code : undefined);

describe("serato_close", () => {
  it("is refused without confirm: true, touching nothing", async () => {
    for (const raw of [{}, { confirm: false }, { confirm: "true" }]) {
      const f = FakePlatform.running();
      const r = await run(f, raw);
      expect(code(r)).toBe("invalid_argument");
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses while audio is playing and does not ask the window to close", async () => {
    const f = FakePlatform.running({ audio: true });
    const r = await run(f, { confirm: true });
    expect(code(r)).toBe("audio_playing");
    expect(f.calls.some((c) => c.startsWith("requestClose"))).toBe(false);
  });

  it("closes gracefully and confirms the database file is stable", async () => {
    const f = FakePlatform.running();
    const r = await run(f, { confirm: true });
    expect(r).toMatchObject({
      was_running: true,
      exited: true,
      pid: 4242,
      database_file_stable: true,
      audio_playing: false,
    });
    expect(f.calls).toContain("requestClose:4242");
  });

  it("proceeds, with a warning, when the audio state is unknown", async () => {
    const f = FakePlatform.running({ audio: "unknown" });
    const r = await run(f, { confirm: true });
    expect(r).toMatchObject({ exited: true, audio_playing: "unknown" });
    expect((r as { warnings?: { code: string }[] }).warnings?.[0]?.code).toBe(
      "audio_state_unknown",
    );
  });

  it("succeeds trivially when Serato is not running", async () => {
    const f = new FakePlatform();
    const r = await run(f, { confirm: true });
    expect(r).toMatchObject({ was_running: false, exited: true });
    expect(f.calls.some((c) => c.startsWith("requestClose"))).toBe(false);
  });

  it("times out with a still-running error, never killing", async () => {
    const f = FakePlatform.running({ exitsOnClose: false });
    const r = await run(f, { confirm: true, timeout_seconds: 5 });
    expect(code(r)).toBe("still_running");
    if (!isSeratoError(r)) throw new Error("unexpected");
    expect(r.error.message).toMatch(/still running/);
    expect(r.error.message).toMatch(/NOT killed/);
    expect(r.error.details).toMatchObject({ killed: false });
    expect(f.time).toBeGreaterThanOrEqual(5000);
    // The platform has no way to end a process; the only mutating call made
    // is the polite close request.
    expect(f.calls.filter((c) => /^(requestClose|launch)/.test(c))).toEqual(["requestClose:4242"]);
  });

  it("rejects timeouts beyond 120 seconds", async () => {
    const r = await run(FakePlatform.running(), { confirm: true, timeout_seconds: 121 });
    expect(code(r)).toBe("invalid_argument");
  });

  it("errors when the database file keeps changing after exit", async () => {
    const f = FakePlatform.running();
    let n = 0;
    f.onTick = (x) => {
      n++;
      x.db = { mtimeMs: 1000 + n, size: 10 };
    };
    const r = await run(f, { confirm: true });
    expect(code(r)).toBe("busy");
    if (!isSeratoError(r)) throw new Error("unexpected");
    expect(r.error.message).toMatch(/still changing/);
  });

  it("errors, not killing, when there is no window to close", async () => {
    const f = FakePlatform.running({ closeDelivered: false });
    const r = await run(f, { confirm: true });
    expect(code(r)).toBe("control_failed");
  });
});

describe("no forced termination anywhere in the control code", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const controlFiles = readdirSync(join(root, "control")).map((f) => join(root, "control", f));
  const toolFiles = ["serato-status", "serato-close", "serato-open"].map((n) =>
    join(root, "tools", `${n}.ts`),
  );
  const FORBIDDEN = /stop-process|taskkill|\.kill\s*\(|\bkill|terminateprocess|\.terminate/i;

  it("found the files", () => {
    expect(controlFiles.length).toBeGreaterThanOrEqual(4);
    expect(toolFiles.length).toBe(3);
  });

  for (const file of [...controlFiles, ...toolFiles]) {
    // The user-facing sentence "was NOT killed" is the one allowed mention,
    // and only in the tool files, never in the backend.
    const raw = readFileSync(file, "utf8");
    const text = controlFiles.includes(file) ? raw : raw.replace(/NOT killed|killed: false/g, "");
    it(`${file.split(/[\\/]/).slice(-2).join("/")} has no kill/stop/terminate`, () => {
      expect(text).not.toMatch(FORBIDDEN);
    });
  }
});
