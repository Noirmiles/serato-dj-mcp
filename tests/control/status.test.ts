import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { seratoStatus } from "../../src/tools/serato-status.js";
import { FakePlatform } from "./fake.js";

const run = (f: FakePlatform, raw: unknown = {}) =>
  seratoStatus(raw, { platform: f, sleep: f.sleep, now: f.now });

describe("serato_status", () => {
  it("reports not running", async () => {
    const f = new FakePlatform();
    const r = await run(f);
    expect(r).toMatchObject({
      running: false,
      pid: null,
      window_title: null,
      looks_idle: false,
      install_path: "C:\\Fake\\Serato DJ Pro.exe",
    });
  });

  it("reports a running, idle Serato", async () => {
    const f = FakePlatform.running();
    const r = await run(f);
    expect(r).toMatchObject({
      running: true,
      process_name: "Serato DJ Pro",
      pid: 4242,
      window_title: "Serato DJ Pro",
      responding: true,
      looks_idle: true,
      audio_playing: false,
    });
    expect(f.time).toBeGreaterThanOrEqual(2000);
  });

  it("is not idle while the database file changes (busy)", async () => {
    const f = FakePlatform.running();
    f.onTick = (x) => {
      x.db = { mtimeMs: 2000, size: 11 };
    };
    expect(await run(f)).toMatchObject({ running: true, looks_idle: false });
  });

  it("is not idle when the window does not respond", async () => {
    const f = FakePlatform.running();
    f.window = { handle: "100", title: "Serato DJ Pro", responding: false };
    expect(await run(f)).toMatchObject({ responding: false, looks_idle: false });
  });

  it("passes an unknown audio state through and warns when the database is missing", async () => {
    const f = FakePlatform.running({ audio: "unknown", db: null });
    const r = await run(f);
    expect(r).toMatchObject({ audio_playing: "unknown", looks_idle: false });
    expect((r as { warnings?: { code: string }[] }).warnings?.[0]?.code).toBe(
      "database_file_not_found",
    );
  });

  it("never asks the platform to close or launch anything", async () => {
    const f = FakePlatform.running();
    await run(f);
    expect(f.calls.filter((c) => /^(requestClose|launch)/.test(c))).toEqual([]);
  });

  it("rejects unexpected arguments", async () => {
    const r = await run(new FakePlatform(), { x: 1 });
    expect(isSeratoError(r)).toBe(true);
  });
});
