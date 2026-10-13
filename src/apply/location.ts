import { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";
import { isSqliteBusy } from "./sqlite.js";

/** SQLITE_BUSY becomes busy with retry_after_ms equal to this. */
export const STORE_BUSY_TIMEOUT_MS = 3000;

/** node:sqlite's extended code for a UNIQUE violation -- see the same
 *  constant in transaction.ts for how it was measured and why the primary
 *  code 19 alone cannot be used to distinguish it from NOT NULL/CHECK/FK. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export type StoreRepair = { oldPortableId: string; newPortableId: string; fileSize: number };

/** `D:\...` or `D:/...`. No absolute POSIX path starts this way. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** `\\server\share\...`, for a store on a network share. */
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/;

/**
 * The real filesystem path to a volume's store, from the database_uri a
 * master.sqlite connection row carries. Mirrors the separator normalization
 * in paths.ts's volumeRootFromDatabaseUri: a Windows drive or UNC uri may
 * use either separator and is normalized to backslashes before it reaches
 * node:sqlite; a POSIX uri is already a path and is returned unchanged.
 */
export function storePathFromUri(databaseUri: string): string {
  if (WINDOWS_DRIVE_PATH.test(databaseUri) || WINDOWS_UNC_PATH.test(databaseUri)) {
    return databaseUri.replaceAll("/", "\\");
  }
  return databaseUri;
}

/**
 * Applies relocation repairs to one volume's store (location.sqlite or
 * root.sqlite): for each repair, points the asset still missing at its old
 * portable_id to the new one, clears is_missing and sets file_size. Opens
 * storePath read-write, in one transaction for the whole batch; the caller
 * handles backup/manifest/order across stores.
 *
 * A repair whose new portable_id collides with a row already in the store
 * (asset.portable_id is UNIQUE) is not a batch failure -- the other repairs
 * in the batch still apply -- so it is reported back in skippedDuplicate
 * instead of thrown.
 */
export function applyStoreRepairs(
  storePath: string,
  repairs: StoreRepair[],
): { updated: number; skippedDuplicate: StoreRepair[] } | SeratoError {
  const notCommitted = (stage: string, message: string, extra: Record<string, unknown> = {}) =>
    err("write_failed_not_committed", message, { stage, ...extra });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(storePath);
  } catch (e) {
    return notCommitted("open", `cannot open the store: ${String(e)}`);
  }
  const rollback = () => {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      // A failed ROLLBACK leaves nothing to add: SQLite rolls back an open
      // transaction when the connection closes, which the finally does.
    }
  };

  try {
    // Explicit even though node:sqlite enables foreign keys by default: the
    // protocol must not depend on a binding's default.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      if (isSqliteBusy(e)) {
        return err("busy", `the store is locked by another writer: ${String(e)}`, {
          retry_after_ms: STORE_BUSY_TIMEOUT_MS,
        });
      }
      // A file that is not a database fails the same way every time, so it
      // must never invite a retry.
      return notCommitted("begin", `cannot start the write transaction: ${String(e)}`);
    }

    const update = db.prepare(
      "UPDATE asset SET portable_id = ?, is_missing = 0, file_size = ? WHERE portable_id = ? AND is_missing = 1",
    );
    let updated = 0;
    const skippedDuplicate: StoreRepair[] = [];
    for (const repair of repairs) {
      try {
        const result = update.run(repair.newPortableId, repair.fileSize, repair.oldPortableId);
        updated += Number(result.changes);
      } catch (e) {
        if ((e as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
          skippedDuplicate.push(repair);
          continue;
        }
        rollback();
        throw e;
      }
    }

    // Before COMMIT: a targeted check instead of quick_check over the whole
    // database.
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      rollback();
      return notCommitted("foreign_key_check", "the write did not check out and was rolled back", {
        violations: violations.length,
      });
    }

    try {
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) {
        // SQLite kept the transaction open: nothing was committed. Busy here
        // is the expected cause -- a reader on another connection holds
        // SHARED -- so it is contention, not failure, and gets a retry hint
        // like any other.
        rollback();
        if (isSqliteBusy(e)) {
          return err("busy", `COMMIT is blocked by another reader: ${String(e)}`, {
            retry_after_ms: STORE_BUSY_TIMEOUT_MS,
          });
        }
        return notCommitted("commit", `COMMIT failed and the write was rolled back: ${String(e)}`);
      }
      // SQLite has already rolled back on its own here.
      return notCommitted("commit", `COMMIT failed and the write was rolled back: ${String(e)}`);
    }
    return { updated, skippedDuplicate };
  } catch (e) {
    rollback();
    if (isSqliteBusy(e)) {
      return err("busy", `the store became busy mid-transaction: ${String(e)}`, {
        retry_after_ms: STORE_BUSY_TIMEOUT_MS,
      });
    }
    return notCommitted("transaction", `the write failed and was rolled back: ${String(e)}`);
  } finally {
    db.close();
  }
}
