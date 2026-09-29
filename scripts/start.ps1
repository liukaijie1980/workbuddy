#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RepoRoot ".env.local"
$WebDir = Join-Path $RepoRoot "apps\web"
$BridgeDir = Join-Path $RepoRoot "apps\bridge"
$PortableNode = Join-Path $RepoRoot ".tools\node"
$PortableNpmGlobal = Join-Path $RepoRoot ".tools\npm-global"
$OpenClawMjs = Join-Path $PortableNpmGlobal "node_modules\openclaw\openclaw.mjs"
$GwOut = Join-Path $RepoRoot ".tools\gateway.out.log"
$GwErr = Join-Path $RepoRoot ".tools\gateway.err.log"
$BridgeOut = Join-Path $RepoRoot ".tools\bridge.out.log"
$BridgeErr = Join-Path $RepoRoot ".tools\bridge.err.log"

if (Test-Path (Join-Path $PortableNode "node.exe")) {
  $env:Path = "$PortableNpmGlobal;$PortableNode;" + $env:Path
}

function Find-OpenClawNodeArgs {
  if ((Test-Path (Join-Path $PortableNode "node.exe")) -and (Test-Path $OpenClawMjs)) {
    return @{
      File = (Join-Path $PortableNode "node.exe")
      Args = @($OpenClawMjs, "gateway", "run")
    }
  }
  $cmd = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($cmd) {
    return @{ File = $cmd.Source; Args = @("gateway", "run") }
  }
  return $null
}

function Stop-Port([int]$Port) {
  $existing = netstat -ano | Select-String ":$Port\s+.*LISTENING\s+(\d+)"
  if ($existing) {
    foreach ($m in $existing.Matches) {
      $listenerPid = [int]$m.Groups[1].Value
      Write-Host "Stopping PID $listenerPid on :$Port"
      Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
  }
}

function Wait-Port([int]$Port, [int]$Seconds = 90) {
  for ($i = 0; $i -lt [math]::Ceiling($Seconds / 2); $i++) {
    if (netstat -ano | Select-String ":$Port\s+.*LISTENING") { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

$launch = Find-OpenClawNodeArgs
if (-not $launch) {
  Write-Host "openclaw not found. Run .\scripts\setup.ps1 first." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $WebDir "dist\index.html"))) {
  Write-Host "Web not built yet; running setup..." -ForegroundColor Yellow
  & (Join-Path $PSScriptRoot "setup.ps1")
}

$token = $null
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^AGENTDESK_GATEWAY_TOKEN=(.+)$') { $token = $Matches[1].Trim() }
  }
}

Stop-Port 18789
Stop-Port 3090

Write-Host "==> Starting OpenClaw Gateway" -ForegroundColor Cyan
Remove-Item $GwOut, $GwErr -ErrorAction SilentlyContinue
$gw = Start-Process -FilePath $launch.File -ArgumentList $launch.Args `
  -RedirectStandardOutput $GwOut -RedirectStandardError $GwErr `
  -PassThru -WindowStyle Hidden

if (-not (Wait-Port 18789 90)) {
  Write-Host "Gateway failed to listen on 18789" -ForegroundColor Red
  Get-Content $GwOut -ErrorAction SilentlyContinue | Select-Object -Last 40
  exit 1
}
Write-Host "Gateway listening on 127.0.0.1:18789"

Write-Host "==> Starting AgentDesk Bridge" -ForegroundColor Cyan
Remove-Item $BridgeOut, $BridgeErr -ErrorAction SilentlyContinue
$nodeExe = if (Test-Path (Join-Path $PortableNode "node.exe")) {
  Join-Path $PortableNode "node.exe"
} else { "node" }
$bridge = Start-Process -FilePath $nodeExe `
  -ArgumentList @((Join-Path $BridgeDir "src\server.mjs")) `
  -RedirectStandardOutput $BridgeOut -RedirectStandardError $BridgeErr `
  -PassThru -WindowStyle Hidden `
  -WorkingDirectory $BridgeDir

if (-not (Wait-Port 3090 30)) {
  Write-Host "Bridge failed to listen on 3090" -ForegroundColor Red
  Get-Content $BridgeErr -ErrorAction SilentlyContinue | Select-Object -Last 40
  exit 1
}
Write-Host "Bridge listening on 127.0.0.1:3090"

Write-Host "==> Starting AgentDesk Web (http://127.0.0.1:3080)" -ForegroundColor Cyan
if ($token) { Write-Host "Gateway Token: $token" }

Push-Location $WebDir
try {
  npm run preview
} finally {
  Pop-Location
  if ($gw -and -not $gw.HasExited) { Stop-Process -Id $gw.Id -Force -ErrorAction SilentlyContinue }
  if ($bridge -and -not $bridge.HasExited) { Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue }
}
