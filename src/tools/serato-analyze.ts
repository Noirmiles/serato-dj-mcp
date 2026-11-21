import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { z } from "zod";
import { parseToolArgs } from "../args.js";
import {
  type AnalyzeMode,
  type AnalyzeResolution,
  detectAnalyzeMode,
  findAnalyzeButton,
  findCloseButton,
  findCrateLabel,
  findLabel,
  findSetupButton,
  isWholeLibraryName,
  modeLabel,
  resolutionLabel,
} from "../control/analyze-match.js";
import { type ControlCtx, clock, controlFailed, POLL_MS } from "../control/context.js";
import type { OcrWindow, SeratoPlatform } from "../control/platform.js";
import { type Box, findFilesTab } from "../control/rescan-match.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { readMarkersFromFile } from "../markers/read.js";
import { isStreamingPortableId, portableIdToAbsolute } from "../paths.js";
import { resolveCrate } from "../read/crates.js";
import { type ReadCtx, readSession } from "../read/session.js";
import { type GridResult, readGrid } from "./read-grid.js";
import { seratoOpen } from "./serato-open.js";

/** More files than this need the caller's explicit go-ahead (recorded in the plan). */
export const MAX_ANALYZE_FILES = 50;
export const MAX_ANALYZE_TIMEOUT_SECONDS = 3600;
export const DEFAULT_ANALYZE_TIMEOUT_SECONDS = 600;
const ANALYZE_POLL_MS = Math.max(2000, POLL_MS);
/** After at least one file changed, this long with no further change counts as finished. */
export const ANALYZE_SETTLE_MS = 30_000;
const UI_SETTLE_MS = 1500;

export const seratoAnalyzeInput = z
  .strictObject({
    files: z.array(z.string().min(1)).min(1).optional(),
    crate: z.string().min(1).optional(),
    mode: z.enum(["fixed", "flexible"]),
    resolution: z.enum(["bars", "beats"]).optional(),
    set_mode: z.boolean().default(false),
    confirm: z.boolean().optional(),
    confirm_token: z.string().min(1).optional(),
    timeout_seconds: z.number().int().min(1).max(MAX_ANALYZE_TIMEOUT_SECONDS).optional(),
  })
  .refine((v) => (v.files === undefined) !== (v.crate === undefined), {
    error: "give exactly one of files or crate",
    params: { reason: "target_required" },
  })
  .refine((v) => (v.mode === "flexible") === (v.resolution !== undefined), {
    error: "resolution is required for mode flexible and not allowed for fixed",
    params: { reason: "resolution_mismatch" },
  });

export const seratoAnalyzeDescription =
  "Make Serato DJ Pro 5 analyse (Lucid Beatgrids) the files of ONE named crate and wait until " +
  "it is done (Windows only, needs --allow-serato-control). Two steps: a call without " +
  "confirm:true does nothing in Serato and returns a plan (files, count, mode, resolution, " +
  "locked_files, refusals such as over_cap, confirm_token); repeat the call with confirm:true and " +
  "that confirm_token to run it. The whole library is never analysed. More than " +
  `${MAX_ANALYZE_FILES} files, or files whose beatgrid is locked, are listed under refusals and ` +
  "only run when you confirm them. Refused while audio is playing, with missing files, or when " +
  "the current Setup analysis mode differs from `mode` (mode_mismatch) unless set_mode:true, " +
  "which changes it in Setup. A loose list of files (`files`) is not supported: Serato needs the " +
  "files selected in a crate, so it returns not_supported. Drives Serato by OCR and real mouse " +
  "clicks (do not use the mouse). Completion is detected from the files' own tags changing; " +
  "timed_out:true means it was not seen finished. Not tested on a real Serato 5.";

const uses = z.enum(["tempo_map", "beatgrid", "none"]);
export const seratoAnalyzeOutput = z.object({
  executed: z.boolean(),
  plan: z.object({
    crate: z.string(),
    files: z.array(z.string()),
    count: z.number(),
    mode: z.enum(["fixed", "flexible"]),
    resolution: z.enum(["bars", "beats"]).nullable(),
    set_mode: z.boolean(),
    locked_files: z.array(z.string()),
    over_cap: z.boolean(),
    refusals: z.array(z.object({ code: z.string(), message: z.string() })),
    confirm_token: z.string(),
  }),
  finished: z.enum(["all_changed", "quiet", "timeout"]).optional(),
  timed_out: z.boolean().optional(),
  waited_ms: z.number().optional(),
  results: z
    .array(
      z.object({
        path: z.string(),
        changed: z.boolean(),
        before_uses: uses,
        after: z.object({
          serato5_uses: uses,
          marker_count: z.number(),
          first_tempo: z.number().nullable(),
        }),
      }),
    )
    .optional(),
  warnings: z.array(warningSchema).optional(),
});

