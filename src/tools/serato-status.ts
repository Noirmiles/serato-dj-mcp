import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { type ControlCtx, clock, controlFailed, STABILITY_MS } from "../control/context.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";

export const seratoStatusInput = z.strictObject({});

export const seratoStatusDescription =
  "Report whether Serato DJ Pro is running (Windows only, needs --allow-serato-control): process " +
  "name, path and pid, the main window's title and whether it responds, whether the audio meter " +
  "shows sound (true, false, or 'unknown' when it cannot be read -- Serato on an ASIO driver is " +
  "invisible to it), and the discovered install path. looks_idle is true only when Serato runs, " +
  "its window responds and the _Serato_ 'database V2' file did not change over a ~2 second poll; " +
  "it is a hint that nothing is being written, not a guarantee. Read-only: changes nothing.";

export const seratoStatusOutput = z.object({
  running: z.boolean(),
  process_name: z.string().nullable(),
  process_path: z.string().nullable(),
  pid: z.number().nullable(),
  window_title: z.string().nullable(),
  responding: z.boolean().nullable(),
  looks_idle: z.boolean(),
  audio_playing: z.union([z.boolean(), z.literal("unknown")]),
  install_path: z.string().nullable(),
  warnings: z.array(warningSchema).optional(),
});

export type SeratoStatusResult = Omit<z.infer<typeof seratoStatusOutput>, "warnings">;

export async function seratoStatus(
  raw: unknown,
  ctx: ControlCtx,
): Promise<(SeratoStatusResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(seratoStatusInput, raw);
  if (isSeratoError(args)) return args;
  const { sleep } = clock(ctx);
  const p = ctx.platform;
  const warnings: Warning[] = [];

  try {
    const installPath = await p.findInstallPath();
    const proc = await p.findProcess();
    if (!proc) {
      return ok({
        running: false,
        process_name: null,
        process_path: null,
        pid: null,
        window_title: null,
        responding: null,
        looks_idle: false,
        audio_playing: false,
        install_path: installPath,
      });
    }
    const win = await p.getMainWindow(proc.pid);
    const audio = await p.detectAudioPlaying(proc.pid);

    let looksIdle = false;
    const before = await p.statDatabaseFile();
    if (before === null) {
      warnings.push({
        code: "database_file_not_found",
        message: "no _Serato_ 'database V2' file found, so looks_idle cannot be established",
      });
    } else if (win?.responding) {
      await sleep(STABILITY_MS);
      const after = await p.statDatabaseFile();
      looksIdle = after !== null && after.mtimeMs === before.mtimeMs && after.size === before.size;
    }

    return ok(
      {
        running: true,
        process_name: proc.name,
        process_path: proc.path,
        pid: proc.pid,
        window_title: win ? win.title : null,
        responding: win ? win.responding : null,
        looks_idle: looksIdle,
        audio_playing: audio,
        install_path: installPath ?? proc.path,
      },
      undefined,
      warnings,
    );
  } catch (e) {
    return controlFailed("could not read Serato's state", e);
  }
}
