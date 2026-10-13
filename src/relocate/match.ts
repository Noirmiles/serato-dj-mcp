import { portableIdToAbsolute } from "../paths.js";

export type MissingAsset = { locationId: number; portableId: string };

export type Repair = {
  locationId: number;
  oldPortableId: string;
  newPortableId: string;
  absolutePath: string;
  fileSize: number;
  kind: "revalidate" | "moved" | "search";
};

export type Ambiguous = {
  locationId: number;
  portableId: string;
  candidates: string[];
};

export type Unresolved = { locationId: number; portableId: string };

export type RepairPlan = {
  repairs: Repair[];
  ambiguous: Ambiguous[];
  notFound: Unresolved[];
  volumeUnavailable: Unresolved[];
};

export type MatchParams = {
  movedUnder?: string;
  searchFolder?: string;
  scope?: { locationId?: number; portableIdPrefix?: string };
};

export type MatchDeps = {
  volumeRoots: Map<number, string>;
  exists(absPath: string): boolean;
  fileSize(absPath: string): number;
  walk?(folder: string): string[];
};

/** Last path segment, accepting either separator (portable_id uses `/`;
 *  walked absolute paths use the host's native separator). */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Basename of the immediate parent folder, or undefined for a bare
 *  filename with no folder segment. */
function parentBasenameOf(p: string): string | undefined {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/** Strips `root` off a candidate's absolute path and switches separators to
 *  `/`, producing a portable_id-shaped relative path like the ones already
 *  stored in the database. */
function deriveNewPortableId(root: string, absPath: string): string {
  const toSlash = (s: string) => s.replaceAll("\\", "/");
  const normRoot = toSlash(root).replace(/\/+$/, "");
  const normPath = toSlash(absPath);
  const prefix = `${normRoot}/`;
  if (normPath.startsWith(prefix)) return normPath.slice(prefix.length);
  return normPath.startsWith(normRoot)
    ? normPath.slice(normRoot.length).replace(/^\/+/, "")
    : normPath;
}

export function matchRepairs(
  missing: MissingAsset[],
  params: MatchParams,
  deps: MatchDeps,
): RepairPlan {
  const plan: RepairPlan = {
    repairs: [],
    ambiguous: [],
    notFound: [],
    volumeUnavailable: [],
  };

  // Walked once per call (not once per missing asset) so N missing assets
  // under the same searchFolder don't each re-walk the whole tree.
  const searchCandidates: string[] | undefined =
    params.searchFolder && deps.walk ? deps.walk(params.searchFolder) : undefined;

  for (const a of missing) {
    if (params.scope?.locationId !== undefined && a.locationId !== params.scope.locationId) {
      continue;
    }

    if (params.scope?.portableIdPrefix && !a.portableId.startsWith(params.scope.portableIdPrefix)) {
      continue;
    }

    const root = deps.volumeRoots.get(a.locationId);
    if (root === undefined) {
      plan.volumeUnavailable.push({
        locationId: a.locationId,
        portableId: a.portableId,
      });
      continue;
    }

    const atPath = portableIdToAbsolute(root, a.portableId);
    if (deps.exists(atPath)) {
      plan.repairs.push({
        locationId: a.locationId,
        oldPortableId: a.portableId,
        newPortableId: a.portableId,
        absolutePath: atPath,
        fileSize: deps.fileSize(atPath),
        kind: "revalidate",
      });
      continue;
    }

    if (params.movedUnder) {
      const movedId = `${params.movedUnder}/${a.portableId}`;
      const movedPath = portableIdToAbsolute(root, movedId);
      if (deps.exists(movedPath)) {
        plan.repairs.push({
          locationId: a.locationId,
          oldPortableId: a.portableId,
          newPortableId: movedId,
          absolutePath: movedPath,
          fileSize: deps.fileSize(movedPath),
          kind: "moved",
        });
        continue;
      }
    }

    if (searchCandidates) {
      const want = basenameOf(a.portableId).toLowerCase();
      const matches = searchCandidates.filter((f) => basenameOf(f).toLowerCase() === want);

      let chosen: string | undefined;
      if (matches.length === 1) {
        chosen = matches[0];
      } else if (matches.length >= 2) {
        const parentWant = parentBasenameOf(a.portableId)?.toLowerCase();
        const parentMatches = matches.filter(
          (f) => parentBasenameOf(f)?.toLowerCase() === parentWant,
        );
        if (parentMatches.length === 1) chosen = parentMatches[0];
      }

      if (chosen) {
        plan.repairs.push({
          locationId: a.locationId,
          oldPortableId: a.portableId,
          newPortableId: deriveNewPortableId(root, chosen),
          absolutePath: chosen,
          fileSize: deps.fileSize(chosen),
          kind: "search",
        });
        continue;
      }

      if (matches.length >= 2) {
        plan.ambiguous.push({
          locationId: a.locationId,
          portableId: a.portableId,
          candidates: matches,
        });
        continue;
      }
    }

    // nothing matched by revalidate, moved-under-parent, or search
    plan.notFound.push({
      locationId: a.locationId,
      portableId: a.portableId,
    });
  }

  return plan;
}
