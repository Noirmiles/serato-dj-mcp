import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { applyStoreRepairs, type StoreRepair } from "./location.js";
import { checkSeratoClosed, type ProcessProbe, systemProbe } from "./serato.js";
import { isSqliteBusy } from "./sqlite.js";

/** SQLITE_BUSY becomes busy with retry_after_ms equal to this. */
export const MASTER_BUSY_TIMEOUT_MS = 3000;

/** node:sqlite's extended code for a UNIQUE violation -- see the same
 *  constant in location.ts/transaction.ts. master.sqlite's
 *  asset__unique_database index is UNIQUE(location_id, portable_id), so a
 *  repoint onto a path a found row already holds surfaces as this. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export type RelocateInput = {
  masterPath: string;
  /** location_id -> { the volume's own store, the repairs for that volume }.
   *  The map's keys are the location_id the master rows are grouped by. */
  byLocation: Map<number, { storePath: string; repairs: StoreRepair[] }>;
  probe?: ProcessProbe;
};

export type RelocateOutcome = {
  repaired: number;
  /** Repoints refused by master's UNIQUE(location_id, portable_id): a found
   *  row already holds the new path. Keyed by the new path that collided. */
  duplicate: { locationId: number; portableId: string }[];
};

/**
 * Applies a relocation plan across every per-volume store AND master.sqlite.
 * This is the first code in the server that writes master.sqlite and the
 * first cross-database write, so the order is the whole safety argument:
 *
 *   every volume store is committed FIRST, master.sqlite LAST.
 *
 * master.sqlite is what Serato reads to decide a track is present; a store
 * (location.sqlite / root.sqlite) is the volume's own copy. A crash between
 * the two must leave master still saying "missing" -- safe, Serato re-offers
 * the relocation -- never "found" while the store disagrees. Committing the
 * stores first and master last guarantees that: the only reachable partial
 * state is stores-ahead-of-master, which reads as still-missing.
 */
export function applyRelocate(input: RelocateInput): RelocateOutcome | SeratoError {
  const probe = input.probe ?? systemProbe;

  // Re-checked at the start of the engine (defense in depth; the tool checks
  // earlier too). Unable to tell, or found running, refuses before any write.
  const running = checkSeratoClosed(input.masterPath, probe);
  if (running !== null) return running;

  // No silent store creation: `new DatabaseSync(path)` materializes a 0-byte
  // database for a path that does not exist, so a disconnected volume would
  // otherwise be "repaired" into an empty file. Every store is checked up
  // front, before a single write, so a missing one refuses the whole plan
  // rather than half-applying the stores that happen to be present.
  for (const { storePath } of input.byLocation.values()) {
    if (!existsSync(storePath)) {
      return err("write_refused", "a volume's store is missing or disconnected", {
        reason: "store_missing",
        store_path: storePath,
      });
    }
  }

  // (1) Stores FIRST. A store error aborts before master is opened.
  for (const { storePath, repairs } of input.byLocation.values()) {
    const stored = applyStoreRepairs(storePath, repairs);
    if (isSeratoError(stored)) return stored;
  }

  // (2) master LAST.
  const written = writeMaster(input);
  if (isSeratoError(written)) return written;

  // (3) Verify, on fresh read-only connections -- the only thing that makes
  // committed_unverified a reachable state rather than a hope.
  const unverified = verifyRelocate(input, written);
  return unverified ?? written;
}

