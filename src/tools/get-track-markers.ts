import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { readMarkersFromFile } from "../markers/read.js";
import { isStreamingPortableId, portableIdToAbsolute, redactPath } from "../paths.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";

export const getTrackMarkersInput = z.strictObject({
  id: z.number().int(),
});

export const getTrackMarkersDescription =
  "Read the cue points, saved loops and track colour that Serato stored in a track's own audio " +
  "file (the Serato Markers2 tag), for a track id from search_tracks or get_tracks. Supports " +
  "MP3 and AIFF (ID3v2) and FLAC; other formats, a missing file or a file without the tag come " +
  "back as a warning with empty lists, not as an error. Positions are milliseconds, colours " +
  "#rrggbb. Reads the file only: it is never written. Serato prefers its older Markers_ tag " +
  "when both exist, and this tool does not read that one. Paths are redacted to ~.";

const cueSchema = z.object({
  index: z.number(),
  position_ms: z.number(),
  color: z.string(),
  name: z.string(),
});
const loopSchema = z.object({
  index: z.number(),
  start_ms: z.number(),
  end_ms: z.number(),
  locked: z.boolean(),
  name: z.string(),
});

export const getTrackMarkersOutput = z.object({
  id: z.number(),
  path: z.string().nullable(),
  format: z.enum(["mp3", "aiff", "flac"]).nullable(),
  cues: z.array(cueSchema),
  loops: z.array(loopSchema),
  track_color: z.string().nullable(),
  bpm_locked: z.boolean().nullable(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export type GetTrackMarkersResult = Omit<z.infer<typeof getTrackMarkersOutput>, "warnings">;

/** Windows drive (`D:\x`, `D:/x`), UNC or POSIX absolute: not relative to a volume. */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/**
 * The file's absolute path, or null if there is no way to know it. A stored
 * portable_id is normally relative to the volume root; one that is already
 * absolute (including a Windows drive letter) is used as it stands.
 */
export function resolveAudioPath(portableId: string, root: string | undefined): string | null {
  if (isStreamingPortableId(portableId)) return null;
  if (ABSOLUTE.test(portableId)) return portableId;
  return root === undefined ? null : portableIdToAbsolute(root, portableId);
}

export async function getTrackMarkers(
  raw: unknown,
  ctx: ReadCtx,
): Promise<(GetTrackMarkersResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(getTrackMarkersInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    const hasLoc = handle.schema.assetColumns.has("location_id");
    const row = handle.db
      .prepare(
        `SELECT portable_id, ${hasLoc ? "location_id" : "NULL AS location_id"} FROM asset WHERE id = ?`,
      )
      .get(args.id) as { portable_id: string | null; location_id: number | null } | undefined;
    if (row === undefined) {
      return err("unknown_ids", `no track with id ${args.id}`, { missing_ids: [args.id] });
    }

    const result: GetTrackMarkersResult = {
      id: args.id,
      path: null,
      format: null,
      cues: [],
      loops: [],
      track_color: null,
      bpm_locked: null,
      generation: handle.snapshot.generation,
    };
    const fail = (code: string, message: string, details?: Record<string, unknown>) =>
      ok(result, handle.snapshot.generation, [
        ...warnings,
        { code, message, ...(details ? { details } : {}) },
      ]);

    if (typeof row.portable_id !== "string" || row.portable_id === "") {
      return fail("path_unavailable", "the library holds no file path for this track");
    }
    if (isStreamingPortableId(row.portable_id)) {
      return fail("streaming_track", "streaming tracks have no audio file to read");
    }
    const root = row.location_id === null ? undefined : handle.volumeRoots.get(row.location_id);
    const abs = resolveAudioPath(row.portable_id, root);
    if (abs === null) {
      return fail("path_unavailable", "the volume holding this track is not known");
    }
    result.path = redactPath(abs);

    const read = readMarkersFromFile(abs);
    result.format = read.format;
    if (read.status !== "ok" || read.parsed === undefined) {
      return fail(read.status, read.message ?? read.status);
    }
    const { markers, problems } = read.parsed;
    result.cues = markers.cues;
    result.loops = markers.loops;
    result.track_color = markers.track_color;
    result.bpm_locked = markers.bpm_locked;
    for (const p of problems) warnings.push({ code: p.code, message: p.message });
    if (markers.unparsed_entry_types.length > 0) {
      warnings.push({
        code: "unparsed_entries",
        message: `Markers2 holds entries this tool does not decode: ${markers.unparsed_entry_types.join(", ")}`,
        details: { types: markers.unparsed_entry_types },
      });
    }
    return ok(result, handle.snapshot.generation, warnings);
  });
}
