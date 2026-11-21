import { describe, expect, it } from "vitest";
import { parseBeatGrid, parseTempoMap } from "../../src/markers/tempo-map.js";
import { beatGrid, tempoMapV1, tempoMapV2 } from "./grid-build.js";

const m = (pos: bigint, tempo = 120, interp = 1) => ({ pos, tempo, note: 4, interp });

describe("parseTempoMap", () => {
  it("reads V2", () => {
    const r = parseTempoMap(
      tempoMapV2([m(0n), { ...m(1000n, 125, 3), curv: -0.5 }, m(2000n, 126, 9)]),
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.value).toMatchObject({
      version: 2,
      header_field: 0x0102,
      mode: 1,
      origin_seconds: 0.05,
    });
    expect(
      r.value.markers.map((x) => [x.position, x.interpolation, x.interpolation_raw, x.curvature]),
    ).toEqual([
      [0, "stepped", 1, 0],
      [1000, "curved", 3, -0.5],
      [2000, "unknown", 9, 0],
    ]);
  });

  it("reads V1 and rebases positions", () => {
    const r = parseTempoMap(
      tempoMapV1([
        { ...m(500n), time: 0.25 },
        { ...m(900n, 130, 2), time: 1 },
      ]),
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.value.version).toBe(1);
    expect(r.value.origin_seconds).toBe(0.25);
    expect(r.value.header_field).toBeNull();
    expect(r.value.markers.map((x) => [x.position, x.curvature, x.interpolation])).toEqual([
      [0, null, "stepped"],
      [400, null, "linear"],
    ]);
  });

  it("returns huge positions as strings", () => {
    const r = parseTempoMap(tempoMapV2([m(0n), m(2n ** 62n)]));
    if (!r.ok) throw new Error(r.message);
    expect(r.value.markers[1]?.position).toBe((2n ** 62n).toString());
  });

  it("rejects bad input without throwing", () => {
    const good = tempoMapV2([m(0n)]);
    const cases: Buffer[] = [
      Buffer.alloc(0),
      Buffer.from([7, 0, 0]),
      good.subarray(0, good.length - 1),
      Buffer.concat([good, Buffer.from([0])]),
      tempoMapV2([m(5n)]),
      tempoMapV2([{ ...m(0n), tempo: 0 }]),
      tempoMapV2([{ ...m(0n), note: -4 }]),
      tempoMapV2([{ ...m(0n), curv: 1.5 }]),
      tempoMapV2([m(0n)], 0, 0, 4),
      Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]),
      Buffer.alloc(40, 0xff),
    ];
    for (const c of cases) expect(parseTempoMap(c).ok).toBe(false);
    const v = parseTempoMap(Buffer.from([7]));
    expect(!v.ok && v.message).toMatch(/version 7/);
  });
});

describe("parseBeatGrid", () => {
  const nt: [number, number][] = [[0.5, 16]];
  it("reads with and without the footer", () => {
    for (const footer of [true, false]) {
      expect(parseBeatGrid(beatGrid(nt, [8.5, 128], footer))).toEqual({
        ok: true,
        value: [
          { position_seconds: 0.5, beats_to_next: 16 },
          { position_seconds: 8.5, bpm: 128 },
        ],
      });
    }
  });

  it("reads a single terminal marker", () => {
    const r = parseBeatGrid(beatGrid([], [0.25, 100]));
    expect(r.ok && r.value).toEqual([{ position_seconds: 0.25, bpm: 100 }]);
  });

  it("rejects truncated, garbage, wrong header and extra bytes", () => {
    const g = beatGrid(nt, [8.5, 128], false);
    for (const c of [
      Buffer.alloc(0),
      g.subarray(0, 5),
      g.subarray(0, g.length - 2),
      Buffer.concat([g, Buffer.alloc(2)]),
      Buffer.concat([Buffer.from([2, 0]), g.subarray(2)]),
      Buffer.alloc(30, 0xff),
    ]) {
      expect(parseBeatGrid(c).ok).toBe(false);
    }
  });
});
