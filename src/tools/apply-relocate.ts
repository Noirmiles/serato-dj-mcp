import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import { backupLibrary, type ExtraStore } from "../apply/backup.js";
import { type StoreRepair, storePathFromUri } from "../apply/location.js";
import { markAborted, markCommitted, writeIntent } from "../apply/manifest.js";
import { acquireWriteLock } from "../apply/mutex.js";
import { applyRelocate as applyRelocateEngine, type RelocateInput } from "../apply/relocate.js";
import { checkSeratoClosed } from "../apply/serato.js";
import { parseToolArgs } from "../args.js";
import { resolveLibrary } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import type { ReadHandle } from "../read/session.js";
import { readSession, schemaWarnings } from "../read/session.js";
import { computeRelocatePlan } from "../relocate/plan.js";
import type { ApplyCtx } from "./apply-changes.js";
import { previewRelocateInput } from "./preview-relocate.js";

export const applyRelocateInput = previewRelocateInput
  .extend({
    confirm: z.boolean(),
    generation: z.string().max(64).optional(),
  })
  .refine((v) => v.confirm === true, {
    error: "apply_relocate writes to the library and needs confirm: true",
    params: { reason: "confirm_required" },
  });

export const applyRelocateOutput = z.object({
  repaired: z.number(),
  revalidated: z.number(),
  skipped: z.object({
    ambiguous: z.number(),
    not_found: z.number(),
    duplicate: z.number(),
    volume_unavailable: z.number(),
  }),
  backup_paths: z
    .object({ root: z.string(), master: z.string(), stores: z.array(z.string()) })
    .nullable(),
  restart_required: z.boolean(),
  warnings: z.array(warningSchema).optional(),
});

export const applyRelocateDescription =
  "Write the repair plan preview_relocate would show for the current library state -- Serato " +
  "must be closed, or the call is refused. Both library databases are backed up first, plus " +
  "every volume store (location.sqlite) a repair touches, and every path is returned -- there " +
  "is no undo tool, restoring means copying those files back with Serato closed. revalidated " +
  "counts a repair where the file was already at its recorded path (only Serato's missing flag " +
  "was stale); repaired counts every other kind. skipped breaks down what was left alone: " +
  "ambiguous and not_found describe tracks no repair was found for, volume_unavailable a track " +
  "whose drive has no known root, and duplicate a repoint the library already holds under " +
  "another track. Pass generation from a recent preview_relocate call so a plan computed against " +
  "an older library state is refused rather than applied blind; omit it to skip that check. " +
  "Serato shows the repaired tracks after it is started again.";

/** The raw database_uri per location_id, straight from master's connection
 *  table -- the one piece of information storePathFromUri needs that
 *  ReadHandle.volumeRoots does not carry (it only has the ALREADY-DERIVED
 *  volume root, with the /_Serato_/Library/location.sqlite suffix stripped
 *  off). */
function connectionUris(handle: ReadHandle): Map<number, string> {
  if (!handle.schema.tables.has("connection")) return new Map();
  const rows = handle.db.prepare("SELECT location_id, database_uri FROM connection").all() as {
    location_id: number;
    database_uri: string;
  }[];
  return new Map(rows.map((r) => [r.location_id, r.database_uri]));
}

type ByLocation = Map<number, { storePath: string; repairs: StoreRepair[] }>;

type Skipped = {
  ambiguous: number;
  not_found: number;
  duplicate: number;
  volume_unavailable: number;
};

export async function applyRelocate(
  raw: unknown,
  ctx: ApplyCtx,
): Promise<
  | {
      repaired: number;
      revalidated: number;
      skipped: Skipped;
      backup_paths: { root: string; master: string; stores: string[] } | null;
      restart_required: boolean;
      warnings?: Warning[];
    }
  | SeratoError
