import { z } from "zod";
import type { AudioState, ProcessInfo, WindowInfo } from "./platform.js";

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
