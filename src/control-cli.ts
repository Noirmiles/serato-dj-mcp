#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import type { ControlCtx } from "./control/context.js";
import { WindowsSeratoPlatform } from "./control/windows.js";
import { isSeratoError } from "./errors.js";
import { readGridTool } from "./tools/read-grid.js";
import { seratoClose } from "./tools/serato-close.js";
import { seratoOpen } from "./tools/serato-open.js";
import { seratoRescan } from "./tools/serato-rescan.js";
import { seratoStatus } from "./tools/serato-status.js";

export const CONTROL_CLI_USAGE =
  "usage: control-cli <status|close|open|rescan> [--timeout-seconds N]  (--timeout-seconds: close and open only) | control-cli read-grid <path>...";

export type ControlCommand = "status" | "close" | "open" | "rescan";
export type ControlInvocation =
  | { command: ControlCommand; timeoutSeconds?: number }
  | { command: "read-grid"; paths: string[] };

const COMMANDS: readonly string[] = ["status", "close", "open", "rescan"];

/** A command word plus an optional --timeout-seconds N (or =N); anything else is a usage error. */
export function parseControlArgs(argv: string[]): ControlInvocation | { usage: string } {
  if (argv[0] === "read-grid") {
    const paths = argv.slice(1);
    if (paths.length === 0) return { usage: "read-grid needs at least one path" };
    return { command: "read-grid", paths };
  }
  let command: string | undefined;
  let timeout: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timeout-seconds" || a.startsWith("--timeout-seconds=")) {
      if (timeout !== undefined) return { usage: "--timeout-seconds given twice" };
      if (a.includes("=")) timeout = a.slice(a.indexOf("=") + 1);
      else if (i + 1 < argv.length) timeout = argv[++i];
      else return { usage: "--timeout-seconds needs a value" };
    } else if (a.startsWith("-")) {
      return { usage: `unknown option: ${a}` };
    } else if (command === undefined) {
      command = a;
    } else {
      return { usage: `unexpected argument: ${a}` };
    }
  }
  if (command === undefined) return { usage: "missing command" };
  if (!COMMANDS.includes(command)) return { usage: `unknown command: ${command}` };
  const cmd = command as ControlCommand;
  if (timeout === undefined) return { command: cmd };
  if (cmd !== "close" && cmd !== "open") {
    return { usage: `--timeout-seconds does not apply to ${cmd}` };
  }
  if (!/^\d+$/.test(timeout)) return { usage: "--timeout-seconds must be a whole number" };
  return { command: cmd, timeoutSeconds: Number(timeout) };
}

export type ControlCliDeps = {
  platform: NodeJS.Platform;
  /** Builds the control context; only called on Windows. */
  makeCtx: () => ControlCtx;
};

export type ControlCliResult = { line: string; exitCode: 0 | 1 | 2 };

const fail = (code: string, message: string, exitCode: 1 | 2): ControlCliResult => ({
  line: JSON.stringify({ ok: false, error: { code, message } }),
  exitCode,
});

/** Runs one command; never throws. `line` is the single JSON line for stdout. */
export async function runControlCli(
  argv: string[],
  deps: ControlCliDeps,
): Promise<ControlCliResult> {
  const parsed = parseControlArgs(argv);
  if ("usage" in parsed) {
    return fail("invalid_argument", `${parsed.usage}. ${CONTROL_CLI_USAGE}`, 2);
  }
  if (parsed.command !== "read-grid" && deps.platform !== "win32") {
    return fail("not_supported", "controlling Serato is only supported on Windows", 1);
  }
  try {
    if (parsed.command === "read-grid") {
      const result = readGridTool({ paths: parsed.paths });
      if (isSeratoError(result)) {
        const { code, message } = result.error;
        return fail(code, message, 1);
      }
      return { line: JSON.stringify({ ok: true, result }), exitCode: 0 };
    }
    const ctx = deps.makeCtx();
    const timeout =
      parsed.timeoutSeconds === undefined ? {} : { timeout_seconds: parsed.timeoutSeconds };
    let result: unknown;
    switch (parsed.command) {
      case "status":
        result = await seratoStatus({}, ctx);
        break;
      case "close":
        result = await seratoClose({ confirm: true, ...timeout }, ctx);
        break;
      case "open":
        result = await seratoOpen(timeout, ctx);
        break;
      case "rescan":
        result = await seratoRescan({ scope: "library" }, ctx);
        break;
    }
    if (isSeratoError(result)) {
      const { code, message, details } = result.error;
      return {
        line: JSON.stringify({
          ok: false,
          error: details === undefined ? { code, message } : { code, message, details },
        }),
        exitCode: 1,
      };
    }
    return { line: JSON.stringify({ ok: true, result }), exitCode: 0 };
  } catch (e) {
    return fail("control_failed", e instanceof Error ? e.message : String(e), 1);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { line, exitCode } = await runControlCli(process.argv.slice(2), {
    platform: process.platform,
    makeCtx: () => ({
      platform: new WindowsSeratoPlatform({ libraryHint: process.env.SERATO_LIBRARY_PATH }),
    }),
  });
  process.stdout.write(`${line}\n`, () => process.exit(exitCode));
}
