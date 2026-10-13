import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyStoreRepairs, type StoreRepair, storePathFromUri } from "../../src/apply/location.js";
import { isSeratoError } from "../../src/errors.js";
import { makeLocationFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-location-"));

function read<T>(path: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("applyStoreRepairs", () => {
  it("relocates a missing asset's portable_id and clears is_missing", () => {
    const path = makeLocationFixture(tmp(), {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });
    const repair: StoreRepair = {
      oldPortableId: "Pop/x.mp3",
      newPortableId: "Keron Crates/Pop/x.mp3",
      fileSize: 5000,
    };

    const r = applyStoreRepairs(path, [repair]);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.updated).toBe(1);
    expect(r.skippedDuplicate).toEqual([]);

    const rows = read<{ portable_id: string; is_missing: number; file_size: number }>(
      path,
      "SELECT portable_id, is_missing, file_size FROM asset WHERE portable_id = ?",
      "Keron Crates/Pop/x.mp3",
    );
    expect(rows).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);
    expect(read(path, "PRAGMA foreign_key_check")).toEqual([]);
  });

  // A relocation that lands on a portable_id already in the store must not
  // take down the rest of the batch: the collision is reported back so the
  // caller can decide, and every other repair in the batch still commits.
  it("skips a repair whose new portable_id already exists, without failing the batch", () => {
    const path = makeLocationFixture(tmp(), {
      assets: [
        { portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 },
        { portableId: "Pop/y.mp3", isMissing: 1, fileSize: 0 },
        { portableId: "Keron Crates/Pop/y.mp3", isMissing: 0, fileSize: 1234 },
      ],
    });
    const repairs: StoreRepair[] = [
      { oldPortableId: "Pop/x.mp3", newPortableId: "Keron Crates/Pop/x.mp3", fileSize: 5000 },
      { oldPortableId: "Pop/y.mp3", newPortableId: "Keron Crates/Pop/y.mp3", fileSize: 6000 },
    ];

    const r = applyStoreRepairs(path, repairs);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.updated).toBe(1);
    expect(r.skippedDuplicate).toEqual([repairs[1]]);

    const rows = read<{ portable_id: string; is_missing: number; file_size: number }>(
      path,
      "SELECT portable_id, is_missing, file_size FROM asset WHERE portable_id = ?",
      "Keron Crates/Pop/x.mp3",
    );
    expect(rows).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);

    // The row the collision was skipped for is untouched.
    const untouched = read<{ is_missing: number }>(
      path,
      "SELECT is_missing FROM asset WHERE portable_id = ?",
      "Pop/y.mp3",
    );
    expect(untouched).toEqual([{ is_missing: 1 }]);
    expect(read(path, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("reports busy when another writer holds the store", () => {
    const path = makeLocationFixture(tmp(), {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const r = applyStoreRepairs(path, [
        { oldPortableId: "Pop/x.mp3", newPortableId: "Keron Crates/Pop/x.mp3", fileSize: 5000 },
      ]);
      expect(isSeratoError(r) && r.error.code).toBe("busy");
      if (isSeratoError(r)) expect(r.error.details?.retry_after_ms).toBe(3000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});

describe("storePathFromUri", () => {
  it("normalizes a Windows drive uri's forward slashes to backslashes", () => {
    expect(storePathFromUri("D:/_Serato_/Library/location.sqlite")).toBe(
      "D:\\_Serato_\\Library\\location.sqlite",
    );
  });

  it("leaves an already-backslashed Windows uri as-is", () => {
    expect(storePathFromUri("D:\\_Serato_\\Library\\location.sqlite")).toBe(
      "D:\\_Serato_\\Library\\location.sqlite",
    );
  });

  it("normalizes a Windows UNC uri's forward slashes to backslashes", () => {
    expect(storePathFromUri("\\\\nas/music/_Serato_/Library/location.sqlite")).toBe(
      "\\\\nas\\music\\_Serato_\\Library\\location.sqlite",
    );
  });

  it("leaves a POSIX uri as-is", () => {
    expect(storePathFromUri("/Volumes/EXTDISK/_Serato_/Library/location.sqlite")).toBe(
      "/Volumes/EXTDISK/_Serato_/Library/location.sqlite",
    );
  });
});
