import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { type ControlCtx, clock, controlFailed, POLL_MS } from "../control/context.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";

export const seratoOpenInput = z.strictObject({
  timeout_seconds: z.number().int().min(1).max(300).optional(),
});

export const seratoOpenDescription =
  "Start Serato DJ Pro (Windows only, needs --allow-serato-control) and wait until its main " +
  "window exists, responds and has a title (timeout_seconds, default 60, max 300). If it is " +
  "already running nothing is launched and already_running is true. The executable is found from " +
  "the SERATO_DJ_EXE environment variable, else the registry's uninstall and App Paths keys, " +
  "else the Program Files folders; if none is found the error says so and names SERATO_DJ_EXE.";

export const seratoOpenOutput = z.object({
  already_running: z.boolean(),
  pid: z.number(),
  window_title: z.string().nullable(),
  install_path: z.string().nullable(),
  waited_ms: z.number(),
  warnings: z.array(warningSchema).optional(),
});

export type SeratoOpenResult = Omit<z.infer<typeof seratoOpenOutput>, "warnings">;

export async function seratoOpen(
  raw: unknown,
  ctx: ControlCtx,
): Promise<(SeratoOpenResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(seratoOpenInput, raw);
  if (isSeratoError(args)) return args;
  const timeoutS = args.timeout_seconds ?? 60;
  const { sleep, now } = clock(ctx);
  const p = ctx.platform;

  try {
    const running = await p.findProcess();
    if (running) {
      const win = await p.getMainWindow(running.pid);
      return ok({
        already_running: true,
        pid: running.pid,
        window_title: win ? win.title : null,
        install_path: running.path ?? (await p.findInstallPath()),
        waited_ms: 0,
      });
    }

    const install = await p.findInstallPath();
    if (!install) {
      return err(
        "install_not_found",
        "Serato DJ Pro's executable was not found in the registry or the Program Files " +
          "folders. Set the SERATO_DJ_EXE environment variable to the full path of " +
          "'Serato DJ Pro.exe' and try again.",
      );
    }

    const started = now();
    try {
      await p.launch(install);
    } catch (e) {
      return err(
        "launch_failed",
        `could not start ${install}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const deadline = started + timeoutS * 1000;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const proc = await p.findProcess();
      if (!proc) continue;
      const win = await p.getMainWindow(proc.pid);
      if (win?.responding && win.title.trim() !== "") {
        return ok({
          already_running: false,
          pid: proc.pid,
          window_title: win.title,
          install_path: install,
          waited_ms: now() - started,
        });
      }
    }
    return err(
      "launch_timeout",
      `Serato was started but its window was not ready within ${timeoutS} s. It may still be ` +
        "loading; check serato_status. It was not stopped.",
      { install_path: install },
    );
  } catch (e) {
    return controlFailed("could not open Serato", e);
  }
}