function writeMaster(input: RelocateInput): RelocateOutcome | SeratoError {
  const notCommitted = (stage: string, message: string, extra: Record<string, unknown> = {}) =>
    err("write_failed_not_committed", message, { stage, ...extra });

  // Checked for the same reason the stores are: a path that does not exist
  // must refuse, never be created as a 0-byte master.sqlite.
  if (!existsSync(input.masterPath)) {
    return err("write_refused", "this library has no master.sqlite to write into", {
      reason: "master_missing",
    });
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(input.masterPath);
  } catch (e) {
    return notCommitted("open", `cannot open master.sqlite: ${String(e)}`);
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
    db.exec(`PRAGMA busy_timeout = ${MASTER_BUSY_TIMEOUT_MS}`);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      if (isSqliteBusy(e)) {
        return err("busy", `master.sqlite is locked by another writer: ${String(e)}`, {
          retry_after_ms: MASTER_BUSY_TIMEOUT_MS,
        });
      }
      // A file that is not a database fails the same way every time, so it
      // must never invite a retry.
      return notCommitted("begin", `cannot start the write transaction: ${String(e)}`);
    }

    // Keyed WHERE location_id AND portable_id AND is_missing = 1: the repair
    // only ever clears a row that is still missing at the old path, so a row
    // Serato already found again is left untouched.
    const update = db.prepare(
      "UPDATE asset SET portable_id = ?, is_missing = 0, file_size = ? WHERE location_id = ? AND portable_id = ? AND is_missing = 1",
    );
    let repaired = 0;
    const duplicate: { locationId: number; portableId: string }[] = [];
    for (const [locationId, { repairs }] of input.byLocation) {
      for (const repair of repairs) {
        try {
          const result = update.run(
            repair.newPortableId,
            repair.fileSize,
            locationId,
            repair.oldPortableId,
          );
          repaired += Number(result.changes);
        } catch (e) {
          // A repoint onto a path a found row already holds is not a batch
          // failure: it is reported back and the rest of the batch stands.
          if ((e as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
            duplicate.push({ locationId, portableId: repair.newPortableId });
            continue;
          }
          rollback();
          throw e;
        }
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
        // is a reader on another connection holding SHARED -- contention, not
        // failure -- so it gets a retry hint like any other.
        rollback();
        if (isSqliteBusy(e)) {
          return err("busy", `COMMIT is blocked by another reader: ${String(e)}`, {
            retry_after_ms: MASTER_BUSY_TIMEOUT_MS,
          });
        }
        return notCommitted("commit", `COMMIT failed and the write was rolled back: ${String(e)}`);
      }
      // SQLite has already rolled back on its own here.
      return notCommitted("commit", `COMMIT failed and the write was rolled back: ${String(e)}`);
    }
    return { repaired, duplicate };
  } catch (e) {
    rollback();
    if (isSqliteBusy(e)) {
      return err("busy", `master.sqlite became busy mid-transaction: ${String(e)}`, {
        retry_after_ms: MASTER_BUSY_TIMEOUT_MS,
      });
    }
    return notCommitted("transaction", `the write failed and was rolled back: ${String(e)}`);
  } finally {
    db.close();
  }
}

/**
 * After COMMIT, on NEW read-only connections: confirms every repair that was
 * not a duplicate reads back as relocated in BOTH its store and master. A
 * failure here means the data may well be in the files, so the caller gets
 * the paths it needs to find the backups alongside them.
 */
function verifyRelocate(input: RelocateInput, outcome: RelocateOutcome): SeratoError | null {
  const writtenStores = [...input.byLocation.values()].map((v) => v.storePath);
  const unverified = (message: string, problems: string[] = []) =>
    err("write_failed_committed_unverified", message, {
      stage: "verify_after_commit",
      written_paths: { master: input.masterPath, stores: writtenStores },
      problems,
    });

  // The paths a repoint collided on, per location: those rows were never
  // meant to change, so they are not read back as relocated.
  const dupByLocation = new Map<number, Set<string>>();
  for (const d of outcome.duplicate) {
    const set = dupByLocation.get(d.locationId) ?? new Set<string>();
    set.add(d.portableId);
    dupByLocation.set(d.locationId, set);
  }

  const relocated = (
    db: DatabaseSync,
    sql: string,
    fileSize: number,
    ...params: (string | number)[]
  ): boolean => {
    const row = db.prepare(sql).get(...params) as
      | { is_missing: number; file_size: number }
      | undefined;
    return row !== undefined && row.is_missing === 0 && row.file_size === fileSize;
  };

  let master: DatabaseSync | undefined;
  try {
    master = new DatabaseSync(input.masterPath, { readOnly: true });
    master.exec(`PRAGMA busy_timeout = ${MASTER_BUSY_TIMEOUT_MS}`);
    const problems: string[] = [];
    for (const [locationId, { storePath, repairs }] of input.byLocation) {
      const dups = dupByLocation.get(locationId) ?? new Set<string>();
      const store = new DatabaseSync(storePath, { readOnly: true });
      store.exec(`PRAGMA busy_timeout = ${MASTER_BUSY_TIMEOUT_MS}`);
      try {
        for (const repair of repairs) {
          if (dups.has(repair.newPortableId)) continue;
          if (
            !relocated(
              master,
              "SELECT is_missing, file_size FROM asset WHERE location_id = ? AND portable_id = ?",
              repair.fileSize,
              locationId,
              repair.newPortableId,
            )
          ) {
            problems.push(
              `master ${locationId}/${repair.newPortableId} did not read back relocated`,
            );
          }
          if (
            !relocated(
              store,
              "SELECT is_missing, file_size FROM asset WHERE portable_id = ?",
              repair.fileSize,
              repair.newPortableId,
            )
          ) {
            problems.push(`store ${storePath} ${repair.newPortableId} did not read back relocated`);
          }
        }
      } finally {
        store.close();
      }
    }
    return problems.length === 0
      ? null
      : unverified("the committed write did not read back", problems);
  } catch (e) {
    return unverified(`the committed write could not be read back: ${String(e)}`);
  } finally {
    master?.close();
  }
}
