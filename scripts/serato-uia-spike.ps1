<#
.SYNOPSIS
  Feasibility spike: dump the UI Automation tree of the running Serato DJ Pro
  main window and look for the Files panel / "Re-Scan File Info" button.

.DESCRIPTION
  Read-only. Nothing is clicked, typed or invoked. Requires Windows PowerShell 5.1,
  an interactive desktop session, and Serato DJ Pro already running.
  Output is plain text on stdout; redirect it to a file to keep it. Element names
  (track titles, crate names) can appear in the dump: review before sharing.

.PARAMETER MaxDepth   Deepest tree level to visit (default 12).
.PARAMETER MaxNodes   Stop after this many elements (default 1500).
.PARAMETER Json       Emit one JSON object instead of the indented text tree.

.EXAMPLE
  powershell -NoProfile -File scripts\serato-uia-spike.ps1 > uia-dump.txt
#>
param([int]$MaxDepth = 12, [int]$MaxNodes = 1500, [switch]$Json)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$p = Get-Process -Name 'Serato DJ Pro' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p -or $p.MainWindowHandle -eq 0) {
  Write-Output 'RESULT: Serato DJ Pro is not running (or has no main window). Open it first.'
  exit 2
}
$root = [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$buttonPattern = '(?i)re-?\s*scan\s*(file\s*info|id3\s*tags?)'
$filesPattern = '(?i)^\s*files?\s*$'
$nodes = New-Object System.Collections.Generic.List[object]
$hits = New-Object System.Collections.Generic.List[object]
$truncated = $false

function Describe($el, $depth) {
  $c = $el.Current
  $r = $c.BoundingRectangle
  $pats = @()
  try { foreach ($pt in $el.GetSupportedPatterns()) { $pats += ($pt.ProgrammaticName -replace 'Identifiers\.Pattern$', '') } } catch {}
  [pscustomobject]@{
    depth = $depth
    controlType = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    name = $c.Name
    automationId = $c.AutomationId
    className = $c.ClassName
    rect = if ($r.IsEmpty -or [double]::IsInfinity($r.X)) { $null } else { '{0},{1},{2}x{3}' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }
    patterns = $pats -join ','
    enabled = $c.IsEnabled
    offscreen = $c.IsOffscreen
  }
}

function Walk($el, $depth) {
  if ($nodes.Count -ge $MaxNodes) { $script:truncated = $true; return }
  $d = Describe $el $depth
  $nodes.Add($d)
  if ($d.name -match $buttonPattern -or $d.automationId -match $buttonPattern) { $hits.Add(@{ kind = 'rescan-button'; node = $d }) }
  elseif ($d.name -match $filesPattern) { $hits.Add(@{ kind = 'files-label'; node = $d }) }
  if ($depth -ge $MaxDepth) { return }
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null) {
    Walk $child ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
Walk $root 0
$sw.Stop()

if ($Json) {
  @{ pid = $p.Id; version = $p.MainModule.FileVersionInfo.ProductVersion; walkMs = $sw.ElapsedMilliseconds; truncated = $truncated
     nodeCount = $nodes.Count; hits = $hits; nodes = $nodes } | ConvertTo-Json -Depth 6
  exit 0
}

Write-Output ("# Serato DJ Pro {0}, pid {1}" -f $p.MainModule.FileVersionInfo.ProductVersion, $p.Id)
Write-Output ("# nodes={0} maxDepth={1} walkMs={2} truncated={3}" -f $nodes.Count, $MaxDepth, $sw.ElapsedMilliseconds, $truncated)
foreach ($n in $nodes) {
  $nm = if ($n.name.Length -gt 60) { $n.name.Substring(0, 60) + '...' } else { $n.name }
  Write-Output ('{0}{1} name="{2}" id="{3}" class="{4}" rect={5} patterns=[{6}]' -f ('  ' * $n.depth), $n.controlType, $nm, $n.automationId, $n.className, $n.rect, $n.patterns)
}
Write-Output ''
Write-Output ('RESULT: rescan-button candidates = {0}; files-label candidates = {1}' -f @($hits | ? { $_.kind -eq 'rescan-button' }).Count, @($hits | ? { $_.kind -eq 'files-label' }).Count)
foreach ($h in $hits) { Write-Output ('  {0}: {1} "{2}" id="{3}" rect={4} patterns=[{5}]' -f $h.kind, $h.node.controlType, $h.node.name, $h.node.automationId, $h.node.rect, $h.node.patterns) }
