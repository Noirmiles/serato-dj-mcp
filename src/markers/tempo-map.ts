/**
 * Pure parsers for Serato's grid tags. Formats come from reverse engineering
 * (see docs/serato-format-notes.md); unknown fields are reported raw. Never throw.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export type TempoMarker = {
  /** Unit unknown. A string when it exceeds Number.MAX_SAFE_INTEGER. */
  position: number | string;
  tempo: number;
  beat_note_value: number;
  interpolation: "stepped" | "linear" | "curved" | "unknown";
  interpolation_raw: number;
  /** null for V1, which has no curvature field. */
  curvature: number | null;
};

export type TempoMap = {
  version: 1 | 2;
  header_field: number | null;
  mode: number | null;
  origin_seconds: number;
  markers: TempoMarker[];
};

export type BeatGridMarker =
  | { position_seconds: number; beats_to_next: number }
  | { position_seconds: number; bpm: number };

const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

const INTERP: Record<number, TempoMarker["interpolation"]> = {
  1: "stepped",
  2: "linear",
  3: "curved",
};

const safeInt = (v: bigint): number | string =>
  v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString();

export function parseTempoMap(b: Uint8Array): Parsed<TempoMap> {
  try {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.length);
    if (buf.length < 1) return bad("Tempo Map is empty");
    const version = buf[0];
    let pos: number;
    let count: number;
    let header: number | null = null;
    let mode: number | null = null;
    let origin = 0;
    let perMarker: number;
    if (version === 2) {
      if (buf.length < 16) return bad("Tempo Map V2 header is truncated");
      header = buf.readUInt16BE(1);
      mode = buf[3] as number;
      if (mode > 3) return bad(`Tempo Map mode ${mode} is outside 0..3`);
      origin = buf.readDoubleBE(4);
      count = buf.readUInt32BE(12);
      pos = 16;
      perMarker = 8 + 8 + 8 + 1 + 8;
    } else if (version === 1) {
      if (buf.length < 5) return bad("Tempo Map V1 header is truncated");
      count = buf.readUInt32BE(1);
      pos = 5;
      perMarker = 8 + 8 + 8 + 8 + 1;
    } else {
      return bad(`unsupported Tempo Map version ${version}`);
    }
    if (count < 1) return bad("Tempo Map has no markers");
    // Checked against the bytes left, so a hostile count cannot drive the loop.
    if (buf.length - pos !== count * perMarker) {
      return bad(`Tempo Map declares ${count} markers but holds ${buf.length - pos} bytes of them`);
    }
    const markers: TempoMarker[] = [];
    let base = 0n;
    for (let i = 0; i < count; i++) {
      if (version === 1) {
        const t = buf.readDoubleBE(pos);
        if (i === 0) origin = t;
        pos += 8;
      }
      const raw = buf.readBigInt64BE(pos);
      if (i === 0) base = raw;
      if (version === 2 && i === 0 && raw !== 0n) return bad("first Tempo Map marker is not at 0");
      const tempo = buf.readDoubleBE(pos + 8);
      const note = buf.readDoubleBE(pos + 16);
      const interp = buf[pos + 24] as number;
      pos += 25;
      let curvature: number | null = null;
      if (version === 2) {
        curvature = buf.readDoubleBE(pos);
        pos += 8;
        if (!(Math.abs(curvature) <= 1)) return bad(`marker ${i} curvature is outside -1..1`);
      }
      if (!(tempo > 0) || !Number.isFinite(tempo)) return bad(`marker ${i} tempo is not positive`);
      if (!(note > 0) || !Number.isFinite(note)) {
        return bad(`marker ${i} beat note value is not positive`);
      }
      markers.push({
        position: safeInt(raw - base),
        tempo,
        beat_note_value: note,
        interpolation: INTERP[interp] ?? "unknown",
        interpolation_raw: interp,
        curvature,
      });
    }
    return {
      ok: true,
      value: {
        version: version as 1 | 2,
        header_field: header,
        mode,
        origin_seconds: origin,
        markers,
      },
    };
  } catch (e) {
    return bad(`Tempo Map could not be read: ${(e as Error).message}`);
  }
}

/** Legacy `Serato BeatGrid`: 01 00, u32 N, N-1 {f32, u32}, {f32, f32 bpm}, optional footer byte. */
export function parseBeatGrid(b: Uint8Array): Parsed<BeatGridMarker[]> {
  try {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.length);
    if (buf.length < 6) return bad("BeatGrid is truncated");
    if (buf[0] !== 1 || buf[1] !== 0) return bad("BeatGrid does not start with 01 00");
    const n = buf.readUInt32BE(2);
    if (n < 1) return bad("BeatGrid has no markers");
    const body = buf.length - 6;
    const need = n * 8; // overflow-safe: n is at most 2^32 and body is small
    if (body !== need && body !== need + 1) {
      return bad(`BeatGrid declares ${n} markers but holds ${body} bytes of them`);
    }
    const out: BeatGridMarker[] = [];
    let pos = 6;
    for (let i = 0; i < n - 1; i++, pos += 8) {
      out.push({
        position_seconds: buf.readFloatBE(pos),
        beats_to_next: buf.readUInt32BE(pos + 4),
      });
    }
    out.push({ position_seconds: buf.readFloatBE(pos), bpm: buf.readFloatBE(pos + 4) });
    return { ok: true, value: out };
  } catch (e) {
    return bad(`BeatGrid could not be read: ${(e as Error).message}`);
  }
}
