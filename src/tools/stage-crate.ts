import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { acquireWriteLock } from "../apply/mutex.js";
import { existingCrateId, findAnchors, resolveSpaceAssets, rootGeneration } from "../apply/root.js";
import { isSqliteBusy } from "../apply/sqlite.js";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { isRootStoreUri, isStreamingPortableId } from "../paths.js";
import { type ReadCtx, type ReadHandle, readSession, schemaWarnings } from "../read/session.js";
import { sameCrateName, validateCrateName } from "../stage/name.js";
import { loadStage, type Stage, type StagedCrate, saveStage } from "../stage/store.js";

/** Bounded, like every other model-supplied list: an unbounded search string
 *  was measured stalling this synchronous server for 36 seconds. */
export const MAX_STAGE_TRACKS = 1000;

/** The number of crates one instance can hold staged at a time -- otherwise
 *  the detail preview_changes response is as unbounded as the stage is. */
export const MAX_STAGED_CRATES = 50;

export type WriteCtx = ReadCtx & { stateDir: string };

export const stageCrateInput = z.object({
  name: z.string().min(1).max(512),
  track_ids: z.array(z.number().int()).min(1).max(MAX_STAGE_TRACKS),
  generation: z.string().max(64).optional(),
});

export const stageCrateOutput = z.object({
  staged_id: z.string(),
  library_id: z.string(),
  name: z.string(),
  track_count: z.number(),
  tracks: z.array(z.object({ id: z.number(), title: z.string(), artist: z.string() })),
  root_generation: z.string(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const stageCrateDescription =
  "Stage a new crate in the Serato Library space from track ids returned by search_tracks, " +
  "get_tracks or get_crate_tracks. Nothing is written to the library: apply_changes does that, " +
  "and only while Serato is closed. The response lists every staged track by title and artist -- " +
  "check it. The whole call is refused if any id is unknown, a streaming track, or not part of " +
  "the library on this computer's disk. Nested crates are not supported: the crate is created at " +
  "the top level. Name: 1-128 characters, no / : or %%.";

type AssetRow = {
  id: number;
  location_id: number;
  portable_id: string;
  name: string | null;
  artist: string | null;
  third_party_type: number | null;
};

type Rejection = { track_id: number; reason: string };

/** A specific message for the one rejection reason that is not "this track"
 *  but "this whole schema" -- every other reason keeps the generic message
 *  below. */
const REJECTION_MESSAGES: Record<string, string> = {
  library_disk_unknown:
    "cannot tell which location is this library's own disk: no connection row names root.sqlite",
};

/**
 * Everything that needs the live root.sqlite: anchors, the space-membership
 * check (appending `not_in_serato_library_space` to `rejections`), the name
 * conflict id and `root_generation`.
 *
 * Owns its own try/catch/finally so the catch below covers exactly "reading
 * root.sqlite" and nothing past it (an earlier, wider catch around the
 * write-lock section too meant a bug in the stage logic came back
 * mislabelled as `root_unreadable`, found in review). Every refusal here is
 * a `return`, not a `throw`, so it already bypasses the
 * catch below on its own -- the catch exists only for what `new
 * DatabaseSync`, `.exec` and the queries against `root` can throw.
 */
function readRoot(
  rootPath: string,
  libraryId: string,
  ids: number[],
  byId: Map<number, AssetRow>,
  rejections: Rejection[],
  crateName: string,
):
  | SeratoError
  | {
      conflict: number | null;
      /** The stored spelling of the conflicting crate's name (the match is case-insensitive). */
      existingName: string | null;
      rootGen: string;
      memberPortableIds: Set<string>;
    } {
  let root: DatabaseSync | undefined;
  try {
    root = new DatabaseSync(rootPath, { readOnly: true });
    root.exec("PRAGMA busy_timeout = 3000");
    const anchors = findAnchors(root);
    if (isSeratoError(anchors)) return anchors;

    const rejected = new Set(rejections.map((r) => r.track_id));
    const candidates = ids.filter((id) => !rejected.has(id));
    const { missing: notInSpace } = resolveSpaceAssets(
      root,
      anchors.spaceId,
      candidates.map((id) => byId.get(id)?.portable_id ?? ""),
    );
    const notInSpaceSet = new Set(notInSpace);
    for (const id of candidates) {
      if (notInSpaceSet.has(byId.get(id)?.portable_id ?? "")) {
        rejections.push({ track_id: id, reason: "not_in_serato_library_space" });
      }
    }
    if (rejections.length > 0) {
      // A partially created crate is worse than a refusal.
      return err(
        "write_refused",
        REJECTION_MESSAGES[rejections[0].reason] ?? "some tracks cannot be written into a crate",
        {
          reason: rejections[0].reason,
          rejected_track_ids: rejections.map((r) => r.track_id),
          rejected: rejections,
        },
      );
    }

    const conflict = existingCrateId(root, anchors.rootContainerId, crateName);
    const rootGen = rootGeneration(root, rootPath, libraryId);
    // Only needed to tell an append how many of its tracks are already there.
    const memberPortableIds = new Set<string>();
    let existingName: string | null = null;
    if (conflict !== null) {
      existingName = (
        root.prepare("SELECT name FROM container WHERE id = ?").get(conflict) as { name: string }
      ).name;
      const rows = root
        .prepare(
          `SELECT a.portable_id FROM container_asset ca
             JOIN space_asset sa ON sa.id = ca.space_asset_id
             JOIN asset a ON a.id = sa.asset_id
            WHERE ca.container_id = ?`,
        )
        .all(conflict) as { portable_id: string }[];
      for (const r of rows) memberPortableIds.add(r.portable_id.toLowerCase());
    }
    return { conflict, existingName, rootGen, memberPortableIds };
  } catch (e) {
    // root.sqlite is live and Serato may hold it open. SQLITE_BUSY means
    // exactly that and is worth a retry; anything else -- a damaged file, an
    // I/O error -- is not, and reporting it as the generic snapshot_failed
    // would blame the wrong database.
    if (isSqliteBusy(e)) {
      return err("busy", "root.sqlite is being written, most likely by Serato", {
        retry_after_ms: 3000,
      });
    }
    return err(
      "write_refused",
      `root.sqlite could not be read: ${e instanceof Error ? e.message : String(e)}`,
      { reason: "root_unreadable", rejected_track_ids: [] },
    );
  } finally {
    root?.close();
  }
}

type ResolvedTracks = {
  ids: number[];
  byId: Map<number, AssetRow>;
  conflict: number | null;
  existingName: string | null;
  rootGen: string;
  memberPortableIds: Set<string>;
};

/**
 * The validation every staging tool shares: de-duplicate the ids, look them up
 * in the snapshot, refuse unknown / streaming / off-disk / out-of-space
 * tracks, and read root.sqlite for the crate named `crateName` (`conflict` is
 * its container id when it already exists). Pushes the generic warnings onto
 * `warnings`.
 */
export function resolveStageTracks(
  handle: ReadHandle,
  trackIds: number[],
  crateName: string,
  requestedGeneration: string | undefined,
  warnings: Warning[],
): ResolvedTracks | SeratoError {
  const ids = [...new Set(trackIds)];
  if (ids.length < trackIds.length) {
    warnings.push({
      code: "duplicates_removed",
      message: `${trackIds.length - ids.length} repeated track ids were staged once`,
      details: { removed: trackIds.length - ids.length },
    });
  }

  const rows = handle.db
    .prepare(
      `SELECT id, location_id, portable_id, name, artist, third_party_type
         FROM asset WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...(ids as never[])) as AssetRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return err("unknown_ids", `no track with id ${missing.join(", ")}`, { missing_ids: missing });
  }

  // The boot disk's store is the connection whose database_uri names
  // root.sqlite; a location.sqlite is another volume, with its own store
  // this protocol does not write. Matched in isRootStoreUri rather than in
  // SQL so that the one definition also covers a uri written with
  // backslashes, which a LIKE '%/root.sqlite' would never match.
  const bootLocations = new Set(
    handle.schema.tables.has("connection")
      ? (
          handle.db.prepare("SELECT location_id, database_uri FROM connection").all() as {
            location_id: number;
            database_uri: string;
          }[]
        )
          .filter((r) => isRootStoreUri(r.database_uri))
          .map((r) => r.location_id)
      : [],
  );

  // An empty set here means no connection row names root.sqlite at all --
  // an unfamiliar schema, not "every track happens to live on another
  // disk". Naming that precisely stops the model from concluding "move the
  // file" when the real problem is elsewhere.
  const diskUnknown = bootLocations.size === 0;

  const rejections: Rejection[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    if (isStreamingPortableId(row.portable_id) || (row.third_party_type ?? 0) !== 0) {
      rejections.push({ track_id: id, reason: "streaming" });
    } else if (!bootLocations.has(row.location_id)) {
      rejections.push({
        track_id: id,
        reason: diskUnknown ? "library_disk_unknown" : "not_on_library_disk",
      });
    }
  }

  const rootPath = join(handle.libraryPath, "root.sqlite");
  const rootRead = readRoot(rootPath, handle.libraryId, ids, byId, rejections, crateName);
  if (isSeratoError(rootRead)) return rootRead;

  // Resolve against the current snapshot and say the library moved, rather
  // than refusing a model that searched a moment ago.
  if (requestedGeneration !== undefined && requestedGeneration !== handle.snapshot.generation) {
    warnings.push({
      code: "snapshot_advanced",
      message: "the library changed since that search; check the staged titles below",
      details: {
        requested_generation: requestedGeneration,
        generation: handle.snapshot.generation,
      },
    });
  }
  return { ids, byId, ...rootRead };
}

export function stagedTracksOf(r: ResolvedTracks): StagedCrate["tracks"] {
  return r.ids.map((id) => {
    const row = r.byId.get(id) as AssetRow;
    return {
      track_id: id,
      portable_id: row.portable_id,
      title: row.name ?? "",
      artist: row.artist ?? "",
    };
  });
}

/**
 * From here to the save, the stage file is read, checked and written as one
 * step. Without the lock, two server instances staging at once can each read
 * the same stage, and the second save silently drops the first's crate. Every
 * read before this -- of the snapshot and of root.sqlite -- is already done,
 * so the lock is held only around the stage file itself.
 *
 * No catch wraps this section (an earlier, wider catch here turned a bug in
 * this logic into a misleading `root_unreadable`, found in review). A genuine
 * bug below propagates to readSession's own handler.
 */
export function appendToStage(
  ctx: WriteCtx,
  handle: ReadHandle,
  crate: StagedCrate,
  rootGen: string,
): SeratoError | null {
  const lock = acquireWriteLock(ctx.stateDir, handle.libraryId);
  if (isSeratoError(lock)) return lock;
  try {
    const existing = loadStage(ctx.stateDir, handle.libraryId);
    if (isSeratoError(existing)) return existing;
    const clash = existing?.crates.find((c) => sameCrateName(c.name, crate.name));
    if (clash !== undefined) {
      return err("invalid_crate_name", `a crate named "${clash.name}" is already staged`, {
        reason: "already_staged",
        staged_id: clash.staged_id,
      });
    }
    if ((existing?.crates.length ?? 0) >= MAX_STAGED_CRATES) {
      return err(
        "write_refused",
        `already ${MAX_STAGED_CRATES} crates are staged; apply or discard some before staging more`,
        { reason: "stage_full", rejected_track_ids: [], limit: MAX_STAGED_CRATES },
      );
    }
    // C1: a stage's generation/root_generation describe when the stage was
    // FIRST created, not the last crate appended to it -- otherwise
    // root_generation_changed at apply only ever compares against the
    // last crate staged, never the earlier ones. The response still reports
    // the caller's own current root_generation.
    const stage: Stage = {
      schema_version: 1,
      library_id: handle.libraryId,
      library_path: handle.libraryPath,
      generation: existing?.generation ?? handle.snapshot.generation,
      root_generation: existing?.root_generation ?? rootGen,
      crates: [...(existing?.crates ?? []), crate],
    };
    const saved = saveStage(ctx.stateDir, stage);
    return isSeratoError(saved) ? saved : null;
  } finally {
    lock.release();
  }
}

export async function stageCrate(
  raw: unknown,
  ctx: WriteCtx,
): Promise<
  | ({
      staged_id: string;
      library_id: string;
      name: string;
      track_count: number;
      tracks: { id: number; title: string; artist: string }[];
      root_generation: string;
    } & { generation?: string; warnings?: Warning[] })
  | SeratoError
> {
  const args = parseToolArgs(stageCrateInput, raw);
  if (isSeratoError(args)) return args;
  const named = validateCrateName(args.name);
  if (isSeratoError(named)) return named;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    const resolved = resolveStageTracks(
      handle,
      args.track_ids,
      named.name,
      args.generation,
      warnings,
    );
    if (isSeratoError(resolved)) return resolved;
    const { conflict, rootGen } = resolved;

    if (conflict !== null) {
      warnings.push({
        code: "crate_name_conflict_preview",
        message: `a crate named "${named.name}" already exists; apply_changes will refuse unless it is renamed`,
        details: { existing_container_id: conflict },
      });
    }

    const crate: StagedCrate = {
      staged_id: randomUUID().slice(0, 8),
      name: named.name,
      tracks: stagedTracksOf(resolved),
      staged_at: new Date().toISOString(),
    };
    const failed = appendToStage(ctx, handle, crate, rootGen);
    if (failed !== null) return failed;

    return ok(
      {
        staged_id: crate.staged_id,
        library_id: handle.libraryId,
        name: crate.name,
        track_count: crate.tracks.length,
        tracks: crate.tracks.map((t) => ({ id: t.track_id, title: t.title, artist: t.artist })),
        root_generation: rootGen,
      },
      handle.snapshot.generation,
      warnings,
    );
  });
}
