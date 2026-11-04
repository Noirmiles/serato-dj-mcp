import { describe, expect, it } from "vitest";
import { decodeRecord, parseRecords } from "../../src/legacy/records.js";
import { concat, record, textRecord, u32be, utf16be } from "../fixtures/make-crate.js";

const malformed = { error: { code: "malformed_file" } };

describe("parseRecords", () => {
  it("splits records in order and returns an empty list for an empty buffer", () => {
    expect(parseRecords(new Uint8Array())).toEqual([]);
    const recs = parseRecords(
      concat(record("abcd", new Uint8Array([1, 2])), record("efgh", new Uint8Array())),
    );
    if (!Array.isArray(recs)) throw new Error("expected records");
    expect(recs.map((r) => r.tag)).toEqual(["abcd", "efgh"]);
    expect(Array.from(recs[0].payload)).toEqual([1, 2]);
    expect(recs[1].payload.length).toBe(0);
  });

  it("works on a subarray with a non-zero offset", () => {
    const whole = concat(new Uint8Array([9, 9, 9]), record("abcd", new Uint8Array([7])));
    const recs = parseRecords(whole.subarray(3));
    if (!Array.isArray(recs)) throw new Error("expected records");
    expect(Array.from(recs[0].payload)).toEqual([7]);
  });

  it("refuses a truncated header, at every cut", () => {
    const full = record("abcd", new Uint8Array([1]));
    for (let n = 1; n < 8; n++) {
      expect(parseRecords(full.subarray(0, n))).toMatchObject(malformed);
    }
  });

  it("refuses a length that runs past the end", () => {
    const full = record("abcd", new Uint8Array([1, 2, 3]));
    expect(parseRecords(full.subarray(0, full.length - 1))).toMatchObject(malformed);
    const huge = concat(new Uint8Array([97, 98, 99, 100]), u32be(0xffffffff));
    expect(parseRecords(huge)).toMatchObject(malformed);
  });

  it("refuses a tag that is not printable ASCII", () => {
    for (const tag of [
      [0, 98, 99, 100],
      [97, 98, 99, 0x7f],
      [0xc3, 0xa9, 99, 100],
      [97, 98, 99, 0x1f],
    ]) {
      expect(parseRecords(concat(new Uint8Array(tag), u32be(0)))).toMatchObject(malformed);
    }
  });
});

describe("decodeRecord", () => {
  const dec = (tag: string, payload: Uint8Array) => decodeRecord({ tag, payload });

  it("decodes text for t, p and vrsn, including non-BMP characters", () => {
    expect(dec("tsng", utf16be("Été"))).toEqual({ kind: "text", value: "Été" });
    expect(dec("pfil", utf16be("Music/x.mp3"))).toEqual({ kind: "text", value: "Music/x.mp3" });
    expect(dec("vrsn", utf16be("1.0"))).toEqual({ kind: "text", value: "1.0" });
    const pair = new Uint8Array([0xd8, 0x3c, 0xdf, 0xb5]);
    expect(dec("tsng", pair)).toEqual({ kind: "text", value: "\u{1F3B5}" });
  });

  it("refuses odd-length text and unpaired surrogates", () => {
    expect(dec("tsng", new Uint8Array([0, 65, 0]))).toMatchObject(malformed);
    expect(dec("tsng", new Uint8Array([0xd8, 0x3c]))).toMatchObject(malformed);
    expect(dec("tsng", new Uint8Array([0xdc, 0x00]))).toMatchObject(malformed);
  });

  it("decodes nested records for o", () => {
    expect(dec("otrk", textRecord("ptrk", "a"))).toMatchObject({ kind: "records" });
    expect(dec("otrk", new Uint8Array([1, 2, 3]))).toMatchObject(malformed);
  });

  it("decodes u32 and refuses other widths", () => {
    expect(dec("utpc", u32be(4000000000))).toEqual({ kind: "u32", value: 4000000000 });
    expect(dec("utpc", new Uint8Array([0, 1]))).toMatchObject(malformed);
  });

  it("accepts s at 2 bytes (unsigned) or 4 bytes (signed) only", () => {
    expect(dec("sxxx", new Uint8Array([0xff, 0xfe]))).toEqual({ kind: "s", value: 65534 });
    expect(dec("sxxx", new Uint8Array([0xff, 0xff, 0xff, 0xfe]))).toEqual({
      kind: "s",
      value: -2,
    });
    for (const n of [0, 1, 3, 5, 8]) {
      expect(dec("sxxx", new Uint8Array(n))).toMatchObject(malformed);
    }
  });

  it("decodes booleans as 0 or 1 and refuses anything else", () => {
    expect(dec("bbgl", new Uint8Array([1]))).toEqual({ kind: "bool", value: true });
    expect(dec("bbgl", new Uint8Array([0]))).toEqual({ kind: "bool", value: false });
    expect(dec("bbgl", new Uint8Array([2]))).toMatchObject(malformed);
    expect(dec("bbgl", new Uint8Array([0, 0]))).toMatchObject(malformed);
    expect(dec("bbgl", new Uint8Array())).toMatchObject(malformed);
  });

  it("returns unknown prefixes as raw bytes", () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(dec("zzzz", payload)).toEqual({ kind: "raw", value: payload });
    expect(dec("rdat", payload)).toEqual({ kind: "raw", value: payload });
  });
});
