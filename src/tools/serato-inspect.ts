import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { searchLocations } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { isStreamingPortableId, portableIdToAbsolute } from "../paths.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";

/** The most path samples ever returned, whatever the library holds. */
export const MAX_PATH_SAMPLES = 5;

export const seratoInspectInput = z.strictObject({});

export const seratoInspectDescription =
  "Report how the Serato library on this machine is laid out, for diagnosing a Windows or " +
  "unfamiliar install: which of master.sqlite, root.sqlite and location.sqlite exist, the " +
  "snapshot's journal mode and schema user_version, its table names, row counts of container, " +
  "container_asset and asset, whether the lock table exists and holds rows, and up to 5 " +
  "samples of stored track paths with their drive-letter and separator style. Everything about " +
  "master.sqlite is read from a snapshot copy, so the lock figure is as of the snapshot; " +
  "root.sqlite and location.sqlite are checked for existence only and never opened. Paths are " +
  "NOT redacted.";

const pathSampleSchema = z.object({
  location_id: z.number().nullable(),
  portable_id: z.string(),
  path: z.string(),
  kind: z.enum(["windows_drive", "windows_unc", "posix", "streaming", "relative"]),
  drive_letter: z.string().nullable(),
  separator: z.enum(["\\", "/", "none"]),
});

export const seratoInspectOutput = z.object({
  library_path: z.string(),
  searched: z.array(z.string()),
  files: z.object({
    "master.sqlite": z.boolean(),
    "root.sqlite": z.boolean(),
    "location.sqlite": z.boolean(),
  }),
  journal_mode: z.string().nullable(),
  user_version: z.number(),
  schema_known: z.boolean(),
  tables: z.array(z.string()),
  row_counts: z.object({
    container: z.number().nullable(),
    container_asset: z.number().nullable(),
    asset: z.number().nullable(),
  }),
  lock: z.object({ table_exists: z.boolean(), has_rows: z.boolean().nullable() }),
  path_samples: z.array(pathSampleSchema).max(MAX_PATH_SAMPLES),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export type PathSample = z.infer<typeof pathSampleSchema>;
export type SeratoInspectResult = Omit<z.infer<typeof seratoInspectOutput>, "warnings">;

/** Classifies one stored path by how it is written, nothing more. */
export function describePath(
  path: string,
  portableId: string,
): Pick<PathSample, "kind" | "drive_letter" | "separator"> {
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  let kind: PathSample["kind"];
  if (isStreamingPortableId(portableId)) kind = "streaming";
  else if (drive) kind = "windows_drive";
  else if (path.startsWith("\\\\")) kind = "windows_unc";
  else if (path.startsWith("/")) kind = "posix";
  else kind = "relative";
  const separator = path.includes("\\") ? "\\" : path.includes("/") ? "/" : "none";
  return { kind, drive_letter: drive ? (drive[1] as string).toUpperCase() : null, separator };
}

function count(db: DatabaseSync, tables: Set<string>, table: string): number | null {
  if (!tables.has(table)) return null;
  return (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

export async function seratoInspect(
  raw: unknown,
  ctx: ReadCtx,
): Promise<(SeratoInspectResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(seratoInspectInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const { db, schema } = handle;
    const warnings: Warning[] = schemaWarnings(handle);

    let journalMode: string | null = null;
    try {
      journalMode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode;
    } catch {
      warnings.push({ code: "journal_mode_unavailable", message: "could not read journal_mode" });
    }

    const lockExists = schema.tables.has("lock");
    const lockHasRows = lockExists
      ? db.prepare('SELECT 1 AS x FROM "lock" LIMIT 1').get() !== undefined
      : null;

    const samples: PathSample[] = [];
    if (schema.tables.has("asset") && schema.assetColumns.has("portable_id")) {
      const hasLoc = schema.assetColumns.has("location_id");
      // One track per location first, so a library spanning several drives
      // shows every path style rather than the first five rows of one.
      const sql = hasLoc
        ? "SELECT location_id, portable_id FROM asset WHERE id IN " +
          `(SELECT MIN(id) FROM asset GROUP BY location_id) ORDER BY id LIMIT ${MAX_PATH_SAMPLES}`
        : `SELECT NULL AS location_id, portable_id FROM asset ORDER BY id LIMIT ${MAX_PATH_SAMPLES}`;
      const rows = db.prepare(sql).all() as { location_id: number | null; portable_id: string }[];
      for (const r of rows) {
        const root = r.location_id === null ? undefined : handle.volumeRoots.get(r.location_id);
        const path =
          root !== undefined && !isStreamingPortableId(r.portable_id)
            ? portableIdToAbsolute(root, r.portable_id)
            : r.portable_id;
        samples.push({
          location_id: r.location_id,
          portable_id: r.portable_id,
          path,
          ...describePath(path, r.portable_id),
        });
      }
    }

    return ok(
      {
        library_path: handle.libraryPath,
        searched: searchLocations({ library: ctx.library, roots: ctx.roots }),
        files: {
          "master.sqlite": existsSync(join(handle.libraryPath, "master.sqlite")),
          "root.sqlite": existsSync(join(handle.libraryPath, "root.sqlite")),
          "location.sqlite": existsSync(join(handle.libraryPath, "location.sqlite")),
        },
        journal_mode: journalMode,
        user_version: schema.userVersion,
        schema_known: schema.known,
        tables: [...schema.tables].sort(),
        row_counts: {
          container: count(db, schema.tables, "container"),
          container_asset: count(db, schema.tables, "container_asset"),
          asset: count(db, schema.tables, "asset"),
        },
        lock: { table_exists: lockExists, has_rows: lockHasRows },
        path_samples: samples.slice(0, MAX_PATH_SAMPLES),
        generation: handle.snapshot.generation,
      },
      handle.snapshot.generation,
      warnings,
    );
  });
}
