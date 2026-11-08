import { z } from "zod";
import {
  type AudioState,
  type OcrWindow,
  PlatformError,
  type ProcessInfo,
  type UiaRescanOutcome,
  type WindowInfo,
} from "./platform.js";

/**
 * Parsing of what the PowerShell scripts print. PowerShell 5.1's
 * ConvertTo-Json turns a one-element array into a bare object and an empty
 * one into nothing, so every parser accepts both shapes and noise around the
 * JSON (a profile banner, a progress line) by taking the last JSON line.
 */

function lastJson(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{") || l.startsWith("["));
  const line = lines[lines.length - 1];
  if (line === undefined) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const procSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string(),
  path: z.string().nullable().optional(),
});

export function parseProcess(stdout: string): ProcessInfo | null {
  const raw = lastJson(stdout);
  const first = Array.isArray(raw) ? raw[0] : raw;
  const p = procSchema.safeParse(first);
  if (!p.success) return null;
  return { pid: p.data.pid, name: p.data.name, path: p.data.path ?? null };
}

const windowSchema = z.object({
  handle: z.union([z.string(), z.number()]),
  title: z.string().nullable().optional(),
  responding: z.boolean(),
});

/** A handle of 0 is "no window". */
export function parseWindow(stdout: string): WindowInfo | null {
  const w = windowSchema.safeParse(lastJson(stdout));
  if (!w.success) return null;
  const handle = String(w.data.handle);
  if (handle === "0" || handle === "") return null;
  return { handle, title: w.data.title ?? "", responding: w.data.responding };
}

export function parseBool(stdout: string, key: string): boolean {
  const raw = lastJson(stdout);
  return typeof raw === "object" && raw !== null && (raw as Record<string, unknown>)[key] === true;
}

export function parseInstallPath(stdout: string): string | null {
  const raw = lastJson(stdout);
  const p = z.object({ path: z.string().nullable() }).safeParse(raw);
  return p.success && p.data.path ? p.data.path : null;
}

/**
 * "playing" and "silent" both mean a WASAPI session of the Serato process was
 * found and its peak meter was read; anything else, including output that
 * cannot be parsed, is "unknown" -- never "false", so a detection failure
 * cannot read as "safe".
 */
export function parseAudio(stdout: string): AudioState {
  const a = z.object({ audio: z.string() }).safeParse(lastJson(stdout));
  if (!a.success) return "unknown";
  if (a.data.audio === "playing") return true;
  if (a.data.audio === "silent") return false;
  return "unknown";
}

const uiaSchema = z.object({
  found: z.boolean(),
  count: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  action: z.enum(["invoke", "click"]).optional(),
});

export function parseUiaRescan(stdout: string): UiaRescanOutcome {
  const p = uiaSchema.safeParse(lastJson(stdout));
  if (!p.success) throw new PlatformError("unreadable UI Automation result");
  const elementCount = p.data.count ?? 0;
  if (!p.data.found || !p.data.action) return { found: false, elementCount };
  return {
    found: true,
    elementCount,
    name: p.data.name ?? "",
    automationId: p.data.id ?? "",
    action: p.data.action,
  };
}

export function parseUiaText(stdout: string): string[] | null {
  const p = z.object({ names: z.array(z.string()) }).safeParse(lastJson(stdout));
  return p.success ? p.data.names : null;
}

const ocrWordSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
const ocrSchema = z.object({
  error: z.string().optional(),
  left: z.number().optional(),
  top: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  // PowerShell 5.1 turns a one-element array into a bare object.
  lines: z
    .array(
      z.object({
        text: z.string(),
        words: z.union([z.array(ocrWordSchema), ocrWordSchema]),
      }),
    )
    .or(z.object({ text: z.string(), words: z.union([z.array(ocrWordSchema), ocrWordSchema]) }))
    .optional(),
});

export function parseOcr(stdout: string): OcrWindow {
  const p = ocrSchema.safeParse(lastJson(stdout));
  if (!p.success) throw new PlatformError("unreadable OCR result");
  if (p.data.error) throw new PlatformError(p.data.error);
  const rawLines =
    p.data.lines === undefined ? [] : Array.isArray(p.data.lines) ? p.data.lines : [p.data.lines];
  return {
    window: {
      left: p.data.left ?? 0,
      top: p.data.top ?? 0,
      width: p.data.width ?? 0,
      height: p.data.height ?? 0,
    },
    lines: rawLines.map((l) => ({
      text: l.text,
      words: (Array.isArray(l.words) ? l.words : [l.words]).map((w) => ({
        text: w.text,
        x: w.x,
        y: w.y,
        width: w.w,
        height: w.h,
      })),
    })),
  };
}

export function parseClick(stdout: string): void {
  const p = z.object({ ok: z.boolean(), error: z.string().optional() }).safeParse(lastJson(stdout));
  if (!p.success) throw new PlatformError("unreadable click result");
  if (!p.data.ok) throw new PlatformError(p.data.error ?? "click was not delivered");
}

export function parseConfirmClicked(stdout: string): boolean {
  return parseBool(stdout, "clicked");
}
