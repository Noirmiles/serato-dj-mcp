import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { applyRelocate } from "../../src/tools/apply-relocate.js";
import { makeLibraryFixture, makeLocationFixture, makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-apply-relocate-"));
const nobody: ProcessProbe = { isAlive: () => false, nameOf: () => null };

// Every seeded row sits on this location (the boot-disk id makeMasterFixture
// seeds); the asserts below read it back by that id.
const LOCATION_ID = 2;

/**
 * A library with two missing assets whose files really are on disk: one
 * still at its recorded path (a revalidate) and one moved under a new parent
 * folder (a moved repair, found with moved_under: "Keron Crates"). The store
 * is a real location.sqlite at the exact path master's connection row names,
 * so the engine has something to open and write.
 */
function twoAssetLibrary() {
  const dir = tmp();
  const volume = tmp();
  const storeDir = join(volume, "_Serato_", "Library");
  mkdirSync(storeDir, { recursive: true });

  // backupLibrary always backs up root.sqlite alongside master.sqlite, even
  // though apply_relocate never writes to it -- so the fixture needs both.
  const { masterPath } = makeLibraryFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 },
      { externalId: 2, portableId: "Rock/y.mp3", name: "Y", isMissing: 1, fileSize: 0 },
    ],
    connectionUri: `${volume}/_Serato_/Library/location.sqlite`,
  });
  const storePath = makeLocationFixture(storeDir, {
    assets: [
      { portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 },
      { portableId: "Rock/y.mp3", isMissing: 1, fileSize: 0 },
    ],
  });

  mkdirSync(join(volume, "Pop"), { recursive: true });
  writeFileSync(join(volume, "Pop", "x.mp3"), "aaaaa");
  mkdirSync(join(volume, "Keron Crates", "Rock"), { recursive: true });
  writeFileSync(join(volume, "Keron Crates", "Rock", "y.mp3"), "bbbbbb");

  const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp(), probe: nobody };
  return { dir, volume, masterPath, storePath, ctx };
}

function masterRow(masterPath: string, portableId: string) {
  const db = new DatabaseSync(masterPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT portable_id, is_missing FROM asset WHERE location_id = ? AND portable_id = ?",
      )
      .get(LOCATION_ID, portableId) as { portable_id: string; is_missing: number } | undefined;
  } finally {
    db.close();
  }
}

function storeRow(storePath: string, portableId: string) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db
      .prepare("SELECT portable_id, is_missing FROM asset WHERE portable_id = ?")
      .get(portableId) as { portable_id: string; is_missing: number } | undefined;
  } finally {
    db.close();
  }
}

