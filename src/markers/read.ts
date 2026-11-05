import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { decodeBase64Strict, type Markers2Result, parseMarkers2 } from "./markers2.js";

/**
 * Locates and reads the Serato Markers2 tag of an audio file. Read-only: the
 * file is opened with flag "r" and only ranges are read, never the whole
 * audio. Anything that goes wrong is returned as a `status`, not thrown.
 */

/** A tag larger than this is treated as corrupt rather than read into memory. */
export const MAX_TAG_BYTES = 16 * 1024 * 1024;

export type MarkersReadStatus =
  | "ok"
  | "file_missing"
  | "unreadable"
  | "unsupported_format"
  | "no_tag"
  | "malformed";

export type MarkersReadResult = {
  status: MarkersReadStatus;
  format: "mp3" | "aiff" | "flac" | null;
  message?: string;
  parsed?: Markers2Result;
};

const GEOB_NAME = "Serato Markers2";
const FLAC_KEY = "SERATO_MARKERS_V2";

class Reader {
  constructor(
    private fd: number,
    readonly size: number,
  ) {}
  at(pos: number, len: number): Buffer | null {
    if (pos < 0 || len < 0 || pos + len > this.size) return null;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(this.fd, buf, got, len - got, pos + got);
      if (n === 0) return null;
      got += n;
    }
    return buf;
  }
}

function synchsafe(b: Buffer, at: number): number {
  return (
    ((b[at] as number) & 0x7f) * 0x200000 +
    ((b[at + 1] as number) & 0x7f) * 0x4000 +
    ((b[at + 2] as number) & 0x7f) * 0x80 +
    ((b[at + 3] as number) & 0x7f)
  );
}

const unsync = (b: Buffer): Buffer => {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i] as number);
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return Buffer.from(out);
};

/** Index of the NUL terminator for the encoding (UTF-16 needs 2 aligned bytes). */
function findTerminator(b: Buffer, from: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return -1;
  }
  return b.indexOf(0, from);
}

/** The data of the GEOB frame called Serato Markers2, or null. */
function geobPayload(frame: Buffer): Buffer | null {
  if (frame.length < 1) return null;
  const enc = frame[0] as number;
  const wide = enc === 1 || enc === 2;
  const mimeEnd = frame.indexOf(0, 1); // MIME type is always Latin-1
  if (mimeEnd < 0) return null;
  const fileEnd = findTerminator(frame, mimeEnd + 1, enc);
  if (fileEnd < 0) return null;
  const descStart = fileEnd + (wide ? 2 : 1);
  const descEnd = findTerminator(frame, descStart, enc);
  if (descEnd < 0) return null;
  const raw = frame.subarray(descStart, descEnd);
  const desc = wide ? raw.toString("utf16le") : raw.toString("latin1");
  if (desc.replace(/^﻿/, "") !== GEOB_NAME) return null;
  return frame.subarray(descEnd + (wide ? 2 : 1));
}

type Found = { payload: Buffer } | { malformed: string } | null;

function findInId3(tag: Buffer, major: number, flags: number): Found {
  let body = tag;
  if (flags & 0x80 && major === 3) body = unsync(body);
  let pos = 0;
  if (flags & 0x40) {
    if (body.length < 4) return { malformed: "ID3 extended header is truncated" };
    pos = major === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
  }
  while (pos + 10 <= body.length) {
    if (body[pos] === 0) break; // padding
    const id = body.toString("latin1", pos, pos + 4);
    const size = major === 4 ? synchsafe(body, pos + 4) : body.readUInt32BE(pos + 4);
    const fflags = body.readUInt16BE(pos + 8);
    const start = pos + 10;
    if (start + size > body.length) {
      return id === "GEOB" ? { malformed: "ID3 GEOB frame runs past the end of the tag" } : null;
    }
    pos = start + size;
    if (id !== "GEOB") continue;
    let data = body.subarray(start, start + size);
    // v2.3 frame flags: 0x0080 compression, 0x0040 encryption. v2.4: 0x0008
    // compression, 0x0004 encryption, 0x0002 unsynchronisation, 0x0001 data
    // length indicator. Compressed or encrypted frames cannot be read here.
    if (major === 3 && fflags & 0x00c0) continue;
    if (major === 4) {
      if (fflags & 0x000c) continue;
      if (fflags & 0x0001) data = data.subarray(4);
      if (fflags & 0x0002) data = unsync(data);
    }
    const payload = geobPayload(data);
    if (payload) return { payload };
  }
  return null;
}

