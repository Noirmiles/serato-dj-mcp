import { describe, expect, it } from "vitest";
import { type MatchDeps, matchRepairs } from "../../src/relocate/match.js";

const deps = (present: Set<string>, sizes: Record<string, number> = {}): MatchDeps => ({
  volumeRoots: new Map([[1, "D:\\"]]),
  exists: (p) => present.has(p),
  fileSize: (p) => sizes[p] ?? 4096,
});

describe("matchRepairs — revalidate in place", () => {
  it("repairs a missing asset whose file exists at its recorded path, no path change", () => {
    const plan = matchRepairs(
      [{ locationId: 1, portableId: "Pop/x.mp3" }],
      {},
      deps(new Set(["D:\\Pop\\x.mp3"]), { "D:\\Pop\\x.mp3": 5000 }),
    );
    expect(plan.repairs).toEqual([
      {
        locationId: 1,
        oldPortableId: "Pop/x.mp3",
        newPortableId: "Pop/x.mp3",
        absolutePath: "D:\\Pop\\x.mp3",
        fileSize: 5000,
        kind: "revalidate",
      },
    ]);
    expect(plan.notFound).toEqual([]);
  });

  it("buckets an asset whose location has no known volume root as volume_unavailable", () => {
    const plan = matchRepairs([{ locationId: 9, portableId: "Pop/x.mp3" }], {}, deps(new Set()));
    expect(plan.volumeUnavailable).toEqual([{ locationId: 9, portableId: "Pop/x.mp3" }]);
    expect(plan.repairs).toEqual([]);
  });

  it("buckets a not-found file as notFound", () => {
    const plan = matchRepairs([{ locationId: 1, portableId: "Pop/x.mp3" }], {}, deps(new Set()));
    expect(plan.notFound).toEqual([{ locationId: 1, portableId: "Pop/x.mp3" }]);
  });
});

describe("matchRepairs — moved-under-parent", () => {
  it("repoints under a new parent when the tree moved (Keron case)", () => {
    const plan = matchRepairs(
      [{ locationId: 1, portableId: "Reggae/x.mp3" }],
      { movedUnder: "Keron Crates" },
      deps(new Set(["D:\\Keron Crates\\Reggae\\x.mp3"]), {
        "D:\\Keron Crates\\Reggae\\x.mp3": 7000,
      }),
    );
    expect(plan.repairs).toEqual([
      {
        locationId: 1,
        oldPortableId: "Reggae/x.mp3",
        newPortableId: "Keron Crates/Reggae/x.mp3",
        absolutePath: "D:\\Keron Crates\\Reggae\\x.mp3",
        fileSize: 7000,
        kind: "moved",
      },
    ]);
  });
  it("prefers revalidate-in-place over moved when both would match", () => {
    const plan = matchRepairs(
      [{ locationId: 1, portableId: "Reggae/x.mp3" }],
      { movedUnder: "Keron Crates" },
      deps(new Set(["D:\\Reggae\\x.mp3", "D:\\Keron Crates\\Reggae\\x.mp3"])),
    );
    expect(plan.repairs[0].kind).toBe("revalidate");
  });
});
