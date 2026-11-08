import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Cli } from "../../src/cli.js";
import { createServer, registeredToolNames } from "../../src/server.js";
import { FakePlatform } from "./fake.js";

const CONTROL = ["serato_close", "serato_open", "serato_status"];
const cli = (over: Partial<Cli> = {}): Cli => ({
  roots: [],
  cacheDir: mkdtempSync(join(tmpdir(), "serato-c-")),
  stateDir: mkdtempSync(join(tmpdir(), "serato-s-")),
  allowWrites: false,
  allowRawSql: false,
  allowSeratoControl: false,
  ...over,
});
const all = (c: Cli, host: NodeJS.Platform) =>
  registeredToolNames(createServer(c, { hostPlatform: host, seratoPlatform: new FakePlatform() }));
const names = (c: Cli, host: NodeJS.Platform) => all(c, host).filter((n) => CONTROL.includes(n));

describe("serato control registration", () => {
  it("registers the three tools only with the flag on Windows", () => {
    expect(names(cli({ allowSeratoControl: true }), "win32").sort()).toEqual(CONTROL);
  });
  it("does not register without the flag", () => {
    expect(names(cli(), "win32")).toEqual([]);
  });
  it("does not register on other platforms even with the flag", () => {
    expect(names(cli({ allowSeratoControl: true }), "darwin")).toEqual([]);
    expect(names(cli({ allowSeratoControl: true }), "linux")).toEqual([]);
  });
  it("does not add library-writing tools", () => {
    expect(all(cli({ allowSeratoControl: true }), "win32")).not.toContain("apply_changes");
  });
});
