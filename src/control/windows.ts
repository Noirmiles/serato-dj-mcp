import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, win32 } from "node:path";
import {
  parseAudio,
  parseBool,
  parseClick,
  parseInstallPath,
  parseOcr,
  parseProcess,
  parseUiaRescan,
  parseUiaText,
  parseWindow,
} from "./parse.js";
import {
  type AudioState,
  type FileStat,
  type OcrWindow,
  PlatformError,
  type ProcessInfo,
  type SeratoPlatform,
  type UiaRescanOutcome,
  type WindowInfo,
} from "./platform.js";
import { WINDOW_SCRIPTS } from "./window-scripts.js";

/**
 * The Windows backend: the only code in this server that looks at processes
 * and windows.
 *
 * Why Windows PowerShell 5.1 and not a native addon, Python or a helper
 * binary: it ships with every Windows install, needs no npm dependency, no
 * compiler and no extra download, and reaches everything required through
 * built-in .NET (Get-Process, Process.CloseMainWindow, the registry provider)
 * plus one Add-Type block for the COM audio-meter interfaces. The scripts run
 * with -NoProfile -NonInteractive and are passed as -EncodedCommand
 * (base64 UTF-16LE), so no argument is ever re-parsed by a shell and nothing
 * the user typed can reach a command line: the only value interpolated into a
 * script is a process id, which is validated as an integer first.
 *
 * Nothing here ends a process by force. requestClose() only asks the main
 * window to close, exactly as the user's close button does.
 */

const PROCESS_NAME = "Serato DJ Pro";
const EXE_NAME = "Serato DJ Pro.exe";
// Built here because a backslash directly before `${` would escape it inside String.raw.
const APP_PATHS = `\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${EXE_NAME}`;
const APP_PATHS_HKLM = `HKLM:${APP_PATHS}`;
const APP_PATHS_HKCU = `HKCU:${APP_PATHS}`;
const DEFAULT_SUBPATH = `Serato\\${PROCESS_NAME}\\${EXE_NAME}`;
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZ";

/** Wraps a script so output is UTF-8 (window titles may not be ASCII) and
 *  progress records never reach stdout. */
export function encodeScript(script: string): string {
  const full = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop';\n${script}\nexit 0`;
  return Buffer.from(full, "utf16le").toString("base64");
}

function assertPid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) throw new PlatformError(`invalid pid: ${pid}`);
  return pid;
}

export const SCRIPTS = {
  findProcess: `
$p = Get-Process -Name '${PROCESS_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) {
  $path = $null
  try { $path = $p.MainModule.FileName } catch {}
  @{ pid = $p.Id; name = $p.ProcessName; path = $path } | ConvertTo-Json -Compress
}`,
  window: (pid: number) => `
$p = Get-Process -Id ${assertPid(pid)} -ErrorAction SilentlyContinue
if ($p) {
  $p.Refresh()
  @{ handle = [string]$p.MainWindowHandle.ToInt64(); title = $p.MainWindowTitle; responding = [bool]$p.Responding } | ConvertTo-Json -Compress
}`,
  requestClose: (pid: number) => `
$p = Get-Process -Id ${assertPid(pid)} -ErrorAction SilentlyContinue
$sent = $false
if ($p) { $sent = [bool]$p.CloseMainWindow() }
@{ ok = $sent } | ConvertTo-Json -Compress`,
  isAlive: (pid: number) => `
$p = Get-Process -Id ${assertPid(pid)} -ErrorAction SilentlyContinue
$alive = $false
if ($p) { $alive = -not $p.HasExited }
@{ ok = $alive } | ConvertTo-Json -Compress`,
  installPath: String.raw`
$c = New-Object System.Collections.Generic.List[string]
$uninstall = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
foreach ($k in $uninstall) {
  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {
    $i = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($i.DisplayName -like '${PROCESS_NAME}*') {
      if ($i.InstallLocation) { $c.Add((Join-Path $i.InstallLocation '${EXE_NAME}')) }
      if ($i.DisplayIcon) { $c.Add((($i.DisplayIcon -replace ',-?\d+$','').Trim('"'))) }
    }
  }
}
foreach ($k in '${APP_PATHS_HKLM}','${APP_PATHS_HKCU}') {
  $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'
  if ($v) { $c.Add($v.Trim('"')) }
}
foreach ($b in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
  if ($b) {
    $c.Add((Join-Path $b '${DEFAULT_SUBPATH}'))
    Get-ChildItem (Join-Path $b 'Serato') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $c.Add((Join-Path $_.FullName '${EXE_NAME}')) }
  }
}
$hit = $c | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
@{ path = $hit } | ConvertTo-Json -Compress`,
  /**
   * Audio detection. Serato's audio sessions are enumerated through the
   * Windows core-audio COM API (IMMDeviceEnumerator -> IAudioSessionManager2
   * -> IAudioSessionEnumerator) on every active render device; the session
   * whose process id is Serato's is asked for its IAudioMeterInformation peak
   * value, sampled 8 times over ~0.5 s. A peak above 0.001 is "playing".
   *
   * Limits, stated plainly: this sees only audio routed through WASAPI / the
   * Windows mixer. Serato driving a DJ controller through ASIO (the usual
   * setup) bypasses that mixer, so no session exists and the answer is
   * "unknown", never "silent". A session that exists but is quiet (paused,
   * faders down, a cue-only channel) reads as not playing. Any COM failure is
   * "unknown". Callers must refuse only on a positive "playing".
   */
  audio: (pid: number) => `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr groupingParam, int streamFlags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr groupingParam, int streamFlags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  [PreserveSig] int RegisterSessionNotification(IntPtr notification);
  [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
  [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
  [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
  [PreserveSig] int GetGroupingParam(out Guid param);
  [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
  [PreserveSig] int SetDuckingPreference(bool optOut);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
  [PreserveSig] int GetPeakValue(out float peak);
}

public static class SeratoAudio {
  public static string Detect(uint pid) {
    try {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDeviceCollection devs;
      if (en.EnumAudioEndpoints(0, 1, out devs) != 0) return "error";
      uint n; devs.GetCount(out n);
      bool found = false; float peak = 0f;
      Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
      for (uint i = 0; i < n; i++) {
        IMMDevice dev; devs.Item(i, out dev);
        object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        var mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator se; mgr.GetSessionEnumerator(out se);
        int c; se.GetCount(out c);
        for (int j = 0; j < c; j++) {
          IAudioSessionControl2 sc; se.GetSession(j, out sc);
          uint spid; sc.GetProcessId(out spid);
          if (spid != pid) continue;
          found = true;
          var meter = (IAudioMeterInformation)sc;
          for (int k = 0; k < 8; k++) {
            float v; meter.GetPeakValue(out v);
            if (v > peak) peak = v;
            Thread.Sleep(60);
          }
        }
      }
      if (!found) return "no_session";
      return peak > 0.001f ? "playing" : "silent";
    } catch (Exception) { return "error"; }
  }
}
'@
$r = [SeratoAudio]::Detect(${assertPid(pid)})
@{ audio = $r } | ConvertTo-Json -Compress`,
};

