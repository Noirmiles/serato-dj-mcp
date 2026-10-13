import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isStreamingPortableId } from "../paths.js";
import type { ReadHandle } from "../read/session.js";
import { type MatchDeps, type MissingAsset, matchRepairs, type RepairPlan } from "./match.js";

/**
 * The repair-plan half of both relocate tools, shared so the two never drift:
 * preview_relocate reads it to report a plan, apply_relocate reads the SAME
 * plan to decide what to write. Only the missing-asset query, the search-walk
 * wiring and the matchRepairs call itself live here -- everything else
 * (sampling, redaction, store-path resolution) is specific to one tool or the
 * other and stays there.
 */
export type RelocatePlanArgs = {
  moved_under?: string;
  search_folder?: string;
  scope?: { location_id?: number; portable_id_prefix?: string };
};

/** Entries of a directory, or [] for one this process cannot read (gone
 *  mid-walk, permission denied) -- the same tolerance existsSync gives every
 *  other path these tools touch, rather than failing the whole call over one
 *  bad folder. */
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

/**
 * Computes the repair plan for every row Serato has flagged missing, against
 * the snapshot behind `handle` -- the only difference between calling this
 * from preview_relocate and from apply_relocate is what each does with the
 * result.
 */
export function computeRelocatePlan(handle: ReadHandle, args: RelocatePlanArgs): RepairPlan {
  return matchRepairs(
    missingAssets(handle),
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
}
