import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { previewRelocate } from "../../src/tools/preview-relocate.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-relocate-"));

describe("preview_relocate", () => {
  // The headline case: a missing asset whose file really is on disk, just
  // under a parent folder that moved. Nothing is written -- the master
  // snapshot byte-for-byte unchanged is the proof.
  it("finds a repair for a file that moved under a new parent, and writes nothing", async () => {
    const dir = tmp();
    const volume = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 1 },
        { externalId: 2, portableId: "Rock/y.mp3", name: "Y", isMissing: 0 },
      ],
      connectionUri: `${volume}/_Serato_/Library/location.sqlite`,
    });
    const before = readFileSync(masterPath);

    mkdirSync(join(volume, "Keron Crates", "Pop"), { recursive: true });
    writeFileSync(join(volume, "Keron Crates", "Pop", "x.mp3"), "audio-bytes");

    const ctx = { library: dir, roots: [], cacheDir: tmp() };
    const r = await previewRelocate({ moved_under: "Keron Crates" }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);

    expect(r.repairs.count).toBe(1);
    expect(r.repairs.samples).toEqual([
      expect.objectContaining({
        old_portable_id: "Pop/x.mp3",
        new_portable_id: "Keron Crates/Pop/x.mp3",
        kind: "moved",
        file_size: "audio-bytes".length,
      }),
    ]);
    expect(r.not_found.count).toBe(0);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);

    expect(readFileSync(masterPath)).toEqual(before);
  });

  it("buckets an unmatched missing asset as not_found, and ignores a non-missing one", async () => {
    const dir = tmp();
    const volume = tmp();
    makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/gone.mp3", name: "Gone", isMissing: 1 }],
      connectionUri: `${volume}/_Serato_/Library/location.sqlite`,
    });
    const ctx = { library: dir, roots: [], cacheDir: tmp() };

    const r = await previewRelocate({}, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.not_found).toEqual({
      count: 1,
      samples: [{ location_id: 2, portable_id: "Pop/gone.mp3" }],
    });
    expect(r.repairs).toEqual({ count: 0, samples: [] });
    expect(r.ambiguous).toEqual({ count: 0, samples: [] });
    expect(r.volume_unavailable).toEqual({ count: 0, samples: [] });
  });

  // A streaming row's portable_id is not a filesystem path, so it must never
  // reach the matcher -- the same rule audit.ts's brokenPaths follows.
  it("never treats a streaming track as a missing filesystem asset", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [
        {
          externalId: 1,
          portableId: "streaming://beatport/9",
          name: "Streamed",
          isMissing: 1,
          thirdPartyType: 2,
        },
      ],
    });
    const r = await previewRelocate({}, { library: dir, roots: [], cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.not_found.count).toBe(0);
    expect(r.volume_unavailable.count).toBe(0);
  });

  // The matcher's own volume_unavailable bucket, wired through: a location
  // this master.sqlite has no connection row for at all.
  it("buckets a missing asset under an unconnected location as volume_unavailable", async () => {
    const dir = tmp();
    const masterPath = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/x.mp3", name: "X", isMissing: 0 }],
    });
    const db = new DatabaseSync(masterPath);
    db.prepare("INSERT INTO location (id, path, uuid, revision) VALUES (99, NULL, ?, 1)").run(
      Buffer.from("33333333333333333333333333333333", "hex"),
    );
    db.prepare(
      `INSERT INTO asset (location_id, external_id, portable_id, file_name, name, is_missing,
                          name_norm, artist_norm, album_norm, genre_norm, comments_norm)
       VALUES (99, 2, 'Pop/orphan.mp3', 'orphan.mp3', 'Orphan', 1, 'orphan', '', '', '', '')`,
    ).run();
    db.close();

    const r = await previewRelocate({}, { library: dir, roots: [], cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.volume_unavailable).toEqual({
      count: 1,
      samples: [{ location_id: 99, portable_id: "Pop/orphan.mp3" }],
    });
  });

  // Found by filename search under search_folder when revalidate and
  // moved_under both miss.
  it("finds a repair by filename search under search_folder", async () => {
    const dir = tmp();
    const volume = tmp();
    makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Pop/song.mp3", name: "Song", isMissing: 1 }],
      connectionUri: `${volume}/_Serato_/Library/location.sqlite`,
    });
    const searchRoot = tmp();
    mkdirSync(join(searchRoot, "Archive"), { recursive: true });
    writeFileSync(join(searchRoot, "Archive", "song.mp3"), "bytes");

    const r = await previewRelocate(
      { search_folder: searchRoot },
      { library: dir, roots: [], cacheDir: tmp() },
    );
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.repairs.count).toBe(1);
    expect(r.repairs.samples[0]).toMatchObject({ kind: "search" });
  });

  // Each bucket is capped so the plan stays readable; count stays the true
  // total.
  it("caps samples per bucket at 50 while the count stays exact", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: Array.from({ length: 60 }, (_, i) => ({
        externalId: i + 1,
        portableId: `Pop/${i}.mp3`,
        name: `T${i}`,
        isMissing: 1,
      })),
    });
    const r = await previewRelocate({}, { library: dir, roots: [], cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.not_found.count).toBe(60);
    expect(r.not_found.samples).toHaveLength(50);
  });
});
