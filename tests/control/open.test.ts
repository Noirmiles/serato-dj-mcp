import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { seratoOpen } from "../../src/tools/serato-open.js";
import { FakePlatform } from "./fake.js";

const run = (f: FakePlatform, raw: unknown = {}) =>
  seratoOpen(raw, { platform: f, sleep: f.sleep, now: f.now });

describe("serato_open", () => {
  it("returns already_running without launching", async () => {
    const f = FakePlatform.running();
    const r = await run(f);
    expect(r).toMatchObject({ already_running: true, pid: 4242, window_title: "Serato DJ Pro" });
    expect(f.calls.some((c) => c.startsWith("launch"))).toBe(false);
  });

  it("launches and waits for a responding, titled window", async () => {
    const f = new FakePlatform();
    f.onTick = (x) => {
      // First tick: process exists but its window is still untitled; then ready.
      if (x.time === 500) {
        x.proc = { pid: 777, name: "Serato DJ Pro", path: x.install };
        x.window = { handle: "5", title: "", responding: true };
      } else if (x.time === 1000) {
        x.window = { handle: "5", title: "Serato DJ Pro", responding: true };
      }
    };
    const r = await run(f);
    expect(r).toMatchObject({
      already_running: false,
      pid: 777,
      window_title: "Serato DJ Pro",
      install_path: "C:\\Fake\\Serato DJ Pro.exe",
    });
    expect(f.calls).toContain("launch:C:\\Fake\\Serato DJ Pro.exe");
  });

  it("gives a clear error naming SERATO_DJ_EXE when no install is found", async () => {
    const f = new FakePlatform();
    f.install = null;
    const r = await run(f);
    expect(isSeratoError(r) && r.error.code).toBe("install_not_found");
    if (!isSeratoError(r)) throw new Error("unexpected");
    expect(r.error.message).toContain("SERATO_DJ_EXE");
    expect(f.calls.some((c) => c.startsWith("launch"))).toBe(false);
  });

  it("reports a launch failure", async () => {
    const f = new FakePlatform();
    f.launchFails = true;
    const r = await run(f);
    expect(isSeratoError(r) && r.error.code).toBe("launch_failed");
  });

  it("times out when the window never becomes ready", async () => {
    const f = new FakePlatform();
    const r = await run(f, { timeout_seconds: 3 });
    expect(isSeratoError(r) && r.error.code).toBe("launch_timeout");
    expect(f.time).toBeGreaterThanOrEqual(3000);
  });
});
