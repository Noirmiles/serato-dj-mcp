import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { BEATGRID_TAG, readTagFromFile, TEMPO_MAP_TAG } from "../markers/read.js";
import { parseBeatGrid, parseTempoMap } from "../markers/tempo-map.js";
import { MAX_IDS } from "./get-tracks.js";

export const readGridInput = z.strictObject({
  paths: z.array(z.string().min(1)).min(1).max(MAX_IDS),
});

export const readGridDescription =
  "Read the beat grid Serato stored in audio files: the Serato DJ Pro 5 'Serato Tempo Map' tag " +
  "(all markers) and the legacy 'Serato BeatGrid' tag, straight from the file tags, plus which " +
  "of the two Serato 5 would use (a valid Tempo Map, else the converted legacy BeatGrid). " +
  "Supports MP3 and AIFF (ID3v2) and FLAC. The formats are reverse-engineered: the Tempo Map " +
  "position unit, header_field and mode are reported raw. Reads files only; never writes and " +
  "never touches Serato. Paths are echoed as given.";

const status = z.enum([
  "ok",
  "file_missing",
  "unreadable",
  "unsupported_format",
  "no_tag",
  "malformed",
]);

const tempoMarker = z.object({
  position: z.union([z.number(), z.string()]),
  tempo: z.number(),
  beat_note_value: z.number(),
  interpolation: z.enum(["stepped", "linear", "curved", "unknown"]),
  interpolation_raw: z.number(),
  curvature: z.number().nullable(),
});

const gridEntry = z.object({
  path: z.string(),
  format: z.enum(["mp3", "aiff", "flac"]).nullable(),
  tempo_map: z.object({
    status,
    version: z.number().optional(),
    header_field: z.number().nullable().optional(),
    mode: z.number().nullable().optional(),
    origin_seconds: z.number().optional(),
    markers: z.array(tempoMarker).optional(),
    message: z.string().optional(),
  }),
  beatgrid: z.object({
    status,
    markers: z
      .array(
        z.object({
          position_seconds: z.number(),
          beats_to_next: z.number().optional(),
          bpm: z.number().optional(),
        }),
      )
      .optional(),
    message: z.string().optional(),
  }),
  serato5_uses: z.enum(["tempo_map", "beatgrid", "none"]),
});

export const readGridOutput = z.object({ files: z.array(gridEntry) });

export type GridResult = z.infer<typeof gridEntry>;

/** Reads both grid tags of one file. Never throws. */
export function readGrid(path: string): GridResult {
  const tm = readTagFromFile(path, TEMPO_MAP_TAG);
  const bg = readTagFromFile(path, BEATGRID_TAG);
  const tempo_map: GridResult["tempo_map"] = { status: tm.status };
  const beatgrid: GridResult["beatgrid"] = { status: bg.status };
  if (tm.message) tempo_map.message = tm.message;
  if (bg.message) beatgrid.message = bg.message;
  if (tm.payload) {
    const p = parseTempoMap(tm.payload);
    if (p.ok) Object.assign(tempo_map, p.value);
    else Object.assign(tempo_map, { status: "malformed", message: p.message });
  }
  if (bg.payload) {
    const p = parseBeatGrid(bg.payload);
    if (p.ok) beatgrid.markers = p.value;
    else Object.assign(beatgrid, { status: "malformed", message: p.message });
  }
  return {
    path,
    format: tm.format ?? bg.format,
    tempo_map,
    beatgrid,
    serato5_uses:
      tempo_map.status === "ok" ? "tempo_map" : beatgrid.status === "ok" ? "beatgrid" : "none",
  };
}

export function readGridTool(raw: unknown): { files: GridResult[] } | SeratoError {
  const args = parseToolArgs(readGridInput, raw);
  if (isSeratoError(args)) return args;
  return ok({ files: args.paths.map(readGrid) });
}
