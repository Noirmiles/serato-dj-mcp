import { describe, expect, it } from "vitest";
import { parseCrateFile } from "../../src/legacy/crate-file.js";
import { concat, makeCrate, record, textRecord } from "../fixtures/make-crate.js";

const malformed = { error: { code: "malformed_file" } };

describe("parseCrateFile", () => {
  it("round-trips a full generated crate, tracks in file order", () => {
    const tracks = [
      "Music/Synthetic/b.mp3",
      "Music/Björk/Été.mp3",
      "Music/日本/曲.mp3",
      "Music/a.mp3",
    ];
    const buf = makeCrate({
      columns: [
        { name: "song", width: "0" },
        { name: "bpm", width: "120" },
      ],
      sort: { column: "key", reverse: true },
      tracks,
    });
    expect(parseCrateFile(buf)).toEqual({
      version: "1.0/Serato ScratchLive Crate",
      sortColumn: "key",
      sortReverse: true,
      columns: [
        { name: "song", width: "0" },
        { name: "bpm", width: "120" },
      ],
      tracks,
      unknownTags: 0,
    });
  });

  it("reads an empty crate and omits sort fields that are absent", () => {
    const r = parseCrateFile(makeCrate());
    expect(r).toEqual({
      version: "1.0/Serato ScratchLive Crate",
      columns: [],
      tracks: [],
      unknownTags: 0,
    });
    expect(r).not.toHaveProperty("sortColumn");
  });

  it("reads a sort setting that is not reversed", () => {
    expect(parseCrateFile(makeCrate({ sort: { column: "bpm" } }))).toMatchObject({
      sortColumn: "bpm",
      sortReverse: false,
    });
  });

  it("ignores unknown top-level tags but counts them", () => {
    const buf = makeCrate({
      tracks: ["Music/a.mp3"],
      extra: [
        ["zzzz", new Uint8Array([1, 2, 3])],
        ["ofoo", textRecord("tbar", "x")],
      ],
    });
    expect(parseCrateFile(buf)).toMatchObject({ tracks: ["Music/a.mp3"], unknownTags: 2 });
  });

  it("refuses a missing vrsn", () => {
    const buf = record("otrk", textRecord("ptrk", "Music/a.mp3"));
    expect(parseCrateFile(buf)).toMatchObject(malformed);
    expect(parseCrateFile(new Uint8Array())).toMatchObject(malformed);
  });

  it("refuses a wrong version, including the smart-crate one", () => {
    expect(
      parseCrateFile(makeCrate({ version: "1.0/Serato ScratchLive Smart Crate" })),
    ).toMatchObject(malformed);
    expect(
      parseCrateFile(makeCrate({ version: "2.0/Serato Scratch LIVE Database" })),
    ).toMatchObject(malformed);
  });

  it("refuses a truncated file and an overrunning length", () => {
    const buf = makeCrate({ tracks: ["Music/a.mp3"] });
    expect(parseCrateFile(buf.subarray(0, buf.length - 1))).toMatchObject(malformed);
    expect(parseCrateFile(buf.subarray(0, buf.length - 20))).toMatchObject(malformed);
    expect(parseCrateFile(concat(buf, new Uint8Array([1, 2, 3])))).toMatchObject(malformed);
  });

  it("refuses an odd-length UTF-16 path", () => {
    const buf = concat(makeCrate(), record("otrk", record("ptrk", new Uint8Array([0, 65, 0]))));
    expect(parseCrateFile(buf)).toMatchObject(malformed);
  });

  it("refuses an otrk without ptrk and an ovct without tvcn", () => {
    expect(
      parseCrateFile(concat(makeCrate(), record("otrk", textRecord("tsng", "x")))),
    ).toMatchObject(malformed);
    expect(
      parseCrateFile(concat(makeCrate(), record("ovct", textRecord("tvcw", "0")))),
    ).toMatchObject(malformed);
  });
});
