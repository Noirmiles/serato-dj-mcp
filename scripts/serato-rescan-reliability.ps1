<#
.SYNOPSIS
  Runs the serato_rescan logic N times against a running Serato DJ Pro and prints,
  per run, the method (uia|ocr), verified (true|false|unknown) and duration.

.DESCRIPTION
  WARNING: each run presses "Re-Scan File Info", which makes Serato re-read the tags
  of EVERY file in the library. On a large library that is slow and heavy on the disk,
  so the script asks first (pass -Yes to skip the question) and waits -GapSeconds
  between runs. It never writes library files itself and never kills Serato.
  The mouse is driven for real (OCR route): do not touch it while a run is in progress.
  Needs: Windows, Serato DJ Pro running with its main window visible, and
  `npm install` done in the repo (it uses node_modules\.bin\tsx).

.PARAMETER Runs        Number of runs (default 5).
.PARAMETER GapSeconds  Pause between runs (default 20).
.PARAMETER Yes         Do not ask for confirmation.

.EXAMPLE
  powershell -NoProfile -File scripts\serato-rescan-reliability.ps1 -Runs 5
#>
param([int]$Runs = 5, [int]$GapSeconds = 20, [switch]$Yes)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tsx = Join-Path $repo 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path -LiteralPath $tsx)) { Write-Output 'tsx not found: run "npm install" in the repo first.'; exit 2 }
$p = Get-Process -Name 'Serato DJ Pro' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output 'Serato DJ Pro is not running. Start it first (or use the serato_open tool).'; exit 2 }
$version = $p.MainModule.FileVersionInfo.ProductVersion
if (-not $Yes) {
  $a = Read-Host "This presses Re-Scan File Info $Runs times on Serato $version (whole library each time). Continue? [y/N]"
  if ($a -notmatch '^(y|yes)$') { Write-Output 'Cancelled.'; exit 1 }
}
Write-Output "Serato DJ Pro $version, $Runs run(s)"
$rows = @()
for ($i = 1; $i -le $Runs; $i++) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $line = & $tsx (Join-Path $repo 'scripts\serato-rescan-once.ts') 2>&1 | Select-Object -Last 1
  $sw.Stop()
  try { $r = $line | ConvertFrom-Json } catch { $r = $null }
  if ($r -and $r.method) {
    $row = [pscustomobject]@{ run = $i; method = $r.method; verified = "$($r.verified)"; ms = $r.duration_ms; note = $r.verification_note }
  } elseif ($r -and $r.error) {
    $row = [pscustomobject]@{ run = $i; method = '-'; verified = 'error'; ms = $sw.ElapsedMilliseconds; note = "$($r.error.code): $($r.error.message)" }
  } else {
    $row = [pscustomobject]@{ run = $i; method = '-'; verified = 'error'; ms = $sw.ElapsedMilliseconds; note = "unreadable output: $line" }
  }
  $rows += $row
  Write-Output ('run {0}: method={1} verified={2} duration={3}ms' -f $row.run, $row.method, $row.verified, $row.ms)
  if ($i -lt $Runs) { Start-Sleep -Seconds $GapSeconds }
}
$clicked = @($rows | Where-Object { $_.method -ne '-' }).Count
$verified = @($rows | Where-Object { $_.verified -eq 'True' }).Count
Write-Output ''
Write-Output ("Serato {0}: button pressed in {1}/{2} runs; verified true in {3}/{2}" -f $version, $clicked, $Runs, $verified)
Write-Output "Methods used: $((($rows | Where-Object { $_.method -ne '-' } | Group-Object method | ForEach-Object { '{0} x{1}' -f $_.Name, $_.Count }) -join ', '))"
$rows | Format-Table run, method, verified, ms -AutoSize | Out-String | Write-Output
