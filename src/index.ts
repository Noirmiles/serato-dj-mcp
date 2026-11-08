#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./cli.js";
import { isSeratoError } from "./errors.js";
import { createServer } from "./server.js";
import { PACKAGE_VERSION as VERSION } from "./version.js";

export const HELP = `serato-dj-mcp ${VERSION} -- MCP server for the Serato DJ 4.x library

Usage: serato-dj-mcp [options]

  --library <path>     Path to the Serato Library directory (the one holding master.sqlite)
  --root <dir>         Extra directory to search; may be repeated
  --cache-dir <dir>    Where snapshots go (safe to delete)
  --state-dir <dir>    Where backups and manifests go (NOT safe to delete)
  --allow-raw-sql      Register run_sql
  --allow-writes       Register stage_crate, stage_add_to_crate, preview_changes, apply_changes, discard_changes
  --allow-serato-control  Windows only: register serato_status, serato_close, serato_open
  -h, --help           Show this help
  -V, --version        Show the version

Environment:
  SERATO_LIBRARY_PATH  Same as --library; --library wins.
  SERATO_DJ_EXE        Full path of 'Serato DJ Pro.exe' for serato_open (else found automatically).
`;

const parsed = parseArgs(process.argv.slice(2), process.env);

if (isSeratoError(parsed)) {
  process.stderr.write(`${parsed.error.code}: ${parsed.error.message}\n\n${HELP}`);
  process.exit(2);
}
if ("help" in parsed) {
  process.stdout.write(HELP);
  process.exit(0);
}
if ("version" in parsed) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// Everything diagnostic goes to stderr: stdout carries the MCP protocol.
const flags: string[] = [];
if (parsed.allowWrites) flags.push("writes enabled");
if (parsed.allowRawSql) flags.push("raw sql enabled");
if (parsed.allowSeratoControl) flags.push("serato control enabled");
process.stderr.write(
  `serato-dj-mcp ${VERSION} on stdio (${flags.length > 0 ? flags.join(", ") : "read-only"})\n`,
);

await createServer(parsed).connect(new StdioServerTransport());
