import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import {
  ANALYZE_SETTLE_MS,
  MAX_ANALYZE_FILES,
  seratoAnalyze,
} from "../../src/tools/serato-analyze.js";
import { makeMasterFixture } from "../fixtures/make.js";
import {
  bpmLockEntry,
  geobFrameData,
  id3Frame,
  id3Tag,
  markers2Payload,
  mp3File,
} from "../markers/build.js";
import { tempoMapV2 } from "../markers/grid-build.js";
import { FakePlatform } from "./fake.js";
import { line, shot } from "./ocr-lines.js";

const CRATE = "Gigs";
const ANALYZE_Y = 500;

/** A library whose crate "Gigs" holds `n` real files in a temp dir. */
function world(n: number, lockedIdx: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "serato-an-"));
  const audio = join(dir, "audio");
  mkdirSync(audio);
  const root = parse(audio).root;
  const files: string[] = [];
  const tracks = [];
  for (let i = 0; i < n; i++) {
    const f = join(audio, `t${i}.mp3`);
    const lock = lockedIdx.includes(i);
    const tag = lock
      ? id3Tag([id3Frame("GEOB", geobFrameData(markers2Payload([bpmLockEntry(true)])), 3)])
      : id3Tag([]);
    writeFileSync(f, mp3File(tag));
    files.push(f);
    tracks.push({
      externalId: i + 1,
      portableId: relative(root, f).split(sep).join("/"),
      name: `T${i}`,
    });
  }
  const lib = join(dir, "lib");
  mkdirSync(lib);
  makeMasterFixture(lib, {
    tracks,
    crates: [{ id: 20, name: CRATE, trackExternalIds: tracks.map((t) => t.externalId) }],
    connectionUri:
      process.platform === "win32" ? `${root.slice(0, 2)}\\root.sqlite` : "/root.sqlite",
  });
  return {
    files,
    read: { library: lib, roots: [], cacheDir: mkdtempSync(join(tmpdir(), "serato-an-c-")) },
  };
}

const UI = shot(
  line("Setup", 10, 10),
  line("Close", 300, 10),
  line("● Flexible", 20, 100),
  line("Fixed", 20, 130),
  line("● Bars", 20, 160),
  line("Beats", 20, 190),
  line(CRATE, 20, 400),
  line("Analyze Files", 20, ANALYZE_Y),
);

const run = (f: FakePlatform, read: object, raw: object) =>
  seratoAnalyze(raw, { platform: f, sleep: f.sleep, now: f.now, read: read as never });
const code = (r: unknown) => (isSeratoError(r) ? r.error.code : undefined);
const base = { crate: CRATE, mode: "flexible", resolution: "bars" };
const touch = (p: string, secs: number) => {
  writeFileSync(p, mp3File(id3Tag([])), { flag: "a" });
  const t = new Date(Date.now() + secs * 1000);
  utimesSync(p, t, t);
};
const stage = async (f: FakePlatform, read: object, extra: object = {}) => {
  const r = await run(f, read, { ...base, ...extra });
  if (isSeratoError(r)) throw new Error(r.error.message);
  return r.plan;
};

