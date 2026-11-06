import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { readSession, schemaWarnings } from "../read/session.js";
import type { StagedCrate } from "../stage/store.js";
import {
  appendToStage,
  MAX_STAGE_TRACKS,
  resolveStageTracks,
  stagedTracksOf,
  type WriteCtx,
} from "./stage-crate.js";

export const stageAddToCrateInput = z.object({
  crate: z.string().min(1).max(512),
  track_ids: z.array(z.number().int()).min(1).max(MAX_STAGE_TRACKS),
  generation: z.string().max(64).optional(),
});

export const stageAddToCrateOutput = z.object({
  staged_id: z.string(),
  library_id: z.string(),
  name: z.string(),
  track_count: z.number(),
  already_in_crate: z.number(),
  tracks: z.array(z.object({ id: z.number(), title: z.string(), artist: z.string() })),
  root_generation: z.string(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const stageAddToCrateDescription =
  "Stage appending tracks to an EXISTING top-level crate of the Serato Library, by crate name " +
  "(see list_crates) and track ids from search_tracks, get_tracks or get_crate_tracks. Nothing " +
  "is written to the library: preview_changes shows it and apply_changes writes it, only while " +
  "Serato is closed. Tracks are added at the end of the crate in the order given; tracks the " +
  "crate already holds are skipped, and already_in_crate says how many. Refused if the crate does " +
  "not exist, or if any id is unknown, a streaming track, or not part of the library on this " +
  "computer's disk. Only one change per crate can be staged at a time.";

export async function stageAddToCrate(
  raw: unknown,
  ctx: WriteCtx,
): Promise<
  | ({
      staged_id: string;
      library_id: string;
      name: string;
      track_count: number;
      already_in_crate: number;
      tracks: { id: number; title: string; artist: string }[];
      root_generation: string;
    } & { generation?: string; warnings?: Warning[] })
  | SeratoError
> {
  const args = parseToolArgs(stageAddToCrateInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    const resolved = resolveStageTracks(
      handle,
      args.track_ids,
      args.crate,
      args.generation,
      warnings,
    );
    if (isSeratoError(resolved)) return resolved;
    const { conflict, existingName, rootGen, memberPortableIds } = resolved;
    if (conflict === null || existingName === null) {
      return err("write_refused", `no crate named "${args.crate}" in the Serato Library`, {
        reason: "crate_not_found",
        rejected_track_ids: [],
        crate_name: args.crate,
      });
    }

    const tracks = stagedTracksOf(resolved);
    const already = tracks.filter((t) => memberPortableIds.has(t.portable_id.toLowerCase())).length;
    if (already > 0) {
      warnings.push({
        code: "already_in_crate",
        message: `${already} of these tracks are already in "${existingName}" and will be skipped by apply_changes`,
        details: { already_in_crate: already },
      });
    }

    const crate: StagedCrate = {
      staged_id: randomUUID().slice(0, 8),
      name: existingName,
      tracks,
      staged_at: new Date().toISOString(),
      mode: "append",
    };
    const failed = appendToStage(ctx, handle, crate, rootGen);
    if (failed !== null) return failed;

    return ok(
      {
        staged_id: crate.staged_id,
        library_id: handle.libraryId,
        name: crate.name,
        track_count: crate.tracks.length,
        already_in_crate: already,
        tracks: crate.tracks.map((t) => ({ id: t.track_id, title: t.title, artist: t.artist })),
        root_generation: rootGen,
      },
      handle.snapshot.generation,
      warnings,
    );
  });
}
