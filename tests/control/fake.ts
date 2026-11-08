import type {
  AudioState,
  FileStat,
  ProcessInfo,
  SeratoPlatform,
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
  async statDatabaseFile() {
    this.calls.push("statDatabaseFile");
    return this.db ? { ...this.db } : null;
  }
}
