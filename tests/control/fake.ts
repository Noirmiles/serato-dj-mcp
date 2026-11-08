import type {
  AudioState,
  FileStat,
  OcrWindow,
  ProcessInfo,
  SeratoPlatform,
  UiaRescanOutcome,
  WindowInfo,
} from "../../src/control/platform.js";

/**
 * An in-memory SeratoPlatform with a virtual clock. `sleep` advances the
 * clock and runs `onTick`, which a test uses to script what the "world" does
 * as time passes (the process exits, the database file changes, a window
 * appears). Every call is recorded in `calls`; there is no method that could
 * end a process by force, so `calls` proves none was attempted.
 */
export class FakePlatform implements SeratoPlatform {
  time = 0;
  calls: string[] = [];
  proc: ProcessInfo | null = null;
  window: WindowInfo | null = null;
  audio: AudioState = false;
  alive = false;
  install: string | null = "C:\\Fake\\Serato DJ Pro.exe";
  db: FileStat | null = { mtimeMs: 1000, size: 10 };
  /** Does a delivered close request make the process exit (on the next tick)? */
  exitsOnClose = true;
  closeDelivered = true;
  launchFails = false;
  /** serato_rescan scripting. */
  uia: UiaRescanOutcome | Error = { found: false, elementCount: 0 };
  /** What UIA can read of the window, per poll; the last entry repeats. */
  uiaText: Array<string[] | null> = [[]];
  /** OCR results, one per ocrWindow call; the last entry repeats. An Error is thrown. */
  ocrs: Array<OcrWindow | Error> = [];
  clicks: Array<{ x: number; y: number }> = [];
  /** Run when a click lands (a test makes the "window" react). */
  onClick: (fake: FakePlatform, x: number, y: number) => void = () => {};
  private uiaTextCalls = 0;
  private ocrCalls = 0;
  onTick: (fake: FakePlatform) => void = () => {};
  private closeRequested = false;

  static running(over: Partial<FakePlatform> = {}): FakePlatform {
    const f = new FakePlatform();
    f.proc = { pid: 4242, name: "Serato DJ Pro", path: "C:\\Fake\\Serato DJ Pro.exe" };
    f.window = { handle: "100", title: "Serato DJ Pro", responding: true };
    f.alive = true;
    return Object.assign(f, over);
  }

  readonly sleep = async (ms: number) => {
    this.time += ms;
    if (this.closeRequested && this.exitsOnClose) {
      this.alive = false;
      this.proc = null;
      this.window = null;
    }
    this.onTick(this);
  };
  readonly now = () => this.time;

  async findProcess() {
    this.calls.push("findProcess");
    return this.proc;
  }
  async getMainWindow(pid: number) {
    this.calls.push(`getMainWindow:${pid}`);
    return this.window;
  }
  async requestClose(pid: number) {
    this.calls.push(`requestClose:${pid}`);
    if (this.closeDelivered) this.closeRequested = true;
    return this.closeDelivered;
  }
  async isProcessAlive(pid: number) {
    this.calls.push(`isProcessAlive:${pid}`);
    return this.alive;
  }
  async launch(exePath: string) {
    this.calls.push(`launch:${exePath}`);
    if (this.launchFails) throw new Error("spawn failed");
    return { pid: 777 };
  }
  async findInstallPath() {
    this.calls.push("findInstallPath");
    return this.install;
  }
  async detectAudioPlaying(pid: number) {
    this.calls.push(`detectAudioPlaying:${pid}`);
    return this.audio;
  }
  async uiaRescan(pid: number) {
    this.calls.push(`uiaRescan:${pid}`);
    if (this.uia instanceof Error) throw this.uia;
    return this.uia;
  }
  async uiaWindowText(pid: number) {
    this.calls.push(`uiaWindowText:${pid}`);
    const i = Math.min(this.uiaTextCalls++, this.uiaText.length - 1);
    return this.uiaText[i] ?? null;
  }
  async ocrWindow(pid: number): Promise<OcrWindow> {
    this.calls.push(`ocrWindow:${pid}`);
    const o = this.ocrs[Math.min(this.ocrCalls++, this.ocrs.length - 1)];
    if (!o) throw new Error("no OCR scripted");
    if (o instanceof Error) throw o;
    return o;
  }
  async clickWindowPoint(pid: number, x: number, y: number) {
    this.calls.push(`click:${pid}:${x},${y}`);
    this.clicks.push({ x, y });
    this.onClick(this, x, y);
  }
  async statDatabaseFile() {
    this.calls.push("statDatabaseFile");
    return this.db ? { ...this.db } : null;
  }
}
