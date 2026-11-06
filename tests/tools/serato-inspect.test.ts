import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { describePath, MAX_PATH_SAMPLES, seratoInspect } from "../../src/tools/serato-inspect.js";
import { makeMasterFixture, type TrackSeed } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-insp-"));
const ctx = (dir: string) => ({ library: dir, roots: [], cacheDir: tmp() });
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function inspect(dir: string) {
  const r = await seratoInspect({}, ctx(dir));
  if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
  return r;
}

const track = (n: number, portableId: string): TrackSeed => ({
  externalId: n,
  portableId,
  name: `T${n}`,
});

describe("serato_inspect", () => {
  it("reports files, schema, tables and counts, and never changes master.sqlite", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [track(1, "Users/x/a.flac"), track(2, "Users/x/b.flac")],
      crates: [{ id: 100, name: "C", trackExternalIds: [1, 2] }],
    });
    writeFileSync(join(dir, "root.sqlite"), "x");
    const before = sha(join(dir, "master.sqlite"));

    const r = await inspect(dir);

    expect(r.library_path).toBe(dir);
    expect(r.files).toEqual({
      "master.sqlite": true,
      "root.sqlite": true,
      "location.sqlite": false,
    });
    expect(r.user_version).toBe(202);
    expect(r.schema_known).toBe(true);
    expect(r.tables).toEqual(expect.arrayContaining(["asset", "container", "container_asset"]));
    expect(r.tables).toEqual([...r.tables].sort());
    expect(r.row_counts.asset).toBe(2);
    expect(r.row_counts.container).toBeGreaterThan(0);
    expect(r.row_counts.container_asset).toBeGreaterThanOrEqual(2);
    expect(typeof r.journal_mode).toBe("string");
    expect(r.generation).toEqual(expect.any(String));
    expect(sha(join(dir, "master.sqlite"))).toBe(before);
  });

  it("reports an empty lock table, then one with rows", async () => {
    const empty = tmp();
    makeMasterFixture(empty, { tracks: [] });
    expect((await inspect(empty)).lock).toEqual({ table_exists: true, has_rows: false });

    // A separate library: takeSnapshot serves a library's last snapshot for
    // 2 s, so editing the same one would still read the empty copy.
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const db = new DatabaseSync(join(dir, "master.sqlite"));
    db.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 4242, 'Serato DJ Pro.exe')",
    ).run();
    db.close();
    expect((await inspect(dir)).lock).toEqual({ table_exists: true, has_rows: true });
  });

  it("reports a missing lock table as absent, not empty", async () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const db = new DatabaseSync(join(dir, "master.sqlite"));
    db.exec("DROP TABLE lock");
    db.close();
    expect((await inspect(dir)).lock).toEqual({ table_exists: false, has_rows: null });
  });

  it("samples Windows drive paths with the drive letter and backslash separator", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      connectionUri: "D:\\_Serato_\\Library\\location.sqlite",
      tracks: [track(1, "Music/House/a.flac")],
    });
    const r = await inspect(dir);
    expect(r.path_samples).toHaveLength(1);
    expect(r.path_samples[0]).toMatchObject({
      portable_id: "Music/House/a.flac",
      path: "D:\\Music\\House\\a.flac",
      kind: "windows_drive",
      drive_letter: "D",
      separator: "\\",
    });
  });

  it("samples POSIX paths with no drive letter", async () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [track(1, "Users/x/a.flac")] });
    const r = await inspect(dir);
    expect(r.path_samples[0]).toMatchObject({
      path: "/Users/x/a.flac",
      kind: "posix",
      drive_letter: null,
      separator: "/",
    });
  });

  it("never returns more than 5 samples", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: Array.from({ length: 12 }, (_, i) => track(i + 1, `Users/x/${i}.flac`)),
    });
    const r = await inspect(dir);
    expect(MAX_PATH_SAMPLES).toBe(5);
    expect(r.row_counts.asset).toBe(12);
    expect(r.path_samples.length).toBeLessThanOrEqual(5);
  });

  it("classifies path styles", () => {
    expect(describePath("C:/a/b", "a/b")).toMatchObject({ kind: "windows_drive", separator: "/" });
    expect(describePath("\\\\nas\\m\\a", "a")).toMatchObject({
      kind: "windows_unc",
      drive_letter: null,
      separator: "\\",
    });
    expect(describePath("streaming://x", "streaming://x").kind).toBe("streaming");
    expect(describePath("a.flac", "a.flac")).toMatchObject({ kind: "relative", separator: "none" });
  });

  it("returns library_not_found as an error value when there is no library", async () => {
    const r = await seratoInspect({}, ctx(tmp()));
    expect(isSeratoError(r)).toBe(true);
  });

  it("refuses arguments it does not take", async () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const r = await seratoInspect({ nope: 1 }, ctx(dir));
    expect(isSeratoError(r)).toBe(true);
  });
});