describe("serato_analyze arguments and refusals", () => {
  it("needs exactly one target and a consistent resolution", async () => {
    const { read } = world(1);
    const f = FakePlatform.running();
    for (const raw of [
      { mode: "fixed" },
      { mode: "fixed", crate: "a", files: ["x"] },
      { mode: "flexible", crate: "a" },
      { mode: "fixed", crate: "a", resolution: "bars" },
      { mode: "fixed", crate: "a", extra: 1 },
    ]) {
      expect(code(await run(f, read, raw)), JSON.stringify(raw)).toBe("invalid_argument");
    }
    expect(f.calls).toEqual([]);
  });

  it("loose file lists are not_supported", async () => {
    const f = FakePlatform.running();
    const r = await run(f, world(1).read, { mode: "fixed", files: ["a.mp3"] });
    expect(code(r)).toBe("not_supported");
    expect(f.calls).toEqual([]);
  });

  it("never the whole library", async () => {
    const f = FakePlatform.running();
    for (const crate of ["All Audio", "all", "ROOT", "Serato Library"]) {
      expect(code(await run(f, world(1).read, { mode: "fixed", crate }))).toBe(
        "whole_library_refused",
      );
    }
    expect(f.calls).toEqual([]);
  });

  it("unknown crate is invalid_argument", async () => {
    expect(
      code(await run(FakePlatform.running(), world(1).read, { mode: "fixed", crate: "Nope" })),
    ).toBe("invalid_argument");
  });

  it("missing files are refused", async () => {
    const w = world(2);
    const gone = join(w.files[1] as string);
    writeFileSync(gone, "");
    const { rmSync } = await import("node:fs");
    rmSync(gone);
    expect(code(await run(FakePlatform.running(), w.read, base))).toBe("files_missing");
  });

  it("audio playing is refused at staging", async () => {
    const f = FakePlatform.running({ audio: true });
    expect(code(await run(f, world(1).read, base))).toBe("audio_playing");
  });
});

describe("serato_analyze plan and token", () => {
  it("staging does no UI action and returns a plan with a token", async () => {
    const f = FakePlatform.running();
    const w = world(2);
    const plan = await stage(f, w.read);
    expect(plan).toMatchObject({
      crate: CRATE,
      count: 2,
      mode: "flexible",
      resolution: "bars",
      over_cap: false,
    });
    expect(plan.files).toEqual(w.files);
    expect(plan.confirm_token).toMatch(/^[0-9a-f]{32}$/);
    expect(f.calls.some((c) => /ocr|click|launch/.test(c))).toBe(false);
  });

  it("lists locked files (Markers2 BPMLOCK) as a refusal in the plan", async () => {
    const w = world(3, [1]);
    const plan = await stage(FakePlatform.running(), w.read);
    expect(plan.locked_files).toEqual([w.files[1]]);
    expect(plan.refusals.map((r) => r.code)).toEqual(["locked_files"]);
  });

  it("lists DB-locked files too", async () => {
    const w = world(2);
    const db = new DatabaseSync(join(w.read.library, "master.sqlite"));
    db.exec(
      "UPDATE asset SET is_beatgrid_locked = 1 WHERE external_id = 2 OR id = (SELECT max(id) FROM asset)",
    );
    db.close();
    const plan = await stage(FakePlatform.running(), w.read);
    expect(plan.locked_files).toHaveLength(1);
  });

  it("records over_cap", async () => {
    const plan = await stage(FakePlatform.running(), world(MAX_ANALYZE_FILES + 1).read);
    expect(plan.over_cap).toBe(true);
    expect(plan.refusals.map((r) => r.code)).toEqual(["over_cap"]);
  });

  it("confirm needs the token, and a different token is plan_changed", async () => {
    const w = world(1);
    const f = FakePlatform.running();
    expect(code(await run(f, w.read, { ...base, confirm: true }))).toBe("confirm_token_required");
    expect(code(await run(f, w.read, { ...base, confirm: true, confirm_token: "x" }))).toBe(
      "plan_changed",
    );
    expect(f.calls.some((c) => /ocr|click/.test(c))).toBe(false);
  });

  it("the token changes when the options change", async () => {
    const w = world(1);
    const a = await stage(FakePlatform.running(), w.read);
    const b = await stage(FakePlatform.running(), w.read, { resolution: "beats" });
    expect(a.confirm_token).not.toBe(b.confirm_token);
  });
});

