import { err, type SeratoError } from "../errors.js";
import type { SeratoPlatform } from "./platform.js";

/** What the control tools need: the OS seam and, for tests, a clock. */
export type ControlCtx = {
  platform: SeratoPlatform;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function clock(ctx: ControlCtx) {
  return { sleep: ctx.sleep ?? realSleep, now: ctx.now ?? Date.now };
}

/** How long the database file must sit unchanged to count as "quiet". */
export const STABILITY_MS = 2000;
export const POLL_MS = 500;

/** A backend failure (PowerShell missing, COM error, ...) as a value. */
export function controlFailed(what: string, e: unknown): SeratoError {
  return err("control_failed", `${what}: ${e instanceof Error ? e.message : String(e)}`);
}
