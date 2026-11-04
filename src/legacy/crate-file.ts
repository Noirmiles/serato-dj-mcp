import { err, type SeratoError } from "../errors.js";
import { decodeRecord, parseRecords, type TlvRecord } from "./records.js";

/**
 * Reader for a legacy `_Serato_/Subcrates/<name>.crate` file
 * (docs/serato-format-notes.md, section 3). Read-only and pure. Tested only
 * against generated files, not files Serato wrote.
 */

export type CrateColumn = { name: string; width: string };

export type CrateFile = {
  version: string;
  sortColumn?: string;
  sortReverse?: boolean;
  columns: CrateColumn[];
  /** `ptrk` values in file order. */
  tracks: string[];
  /** Top-level records whose tag is not one of vrsn, osrt, ovct, otrk. */
  unknownTags: number;
};

const VERSION_PREFIX = "1.0/Serato ScratchLive Crate";

function bad(message: string): SeratoError {
  return err("malformed_file", message);
}

function text(rec: TlvRecord): string | SeratoError {
  const d = decodeRecord(rec);
  if ("error" in d) return d;
  return d.kind === "text" ? d.value : bad(`Record "${rec.tag}" is not text.`);
}

function nested(rec: TlvRecord): TlvRecord[] | SeratoError {
  const d = decodeRecord(rec);
  if ("error" in d) return d;
  return d.kind === "records" ? d.value : bad(`Record "${rec.tag}" is not a nested record.`);
}

export function parseCrateFile(buf: Uint8Array): CrateFile | SeratoError {
  const top = parseRecords(buf);
  if ("error" in top) return top;

  let version: string | undefined;
  let sortColumn: string | undefined;
  let sortReverse: boolean | undefined;
  const columns: CrateColumn[] = [];
  const tracks: string[] = [];
  let unknownTags = 0;

  for (const rec of top) {
    switch (rec.tag) {
      case "vrsn": {
        const v = text(rec);
        if (typeof v !== "string") return v;
        version = v;
        // Checked at once: nothing after a foreign version is interpreted.
        if (!v.startsWith(VERSION_PREFIX)) {
          return bad(`Not a Serato crate file: version is "${v}", expected "${VERSION_PREFIX}…".`);
        }
        break;
      }
      case "osrt": {
        const inner = nested(rec);
        if ("error" in inner) return inner;
        for (const f of inner) {
          if (f.tag === "tvcn") {
            const v = text(f);
            if (typeof v !== "string") return v;
            sortColumn = v;
          } else if (f.tag === "brev") {
            const d = decodeRecord(f);
            if ("error" in d) return d;
            if (d.kind !== "bool") return bad(`Record "brev" is not a boolean.`);
            sortReverse = d.value;
          }
        }
        break;
      }
      case "ovct": {
        const inner = nested(rec);
        if ("error" in inner) return inner;
        let name: string | undefined;
        let width = "";
        for (const f of inner) {
          if (f.tag !== "tvcn" && f.tag !== "tvcw") continue;
          const v = text(f);
          if (typeof v !== "string") return v;
          if (f.tag === "tvcn") name = v;
          else width = v;
        }
        if (name === undefined) return bad(`Column record "ovct" has no "tvcn".`);
        columns.push({ name, width });
        break;
      }
      case "otrk": {
        const inner = nested(rec);
        if ("error" in inner) return inner;
        const p = inner.find((f) => f.tag === "ptrk");
        if (p === undefined) return bad(`Track record "otrk" has no "ptrk".`);
        const v = text(p);
        if (typeof v !== "string") return v;
        tracks.push(v);
        break;
      }
      default:
        unknownTags++;
    }
  }

  if (version === undefined) return bad(`Not a Serato crate file: no "vrsn" record.`);
  const out: CrateFile = { version, columns, tracks, unknownTags };
  if (sortColumn !== undefined) out.sortColumn = sortColumn;
  if (sortReverse !== undefined) out.sortReverse = sortReverse;
  return out;
}
