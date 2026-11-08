import { z } from "zod";
import { parseToolArgs } from "../args.js";
import {
  type ControlCtx,
  clock,
  controlFailed,
  POLL_MS,
  STABILITY_MS,
} from "../control/context.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";

export const MAX_CLOSE_TIMEOUT_SECONDS = 120;
export const DEFAULT_CLOSE_TIMEOUT_SECONDS = 30;
/** Pairs of database-file stats tried before giving up on it settling. */
const STABILITY_ATTEMPTS = 3;
/** Serato asks "Exit - are you sure?" a moment after the close request. */
const DIALOG_FIRST_CHECK_MS = 1000;
const DIALOG_RETRY_MS = 3000;
const DIALOG_MAX_ATTEMPTS = 3;

export const seratoCloseInput = z
  .object({
    confirm: z.boolean(),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_CLOSE_TIMEOUT_SECONDS)
      .default(DEFAULT_CLOSE_TIMEOUT_SECONDS),
  })
  .refine((v) => v.confirm === true, {
    error: "serato_close closes the Serato window and needs confirm: true",
    params: { reason: "confirm_required" },
  });

export const seratoCloseDescription =
  "Gracefully close Serato DJ Pro (Windows only, needs --allow-serato-control): asks its main " +
  "window to close, exactly like the close button (if Serato answers with its 'Exit - are you sure?' " +
  "dialog, that dialog's Yes/OK button is pressed -- only ever after the audio check passed), waits up to timeout_seconds (default 30, max " +
  "120) for the process to exit, then confirms the _Serato_ 'database V2' file stopped changing " +
  "for ~2 seconds. It never forces anything to end. Refused with audio_playing when the audio " +
  "meter shows sound (if the meter cannot be read the answer is 'unknown' and the close goes " +
  "ahead). If Serato does not exit -- usually because a dialog is waiting for the user -- the " +
  "error says it is still running and was NOT killed (also when no exit dialog could be found). Needs confirm: true; get the user's " +
  "go-ahead first, since unsaved DJ work is theirs to decide about. Closing Serato is what makes " +
  "apply_changes possible.";

export const seratoCloseOutput = z.object({
  was_running: z.boolean(),
  exited: z.boolean(),
  pid: z.number().nullable(),
  waited_ms: z.number(),
  database_file_stable: z.boolean().nullable(),
  audio_playing: z.union([z.boolean(), z.literal("unknown")]),
  warnings: z.array(warningSchema).optional(),
});

export type SeratoCloseResult = Omit<z.infer<typeof seratoCloseOutput>, "warnings">;

export async function seratoClose(
  raw: unknown,
  ctx: ControlCtx,
): Promise<(SeratoCloseResult & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(seratoCloseInput, raw);
  if (isSeratoError(args)) return args;
  const { sleep, now } = clock(ctx);
  const p = ctx.platform;
  const warnings: Warning[] = [];

  try {
    const proc = await p.findProcess();
    if (!proc) {
      return ok({
        was_running: false,
        exited: true,
        pid: null,
        waited_ms: 0,
        database_file_stable: null,
        audio_playing: false,
      });
    }

    const audio = await p.detectAudioPlaying(proc.pid);
    if (audio === true) {
      return err(
        "audio_playing",
        "Serato is producing audio; not closing it. Stop playback in Serato and call again.",
        { pid: proc.pid },
      );
    }
    if (audio === "unknown") {
      warnings.push({
        code: "audio_state_unknown",
        message:
          "could not tell whether Serato is playing (an ASIO output is not visible to the " +
          "audio meter); closed on the confirmation alone",
      });
    }

    const started = now();
    const delivered = await p.requestClose(proc.pid);
    if (!delivered) {
      return err(
        "control_failed",
        "Serato has no main window to ask to close. It is still running and was NOT killed.",
        { pid: proc.pid, killed: false },
      );
    }

    const deadline = started + args.timeout_seconds * 1000;
    let alive = true;
    let dialogAttempts = 0;
    let dialogConfirmed = false;
    let nextDialogCheck = started + DIALOG_FIRST_CHECK_MS;
    while (now() < deadline) {
      await sleep(POLL_MS);
      alive = await p.isProcessAlive(proc.pid);
      if (!alive) break;
      // Still alive: Serato 4 shows an "Exit - are you sure?" dialog and waits
      // for an answer. Audio was already checked above, so reaching here means
      // the user's confirm: true plus a silent (or unknowable) meter.
      if (!dialogConfirmed && dialogAttempts < DIALOG_MAX_ATTEMPTS && now() >= nextDialogCheck) {
        dialogAttempts++;
        nextDialogCheck = now() + DIALOG_RETRY_MS;
        dialogConfirmed = (await p.confirmExitDialog(proc.pid)) === "clicked";
      }
    }
    if (alive) alive = await p.isProcessAlive(proc.pid);
    if (alive) {
      return err(
        "still_running",
        `Serato did not exit within ${args.timeout_seconds} s. It is still running and was ` +
          "NOT killed -- a dialog (for example an unsaved-changes prompt) may be waiting for the user.",
        { pid: proc.pid, waited_seconds: args.timeout_seconds, killed: false },
      );
    }
    const waitedMs = now() - started;

    // The process is gone; the database file must also have stopped moving
    // before anything else is allowed to touch the library.
    let stable: boolean | null = null;
    let before = await p.statDatabaseFile();
    if (before === null) {
      warnings.push({
        code: "database_file_not_found",
        message: "no _Serato_ 'database V2' file found; its stability could not be confirmed",
      });
    } else {
      stable = false;
      for (let i = 0; i < STABILITY_ATTEMPTS && !stable; i++) {
        await sleep(STABILITY_MS);
        const after = await p.statDatabaseFile();
        if (after !== null && after.mtimeMs === before.mtimeMs && after.size === before.size) {
          stable = true;
        } else before = after ?? before;
      }
      if (!stable) {
        return err(
          "busy",
          "Serato has exited but its 'database V2' file is still changing; something else is " +
            "writing to it. Wait and check serato_status before touching the library.",
          { pid: proc.pid, exited: true },
        );
      }
    }

    return ok(
      {
        was_running: true,
        exited: true,
        pid: proc.pid,
        waited_ms: waitedMs,
        database_file_stable: stable,
        audio_playing: audio,
      },
      undefined,
      warnings,
    );
  } catch (e) {
    return controlFailed("could not close Serato", e);
  }
}
