import { PlatformError } from "./platform.js";
import { RESCAN_UIA_PATTERN } from "./rescan-match.js";

/**
 * PowerShell for the window-driving calls behind serato_rescan.
 *
 * Everything is scoped to ONE window, Serato's main window: its rectangle is
 * the only screen area ever captured (never the full screen), and a click is
 * refused unless the point is inside that rectangle. No script here ends a
 * process, writes a file, or types text. The only values interpolated are a
 * process id and two integer coordinates, each validated first.
 *
 * Plain string concatenation is used below instead of template literals
 * because PowerShell's escape character is the backtick.
 */

function assertPid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) throw new PlatformError(`invalid pid: ${pid}`);
  return pid;
}

function assertCoord(n: number): number {
  if (!Number.isInteger(n) || n < -32768 || n > 32767) {
    throw new PlatformError(`invalid coordinate: ${n}`);
  }
  return n;
}

const WIN32_PRELUDE = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class SW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
}
'@
[void][SW]::SetProcessDPIAware()
function Focus-Window($h) {
  if ([SW]::IsIconic($h)) { [void][SW]::ShowWindow($h, 9) }
  for ($i = 0; $i -lt 4; $i++) {
    [SW]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [SW]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][SW]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 400
    if ([SW]::GetForegroundWindow() -eq $h) { return $true }
  }
  return $false
}
function Get-Rect($h) { $r = New-Object SW+RECT; [void][SW]::GetWindowRect($h, [ref]$r); $r }
function Click-Point($h, [int]$x, [int]$y) {
  $r = Get-Rect $h
  if ($x -lt $r.L -or $x -ge $r.R -or $y -lt $r.T -or $y -ge $r.B) { return 'point is outside the Serato window' }
  if (-not (Focus-Window $h)) { return 'could not bring the Serato window to the front' }
  $old = New-Object SW+PT; [void][SW]::GetCursorPos([ref]$old)
  [void][SW]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 120
  [SW]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [SW]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120
  [void][SW]::SetCursorPos($old.X, $old.Y)
  return $null
}
function Get-SeratoHandle([int]$procId) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $p) { return [IntPtr]::Zero }
  $p.Refresh(); return $p.MainWindowHandle
}
`;

const UIA_PRELUDE = String.raw`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Get-UiaElements($h, [int]$cap) {
  $root = [Windows.Automation.AutomationElement]::FromHandle($h)
  $all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  $n = [Math]::Min($all.Count, $cap)
  for ($i = 0; $i -lt $n; $i++) { $all.Item($i) }
}
`;

const UIA_RESCAN_BODY = String.raw`
if ($h -eq [IntPtr]::Zero) { @{ found = $false; count = 0 } | ConvertTo-Json -Compress; return }
$els = @(Get-UiaElements $h 5000)
$hit = $els | Where-Object { $_.Current.Name -match $pat -or $_.Current.AutomationId -match $pat } | Select-Object -First 1
if (-not $hit) { @{ found = $false; count = $els.Count } | ConvertTo-Json -Compress; return }
$action = 'click'
$ip = $null
if ($hit.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { $ip.Invoke(); $action = 'invoke' }
else {
  $r = $hit.Current.BoundingRectangle
  if ($r.IsEmpty) { @{ found = $false; count = $els.Count } | ConvertTo-Json -Compress; return }
  $why = Click-Point $h ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2))
  if ($why) { throw $why }
}
@{ found = $true; count = $els.Count; name = $hit.Current.Name; id = $hit.Current.AutomationId; action = $action } | ConvertTo-Json -Compress`;

const UIA_TEXT_BODY = String.raw`
$names = @()
if ($h -ne [IntPtr]::Zero) { $names = @(Get-UiaElements $h 2000 | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
@{ names = $names } | ConvertTo-Json -Compress`;

/**
 * Screenshot of the Serato window rectangle only, after bringing that window
 * to the front so nothing else sits inside the rectangle (if it cannot be
 * brought to the front nothing is captured). Upscaled up to 3x because the UI
 * text is tiny, then recognised with Windows.Media.Ocr. The image lives in
 * memory only. Coordinates come back in screen pixels.
 */
const OCR_BODY = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
if ($h -eq [IntPtr]::Zero) { @{ error = 'Serato has no main window' } | ConvertTo-Json -Compress; return }
if (-not (Focus-Window $h)) { @{ error = 'could not bring the Serato window to the front, so it was not captured' } | ConvertTo-Json -Compress; return }
$r = Get-Rect $h
$w = $r.R - $r.L; $hh = $r.B - $r.T
if ($w -lt 200 -or $hh -lt 200) { @{ error = 'the Serato window is minimised or too small to read' } | ConvertTo-Json -Compress; return }
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $eng) { @{ error = 'Windows OCR has no recognition language installed for this user' } | ConvertTo-Json -Compress; return }
$S = [Math]::Max(1, [Math]::Min(3, [Math]::Floor([Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [Math]::Max($w, $hh))))
$bmp = New-Object Drawing.Bitmap $w, $hh
$g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $g.Dispose()
$big = New-Object Drawing.Bitmap ($w * $S), ($hh * $S)
$g = [Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($bmp, 0, 0, ($w * $S), ($hh * $S)); $g.Dispose()
$ms = New-Object IO.MemoryStream; $big.Save($ms, [Drawing.Imaging.ImageFormat]::Png); [void]$ms.Seek(0, 'Begin')
$bmp.Dispose(); $big.Dispose()
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
function Await($op, $t) { $x = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$x.Wait(-1); $x.Result }
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($l in $res.Lines) {
  $ws = @()
  foreach ($wd in $l.Words) {
    $b = $wd.BoundingRect
    $ws += @{ text = $wd.Text; x = [int]($r.L + $b.X / $S); y = [int]($r.T + $b.Y / $S); w = [int]($b.Width / $S); h = [int]($b.Height / $S) }
  }
  $lines += @{ text = $l.Text; words = $ws }
}
@{ left = $r.L; top = $r.T; width = $w; height = $hh; lines = $lines } | ConvertTo-Json -Compress -Depth 5`;

const CLICK_BODY = String.raw`
if ($h -eq [IntPtr]::Zero) { @{ ok = $false; error = 'Serato has no main window' } | ConvertTo-Json -Compress; return }
$why = Click-Point $h $cx $cy
if ($why) { @{ ok = $false; error = $why } | ConvertTo-Json -Compress } else { @{ ok = $true } | ConvertTo-Json -Compress }`;

function handleLine(pid: number): string {
  return `\n$h = Get-SeratoHandle ${assertPid(pid)}`;
}

export const WINDOW_SCRIPTS = {
  /** UIA search for the rescan button by name or AutomationId; press it if found. */
  uiaRescan: (pid: number) =>
    WIN32_PRELUDE +
    UIA_PRELUDE +
    handleLine(pid) +
    `\n$pat = '${RESCAN_UIA_PATTERN}'` +
    UIA_RESCAN_BODY,
  uiaText: (pid: number) => WIN32_PRELUDE + UIA_PRELUDE + handleLine(pid) + UIA_TEXT_BODY,
  ocr: (pid: number) => WIN32_PRELUDE + handleLine(pid) + OCR_BODY,
  click: (pid: number, x: number, y: number) =>
    WIN32_PRELUDE +
    handleLine(pid) +
    `\n$cx = ${assertCoord(x)}; $cy = ${assertCoord(y)}` +
    CLICK_BODY,
};