> {
  const args = parseToolArgs(applyRelocateInput, raw);
  if (isSeratoError(args)) return args;

  const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
  if (isSeratoError(lib)) return lib;

  const lock = acquireWriteLock(ctx.stateDir, lib.uuid);
  if (isSeratoError(lock)) return lock;
  try {
    // The plan is computed the same way preview_relocate computes it -- off a
    // snapshot of master.sqlite, not the live file -- so this tool and that
    // one never disagree about what counts as a repair. Held under the write
    // lock so nothing else applies a conflicting plan in between.
    const planResult = await readSession(ctx, (handle) => {
      const warnings: Warning[] = schemaWarnings(handle);
      const plan = computeRelocatePlan(handle, args);
      return {
        plan,
        uris: connectionUris(handle),
        generation: handle.snapshot.generation,
        warnings,
      };
    });
    if (isSeratoError(planResult)) return planResult;
    const { plan, uris, generation, warnings } = planResult;

    // Checked before anything else proceeds: a plan computed against an
    // older library state must never be written blind.
    if (args.generation !== undefined && args.generation !== generation) {
      return err(
        "generation_mismatch",
        "the library changed since that repair plan was computed; preview_relocate again and " +
          "retry with the new generation",
        { requested_generation: args.generation, generation },
      );
    }

    const skipped: Skipped = {
      ambiguous: plan.ambiguous.length,
      not_found: plan.notFound.length,
      duplicate: 0,
      volume_unavailable: plan.volumeUnavailable.length,
    };

    // Grouped by location_id, the same key the engine's RelocateInput wants,
    // with each repair's store path resolved from the live connection row --
    // never guessed from the already-stripped volume root.
    const byLocation: ByLocation = new Map();
    for (const r of plan.repairs) {
      const uri = uris.get(r.locationId);
      // Invariant: matchRepairs only ever produces a repair for a location
      // whose root resolved, which itself only happens for a location whose
      // connection row parsed -- so this is unreachable in practice, not a
      // real case to handle.
      if (uri === undefined) continue;
      const storePath = storePathFromUri(uri);
      const entry = byLocation.get(r.locationId) ?? { storePath, repairs: [] };
      entry.repairs.push({
        oldPortableId: r.oldPortableId,
        newPortableId: r.newPortableId,
        fileSize: r.fileSize,
      });
      byLocation.set(r.locationId, entry);
    }

    // Nothing to write: the same short-circuit apply_changes takes for an
    // empty stage -- no backup of a library nothing is about to touch.
    if (byLocation.size === 0) {
      return ok(
        { repaired: 0, revalidated: 0, skipped, backup_paths: null, restart_required: false },
        undefined,
        warnings,
      );
    }

    // Preconditions on every store this plan is about to touch, checked
    // before Serato and before the backup -- the same root.sqlite-journal
    // check apply_changes does, per store instead of once.
    for (const { storePath } of byLocation.values()) {
      if (!existsSync(storePath)) {
        return err("write_refused", "a volume's store is missing or disconnected", {
          reason: "store_missing",
          store_path: storePath,
        });
      }
      if (existsSync(`${storePath}-journal`)) {
        return err(
          "write_refused",
          `${storePath}-journal exists: either Serato is writing this store right now, or a ` +
            "write was interrupted. Quit Serato and retry; if it persists with Serato closed, " +
            "start and quit Serato once so SQLite can roll it back.",
          { reason: "store_journal_present", store_path: storePath },
        );
      }
    }

    // Checked here first -- before the backup, so a running Serato costs
    // nothing. The engine checks again once it holds each write.
    const running = checkSeratoClosed(lib.masterPath, ctx.probe);
    if (running !== null) return running;

    const extraStores: ExtraStore[] = [...byLocation.values()].map((v) => ({
      path: v.storePath,
    }));
    const backupResult = await backupLibrary(lib.path, ctx.stateDir, lib.uuid, extraStores);
    if (isSeratoError(backupResult)) return backupResult;
    const backupPaths = {
      root: backupResult.root,
      master: backupResult.master,
      stores: backupResult.stores,
    };

    // Intent recorded before BEGIN (see writeIntent's own doc for why). This
    // tool has no crates to record, so it carries none -- op_id, backup_paths
    // and commit_state are the fields a relocate recovery actually needs.
    const opId = randomUUID();
    const intent = writeIntent(ctx.stateDir, {
      schema_version: 1,
      op_id: opId,
      ts: new Date().toISOString(),
      library_id: lib.uuid,
      crates: [],
      backup_paths: backupPaths,
      commit_state: "intent",
    });
    if (isSeratoError(intent)) return intent;

    const engineInput: RelocateInput = {
      masterPath: lib.masterPath,
      byLocation,
      probe: ctx.probe,
    };
    const outcome = applyRelocateEngine(engineInput);
    if (isSeratoError(outcome)) {
      // committed_unverified is the one failure that may well be in the
      // files, so it keeps its intent rather than being marked aborted -- and
      // the caller is told plainly not to retry over it.
      if (outcome.error.code === "write_failed_committed_unverified") {
        return {
          error: {
            ...outcome.error,
            message:
              `${outcome.error.message} -- the repairs are most likely written. Do not retry ` +
              "apply_relocate; start Serato to check, and restore from the backup paths only if " +
              "they are wrong.",
          },
        };
      }
      // Every other failure is known not committed: say so in the manifest.
      const aborted = markAborted(ctx.stateDir, lib.uuid, opId, outcome.error.code);
      if (isSeratoError(aborted)) {
        return {
          error: {
            ...outcome.error,
            details: { ...outcome.error.details, manifest_not_updated: true },
          },
        };
      }
      return outcome;
    }

    // outcome.repaired is the engine's own total of successful UPDATEs,
    // across both kinds; revalidated/repaired split it by whether a repair's
    // new path is the same as its old one, same as preview_relocate's own
    // "revalidate" bucket -- derived from the plan, not re-asked of the
    // engine, which does not carry that distinction.
    const dupKeys = new Set(outcome.duplicate.map((d) => `${d.locationId} ${d.portableId}`));
    let revalidated = 0;
    let repaired = 0;
    for (const r of plan.repairs) {
      if (dupKeys.has(`${r.locationId} ${r.newPortableId}`)) continue;
      if (r.newPortableId === r.oldPortableId) revalidated += 1;
      else repaired += 1;
    }
    skipped.duplicate = outcome.duplicate.length;

    const committed = markCommitted(ctx.stateDir, lib.uuid, opId, new Map());
    if (isSeratoError(committed)) {
      warnings.push({
        code: "manifest_not_updated",
        message: "the repairs were written, but the manifest could not be marked committed",
        details: { op_id: opId },
      });
    }

    return ok(
      { repaired, revalidated, skipped, backup_paths: backupPaths, restart_required: true },
      undefined,
      warnings,
    );
  } finally {
    lock.release();
  }
}
