# Prototype install for Windows. Copies the CEP panel and turns on PlayerDebugMode.
# Run from the repo root, or from a folder that contains .\panel :
#   powershell -ExecutionPolicy Bypass -File .\installer\install-windows.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$panel = Join-Path (Split-Path -Parent $here) "panel"
if (-not (Test-Path (Join-Path $panel "CSXS\manifest.xml"))) {
  $panel = Join-Path $here "panel"
}
if (-not (Test-Path (Join-Path $panel "CSXS\manifest.xml"))) {
  throw "Could not find the panel folder."
}
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.comfy.aemcp"
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $panel "*") $target
foreach ($ver in 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$ver"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name PlayerDebugMode -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "Installed to $target"
Write-Host "Restart After Effects, then Window > Extensions > Comfy AE Bridge."
