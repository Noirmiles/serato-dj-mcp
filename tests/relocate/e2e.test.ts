import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { applyRelocate } from "../../src/tools/apply-relocate.js";
import { previewRelocate } from "../../src/tools/preview-relocate.js";
import { makeLibraryFixture, makeLocationFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-relocate-e2e-"));
const nobody: ProcessProbe = { isAlive: () => false, nameOf: () => null };

// makeMasterFixture (via makeLibraryFixture) always seeds the boot-disk
// location at this id; every row below sits on it.
const LOCATION_ID = 2;

function openReadOnly(path: string) {
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * The full tool chain a model actually drives: preview_relocate to see the
 * plan and pick up its generation, then apply_relocate to write it -- across
 * a REAL on-disk library (master.sqlite + root.sqlite) and a REAL per-volume
 * store (location.sqlite), with a REAL audio file relocated under a moved
 * parent folder on disk. Reopening both databases read-only afterward is the
 * only way to prove the write actually landed where Serato itself would read
 * it from, rather than just trusting the tool's own return value.
 */
describe("relocate end-to-end", () => {
  it("previews a moved-parent repair, applies it, and leaves both databases consistent", async () => {
    const dir = tmp();
    const volume = tmp();
    const storeDir = join(volume, "_Serato_", "Library");
    mkdirSync(storeDir, { recursive: true });

    const { masterPath } = makeLibraryFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1, fileSize: 0 }],
      connectionUri: `${volume}/_Serato_/Library/location.sqlite`,
    });
    const storePath = makeLocationFixture(storeDir, {
      assets: [{ portableId: "Pop/x.mp3", isMissing: 1, fileSize: 0 }],
    });

    // The file really moved: it no longer exists at its recorded path, only
    // under a new parent folder.
    mkdirSync(join(volume, "Keron Crates", "Pop"), { recursive: true });
    const bytes = "real-audio-bytes";
    writeFileSync(join(volume, "Keron Crates", "Pop", "x.mp3"), bytes);

    const readCtx = { library: dir, roots: [], cacheDir: tmp() };
    const preview = await previewRelocate({ moved_under: "Keron Crates" }, readCtx);
    if (isSeratoError(preview)) throw new Error(`unexpected error: ${preview.error.message}`);

    expect(preview.repairs.count).toBe(1);
    expect(preview.repairs.samples[0]).toMatchObject({
      old_portable_id: "Pop/x.mp3",
      new_portable_id: "Keron Crates/Pop/x.mp3",
      kind: "moved",
      file_size: bytes.length,
    });
    expect(preview.generation).toMatch(/^[0-9a-f]{12}$/);

    const stateDir = tmp();
    const applyCtx = { ...readCtx, stateDir, probe: nobody };
    const applied = await applyRelocate(
      { confirm: true, moved_under: "Keron Crates", generation: preview.generation },
      applyCtx,
    );
    if (isSeratoError(applied)) throw new Error(`unexpected error: ${applied.error.message}`);

    expect(applied.repaired).toBe(1);
    expect(applied.revalidated).toBe(0);
    expect(applied.skipped).toEqual({
      ambiguous: 0,
      not_found: 0,
      duplicate: 0,
      volume_unavailable: 0,
    });
    expect(applied.restart_required).toBe(true);

    expect(applied.backup_paths).not.toBeNull();
    const backups = applied.backup_paths;
    if (backups === null) throw new Error("expected backup_paths");
    expect(existsSync(backups.root)).toBe(true);
    expect(existsSync(backups.master)).toBe(true);
    expect(backups.stores).toHaveLength(1);
    expect(existsSync(backups.stores[0])).toBe(true);

    // Reopened on fresh read-only connections, exactly as Serato itself would
    // open these files on the next launch -- not the write connections the
    // engine just used.
    const master = openReadOnly(masterPath);
    try {
      const row = master
        .prepare(
          "SELECT portable_id, is_missing, file_size FROM asset WHERE location_id = ? AND portable_id = ?",
        )
        .get(LOCATION_ID, "Keron Crates/Pop/x.mp3") as
        | { portable_id: string; is_missing: number; file_size: number }
        | undefined;
      expect(row).toEqual({
        portable_id: "Keron Crates/Pop/x.mp3",
        is_missing: 0,
        file_size: bytes.length,
      });
      expect(master.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      master.close();
    }

    const store = openReadOnly(storePath);
    try {
      const row = store
        .prepare("SELECT portable_id, is_missing, file_size FROM asset WHERE portable_id = ?")
        .get("Keron Crates/Pop/x.mp3") as
        | { portable_id: string; is_missing: number; file_size: number }
        | undefined;
      expect(row).toEqual({
        portable_id: "Keron Crates/Pop/x.mp3",
        is_missing: 0,
        file_size: bytes.length,
      });
      expect(store.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
