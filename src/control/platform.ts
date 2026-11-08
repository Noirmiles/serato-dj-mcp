/**
 * The only seam between the Serato control tools and the operating system.
 *
 * Everything under src/tools/serato-{status,close,open}.ts talks to this
 * interface and nothing else, so the tests inject a fake and the Windows
 * backend (windows.ts) is the one place that touches processes and windows.
 *
 * There is deliberately no method that ends a process by force.
 * The strongest thing a platform can do is ask the main window to close.
 */

export type ProcessInfo = {
  pid: number;
  /** Image name without extension, e.g. "Serato DJ Pro". */
  name: string;
  /** Full path of the executable; null when the OS would not tell us. */
  path: string | null;
};

export type WindowInfo = {
  /** Opaque window handle as a decimal string. */
  handle: string;
  title: string;
  responding: boolean;
};

/** true / false when the meter could be read, "unknown" when it could not. */
export type AudioState = true | false | "unknown";

export type FileStat = { mtimeMs: number; size: number };

export interface SeratoPlatform {
  /** The running Serato DJ Pro process, or null. */
  findProcess(): Promise<ProcessInfo | null>;
  /** The process's main window, or null while it has none (starting, closing). */
  getMainWindow(pid: number): Promise<WindowInfo | null>;
  /** Asks the main window to close (WM_CLOSE / CloseMainWindow). Resolves to
   *  whether the request was delivered; it says nothing about whether Serato
   *  agreed. Never terminates the process. */
  requestClose(pid: number): Promise<boolean>;
  isProcessAlive(pid: number): Promise<boolean>;
  /** Starts the executable detached and resolves to its pid. */
  launch(exePath: string): Promise<{ pid: number }>;
  /** SERATO_DJ_EXE, else registry / App Paths / Program Files; null if none. */
  findInstallPath(): Promise<string | null>;
  /** Whether the Serato process is currently producing audio. */
  detectAudioPlaying(pid: number): Promise<AudioState>;
  /** mtime and size of the _Serato_ "database V2" file; null if not found. */
  statDatabaseFile(): Promise<FileStat | null>;
}

/** Thrown by a backend when the OS call itself failed (not "not found"). */
export class PlatformError extends Error {}
