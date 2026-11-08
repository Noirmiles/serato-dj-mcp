import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { FakePlatform } from "./control/fake.js";
import { makeMasterFixture } from "./fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-ann-"));

/**
 * What each tool tells a client about itself, pinned for every tool the
 * server can register. Clients use these hints to decide what to ask the user
 * before a call, and extension directories require them, so a new tool
 * without an entry here, or a hint that drifts, fails this test.
 *
 * apply_changes is destructive although it only adds crates: it writes into
 * Serato's own database, rotates old backups out, and undoing it means
 * restoring files by hand. discard_changes deletes staged work. Nothing here
 * reaches beyond the user's computer, so openWorldHint is false throughout.
 */
const EXPECTED: Record<
  string,
  { readOnly: boolean; destructive: boolean; idempotent: boolean; title: string }
> = {
  list_libraries: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "List Serato libraries",
  },
  list_crates: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "List Serato crates",
  },
  search_tracks: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Search Serato tracks",
  },
  get_tracks: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Get Serato tracks by id",
  },
  get_crate_tracks: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Get the tracks of a crate",
  },
  get_track_markers: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Get a track's cues, loops and colour",
  },
  audit_library: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Audit the Serato library",
  },
  serato_inspect: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Inspect the Serato library layout",
  },
  serato_status: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Check whether Serato DJ Pro is running",
  },
  serato_close: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    title: "Gracefully close Serato DJ Pro",
  },
  serato_open: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    title: "Start Serato DJ Pro",
  },
  run_sql: { readOnly: true, destructive: false, idempotent: true, title: "Run read-only SQL" },
  stage_crate: { readOnly: false, destructive: false, idempotent: false, title: "Stage a crate" },
  stage_add_to_crate: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    title: "Stage tracks to add to an existing crate",
  },
  preview_changes: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    title: "Preview staged changes",
  },
  apply_changes: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    title: "Apply staged changes",
  },
  discard_changes: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    title: "Discard staged changes",
  },
};

describe("tool annotations over tools/list", () => {
  it("every tool, with every flag on, carries a title and all four hints", async () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const server = createServer(
      {
        library: dir,
        roots: [],
        cacheDir: tmp(),
        stateDir: tmp(),
        allowWrites: true,
        allowRawSql: true,
        allowSeratoControl: true,
      },
      { hostPlatform: "win32", seratoPlatform: new FakePlatform() },
    );
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
      for (const tool of tools) {
        const want = EXPECTED[tool.name];
        expect(tool.title, tool.name).toBe(want.title);
        expect(tool.annotations, tool.name).toEqual({
          title: want.title,
          readOnlyHint: want.readOnly,
          destructiveHint: want.destructive,
          idempotentHint: want.idempotent,
          openWorldHint: false,
        });
      }
    } finally {
      await client.close();
    }
  });
});