describe("apply_relocate", () => {
  it("repairs a revalidated file and a moved file in both master and the store, and backs up the store", async () => {
    const { masterPath, storePath, ctx } = twoAssetLibrary();
    const r = await applyRelocate({ confirm: true, moved_under: "Keron Crates" }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);

    expect(r.revalidated).toBe(1);
    expect(r.repaired).toBe(1);
    expect(r.skipped).toEqual({ ambiguous: 0, not_found: 0, duplicate: 0, volume_unavailable: 0 });
    expect(r.restart_required).toBe(true);

    expect(r.backup_paths).not.toBeNull();
    const backups = r.backup_paths;
    if (backups !== null) {
      expect(existsSync(backups.root)).toBe(true);
      expect(existsSync(backups.master)).toBe(true);
      expect(backups.stores).toHaveLength(1);
      expect(existsSync(backups.stores[0])).toBe(true);
    }

    expect(masterRow(masterPath, "Pop/x.mp3")).toEqual({ portable_id: "Pop/x.mp3", is_missing: 0 });
    expect(masterRow(masterPath, "Keron Crates/Rock/y.mp3")).toEqual({
      portable_id: "Keron Crates/Rock/y.mp3",
      is_missing: 0,
    });
    expect(storeRow(storePath, "Pop/x.mp3")).toEqual({ portable_id: "Pop/x.mp3", is_missing: 0 });
    expect(storeRow(storePath, "Keron Crates/Rock/y.mp3")).toEqual({
      portable_id: "Keron Crates/Rock/y.mp3",
      is_missing: 0,
    });
  });

  it("refuses without confirm: true, writing nothing", async () => {
    const { masterPath, ctx } = twoAssetLibrary();
    const before = readFileSync(masterPath);

    const r = await applyRelocate({ confirm: false, moved_under: "Keron Crates" }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("invalid_argument");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("confirm_required");
    expect(readFileSync(masterPath).equals(before)).toBe(true);
  });

  // Refused before the backup, so a running Serato costs nothing -- the same
  // property apply_changes' equivalent test proves.
  it('refuses while Serato is "running", before taking any backup', async () => {
    const { masterPath, ctx } = twoAssetLibrary();
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
    const running: ProcessProbe = { isAlive: (pid) => pid === 500, nameOf: () => "Serato DJ Lite" };

    const r = await applyRelocate(
      { confirm: true, moved_under: "Keron Crates" },
      { ...ctx, probe: running },
    );
    expect(isSeratoError(r) && r.error.code).toBe("serato_running");
    expect(masterRow(masterPath, "Pop/x.mp3")).toEqual({ portable_id: "Pop/x.mp3", is_missing: 1 });
    expect(masterRow(masterPath, "Rock/y.mp3")).toEqual({
      portable_id: "Rock/y.mp3",
      is_missing: 1,
    });
    expect(existsSync(join(ctx.stateDir, "backups"))).toBe(false);
  });

  it("refuses a stale generation rather than apply a plan computed against an older library state", async () => {
    const { masterPath, ctx } = twoAssetLibrary();

    const r = await applyRelocate(
      { confirm: true, moved_under: "Keron Crates", generation: "not-the-real-one" },
      ctx,
    );
    expect(isSeratoError(r) && r.error.code).toBe("generation_mismatch");
    expect(masterRow(masterPath, "Pop/x.mp3")).toEqual({ portable_id: "Pop/x.mp3", is_missing: 1 });
    expect(masterRow(masterPath, "Rock/y.mp3")).toEqual({
      portable_id: "Rock/y.mp3",
      is_missing: 1,
    });
    expect(existsSync(join(ctx.stateDir, "backups"))).toBe(false);
  });

  // The matcher's own volume_unavailable bucket, the same scenario
  // preview_relocate's own test for it uses: a location this master.sqlite
  // has no connection row for at all.
  it("reports a volume_unavailable asset in skipped and writes nothing", async () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 0 }],
    });
    const db = new DatabaseSync(masterPath);
    // "1111...1111" is one of repo-hygiene.test.ts's two allowed synthetic
    // ids -- location 2 already carries "2222...2222" (see make.ts), so this
    // stays distinct without introducing a third, disallowed, id.
    db.prepare("INSERT INTO location (id, path, uuid, revision) VALUES (99, NULL, ?, 1)").run(
      Buffer.from("11111111111111111111111111111111", "hex"),
    );
    db.prepare(
      `INSERT INTO asset (location_id, external_id, portable_id, file_name, name, is_missing,
                          name_norm, artist_norm, album_norm, genre_norm, comments_norm)
       VALUES (99, 2, 'Pop/orphan.mp3', 'orphan.mp3', 'Orphan', 1, 'orphan', '', '', '', '')`,
    ).run();
    db.close();
    const before = readFileSync(masterPath);

    const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp(), probe: nobody };
    const r = await applyRelocate({ confirm: true }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);

    expect(r.skipped).toEqual({ ambiguous: 0, not_found: 0, duplicate: 0, volume_unavailable: 1 });
    expect(r.repaired).toBe(0);
    expect(r.revalidated).toBe(0);
    expect(r.backup_paths).toBeNull();
    expect(r.restart_required).toBe(false);
    expect(readFileSync(masterPath).equals(before)).toBe(true);
    expect(existsSync(join(ctx.stateDir, "backups"))).toBe(false);
  });
});