export type WindowsOptions = {
  env?: NodeJS.ProcessEnv;
  /** The library folder in use, if known; "database V2" is looked for beside it. */
  libraryHint?: string;
  /** Test seam: run a script, return stdout. */
  run?: (script: string) => Promise<string>;
};

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeScript(script)],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new PlatformError(
              `powershell failed (exit ${String(error.code)})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
            ),
          );
        } else resolve(stdout);
      },
    );
  });
}

export class WindowsSeratoPlatform implements SeratoPlatform {
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: (script: string) => Promise<string>;
  private readonly libraryHint: string | undefined;

  constructor(opts: WindowsOptions = {}) {
    this.env = opts.env ?? process.env;
    this.run = opts.run ?? runPowerShell;
    this.libraryHint = opts.libraryHint;
  }

  async findProcess(): Promise<ProcessInfo | null> {
    return parseProcess(await this.run(SCRIPTS.findProcess));
  }

  async getMainWindow(pid: number): Promise<WindowInfo | null> {
    return parseWindow(await this.run(SCRIPTS.window(pid)));
  }

  async requestClose(pid: number): Promise<boolean> {
    return parseBool(await this.run(SCRIPTS.requestClose(pid)), "ok");
  }

  async isProcessAlive(pid: number): Promise<boolean> {
    return parseBool(await this.run(SCRIPTS.isAlive(pid)), "ok");
  }

  async launch(exePath: string): Promise<{ pid: number }> {
    if (!/\.exe$/i.test(exePath) || !existsSync(exePath)) {
      throw new PlatformError(`not an existing .exe file: ${exePath}`);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(exePath, [], {
        detached: true,
        stdio: "ignore",
        cwd: dirname(exePath),
      });
      child.once("error", (e) => reject(new PlatformError(`launch failed: ${e.message}`)));
      child.once("spawn", () => {
        child.unref();
        resolve({ pid: child.pid ?? 0 });
      });
    });
  }

  async findInstallPath(): Promise<string | null> {
    const override = this.env.SERATO_DJ_EXE;
    if (override && existsSync(override)) return override;
    return parseInstallPath(await this.run(SCRIPTS.installPath));
  }

  async detectAudioPlaying(pid: number): Promise<AudioState> {
    try {
      return parseAudio(await this.run(SCRIPTS.audio(pid)));
    } catch {
      return "unknown";
    }
  }

  async uiaRescan(pid: number): Promise<UiaRescanOutcome> {
    return parseUiaRescan(await this.run(WINDOW_SCRIPTS.uiaRescan(pid)));
  }

  async uiaWindowText(pid: number): Promise<string[] | null> {
    try {
      return parseUiaText(await this.run(WINDOW_SCRIPTS.uiaText(pid)));
    } catch {
      return null;
    }
  }

  async ocrWindow(pid: number): Promise<OcrWindow> {
    return parseOcr(await this.run(WINDOW_SCRIPTS.ocr(pid)));
  }

  async clickWindowPoint(pid: number, x: number, y: number): Promise<void> {
    parseClick(await this.run(WINDOW_SCRIPTS.click(pid, x, y)));
  }

  async statDatabaseFile(): Promise<FileStat | null> {
    for (const p of this.databaseCandidates()) {
      try {
        const s = statSync(p);
        if (s.isFile()) return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        // Not there (or a drive that cannot be asked): try the next one.
      }
    }
    return null;
  }

  /** "database V2" sits in _Serato_ beside Library; _Serato_ is in the user's
   *  Music folder or at the root of each drive. */
  private databaseCandidates(): string[] {
    const out: string[] = [];
    if (this.libraryHint) out.push(win32.join(win32.dirname(this.libraryHint), "database V2"));
    const profile = this.env.USERPROFILE;
    if (profile) out.push(win32.join(profile, "Music", "_Serato_", "database V2"));
    for (const l of DRIVE_LETTERS) out.push(`${l}:\\_Serato_\\database V2`);
    return out;
  }
}
