#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseArgs } from "./cli.js";
import { WindowsSeratoPlatform } from "./control/windows.js";
import { isSeratoError } from "./errors.js";
import { readGridTool } from "./tools/read-grid.js";
import { type AnalyzeCtx, seratoAnalyze } from "./tools/serato-analyze.js";
import { seratoClose } from "./tools/serato-close.js";
import { seratoOpen } from "./tools/serato-open.js";
import { seratoRescan } from "./tools/serato-rescan.js";
import { seratoStatus } from "./tools/serato-status.js";

export const CONTROL_CLI_USAGE =
  "usage: control-cli <status|close|open|rescan> [--timeout-seconds N]  (--timeout-seconds: close and open only) | control-cli read-grid <path>... | control-cli analyze (--crate NAME | --file PATH ...) --mode fixed|flexible [--resolution bars|beats] [--set-mode] [--confirm --token T] [--timeout-seconds N]";

export type ControlCommand = "status" | "close" | "open" | "rescan";
export type ControlInvocation =
  | { command: ControlCommand; timeoutSeconds?: number }
  | { command: "read-grid"; paths: string[] }
  | { command: "analyze"; args: Record<string, unknown> };

const COMMANDS: readonly string[] = ["status", "close", "open", "rescan"];

const ANALYZE_VALUE_FLAGS: Record<string, string> = {
  "--crate": "crate",
  "--mode": "mode",
  "--resolution": "resolution",
  "--token": "confirm_token",
  "--timeout-seconds": "timeout_seconds",
};

/** Flags to the tool's input; the tool's own schema does the real validation. */
function parseAnalyzeArgs(argv: string[]): ControlInvocation | { usage: string } {
  const args: Record<string, unknown> = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--set-mode") args.set_mode = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--file" || a in ANALYZE_VALUE_FLAGS) {
      const v = argv[++i];
      if (v === undefined) return { usage: `${a} needs a value` };
      if (a === "--file") files.push(v);
      else {
        const key = ANALYZE_VALUE_FLAGS[a] as string;
        if (key in args) return { usage: `${a} given twice` };
        if (key === "timeout_seconds") {
          if (!/^\d+$/.test(v)) return { usage: "--timeout-seconds must be a whole number" };
          args[key] = Number(v);
        } else args[key] = v;
      }
    } else return { usage: `unexpected argument: ${a}` };
  }
  if (files.length > 0) args.files = files;
  return { command: "analyze", args };
}

/** A command word plus an optional --timeout-seconds N (or =N); anything else is a usage error. */
export function parseControlArgs(argv: string[]): ControlInvocation | { usage: string } {
  if (argv[0] === "read-grid") {
    const paths = argv.slice(1);
    if (paths.length === 0) return { usage: "read-grid needs at least one path" };
    return { command: "read-grid", paths };
  }
  if (argv[0] === "analyze") return parseAnalyzeArgs(argv.slice(1));
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
  makeCtx: () => AnalyzeCtx;
};

export type ControlCliResult = { line: string; exitCode: 0 | 1 | 2 };

const fail = (code: string, message: string, exitCode: 1 | 2): ControlCliResult => ({
  line: JSON.stringify({ ok: false, error: { code, message } }),
  exitCode,
});

function finish(result: unknown): ControlCliResult {
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
}

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
      return finish(readGridTool({ paths: parsed.paths }));
    }
    const ctx = deps.makeCtx();
    if (parsed.command === "analyze") return finish(await seratoAnalyze(parsed.args, ctx));
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
    return finish(result);
  } catch (e) {
    return fail("control_failed", e instanceof Error ? e.message : String(e), 1);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { line, exitCode } = await runControlCli(process.argv.slice(2), {
    platform: process.platform,
    makeCtx: () => {
      const cli = parseArgs([], process.env);
      return {
        platform: new WindowsSeratoPlatform({ libraryHint: process.env.SERATO_LIBRARY_PATH }),
        read:
          "cacheDir" in cli
            ? { library: cli.library, roots: [], cacheDir: cli.cacheDir }
            : undefined,
      };
    },
  });
  process.stdout.write(`${line}\n`, () => process.exit(exitCode));
}
