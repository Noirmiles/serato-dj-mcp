import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

/** Backups are kept, not merely cached -- the last ten per library. */
export const MAX_BACKUPS = 10;

export type BackupPaths = { root: string; master: string };

/** An extra database to back up alongside root/master -- a volume's own
 *  location.sqlite, when a relocate write is about to touch it. */
export type ExtraStore = { path: string };

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.(\d{3})Z$/, "-$1");

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const failed = (message: string) => err("write_failed_not_committed", message, { stage: "backup" });

/**
 * A filename for an extra store's backup, derived from its real path so two
 * stores named location.sqlite on different volumes do not collide: every
 * volume's store shares that same leaf name, so the leaf alone is not
 * unique, but a path-derived digest is.
 */
const storeBackupFilename = (storePath: string) => {
  const leaf = storePath.replaceAll("\\", "/").split("/").pop() || "store.sqlite";
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const ext = dot > 0 ? leaf.slice(dot) : ".sqlite";
  const digest = createHash("sha256").update(storePath).digest("hex").slice(0, 12);
  return `${stem}-${digest}${ext}`;
};

/**
 * Backs up one SQLite database via the backup() API on a read-only
 * connection, verifies it with PRAGMA integrity_check, and drops any -wal/
 * -shm sidecar the check itself produced -- the same path master.sqlite
 * uses, and for the same reason: a plain file copy is not atomic against a
 * live -wal, and a volume's own location.sqlite can carry one too.
 */
async function backupSqliteChecked(sourcePath: string, destPath: string): Promise<void> {
  let src: DatabaseSync | undefined;
  try {
    src = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(src, destPath);
    const copy = new DatabaseSync(destPath, { readOnly: true });
    try {
      const { integrity_check } = copy.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (integrity_check !== "ok") throw new Error(`integrity_check returned ${integrity_check}`);
    } finally {
      copy.close();
    }
  } finally {
    src?.close();
    rmSync(`${destPath}-wal`, { force: true });
    rmSync(`${destPath}-shm`, { force: true });
  }
}

/**
 * Backs up both databases before any write, fail-closed, plus any extra
 * per-volume stores (location.sqlite) a relocate write is about to touch.
 *
 * root.sqlite is a plain file copy verified by hash: it runs in journal_mode
 * DELETE with no sidecars, and apply refuses earlier if a root.sqlite-journal
 * exists. master.sqlite and every extra store go through backup() on a
 * read-only connection -- never a file copy, which is not atomic against a
 * live -wal, and never a checkpoint of the live file.
 */
export async function backupLibrary(
  libraryPath: string,
  stateDir: string,
  libraryId: string,
  extraStores: ExtraStore[] = [],
  now: Date = new Date(),
): Promise<(BackupPaths & { stores: string[] }) | SeratoError> {
  const libraryBackups = join(stateDir, "backups", libraryId);
  const dir = join(libraryBackups, stamp(now));
  const paths: BackupPaths & { stores: string[] } = {
    root: join(dir, "root.sqlite"),
    master: join(dir, "master.sqlite"),
    stores: extraStores.map((store) => join(dir, storeBackupFilename(store.path))),
  };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return failed(`cannot create the backup directory: ${String(e)}`);
  }

  try {
    const source = join(libraryPath, "root.sqlite");
    copyFileSync(source, paths.root);
    if (sha256(source) !== sha256(paths.root)) {
      rmSync(dir, { recursive: true, force: true });
      return failed("the root.sqlite backup does not match the original byte for byte");
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return failed(`cannot back up root.sqlite: ${String(e)}`);
  }

  try {
    await backupSqliteChecked(join(libraryPath, "master.sqlite"), paths.master);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return failed(`cannot back up master.sqlite: ${String(e)}`);
  }

  for (let i = 0; i < extraStores.length; i += 1) {
    try {
      await backupSqliteChecked(extraStores[i].path, paths.stores[i]);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      return failed(`cannot back up the store ${extraStores[i].path}: ${String(e)}`);
    }
  }

  // Retention never fails a backup that already succeeded: an old directory
  // we cannot delete is a disk-space problem, not a reason to refuse a write.
  //
  // The directory names are UTC stamps sorted lexically, which assumes the
  // clock moves forward. If it has moved back since an earlier backup, this
  // call's own stamp can sort before some of the last ten and land in the
  // "oldest" slice -- so this call's own directory is never a deletion
  // candidate, no matter where it sorts.
  const ownStamp = stamp(now);
  try {
    const all = readdirSync(libraryBackups).sort();
    const deletable = all.filter((name) => name !== ownStamp);
    const excess = Math.max(0, all.length - MAX_BACKUPS);
    for (const old of deletable.slice(0, excess)) {
      rmSync(join(libraryBackups, old), { recursive: true, force: true });
    }
  } catch {
    // see above
  }
  // Belt and braces: if the directory this call just wrote is gone regardless,
  // a write must never proceed believing it has a backup it does not.
  if (
    !existsSync(paths.root) ||
    !existsSync(paths.master) ||
    paths.stores.some((store) => !existsSync(store))
  ) {
    return failed("the new backup was removed during retention");
  }
  return paths;
}
