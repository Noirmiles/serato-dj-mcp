import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkers2 } from "../../src/markers/markers2.js";
import { readMarkersFromFile } from "../../src/markers/read.js";
import {
  aiffFile,
  bpmLockEntry,
  colorEntry,
  cueEntry,
  entry,
  flacFile,
  geobFrameData,
  id3Frame,
  id3Tag,
  loopEntry,
  markers2Payload,
  mp3File,
} from "./build.js";

const dir = mkdtempSync(join(tmpdir(), "serato-mk-"));
let n = 0;
const write = (bytes: Buffer, name = `f${n++}.bin`) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};

const entries = () => [
  cueEntry(0, 1500, [0xcc, 0x00, 0x00], "Intro"),
  cueEntry(3, 61_250, [0x00, 0xcc, 0xff], ""),
  loopEntry(0, 2000, 6000, true, "Loop é"),
  colorEntry([0x12, 0x34, 0x56]),
  bpmLockEntry(true),
];

const expected = {
  cues: [
    { index: 0, position_ms: 1500, color: "#cc0000", name: "Intro" },
    { index: 3, position_ms: 61250, color: "#00ccff", name: "" },
  ],
  loops: [{ index: 0, start_ms: 2000, end_ms: 6000, locked: true, name: "Loop é" }],
  track_color: "#123456",
  bpm_locked: true,
};

describe("parseMarkers2", () => {
  it("decodes cues, loops, colour and bpm lock", () => {
    const { markers, problems } = parseMarkers2(markers2Payload(entries()));
    expect(problems).toEqual([]);
    expect(markers).toMatchObject(expected);
  });

  it("decodes CUELOOP like LOOP into cue_loops", () => {
    const { markers, unparsed } = (({ markers }) => ({
      markers,
      unparsed: markers.unparsed_entry_types,
    }))(parseMarkers2(markers2Payload([loopEntry(1, 100, 900, false, "CL", "CUELOOP")])));
    expect(markers.cue_loops).toEqual([
      { index: 1, start_ms: 100, end_ms: 900, locked: false, name: "CL" },
    ]);
    expect(markers.loops).toEqual([]);
    expect(unparsed).toEqual([]);
  });

  it("reports an entry type it cannot decode instead of dropping it silently", () => {
    const { markers } = parseMarkers2(markers2Payload([entry("FLIP", Buffer.alloc(5))]));
    expect(markers.unparsed_entry_types).toEqual(["FLIP"]);
  });

  it("rejects bad base64 without throwing", () => {
    const { markers, problems } = parseMarkers2(markers2Payload([], { rawText: "AQE!!!not b64" }));
    expect(problems.map((p) => p.code)).toEqual(["bad_base64"]);
    expect(markers.cues).toEqual([]);
  });

  it("rejects a payload without the 01 01 header", () => {
    expect(parseMarkers2(Buffer.from("garbage")).problems[0]?.code).toBe("bad_payload");
  });

  it("keeps the entries before a truncated one and says so", () => {
    const full = Buffer.concat([cueEntry(0, 10, [1, 2, 3], "A"), cueEntry(1, 20, [4, 5, 6], "B")]);
    // Cut in the middle of the second entry's data.
    const inner = Buffer.concat([Buffer.from([1, 1]), full]).subarray(0, full.length - 4);
    const payload = markers2Payload([], { rawText: inner.toString("base64") });
    const { markers, problems } = parseMarkers2(payload);
    expect(markers.cues.map((c) => c.name)).toEqual(["A"]);
    expect(problems.map((p) => p.code)).toEqual(["truncated"]);
  });
});

describe("readMarkersFromFile", () => {
  it("reads an MP3 with an ID3v2.3 GEOB frame", () => {
    const tag = id3Tag([id3Frame("GEOB", geobFrameData(markers2Payload(entries())), 3)], 3);
    const r = readMarkersFromFile(write(mp3File(tag)));
    expect(r.status).toBe("ok");
    expect(r.format).toBe("mp3");
    expect(r.parsed?.markers).toMatchObject(expected);
  });

  it("reads ID3v2.4 and skips unrelated frames and other GEOB tags", () => {
    const tag = id3Tag(
      [
        id3Frame("TIT2", Buffer.from("\0title"), 4),
        id3Frame("GEOB", geobFrameData(Buffer.from([1, 2]), "Serato Overview"), 4),
        id3Frame("GEOB", geobFrameData(markers2Payload(entries())), 4),
      ],
      4,
    );
    const r = readMarkersFromFile(write(mp3File(tag)));
    expect(r.parsed?.markers).toMatchObject(expected);
  });

  it("reads the ID3 chunk of an AIFF", () => {
    const tag = id3Tag([id3Frame("GEOB", geobFrameData(markers2Payload(entries())), 3)], 3, 13);
    const r = readMarkersFromFile(write(aiffFile(tag)));
    expect(r.format).toBe("aiff");
    expect(r.parsed?.markers).toMatchObject(expected);
  });

  it("reads SERATO_MARKERS_V2 from a FLAC Vorbis comment", () => {
    const r = readMarkersFromFile(
      write(flacFile({ payload: markers2Payload(entries()) }, ["TITLE=x"])),
    );
    expect(r.status).toBe("ok");
    expect(r.format).toBe("flac");
    expect(r.parsed?.markers).toMatchObject(expected);
  });

  it("returns no_tag when the file has none", () => {
    expect(readMarkersFromFile(write(mp3File(id3Tag([])))).status).toBe("no_tag");
    expect(readMarkersFromFile(write(flacFile(null, ["TITLE=x"]))).status).toBe("no_tag");
  });

  it("returns unsupported_format for other containers", () => {
    const r = readMarkersFromFile(write(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40)])));
    expect(r.status).toBe("unsupported_format");
    expect(r.format).toBeNull();
    expect(readMarkersFromFile(write(Buffer.alloc(0))).status).toBe("unsupported_format");
  });

  it("returns file_missing for a path that does not exist", () => {
    expect(readMarkersFromFile(join(dir, "nope.mp3")).status).toBe("file_missing");
  });

  it("returns malformed for a tag cut short, without throwing", () => {
    const tag = id3Tag([id3Frame("GEOB", geobFrameData(markers2Payload(entries())), 3)], 3);
    const cut = mp3File(tag).subarray(0, 120);
    expect(readMarkersFromFile(write(cut)).status).toBe("malformed");
    const flac = flacFile({ payload: markers2Payload(entries()) }).subarray(0, 100);
    expect(readMarkersFromFile(write(flac)).status).toBe("malformed");
  });
});