export type SeratoAnalyzeResult = Omit<z.infer<typeof seratoAnalyzeOutput>, "warnings">;
export type AnalyzeCtx = ControlCtx & { read?: ReadCtx };

type CrateFiles = { name: string; files: string[]; dbLocked: Set<string>; unresolved: string[] };

function crateFiles(ctx: ReadCtx, name: string): Promise<CrateFiles | SeratoError> {
  return readSession(ctx, (h) => {
    const crate = resolveCrate(h.db, { name });
    if (isSeratoError(crate)) return crate;
    const lockedCol = h.schema.assetColumns.has("is_beatgrid_locked");
    const rows = h.db
      .prepare(
        `SELECT a.portable_id AS pid, a.location_id AS loc${lockedCol ? ", a.is_beatgrid_locked AS locked" : ""}
           FROM asset a
           JOIN container_asset ca ON ca.asset_id = a.id
           JOIN location_container lc ON lc.id = ca.location_container_id
          WHERE lc.container_id = ?
          GROUP BY a.id ORDER BY min(ca.list_order), a.id`,
      )
      .all(crate.id) as { pid: string | null; loc: number; locked?: number | null }[];
    const out: CrateFiles = { name: crate.name, files: [], dbLocked: new Set(), unresolved: [] };
    for (const r of rows) {
      const root = h.volumeRoots.get(r.loc);
      if (typeof r.pid !== "string" || isStreamingPortableId(r.pid) || root === undefined) {
        out.unresolved.push(String(r.pid));
        continue;
      }
      const path = portableIdToAbsolute(root, r.pid);
      out.files.push(path);
      if (r.locked) out.dbLocked.add(path);
    }
    return out;
  });
}

const summary = (g: GridResult) => ({
  serato5_uses: g.serato5_uses,
  marker_count: g.tempo_map.markers?.length ?? g.beatgrid.markers?.length ?? 0,
  first_tempo: g.tempo_map.markers?.[0]?.tempo ?? g.beatgrid.markers?.[0]?.bpm ?? null,
});

const centre = (b: Box) => ({
  x: Math.round(b.x + b.width / 2),
  y: Math.round(b.y + b.height / 2),
});
const click = (p: SeratoPlatform, pid: number, b: Box) => {
  const c = centre(b);
  return p.clickWindowPoint(pid, c.x, c.y);
};

