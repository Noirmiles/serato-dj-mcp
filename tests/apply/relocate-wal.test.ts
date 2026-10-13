import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { StoreRepair } from "../../src/apply/location.js";
import { applyRelocate, type RelocateInput } from "../../src/apply/relocate.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { makeLocationFixture, makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-relocate-wal-"));
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

// Every production master.sqlite is WAL journal mode, but every other test
// fixture is rollback-journal, so without this file the engine's
// reopen-verify (verifyRelocate, on a fresh read-only connection) is never
// exercised against a WAL master -- the exact case writeMaster's post-COMMIT
// `PRAGMA wal_checkpoint(TRUNCATE)` exists to handle: a read-only connection
// opened after COMMIT is not guaranteed to see rows that live only in the
// -wal file.
describe("applyRelocate against a WAL-mode master", () => {
  it("repairs and verifies clean -- no spurious write_failed_committed_unverified", () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
      journalMode: "WAL",
    });
    expect(read<{ journal_mode: string }>(masterPath, "PRAGMA journal_mode")[0].journal_mode).toBe(
      "wal",
    );

    const storePath = makeLocationFixture(dir, {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });
    const repair: StoreRepair = {
      oldPortableId: "Pop/x.mp3",
      newPortableId: "Keron Crates/Pop/x.mp3",
      fileSize: 5000,
    };
    const engineInput: RelocateInput = {
      masterPath,
      byLocation: new Map([[LOCATION_ID, { storePath, repairs: [repair] }]]),
      probe: nobodyRunning,
    };

    const r = applyRelocate(engineInput);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.repaired).toBe(1);
    expect(r.duplicate).toEqual([]);

    // Master is still WAL (the checkpoint folds the WAL back into the main
    // file; it does not switch the journal mode), and reads back relocated
    // on a brand-new connection -- the same thing verifyRelocate itself just
    // checked, confirmed independently here.
    expect(read<{ journal_mode: string }>(masterPath, "PRAGMA journal_mode")[0].journal_mode).toBe(
      "wal",
    );
    expect(masterAsset(masterPath, "Keron Crates/Pop/x.mp3")).toEqual([
      { portable_id: "Keron Crates/Pop/x.mp3", is_missing: 0, file_size: 5000 },
    ]);
  });
});