describe("serato_analyze execution", () => {
  const exec = async (f: FakePlatform, w: ReturnType<typeof world>, extra: object = {}) => {
    const plan = await stage(f, w.read, extra);
    return run(f, w.read, { ...base, ...extra, confirm: true, confirm_token: plan.confirm_token });
  };
  const running = () => {
    const f = FakePlatform.running();
    f.ocrs = [UI];
    return f;
  };

  it("mode_mismatch when Setup shows another mode", async () => {
    const f = running();
    const r = await exec(f, world(1), { mode: "fixed", resolution: undefined });
    expect(code(r)).toBe("mode_mismatch");
    expect(f.clicks.some((c) => c.y === ANALYZE_Y + 4)).toBe(false);
  });

  it("mode_unverifiable when the setting cannot be read", async () => {
    const f = running();
    f.ocrs = [shot(line("Setup", 10, 10), line("Fixed", 20, 130), line("Flexible", 20, 100))];
    expect(code(await exec(f, world(1)))).toBe("mode_unverifiable");
  });

  it("set_mode clicks the options instead of refusing", async () => {
    const f = running();
    const w = world(1);
    f.onClick = (fk, _x, y) => {
      if (y >= ANALYZE_Y) touch(w.files[0] as string, 100);
      void fk;
    };
    const r = await exec(f, w, { mode: "fixed", resolution: undefined, set_mode: true });
    expect(isSeratoError(r)).toBe(false);
    // Setup, Fixed, Close, crate, Analyze Files
    expect(f.clicks.length).toBe(5);
  });

  it("all files changed ends the wait", async () => {
    const f = running();
    const w = world(2);
    f.onClick = (_fk, _x, y) => {
      if (y >= ANALYZE_Y) for (const p of w.files) touch(p, 100);
    };
    const r = await exec(f, w);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r).toMatchObject({ executed: true, finished: "all_changed", timed_out: false });
    expect(r.results?.map((x) => x.changed)).toEqual([true, true]);
  });

  it("reports the final grid when the tag changes twice", async () => {
    const f = running();
    const w = world(2);
    const file = w.files[0] as string;
    const tagged = (n: number) =>
      mp3File(
        id3Tag([
          id3Frame(
            "GEOB",
            geobFrameData(
              tempoMapV2(
                Array.from({ length: n }, (_, k) => ({
                  pos: BigInt(k * 100),
                  tempo: 120 + k,
                  note: 4,
                  interp: 1,
                })),
              ),
              "Serato Tempo Map",
            ),
            3,
          ),
        ]),
      );
    let polls = -1; // counts sleeps once Analyze is clicked
    f.onClick = (_fk, _x, y) => {
      if (y < ANALYZE_Y) return;
      writeFileSync(file, tagged(1)); // partial
      polls = 0;
    };
    const sleep = f.sleep;
    (f as { sleep: unknown }).sleep = async (ms: number) => {
      await sleep(ms);
      if (polls >= 0 && ++polls === 2) writeFileSync(file, tagged(3)); // final
    };
    const r = await exec(f, w);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r.results?.[0]).toMatchObject({ changed: true, after: { marker_count: 3 } });
  });

  it("goes quiet after some files changed", async () => {
    const f = running();
    const w = world(2);
    f.onClick = (_fk, _x, y) => {
      if (y >= ANALYZE_Y) touch(w.files[0] as string, 100);
    };
    const r = await exec(f, w);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r.finished).toBe("quiet");
    expect(r.timed_out).toBe(false);
    expect(r.results?.map((x) => x.changed)).toEqual([true, false]);
    expect(r.waited_ms).toBeGreaterThanOrEqual(ANALYZE_SETTLE_MS);
  });

  it("times out when nothing changes", async () => {
    const f = running();
    const r = await exec(f, world(1), { timeout_seconds: 10 });
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r).toMatchObject({ finished: "timeout", timed_out: true });
    expect(r.results?.[0]?.changed).toBe(false);
  });

  it("refuses when audio starts between staging and confirm", async () => {
    const f = running();
    const w = world(1);
    const plan = await stage(f, w.read);
    f.audio = true;
    const r = await run(f, w.read, { ...base, confirm: true, confirm_token: plan.confirm_token });
    expect(code(r)).toBe("audio_playing");
    expect(f.clicks).toEqual([]);
  });

  it("analyze_ui_not_found when the crate is not on screen", async () => {
    const f = running();
    f.ocrs = [
      shot(
        line("Setup", 10, 10),
        line("Close", 300, 10),
        line("● Flexible", 20, 100),
        line("● Bars", 20, 160),
      ),
    ];
    expect(code(await exec(f, world(1)))).toBe("analyze_ui_not_found");
  });
});