async function ocr(p: SeratoPlatform, pid: number, what: string): Promise<OcrWindow | SeratoError> {
  try {
    return await p.ocrWindow(pid);
  } catch (e) {
    return err(
      "analyze_ui_not_found",
      `could not read the Serato window while looking for ${what}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const notFound = (what: string) =>
  err(
    "analyze_ui_not_found",
    `OCR read the Serato window but did not find ${what}. Nothing was analysed. Keep the window ` +
      "uncovered and check the layout (this tool has not been tried on a real Serato 5).",
  );

/** Setup > analysis: verify the setting, or set it. Leaves Setup closed if it can. */
async function applyMode(
  p: SeratoPlatform,
  pid: number,
  want: { mode: AnalyzeMode; resolution: AnalyzeResolution | null; set: boolean },
  sleep: (ms: number) => Promise<void>,
  warnings: Warning[],
): Promise<SeratoError | null> {
  let shot = await ocr(p, pid, "the Setup button");
  if (isSeratoError(shot)) return shot;
  const setup = findSetupButton(shot.lines);
  if (!setup) return notFound("the Setup button");
  await click(p, pid, setup);
  await sleep(UI_SETTLE_MS);
  shot = await ocr(p, pid, "the analysis options in Setup");
  if (isSeratoError(shot)) return shot;

  let problem: SeratoError | null = null;
  if (want.set) {
    const labels = [modeLabel(want.mode)];
    if (want.resolution) labels.push(resolutionLabel(want.resolution));
    for (const label of labels) {
      if (problem) break;
      const box = findLabel(shot.lines, label);
      if (!box) problem = notFound(`the "${label}" option in Setup`);
      else await click(p, pid, box);
    }
  } else {
    const cur = detectAnalyzeMode(shot.lines);
    const wantedText = `${want.mode}${want.resolution ? ` (${want.resolution})` : ""}`;
    if (!cur || (cur.mode === "flexible" && cur.resolution === null)) {
      problem = err(
        "mode_unverifiable",
        "the current analysis mode in Setup cannot be read from the screen. Set it by hand, or " +
          "call again with set_mode:true to have it clicked.",
      );
    } else if (
      cur.mode !== want.mode ||
      (cur.mode === "flexible" && cur.resolution !== want.resolution)
    ) {
      problem = err(
        "mode_mismatch",
        `Setup is set to ${cur.mode}${cur.resolution ? ` (${cur.resolution})` : ""}, not ` +
          `${wantedText}. Call again with set_mode:true to change it.`,
        { current: cur, wanted: { mode: want.mode, resolution: want.resolution } },
      );
    }
  }
  // Leave Setup either way so the library view is back for the next step.
  await sleep(UI_SETTLE_MS);
  const after = await ocr(p, pid, "the Setup close button");
  const close = isSeratoError(after) ? null : findCloseButton(after.lines);
  if (close) await click(p, pid, close);
  else {
    warnings.push({
      code: "setup_left_open",
      message: "no Close button was found; Setup may still be open",
    });
  }
  await sleep(UI_SETTLE_MS);
  return problem;
}

async function startCrateAnalysis(
  p: SeratoPlatform,
  pid: number,
  crate: string,
  sleep: (ms: number) => Promise<void>,
): Promise<SeratoError | null> {
  let shot = await ocr(p, pid, `the crate "${crate}"`);
  if (isSeratoError(shot)) return shot;
  const box = findCrateLabel(shot.lines, crate);
  if (!box) return notFound(`the crate "${crate}" in the crate list`);
  await click(p, pid, box);
  await sleep(UI_SETTLE_MS);
  shot = await ocr(p, pid, "the Analyze Files button");
  if (isSeratoError(shot)) return shot;
  let btn = findAnalyzeButton(shot.lines);
  if (!btn) {
    const tab = findFilesTab(shot.lines);
    if (!tab) return notFound("the Analyze Files button or the Files tab");
    await click(p, pid, tab);
    await sleep(UI_SETTLE_MS);
    shot = await ocr(p, pid, "the Analyze Files button");
    if (isSeratoError(shot)) return shot;
    btn = findAnalyzeButton(shot.lines);
    if (!btn) return notFound("the Analyze Files button");
  }
  await click(p, pid, btn);
  return null;
}

const mtime = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};
const sig = (g: GridResult) => JSON.stringify([g.tempo_map, g.beatgrid]);

export async function seratoAnalyze(
  raw: unknown,
  ctx: AnalyzeCtx,
): Promise<(SeratoAnalyzeResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(seratoAnalyzeInput, raw);
  if (isSeratoError(args)) return args;
  if (args.files !== undefined) {
    return err(
      "not_supported",
      "a loose list of files cannot be analysed: Serato analyses what is selected in its own " +
        "crate view and this server cannot select arbitrary files. Put them in a crate and pass crate.",
      { reason: "loose_files" },
    );
  }
  const crate = args.crate as string;
  if (isWholeLibraryName(crate)) {
    return err(
      "whole_library_refused",
      "analysing the whole library is never done; name one crate.",
    );
  }
  if (!ctx.read) return err("control_failed", "no library is configured to read the crate from");
  const { sleep, now } = clock(ctx);
  const p = ctx.platform;
  const warnings: Warning[] = [];

  try {
    const found = await crateFiles(ctx.read, crate);
    if (isSeratoError(found)) return found;
    if (found.files.length === 0 && found.unresolved.length === 0) {
      return err("invalid_argument", `crate ${found.name} has no tracks`, {
        reason: "empty_crate",
      });
    }
    const missing = [...found.unresolved, ...found.files.filter((f) => !existsSync(f))];
    if (missing.length > 0) {
      return err(
        "files_missing",
        `${missing.length} file(s) of the crate are missing or not local`,
        { count: missing.length, sample: missing.slice(0, 20) },
      );
    }

    const checkAudio = async (): Promise<SeratoError | null> => {
      const proc = await p.findProcess();
      if (!proc) return null;
      // Same check serato_close makes.
      const audio = await p.detectAudioPlaying(proc.pid);
      if (audio === true) {
        return err(
          "audio_playing",
          "Serato is producing audio; not analysing. Stop playback in Serato and call again.",
          { pid: proc.pid },
        );
      }
      if (audio === "unknown" && !warnings.some((w) => w.code === "audio_state_unknown")) {
        warnings.push({
          code: "audio_state_unknown",
          message: "could not tell whether Serato is playing (an ASIO output is not visible)",
        });
      }
      return null;
    };
    const audioErr = await checkAudio();
    if (audioErr) return audioErr;

    const locked = found.files.filter(
      (f) => found.dbLocked.has(f) || readMarkersFromFile(f).parsed?.markers.bpm_locked === true,
    );
    const overCap = found.files.length > MAX_ANALYZE_FILES;
    const refusals: { code: string; message: string }[] = [];
    if (overCap) {
      refusals.push({
        code: "over_cap",
        message: `${found.files.length} files, more than the cap of ${MAX_ANALYZE_FILES}`,
      });
    }
    if (locked.length > 0) {
      refusals.push({
        code: "locked_files",
        message: `${locked.length} file(s) have a locked beatgrid; Serato may leave them unchanged`,
      });
    }
    const resolution = args.resolution ?? null;
    const body = {
      crate: found.name,
      files: found.files,
      count: found.files.length,
      mode: args.mode,
      resolution,
      set_mode: args.set_mode,
      locked_files: locked,
      over_cap: overCap,
      refusals,
    };
    const confirm_token = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")
      .slice(0, 32);
    const plan = { ...body, confirm_token };

    if (args.confirm !== true) return ok({ executed: false, plan }, undefined, warnings);
    if (args.confirm_token === undefined) {
      return err("confirm_token_required", "confirm:true needs the confirm_token from the plan", {
        confirm_token,
      });
    }
    if (args.confirm_token !== confirm_token) {
      return err(
        "plan_changed",
        "the files, crate or options changed since the plan was made; review the new plan",
        { plan },
      );
    }

    // Execute.
    const opened = await seratoOpen({}, ctx);
    if (isSeratoError(opened)) return opened;
    const pid = opened.pid;
    const again = await checkAudio();
    if (again) return again;

    const modeErr = await applyMode(
      p,
      pid,
      { mode: args.mode, resolution, set: args.set_mode },
      sleep,
      warnings,
    );
    if (modeErr) return modeErr;

    const before = found.files.map((path) => {
      const grid = readGrid(path);
      return { path, mtime: mtime(path), grid, sig: sig(grid) };
    });
    const startErr = await startCrateAnalysis(p, pid, found.name, sleep);
    if (startErr) return startErr;

    const started = now();
    const deadline = started + (args.timeout_seconds ?? DEFAULT_ANALYZE_TIMEOUT_SECONDS) * 1000;
    const changed = before.map(() => false);
    const latest = before.map((b) => b.grid);
    let lastChange: number | null = null;
    let finished: "all_changed" | "quiet" | "timeout" = "timeout";
    while (now() < deadline) {
      await sleep(ANALYZE_POLL_MS);
      before.forEach((b, i) => {
        if (changed[i]) return;
        const g = readGrid(b.path);
        if (mtime(b.path) !== b.mtime || sig(g) !== b.sig) {
          changed[i] = true;
          latest[i] = g;
          lastChange = now();
        }
      });
      if (changed.every(Boolean)) {
        finished = "all_changed";
        break;
      }
      if (lastChange !== null && now() - lastChange >= ANALYZE_SETTLE_MS) {
        finished = "quiet";
        break;
      }
    }
    // Serato may touch a file before its tags are complete: take the final state of every file.
    before.forEach((b, i) => {
      const g = readGrid(b.path);
      if (mtime(b.path) !== b.mtime || sig(g) !== b.sig) changed[i] = true;
      latest[i] = g;
    });
    return ok(
      {
        executed: true,
        plan,
        finished,
        timed_out: finished === "timeout",
        waited_ms: now() - started,
        results: before.map((b, i) => ({
          path: b.path,
          changed: changed[i] as boolean,
          before_uses: b.grid.serato5_uses,
          after: summary(latest[i] as GridResult),
        })),
      },
      undefined,
      warnings,
    );
  } catch (e) {
    return controlFailed("could not analyse", e);
  }
}
