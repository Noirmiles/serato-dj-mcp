/** Synthetic byte builders for Serato marker tags. No real audio anywhere. */

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);

export const entry = (type: string, data: Buffer): Buffer =>
  Buffer.concat([cstr(type), u32(data.length), data]);

export const cueEntry = (index: number, ms: number, rgb: number[], name: string): Buffer =>
  entry(
    "CUE",
    Buffer.concat([Buffer.from([0, index]), u32(ms), Buffer.from([0, ...rgb, 0, 0]), cstr(name)]),
  );

export const loopEntry = (
  index: number,
  start: number,
  end: number,
  locked: boolean,
  name: string,
  type = "LOOP",
): Buffer =>
  entry(
    type,
    Buffer.concat([
      Buffer.from([0, index]),
      u32(start),
      u32(end),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x27, 0xaa, 0xe1, locked ? 1 : 0]),
      cstr(name),
    ]),
  );

export const colorEntry = (rgb: number[]): Buffer => entry("COLOR", Buffer.from([0, ...rgb]));
export const bpmLockEntry = (on: boolean): Buffer => entry("BPMLOCK", Buffer.from([on ? 1 : 0]));

/** Base64 with a line feed every 72 characters. */
export const wrap72 = (b64: string): string => b64.replace(/(.{72})/g, "$1\n");

/** The GEOB data of Serato Markers2: `01 01`, wrapped base64, NUL padding. */
export function markers2Payload(entries: Buffer[], opts: { rawText?: string } = {}): Buffer {
  const inner = Buffer.concat([Buffer.from([1, 1]), ...entries, Buffer.from([0])]);
  const text = Buffer.from(opts.rawText ?? wrap72(inner.toString("base64")), "latin1");
  const padded = Buffer.concat([Buffer.from([1, 1]), text]);
  return padded.length >= 470 ? padded : Buffer.concat([padded, Buffer.alloc(470 - padded.length)]);
}

export function geobFrameData(payload: Buffer, description = "Serato Markers2"): Buffer {
  return Buffer.concat([
    Buffer.from([0]),
    cstr("application/octet-stream"),
    cstr(""),
    cstr(description),
    payload,
  ]);
}

const synchsafe = (n: number): Buffer =>
  Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

export function id3Frame(id: string, data: Buffer, version: 3 | 4): Buffer {
  return Buffer.concat([
    Buffer.from(id, "latin1"),
    version === 4 ? synchsafe(data.length) : u32(data.length),
    Buffer.alloc(2),
    data,
  ]);
}

export function id3Tag(frames: Buffer[], version: 3 | 4 = 3, pad = 64): Buffer {
  const body = Buffer.concat([...frames, Buffer.alloc(pad)]);
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, version, 0, 0]),
    synchsafe(body.length),
    body,
  ]);
}

/** An MP3-ish file: the ID3 tag followed by junk standing in for audio. */
export const mp3File = (tag: Buffer): Buffer =>
  Buffer.concat([tag, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64, 0x55)]);

export function aiffFile(tag: Buffer): Buffer {
  const comm = Buffer.concat([Buffer.from("COMM"), u32(18), Buffer.alloc(18)]);
  const odd = tag.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const id3 = Buffer.concat([Buffer.from("ID3 "), u32(tag.length), tag, odd]);
  const body = Buffer.concat([Buffer.from("AIFF"), comm, id3]);
  return Buffer.concat([Buffer.from("FORM"), u32(body.length), body]);
}

const le32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

export function flacFile(markers: { payload: Buffer } | null, other: string[] = []): Buffer {
  const comments = [...other];
  if (markers) {
    const content = Buffer.concat([
      cstr("application/octet-stream"),
      cstr("Serato Markers2"),
      markers.payload,
    ]);
    // FLAC carries the value as base64 without padding.
    comments.push(`SERATO_MARKERS_V2=${wrap72(content.toString("base64").replace(/=+$/, ""))}`);
  }
  const vendor = Buffer.from("synthetic");
  const body = Buffer.concat([
    le32(vendor.length),
    vendor,
    le32(comments.length),
    ...comments.flatMap((c) => [le32(Buffer.byteLength(c)), Buffer.from(c)]),
  ]);
  const blockHeader = (type: number, last: boolean, len: number) =>
    Buffer.from([(last ? 0x80 : 0) | type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([
    Buffer.from("fLaC"),
    blockHeader(0, false, 34),
    Buffer.alloc(34),
    blockHeader(4, true, body.length),
    body,
    Buffer.alloc(32, 0xaa),
  ]);
}
