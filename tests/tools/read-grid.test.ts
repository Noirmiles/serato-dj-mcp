import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { readGrid, readGridTool } from "../../src/tools/read-grid.js";
import { flacFile, geobFrameData, id3Frame, id3Tag, mp3File } from "../markers/build.js";
import { beatGrid, tempoMapV2 } from "../markers/grid-build.js";

const dir = mkdtempSync(join(tmpdir(), "serato-grid-"));
const put = (name: string, b: Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, b);
  return p;
};
const tm = tempoMapV2([
  { pos: 0n, tempo: 120, note: 4, interp: 1 },
  { pos: 100n, tempo: 121, note: 4, interp: 2 },
]);
const bg = beatGrid([], [0.5, 120]);
const mp3 = (...frames: [string, Buffer][]) =>
  mp3File(id3Tag(frames.map(([d, p]) => id3Frame("GEOB", geobFrameData(p, d), 3))));
const flacTag = (key: string, name: string, payload: Buffer) => {
  const head = Buffer.from(`application/octet-stream\u0000${name}\u0000`, "latin1");
  return `${key}=${Buffer.concat([head, payload]).toString("base64").replace(/=+$/, "")}`;
};

describe("readGrid", () => {
  it("prefers the Tempo Map when both tags exist (MP3)", () => {
    const r = readGrid(put("both.mp3", mp3(["Serato BeatGrid", bg], ["Serato Tempo Map", tm])));
    expect(r.format).toBe("mp3");
    expect(r.serato5_uses).toBe("tempo_map");
    expect(r.tempo_map).toMatchObject({ status: "ok", version: 2, mode: 1 });
    expect(r.tempo_map.markers?.map((x) => x.interpolation)).toEqual(["stepped", "linear"]);
    expect(r.beatgrid.markers).toEqual([{ position_seconds: 0.5, bpm: 120 }]);
  });

  it("falls back to the BeatGrid", () => {
    const r = readGrid(put("bg.mp3", mp3(["Serato BeatGrid", bg])));
    expect(r.serato5_uses).toBe("beatgrid");
    expect(r.tempo_map.status).toBe("no_tag");
  });

  it("reports neither", () => {
    const r = readGrid(put("none.mp3", mp3()));
    expect(r.serato5_uses).toBe("none");
    expect(r.beatgrid.status).toBe("no_tag");
  });

  it("reads FLAC and treats a malformed Tempo Map as unusable", () => {
    const f = readGrid(
      put(
        "a.flac",
        flacFile(null, [
          flacTag("SERATO_TEMPO_MAP", "Serato Tempo Map", tm),
          flacTag("SERATO_BEATGRID", "Serato BeatGrid", bg),
        ]),
      ),
    );
    expect(f).toMatchObject({ format: "flac", serato5_uses: "tempo_map" });
    expect(f.beatgrid.status).toBe("ok");
    const bad = readGrid(
      put(
        "b.flac",
        flacFile(null, [flacTag("SERATO_TEMPO_MAP", "Serato Tempo Map", Buffer.from([9]))]),
      ),
    );
    expect(bad.tempo_map.status).toBe("malformed");
    expect(bad.serato5_uses).toBe("none");
  });

  it("reports missing and unsupported files", () => {
    expect(readGrid(join(dir, "nope.mp3")).tempo_map.status).toBe("file_missing");
    expect(readGrid(put("x.m4a", Buffer.alloc(64))).tempo_map.status).toBe("unsupported_format");
  });
});

describe("serato_read_grid tool", () => {
  it("returns files in order", () => {
    const r = readGridTool({ paths: [put("o.mp3", mp3()), join(dir, "gone.mp3")] });
    if (isSeratoError(r)) throw new Error("unexpected");
    expect(r.files.map((f) => f.tempo_map.status)).toEqual(["no_tag", "file_missing"]);
  });

  it("validates arguments", () => {
    const bad = [
      {},
      { paths: [] },
      { paths: [""] },
      { paths: ["a"], x: 1 },
      { paths: Array(201).fill("a") },
    ];
    for (const a of bad) expect(isSeratoError(readGridTool(a))).toBe(true);
  });
});
