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

    // moved-under-parent and filename-search added in Tasks 2 and 3
    plan.notFound.push({
      locationId: a.locationId,
      portableId: a.portableId,
    });
  }

  return plan;
}
