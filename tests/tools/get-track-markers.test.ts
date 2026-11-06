import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { getTrackMarkers, resolveAudioPath } from "../../src/tools/get-track-markers.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { makeMasterFixture } from "../fixtures/make.js";
import {
  colorEntry,
  cueEntry,
  flacFile,
  geobFrameData,
  id3Frame,
  id3Tag,
  loopEntry,
  markers2Payload,
  mp3File,
} from "../markers/build.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-gtm-"));

const payload = markers2Payload([
  cueEntry(0, 1500, [0xcc, 0, 0], "Intro"),
  loopEntry(1, 2000, 6000, false, "L"),
  colorEntry([1, 2, 3]),
]);

/** A library whose volume root is a temp dir holding the given audio files. */
async function setup(files: Record<string, Buffer>, portableIds = Object.keys(files)) {
  const music = tmp();
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(music, name), bytes);
  const lib = tmp();
  makeMasterFixture(lib, {
    connectionUri: join(music, "_Serato_", "Library", "location.sqlite"),
    tracks: portableIds.map((p, i) => ({ externalId: i + 1, portableId: p, name: `T${i}` })),
  });
  const ctx = { library: lib, roots: [], cacheDir: tmp() };
  const found = await searchTracks({ sort: "added:asc" }, ctx);
  if (isSeratoError(found)) throw new Error("search failed");
  return { ctx, ids: found.tracks.map((t) => t.id as number), music };
}

describe("get_track_markers", () => {
  it("returns cues, loops and colour for an MP3 and FLAC, and leaves the files untouched", async () => {
    const mp3 = mp3File(id3Tag([id3Frame("GEOB", geobFrameData(payload), 3)]));
    const flac = flacFile({ payload });
    const { ctx, ids, music } = await setup({ "a.mp3": mp3, "b.flac": flac });
    const sha = (f: string) =>
      createHash("sha256")
        .update(readFileSync(join(music, f)))
        .digest("hex");
    const before = [sha("a.mp3"), sha("b.flac")];

    for (const id of ids) {
      const r = await getTrackMarkers({ id }, ctx);
      if (isSeratoError(r)) throw new Error(r.error.message);
      expect(r.cues).toEqual([{ index: 0, position_ms: 1500, color: "#cc0000", name: "Intro" }]);
      expect(r.loops).toEqual([
        { index: 1, start_ms: 2000, end_ms: 6000, locked: false, name: "L" },
      ]);
      expect(r.track_color).toBe("#010203");
      expect(r.warnings).toBeUndefined();
    }
    expect([sha("a.mp3"), sha("b.flac")]).toEqual(before);
  });

  it("warns, rather than failing, when the file is missing", async () => {
    const { ctx, ids } = await setup({}, ["gone.mp3"]);
    const r = await getTrackMarkers({ id: ids[0] }, ctx);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r.cues).toEqual([]);
    expect(r.warnings?.map((w) => w.code)).toEqual(["file_missing"]);
  });

  it("warns on an unsupported format and on a file without the tag", async () => {
    const { ctx, ids } = await setup({
      "a.ogg": Buffer.concat([Buffer.from("OggS"), Buffer.alloc(30)]),
      "b.mp3": mp3File(id3Tag([])),
    });
    const codes: (string | undefined)[] = [];
    for (const id of ids) {
      const r = await getTrackMarkers({ id }, ctx);
      if (isSeratoError(r)) throw new Error(r.error.message);
      codes.push(r.warnings?.[0]?.code);
    }
    expect(codes).toEqual(["unsupported_format", "no_tag"]);
  });

  it("surfaces bad base64 as a warning", async () => {
    const bad = markers2Payload([], { rawText: "@@@@" });
    const { ctx, ids } = await setup({
      "a.mp3": mp3File(id3Tag([id3Frame("GEOB", geobFrameData(bad), 3)])),
    });
    const r = await getTrackMarkers({ id: ids[0] }, ctx);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r.warnings?.map((w) => w.code)).toEqual(["bad_base64"]);
  });

  it("returns unknown_ids for an id that is not in the library", async () => {
    const { ctx } = await setup({});
    const r = await getTrackMarkers({ id: 99999 }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("unknown_ids");
  });

  it("rejects unexpected arguments", async () => {
    const { ctx } = await setup({});
    const r = await getTrackMarkers({ id: 1, extra: true }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("invalid_argument");
  });

  it("reads a track whose stored path is absolute", async () => {
    const music = tmp();
    mkdirSync(join(music, "sub"));
    const file = join(music, "sub", "c.mp3");
    writeFileSync(file, mp3File(id3Tag([id3Frame("GEOB", geobFrameData(payload), 3)])));
    const lib = tmp();
    makeMasterFixture(lib, { tracks: [{ externalId: 1, portableId: file, name: "T" }] });
    const ctx = { library: lib, roots: [], cacheDir: tmp() };
    const found = await searchTracks({}, ctx);
    if (isSeratoError(found)) throw new Error("search failed");
    const r = await getTrackMarkers({ id: found.tracks[0]?.id }, ctx);
    if (isSeratoError(r)) throw new Error(r.error.message);
    expect(r.cues).toHaveLength(1);
  });
});

describe("resolveAudioPath", () => {
  it("joins a relative id onto a Windows drive root with backslashes", () => {
    expect(resolveAudioPath("Music/a b/c.mp3", "D:\\")).toBe("D:\\Music\\a b\\c.mp3");
  });
  it("keeps a stored drive-letter or UNC path as it is", () => {
    expect(resolveAudioPath("C:/Music/c.mp3", "D:\\")).toBe("C:/Music/c.mp3");
    expect(resolveAudioPath("\\\\nas\\m\\c.mp3", undefined)).toBe("\\\\nas\\m\\c.mp3");
  });
  it("joins onto a POSIX root", () => {
    expect(resolveAudioPath("Music/c.mp3", "/Volumes/X")).toBe("/Volumes/X/Music/c.mp3");
  });
  it("gives null for streaming ids and for an unknown root", () => {
    expect(resolveAudioPath("streaming://x", "/")).toBeNull();
    expect(resolveAudioPath("Music/c.mp3", undefined)).toBeNull();
  });
});
