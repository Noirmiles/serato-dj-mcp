import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { isStreamingPortableId, redactPath } from "../paths.js";
import { type ReadCtx, type ReadHandle, readSession, schemaWarnings } from "../read/session.js";
import {
  type MatchDeps,
  type MissingAsset,
  matchRepairs,
  type RepairPlan,
} from "../relocate/match.js";

/** Scaled up from audit.ts's MAX_SAMPLES (10): this is a repair plan a model
 *  decides whether to apply, not a diagnosis, so more real candidates earn
 *  their place -- while still stopping far short of dumping a whole
 *  library. */
export const MAX_SAMPLES = 50;

export const previewRelocateInput = z.object({
  moved_under: z.string().optional(),
  search_folder: z.string().optional(),
  scope: z
    .object({
      location_id: z.number().int().optional(),
      portable_id_prefix: z.string().optional(),
    })
    .optional(),
});

const repairSampleSchema = z.object({
  location_id: z.number(),
  old_portable_id: z.string(),
  new_portable_id: z.string(),
  absolute_path: z.string(),
  file_size: z.number(),
  kind: z.enum(["revalidate", "moved", "search"]),
});

const ambiguousSampleSchema = z.object({
  location_id: z.number(),
  portable_id: z.string(),
  candidates: z.array(z.string()),
});

const unresolvedSampleSchema = z.object({
  location_id: z.number(),
  portable_id: z.string(),
});

function bucketSchema<T extends z.ZodType>(sample: T) {
  return z.object({ count: z.number(), samples: z.array(sample) });
}

export const previewRelocateOutput = z.object({
  repairs: bucketSchema(repairSampleSchema),
  ambiguous: bucketSchema(ambiguousSampleSchema),
  not_found: bucketSchema(unresolvedSampleSchema),
  volume_unavailable: bucketSchema(unresolvedSampleSchema),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const previewRelocateDescription =
  "Preview a repair plan for tracks Serato has flagged missing, without writing anything -- " +
  "call apply_relocate to act on it. revalidate: the file is still at its recorded path " +
  "(Serato's flag is stale). moved: found under moved_under, the same relative path prefixed " +
  "with a new parent folder. search: found by filename somewhere under search_folder, " +
  "disambiguated by parent folder name when more than one candidate shares that filename. " +
  "Buckets: repairs, ambiguous (multiple same-named candidates, none applied), not_found, and " +
  "volume_unavailable (the track's volume has no known root, usually because its drive is not " +
  `connected). Each bucket reports a count and up to ${MAX_SAMPLES} example entries.`;

type Bucket<T> = { count: number; samples: T[] };

function toBucket<I, O>(items: I[], map: (item: I) => O): Bucket<O> {
  return { count: items.length, samples: items.slice(0, MAX_SAMPLES).map(map) };
}

/** Entries of a directory, or [] for one this process cannot read (gone
 *  mid-walk, permission denied) -- the same tolerance existsSync gives every
 *  other path in this tool, rather than failing the whole call over one bad
 *  folder. */
function entriesOf(folder: string) {
  try {
    return readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** A recursive listing of absolute file paths, used only to feed
 *  matchRepairs' filename search when search_folder is given. */
function walk(folder: string): string[] {
  const out: string[] = [];
  for (const entry of entriesOf(folder)) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function buildMatchDeps(handle: ReadHandle, searchFolder: string | undefined): MatchDeps {
  return {
    volumeRoots: handle.volumeRoots,
    exists: existsSync,
    fileSize: (p) => statSync(p).size,
    walk: searchFolder === undefined ? undefined : walk,
  };
}

/** The same criterion audit.ts's brokenPaths check uses for its database
 *  half: Serato's own is_missing flag, which costs nothing to read and is a
 *  real finding. A streaming row's portable_id is not a filesystem path, so
 *  it is dropped here rather than handed to the matcher -- the same rule
 *  brokenPaths follows before any existsSync call. */
function missingAssets(handle: ReadHandle): MissingAsset[] {
  const rows = handle.db
    .prepare("SELECT location_id, portable_id FROM asset WHERE is_missing <> 0")
    .all() as { location_id: number; portable_id: string }[];
  return rows
    .filter((r) => !isStreamingPortableId(r.portable_id))
    .map((r) => ({ locationId: r.location_id, portableId: r.portable_id }));
}

/** Paths are redacted to ~ before they reach the model, same as get_tracks
 *  (see mapRow in ../read/fields.ts) -- a repair plan is as much of a path
 *  leak as a track listing is. */
function planToPayload(plan: RepairPlan) {
  return {
    repairs: toBucket(plan.repairs, (r) => ({
      location_id: r.locationId,
      old_portable_id: r.oldPortableId,
      new_portable_id: r.newPortableId,
      absolute_path: redactPath(r.absolutePath),
      file_size: r.fileSize,
      kind: r.kind,
    })),
    ambiguous: toBucket(plan.ambiguous, (a) => ({
      location_id: a.locationId,
      portable_id: a.portableId,
      candidates: a.candidates.map((c) => redactPath(c)),
    })),
    not_found: toBucket(plan.notFound, (u) => ({
      location_id: u.locationId,
      portable_id: u.portableId,
    })),
    volume_unavailable: toBucket(plan.volumeUnavailable, (u) => ({
      location_id: u.locationId,
      portable_id: u.portableId,
    })),
  };
}

type RelocatePlanPayload = ReturnType<typeof planToPayload>;

export async function previewRelocate(
  raw: unknown,
  ctx: ReadCtx,
): Promise<(RelocatePlanPayload & { generation?: string; warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(previewRelocateInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    const missing = missingAssets(handle);
    const plan = matchRepairs(
      missing,
      {
        movedUnder: args.moved_under,
        searchFolder: args.search_folder,
        scope:
          args.scope === undefined
            ? undefined
            : {
                locationId: args.scope.location_id,
                portableIdPrefix: args.scope.portable_id_prefix,
              },
      },
      buildMatchDeps(handle, args.search_folder),
    );
    return ok(planToPayload(plan), handle.snapshot.generation, warnings);
  });
}
