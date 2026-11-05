import { err, type SeratoError } from "../errors.js";

/**
 * Reader for the tag-length-value layout shared by Serato 3.x `database V2`
 * and the legacy `.crate` files: a 4-byte ASCII tag, a 4-byte big-endian
 * length, then that many payload bytes (docs/serato-format-notes.md,
 * sections 2 and 3). Pure and read-only: it works on bytes it is handed and
 * touches no file. Everything it knows about the layout is published by third
 * parties; it has been tested only on generated files, not on files Serato
 * wrote.
 *
 * Errors are values (`SeratoError`, code `malformed_file`), like the rest of
 * the project; nothing here throws on bad input.
 */

export type TlvRecord = { tag: string; payload: Uint8Array };

export type Decoded =
  | { kind: "text"; value: string }
  | { kind: "records"; value: TlvRecord[] }
  | { kind: "u32"; value: number }
  | { kind: "s"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "raw"; value: Uint8Array };

const HEADER = 8;

function bad(message: string, details?: Record<string, unknown>): SeratoError {
  return err("malformed_file", message, details);
}

function isPrintableAscii(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/** Splits a buffer into its records, in order. Fails closed on any damage. */
export function parseRecords(buf: Uint8Array): TlvRecord[] | SeratoError {
  const out: TlvRecord[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos < HEADER) {
      return bad(
        `Truncated record header at offset ${pos}: ${buf.length - pos} of ${HEADER} bytes.`,
        { offset: pos },
      );
    }
    let tag = "";
    for (let i = 0; i < 4; i++) {
      const b = buf[pos + i];
      if (!isPrintableAscii(b)) {
        return bad(
          `Record tag at offset ${pos} is not printable ASCII (byte ${i} is 0x${b.toString(16).padStart(2, "0")}).`,
          { offset: pos },
        );
      }
      tag += String.fromCharCode(b);
    }
    const length = view.getUint32(pos + 4, false);
    const start = pos + HEADER;
    if (length > buf.length - start) {
      return bad(
        `Record "${tag}" at offset ${pos} declares ${length} payload bytes but only ${buf.length - start} remain.`,
        { offset: pos, tag, length },
      );
    }
    out.push({ tag, payload: buf.subarray(start, start + length) });
    pos = start + length;
  }
  return out;
}

/** UTF-16 big-endian text. Odd lengths and unpaired surrogates are refused. */
export function decodeText(payload: Uint8Array): string | SeratoError {
  if (payload.length % 2 !== 0) {
    return bad(`UTF-16 text payload has an odd length (${payload.length}).`);
  }
  let s = "";
  for (let i = 0; i < payload.length; i += 2) {
    const unit = (payload[i] << 8) | payload[i + 1];
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 2 < payload.length ? (payload[i + 2] << 8) | payload[i + 3] : 0;
      if (next < 0xdc00 || next > 0xdfff) return bad("UTF-16 text has an unpaired surrogate.");
      s += String.fromCharCode(unit, next);
      i += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return bad("UTF-16 text has an unpaired surrogate.");
    } else {
      s += String.fromCharCode(unit);
    }
  }
  return s;
}

function wrapText(payload: Uint8Array, tag: string): Decoded | SeratoError {
  const t = decodeText(payload);
  if (typeof t !== "string") return bad(`Record "${tag}": ${t.error.message}`, { tag });
  return { kind: "text", value: t };
}

/**
 * Decodes a payload by the first letter of its tag. `vrsn` is the one exact
 * tag treated as text. Unknown prefixes come back as raw bytes, not guessed.
 *
 * `s`: the sources disagree (serato-tools: unsigned 16-bit; Mixxx-db: signed
 * 32-bit). Only those two widths are accepted -- 2 bytes as unsigned, 4 bytes
 * as signed -- and any other length is refused.
 * `b`: exactly one byte, 0 or 1 (serato-tools); anything else is refused.
 */
export function decodeRecord(rec: TlvRecord): Decoded | SeratoError {
  const { tag, payload } = rec;
  const here = (m: string) => bad(`Record "${tag}": ${m}`, { tag });
  if (tag === "vrsn") return wrapText(payload, tag);
  switch (tag[0]) {
    case "t":
    case "p":
      return wrapText(payload, tag);
    case "o": {
      const inner = parseRecords(payload);
      return Array.isArray(inner) ? { kind: "records", value: inner } : inner;
    }
    case "u": {
      if (payload.length !== 4) return here(`u32 payload must be 4 bytes, got ${payload.length}.`);
      const v = new DataView(payload.buffer, payload.byteOffset, 4);
      return { kind: "u32", value: v.getUint32(0, false) };
    }
    case "s": {
      const v = new DataView(payload.buffer, payload.byteOffset, payload.length);
      if (payload.length === 2) return { kind: "s", value: v.getUint16(0, false) };
      if (payload.length === 4) return { kind: "s", value: v.getInt32(0, false) };
      return here(`s payload must be 2 or 4 bytes, got ${payload.length}.`);
    }
    case "b": {
      if (payload.length !== 1 || payload[0] > 1) {
        return here("boolean payload must be a single byte, 0 or 1.");
      }
      return { kind: "bool", value: payload[0] === 1 };
    }
    default:
      return { kind: "raw", value: payload };
  }
}