function readId3At(r: Reader, offset: number): Found {
  const head = r.at(offset, 10);
  if (head === null || head.toString("latin1", 0, 3) !== "ID3") return null;
  const major = head[3] as number;
  if (major !== 3 && major !== 4) return { malformed: `unsupported ID3v2.${major} tag` };
  const size = synchsafe(head, 6);
  if (size > MAX_TAG_BYTES) return { malformed: "ID3 tag is implausibly large" };
  const tag = r.at(offset + 10, size);
  if (!tag) return { malformed: "ID3 tag is truncated" };
  return findInId3(tag, major, head[5] as number);
}

function findInAiff(r: Reader): Found {
  let pos = 12;
  while (pos + 8 <= r.size) {
    const head = r.at(pos, 8) as Buffer;
    const id = head.toString("latin1", 0, 4);
    const size = head.readUInt32BE(4);
    if (id === "ID3 " || id === "id3 ") return readId3At(r, pos + 8);
    pos += 8 + size + (size & 1);
  }
  return null;
}

function decodeFlacValue(value: string): Found {
  const decoded = decodeBase64Strict(Buffer.from(value, "latin1"));
  if (decoded === null) return { malformed: "SERATO_MARKERS_V2 is not valid base64" };
  // GEOB-style content: mime, NUL, tag name, NUL, payload. Tolerate a bare
  // payload (starting 01 01) in case a writer omits the prefix.
  if (decoded[0] === 1 && decoded[1] === 1) return { payload: decoded };
  const mimeEnd = decoded.indexOf(0);
  const nameEnd = mimeEnd < 0 ? -1 : decoded.indexOf(0, mimeEnd + 1);
  if (nameEnd < 0) return { malformed: "SERATO_MARKERS_V2 has no GEOB-style prefix" };
  return { payload: decoded.subarray(nameEnd + 1) };
}

function findInVorbis(b: Buffer): Found {
  const bad = { malformed: "Vorbis comment block is malformed" };
  if (b.length < 8) return bad;
  let pos = 4 + b.readUInt32LE(0);
  if (pos + 4 > b.length) return bad;
  const count = b.readUInt32LE(pos);
  pos += 4;
  for (let i = 0; i < count; i++) {
    if (pos + 4 > b.length) return bad;
    const n = b.readUInt32LE(pos);
    pos += 4;
    if (pos + n > b.length) return bad;
    const s = b.toString("utf8", pos, pos + n);
    pos += n;
    const eq = s.indexOf("=");
    if (eq > 0 && s.slice(0, eq).toUpperCase() === FLAC_KEY) {
      return decodeFlacValue(s.slice(eq + 1));
    }
  }
  return null;
}

function findInFlac(r: Reader): Found {
  let pos = 4;
  for (;;) {
    const head = r.at(pos, 4);
    if (!head) return { malformed: "FLAC metadata is truncated" };
    const last = (head[0] as number) & 0x80;
    const type = (head[0] as number) & 0x7f;
    const len = head.readUIntBE(1, 3);
    if (type === 4) {
      const b = r.at(pos + 4, len);
      if (!b) return { malformed: "Vorbis comment block is truncated" };
      return findInVorbis(b);
    }
    if (last) return null;
    pos += 4 + len;
  }
}

export function readMarkersFromFile(path: string): MarkersReadResult {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const missing = code === "ENOENT" || code === "ENOTDIR";
    return {
      status: missing ? "file_missing" : "unreadable",
      format: null,
      message: missing ? "audio file not found" : `cannot open audio file (${code ?? "error"})`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { status: "unreadable", format: null, message: "not a regular file" };
    const r = new Reader(fd, st.size);
    const magic = r.at(0, 4)?.toString("latin1") ?? "";
    let format: "mp3" | "aiff" | "flac";
    let found: Found;
    if (magic.startsWith("ID3")) {
      format = "mp3";
      found = readId3At(r, 0);
    } else if (magic === "fLaC") {
      format = "flac";
      found = findInFlac(r);
    } else if (magic === "FORM") {
      const kind = r.at(8, 4)?.toString("latin1");
      if (kind !== "AIFF" && kind !== "AIFC") {
        return { status: "unsupported_format", format: null, message: "not an AIFF file" };
      }
      format = "aiff";
      found = findInAiff(r);
    } else {
      return {
        status: "unsupported_format",
        format: null,
        message: "only MP3 (with an ID3v2 tag), AIFF and FLAC are supported",
      };
    }
    if (found === null) {
      return { status: "no_tag", format, message: "no Serato Markers2 tag in this file" };
    }
    if ("malformed" in found) return { status: "malformed", format, message: found.malformed };
    return { status: "ok", format, parsed: parseMarkers2(found.payload) };
  } catch (e) {
    return { status: "unreadable", format: null, message: `read failed: ${(e as Error).message}` };
  } finally {
    closeSync(fd);
  }
}
