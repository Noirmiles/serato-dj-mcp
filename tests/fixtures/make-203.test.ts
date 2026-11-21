import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { makeLibraryFixture } from "./make.js";

const tracks = [
  { externalId: 1, portableId: "Users/x/a.flac", name: "Track A", bpm: 124, keyValue: 21 },
];
const cols = (db: DatabaseSync, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    dflt_value: string | null;
  }[];

describe("Serato DJ Pro 5 (203) fixtures", () => {
  const { masterPath, rootPath } = makeLibraryFixture(
    mkdtempSync(join(tmpdir(), "serato-fx203-")),
    { userVersion: 203, tracks, crates: [{ id: 100, name: "C", trackExternalIds: [1] }] },
  );

  it("builds master at user_version 203 with the new asset columns", () => {
    const db = new DatabaseSync(masterPath, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 203 });
    const names = cols(db, "asset").map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["import_id", "explicit", "pending_tempo_map_analysis"]),
    );
    expect(cols(db, "asset").find((c) => c.name === "explicit")?.dflt_value).toBe("0");
    expect(db.prepare("SELECT COUNT(*) n FROM asset").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM container_asset").get()).toEqual({ n: 1 });
    db.close();
  });

  it("builds root at user_version 203 with space_asset.revision defaulting to max int64", () => {
    const db = new DatabaseSync(rootPath, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 203 });
    expect(cols(db, "space_asset").find((c) => c.name === "revision")?.dflt_value).toBe(
      "9223372036854775807",
    );
    expect(cols(db, "asset").map((c) => c.name)).toContain("import_id");
    expect(db.prepare("SELECT COUNT(*) n FROM asset").get()).toEqual({ n: 1 });
    db.close();
  });

  it("keeps 202 the default", () => {
    const { masterPath: m } = makeLibraryFixture(mkdtempSync(join(tmpdir(), "serato-fx202-")));
    const db = new DatabaseSync(m, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 202 });
    expect(cols(db, "asset").map((c) => c.name)).not.toContain("import_id");
    db.close();
  });
});
