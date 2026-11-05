/**
 * Decoder for the payload of Serato's "Markers2" tag (see
 * docs/serato-format-notes.md, section 4). Pure: bytes in, a value out; it
 * never throws on bad input, it reports what it could not read.
 *
 * Layout, as published by Holzhaus-tags (unverified against Serato 4.x):
 * header `01 01`, base64 text with a line feed every 72 characters and NUL
 * padding after it; the decoded bytes are `01 01`, a series of entries (a
 * NUL-terminated ASCII type name, a 32-bit big-endian length, the data) and
 * a closing `00`.
 */

export type Cue = { index: number; position_ms: number; color: string; name: string };
export type Loop = {
  index: number;
  start_ms: number;
  end_ms: number;
  locked: boolean;
  name: string;
};

export type Markers2 = {
  cues: Cue[];
  loops: Loop[];
  track_color: string | null;
  bpm_locked: boolean | null;
  /** Entry types seen but not decoded (FLIP, or anything newer). */
  unparsed_entry_types: string[];
};

export type MarkersProblem = { code: "bad_base64" | "truncated" | "bad_payload"; message: string };

export type Markers2Result = { markers: Markers2; problems: MarkersProblem[] };

const emptyMarkers = (): Markers2 => ({
  cues: [],
  loops: [],
  track_color: null,
  bpm_locked: null,
  unparsed_entry_types: [],
});

const hex = (b: Uint8Array, at: number): string =>
  `#${[0, 1, 2].map((i) => (b[at + i] as number).toString(16).padStart(2, "0")).join("")}`;

function cString(b: Uint8Array, from: number): string {
  let end = from;
  while (end < b.length && b[end] !== 0) end++;
  return Buffer.from(b.subarray(from, end)).toString("utf8");
}

/**
 * Decodes base64 text strictly: Buffer.from silently skips characters that
 * are not base64, which would turn a corrupt tag into plausible garbage.
 * Line feeds and trailing NUL padding are allowed. Returns null if invalid.
 */
export function decodeBase64Strict(text: Uint8Array): Buffer | null {
  let end = text.length;
  while (end > 0 && text[end - 1] === 0) end--; // NUL padding
  const s = Buffer.from(text.subarray(0, end))
    .toString("latin1")
    .replace(/[\r\n]/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  let body = s.replace(/=+$/, "");
  // The documented quirk: the text can come out one character too long,
  // which no base64 length allows; appending "A" is the known workaround.
  if (body.length % 4 === 1) body += "A";
  return Buffer.from(body, "base64");
}

/** `payload` is the GEOB data: `01 01` followed by the base64 text. */
export function parseMarkers2(payload: Uint8Array): Markers2Result {
  const markers = emptyMarkers();
  const problems: MarkersProblem[] = [];
  if (payload.length < 2 || payload[0] !== 1 || payload[1] !== 1) {
    problems.push({ code: "bad_payload", message: "Markers2 payload does not start with 01 01" });
    return { markers, problems };
  }
  const decoded = decodeBase64Strict(payload.subarray(2));
  if (decoded === null) {
    problems.push({ code: "bad_base64", message: "Markers2 payload is not valid base64" });
    return { markers, problems };
  }
  if (decoded.length < 2 || decoded[0] !== 1 || decoded[1] !== 1) {
    problems.push({ code: "bad_payload", message: "decoded Markers2 does not start with 01 01" });
    return { markers, problems };
  }

  let pos = 2;
  while (pos < decoded.length) {
    if (decoded[pos] === 0) break; // the closing 00
    let nameEnd = pos;
    while (nameEnd < decoded.length && decoded[nameEnd] !== 0) nameEnd++;
    if (nameEnd + 5 > decoded.length) {
      problems.push({ code: "truncated", message: "Markers2 ends inside an entry header" });
      break;
    }
    const type = decoded.toString("latin1", pos, nameEnd);
    const len = decoded.readUInt32BE(nameEnd + 1);
    const start = nameEnd + 5;
    if (start + len > decoded.length) {
      problems.push({
        code: "truncated",
        message: `Markers2 entry ${type} claims ${len} bytes but only ${decoded.length - start} remain`,
      });
      break;
    }
    const d = decoded.subarray(start, start + len);
    pos = start + len;

    if (type === "CUE" && d.length >= 12) {
      markers.cues.push({
        index: d[1] as number,
        position_ms: d.readUInt32BE(2),
        color: hex(d, 7),
        name: cString(d, 12),
      });
    } else if (type === "LOOP" && d.length >= 19) {
      markers.loops.push({
        index: d[1] as number,
        start_ms: d.readUInt32BE(2),
        end_ms: d.readUInt32BE(6),
        locked: d[18] !== 0,
        name: cString(d, 19),
      });
    } else if (type === "COLOR" && d.length >= 4) {
      markers.track_color = hex(d, 1);
    } else if (type === "BPMLOCK" && d.length >= 1) {
      markers.bpm_locked = d[0] !== 0;
    } else if (!markers.unparsed_entry_types.includes(type)) {
      // Includes a known type whose data is too short to decode.
      markers.unparsed_entry_types.push(type);
    }
  }
  return { markers, problems };
}
