import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StoreRepair } from "../../src/apply/location.js";
import { applyRelocate, type RelocateInput } from "../../src/apply/relocate.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { makeLocationFixture, makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-relocate-"));
const nobodyRunning: ProcessProbe = { isAlive: () => false, nameOf: () => null };

// Every master fixture row this engine touches is on this location (the
// boot-disk id makeMasterFixture seeds); byLocation keys match it.
const LOCATION_ID = 2;

function read<T>(path: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const masterAsset = (path: string, portableId: string) =>
  read<{ portable_id: string; is_missing: number; file_size: number }>(
    path,
    "SELECT portable_id, is_missing, file_size FROM asset WHERE location_id = ? AND portable_id = ?",
    LOCATION_ID,
    portableId,
  );

const storeAsset = (path: string, portableId: string) =>
  read<{ portable_id: string; is_missing: number; file_size: number }>(
    path,
    "SELECT portable_id, is_missing, file_size FROM asset WHERE portable_id = ?",
    portableId,
  );

const input = (masterPath: string, storePath: string, repairs: StoreRepair[]): RelocateInput => ({
  masterPath,
  byLocation: new Map([[LOCATION_ID, { storePath, repairs }]]),
  probe: nobodyRunning,
});

describe("applyRelocate", () => {
  it("relocates a missing asset in both the volume store and master", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
    });
    const storePath = makeLocationFixture(dir, {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });
    const repair: StoreRepair = {
      oldPortableId: "Pop/x.mp3",
      newPortableId: "Keron Crates/Pop/x.mp3",
      fileSize: 5000,
    };

    const r = applyRelocate(input(masterPath, storePath, [repair]));
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.repaired).toBe(1);
    expect(r.duplicate).toEqual([]);

    // Both databases updated: new portable_id, is_missing cleared, size set.
    expect(masterAsset(masterPath, "Keron Crates/Pop/x.mp3")).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);
    expect(storeAsset(storePath, "Keron Crates/Pop/x.mp3")).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);
    expect(read(masterPath, "PRAGMA foreign_key_check")).toEqual([]);
    expect(read(storePath, "PRAGMA foreign_key_check")).toEqual([]);
  });

  // Write order is the whole safety argument: every store commits BEFORE
  // master. A store write that fails must leave master untouched -- so a crash
  // there leaves tracks still-missing (safe), never falsely-found.
  it("leaves master untouched when a store write fails (stores before master)", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
    });
    // A file that is not a database: applyStoreRepairs fails at BEGIN, before
    // a single master row could be written.
    const storePath = join(dir, "location.sqlite");
    writeFileSync(storePath, "not a database ".repeat(300));

    const r = applyRelocate(
      input(masterPath, storePath, [
        { oldPortableId: "Pop/x.mp3", newPortableId: "Keron Crates/Pop/x.mp3", fileSize: 5000 },
      ]),
    );
    expect(isSeratoError(r)).toBe(true);

    // Master is exactly as it was: the row is still missing.
    expect(masterAsset(masterPath, "Pop/x.mp3")).toEqual([
      { portable_id: "Pop/x.mp3", is_missing: 1, file_size: 0 },
    ]);
    expect(masterAsset(masterPath, "Keron Crates/Pop/x.mp3")).toEqual([]);
  });

  // No silent store creation: a disconnected volume's store path must be
  // refused, never materialized as a 0-byte database by node:sqlite.
  it("refuses a missing store without creating one, and without writing master", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
    });
    const storePath = join(dir, "disconnected", "location.sqlite");

    const r = applyRelocate(
      input(masterPath, storePath, [
        { oldPortableId: "Pop/x.mp3", newPortableId: "Keron Crates/Pop/x.mp3", fileSize: 5000 },
      ]),
    );
    expect(isSeratoError(r) && r.error.code).toBe("write_refused");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("store_missing");
    expect(existsSync(storePath)).toBe(false);
    // Master untouched.
    expect(masterAsset(masterPath, "Pop/x.mp3")).toEqual([
      { portable_id: "Pop/x.mp3", is_missing: 1, file_size: 0 },
    ]);
  });

  // A repoint whose new (location_id, portable_id) already exists is not a
  // batch failure: it is reported in outcome.duplicate and every other repair
  // still commits -- in both the store and master.
  it("records a duplicate repoint and still repairs the rest of the batch", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 },
        { externalId: 2, portableId: "Pop/y.mp3", name: "Y", isMissing: 1, fileSize: 0 },
        {
          externalId: 3,
          portableId: "Keron Crates/Pop/y.mp3",
          name: "YFound",
          isMissing: 0,
          fileSize: 1234,
        },
      ],
    });
    const storePath = makeLocationFixture(dir, {
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

    const r = applyRelocate(input(masterPath, storePath, repairs));
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.repaired).toBe(1);
    expect(r.duplicate).toEqual([
      { locationId: LOCATION_ID, portableId: "Keron Crates/Pop/y.mp3" },
    ]);

    // x relocated in both databases.
    expect(masterAsset(masterPath, "Keron Crates/Pop/x.mp3")).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);
    expect(storeAsset(storePath, "Keron Crates/Pop/x.mp3")).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);
    // y stayed missing (its repoint collided), and the pre-existing found row
    // was not clobbered.
    expect(masterAsset(masterPath, "Pop/y.mp3")).toEqual([
      { portable_id: "Pop/y.mp3", is_missing: 1, file_size: 0 },
    ]);
    expect(masterAsset(masterPath, "Keron Crates/Pop/y.mp3")).toEqual([
      { portable_id: "Keron Crates/Pop/y.mp3", is_missing: 0, file_size: 1234 },
    ]);
    expect(read(masterPath, "PRAGMA foreign_key_check")).toEqual([]);
    expect(read(storePath, "PRAGMA foreign_key_check")).toEqual([]);
  });

  // Serato is re-checked at the start of the engine (defense in depth; the
  // tool checks earlier). A live owner refuses before anything is written.
  it("refuses when Serato is running, writing neither store nor master", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
    });
    const storePath = makeLocationFixture(dir, {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
    const running: ProcessProbe = { isAlive: (pid) => pid === 500, nameOf: () => "Serato DJ Lite" };

    const r = applyRelocate({
      masterPath,
      byLocation: new Map([
        [
          LOCATION_ID,
          {
            storePath,
            repairs: [
              {
                oldPortableId: "Pop/x.mp3",
                newPortableId: "Keron Crates/Pop/x.mp3",
                fileSize: 5000,
              },
            ],
          },
        ],
      ]),
      probe: running,
    });
    expect(isSeratoError(r) && r.error.code).toBe("serato_running");
    expect(masterAsset(masterPath, "Pop/x.mp3")).toEqual([
      { portable_id: "Pop/x.mp3", is_missing: 1, file_size: 0 },
    ]);
    expect(storeAsset(storePath, "Pop/x.mp3")).toEqual([
      { portable_id: "Pop/x.mp3", is_missing: 1, file_size: 0 },
    ]);
  });

  // The pre-COMMIT checks never read the rows back, so a trigger that undoes
  // the repair after its own UPDATE still commits -- only the post-commit
  // verification, on a fresh read-only connection, catches it and hands back
  // the paths needed to find the backups.
  it("reports committed_unverified when master does not read back the repair", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
    });
    const storePath = makeLocationFixture(dir, {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });
    const seed = new DatabaseSync(masterPath);
    seed.exec(
      `CREATE TRIGGER undo_relocate AFTER UPDATE OF portable_id ON asset
       BEGIN UPDATE asset SET is_missing = 1 WHERE id = new.id; END`,
    );
    seed.close();

    const r = applyRelocate(
      input(masterPath, storePath, [
        { oldPortableId: "Pop/x.mp3", newPortableId: "Keron Crates/Pop/x.mp3", fileSize: 5000 },
      ]),
    );
    expect(isSeratoError(r) && r.error.code).toBe("write_failed_committed_unverified");
    if (isSeratoError(r)) {
      expect(r.error.details?.stage).toBe("verify_after_commit");
      const written = r.error.details?.written_paths as { master: string; stores: string[] };
      expect(written.master).toBe(masterPath);
      expect(written.stores).toEqual([storePath]);
    }
  });
});
