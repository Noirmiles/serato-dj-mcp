import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readManifest } from "../../src/apply/manifest.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { loadStage, type Stage, saveStage } from "../../src/stage/store.js";
import { applyChanges } from "../../src/tools/apply-changes.js";
import { previewChanges } from "../../src/tools/preview-changes.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { stageAddToCrate } from "../../src/tools/stage-add-to-crate.js";
import { stageCrate } from "../../src/tools/stage-crate.js";
import { makeLibraryFixture, ROOT_SPACE_ID } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-add-"));
const nobody: ProcessProbe = { isAlive: () => false, nameOf: () => null };
const running: ProcessProbe = { isAlive: (pid) => pid === 500, nameOf: () => "Serato DJ Lite" };

async function setup() {
  const dir = tmp();
  const { masterPath, rootPath } = makeLibraryFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "Rain" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Storm" },
      { externalId: 3, portableId: "Users/x/3.flac", name: "Fog" },
      { externalId: 4, portableId: "Users/x/4.flac", name: "Sun", thirdPartyType: 2 },
    ],
    crates: [{ id: 10, name: "Warm Up", trackExternalIds: [1] }],
  });
  const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp(), probe: nobody };
  const found = await searchTracks({ fields: ["title"], limit: 50 }, ctx);
  if (isSeratoError(found)) throw new Error("unexpected error");
  const id = new Map(found.tracks.map((t) => [t.title as string, t.id as number]));
  const members = () => {
    const db = new DatabaseSync(rootPath, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT a.name AS name, ca.list_order AS list_order, ca.revision AS revision
             FROM container c JOIN container_asset ca ON ca.container_id = c.id
             JOIN space_asset sa ON sa.id = ca.space_asset_id JOIN asset a ON a.id = sa.asset_id
            WHERE c.name = 'Warm Up' ORDER BY ca.list_order`,
        )
        .all() as { name: string; list_order: number; revision: number }[];
    } finally {
      db.close();
    }
  };
  const revisions = () => {
    const db = new DatabaseSync(rootPath, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT (SELECT revision FROM serato) AS serato, (SELECT revision FROM space WHERE id = ?) AS space",
        )
        .get(ROOT_SPACE_ID) as { serato: number; space: number };
    } finally {
      db.close();
    }
  };
  return { dir, ctx, masterPath, rootPath, id, members, revisions };
}

describe("stage_add_to_crate", () => {
  it("stages, previews and applies an append: order kept, revision bumped, backup taken", async () => {
    const { ctx, id, members, revisions } = await setup();
    const before = revisions();
    const staged = await stageAddToCrate(
      { crate: "warm up", track_ids: [id.get("Fog"), id.get("Storm")] },
      ctx,
    );
    if (isSeratoError(staged)) throw new Error(staged.error.message);
    // The stored spelling, not the one typed.
    expect(staged.name).toBe("Warm Up");
    expect(staged.already_in_crate).toBe(0);
    expect(staged.tracks.map((t) => t.title)).toEqual(["Fog", "Storm"]);
    // Staging writes nothing.
    expect(revisions()).toEqual(before);
    expect(members()).toHaveLength(1);

    const preview = await previewChanges({ format: "detail" }, ctx);
    if (isSeratoError(preview)) throw new Error(preview.error.message);
    expect(preview.pending[0]).toMatchObject({ name: "Warm Up", mode: "append", track_count: 2 });

    const applied = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(applied)) throw new Error(applied.error.message);
    expect(applied.applied[0]).toMatchObject({
      name: "Warm Up",
      mode: "append",
      added: 2,
      skipped_duplicates: 0,
      track_count: 3,
    });
    expect(applied.backup_paths).not.toBeNull();
    expect(members().map((m) => m.name)).toEqual(["Rain", "Fog", "Storm"]);
    expect(members().map((m) => m.list_order)).toEqual([1, 2, 3]);
    const after = revisions();
    expect(after.serato).toBe(before.serato + 1);
    expect(after.space).toBe(after.serato);
    // The new rows carry the bumped revision, the old one keeps its own.
    expect(members().map((m) => m.revision)).toEqual([before.serato, after.serato, after.serato]);
    expect(loadStage(ctx.stateDir, staged.library_id)).toBeNull();
    expect(readManifest(ctx.stateDir, staged.library_id)[0].crates[0]).toMatchObject({
      mode: "append",
    });
  });

  it("skips tracks the crate already holds and says so", async () => {
    const { ctx, id, members } = await setup();
    const staged = await stageAddToCrate(
      { crate: "Warm Up", track_ids: [id.get("Rain"), id.get("Fog")] },
      ctx,
    );
    if (isSeratoError(staged)) throw new Error(staged.error.message);
    expect(staged.already_in_crate).toBe(1);
    expect(staged.warnings?.map((w) => w.code)).toContain("already_in_crate");

    const applied = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(applied)) throw new Error(applied.error.message);
    expect(applied.applied[0]).toMatchObject({ added: 1, skipped_duplicates: 1, track_count: 2 });
    expect(members().map((m) => m.name)).toEqual(["Rain", "Fog"]);
  });

  it("an append of only duplicates writes no rows but still verifies", async () => {
    const { ctx, id, members } = await setup();
    await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Rain")] }, ctx);
    const applied = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(applied)) throw new Error(applied.error.message);
    expect(applied.applied[0]).toMatchObject({ added: 0, skipped_duplicates: 1, track_count: 1 });
    expect(members()).toHaveLength(1);
  });

  it("refuses an unknown crate, staging nothing", async () => {
    const { ctx, id } = await setup();
    const r = await stageAddToCrate({ crate: "Nope", track_ids: [id.get("Rain")] }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("write_refused");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("crate_not_found");
    const p = await previewChanges({}, ctx);
    if (isSeratoError(p)) throw new Error("unexpected");
    expect(p.pending).toEqual([]);
  });

  it("refuses an unknown track id and a streaming track", async () => {
    const { ctx, id } = await setup();
    const unknown = await stageAddToCrate({ crate: "Warm Up", track_ids: [999999] }, ctx);
    expect(isSeratoError(unknown) && unknown.error.code).toBe("unknown_ids");
    const streaming = await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Sun")] }, ctx);
    expect(isSeratoError(streaming) && streaming.error.code).toBe("write_refused");
  });

  it("refuses a second change to a crate that is already staged", async () => {
    const { ctx, id } = await setup();
    await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Fog")] }, ctx);
    const again = await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Storm")] }, ctx);
    expect(isSeratoError(again) && again.error.details?.reason).toBe("already_staged");
  });

  it("refuses to apply while Serato runs, writing nothing", async () => {
    const { ctx, id, masterPath, members, revisions } = await setup();
    await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Fog")] }, ctx);
    const before = revisions();
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
    const r = await applyChanges({ confirm: true }, { ...ctx, probe: running });
    expect(isSeratoError(r) && r.error.code).toBe("serato_running");
    expect(members()).toHaveLength(1);
    expect(revisions()).toEqual(before);
  });

  it("a crate deleted between staging and applying refuses the apply, keeping the stage", async () => {
    const { ctx, id, rootPath, members } = await setup();
    const staged = await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Fog")] }, ctx);
    if (isSeratoError(staged)) throw new Error(staged.error.message);
    const db = new DatabaseSync(rootPath);
    db.exec("DELETE FROM container_asset; DELETE FROM container WHERE name = 'Warm Up'");
    db.close();
    const r = await applyChanges({ confirm: true }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("write_refused");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("crate_not_found");
    expect(members()).toHaveLength(0);
    expect((loadStage(ctx.stateDir, staged.library_id) as Stage).crates).toHaveLength(1);
  });

  it("applies a new crate and an append in one batch", async () => {
    const { ctx, id, members } = await setup();
    await stageCrate({ name: "Peak", track_ids: [id.get("Storm")] }, ctx);
    await stageAddToCrate({ crate: "Warm Up", track_ids: [id.get("Fog")] }, ctx);
    const r = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r.applied.map((a) => [a.name, a.mode])).toEqual([
      ["Peak", undefined],
      ["Warm Up", "append"],
    ]);
    expect(members().map((m) => m.name)).toEqual(["Rain", "Fog"]);
  });

  // Old stage files carry no `mode`; they must keep loading as new crates.
  it("loads a stage without a mode field unchanged", async () => {
    const { ctx } = await setup();
    const stage: Stage = {
      schema_version: 1,
      library_id: "lib",
      library_path: "/x",
      generation: "g",
      root_generation: "r",
      crates: [
        {
          staged_id: "a",
          name: "Old",
          tracks: [{ track_id: 1, portable_id: "p", title: "t", artist: "a" }],
          staged_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    saveStage(ctx.stateDir, stage);
    expect(loadStage(ctx.stateDir, "lib")).toEqual(stage);
  });
});
