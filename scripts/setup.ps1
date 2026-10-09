#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TemplatePath = Join-Path $RepoRoot "config\openclaw.template.json"
$OpenClawDir = Join-Path $env:USERPROFILE ".openclaw"
$ConfigPath = Join-Path $OpenClawDir "openclaw.json"
$WorkspaceSkills = Join-Path $OpenClawDir "workspace\skills"
$WorkbuddySkill = Join-Path $env:USERPROFILE ".workbuddy\skills\image-to-cad-dxf"
$EnvFile = Join-Path $RepoRoot ".env.local"

Write-Host "==> AgentDesk setup" -ForegroundColor Cyan

# Prefer repo-local portable Node 24 if present
$PortableNode = Join-Path $RepoRoot ".tools\node"
$PortableNpmGlobal = Join-Path $RepoRoot ".tools\npm-global"
if (Test-Path (Join-Path $PortableNode "node.exe")) {
  $env:Path = "$PortableNpmGlobal;$PortableNpmGlobal\node_modules\.bin;$PortableNode;" + $env:Path
}

function Find-OpenClaw {
  $cmd = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $RepoRoot ".tools\npm-global\openclaw.cmd"),
    (Join-Path $RepoRoot ".tools\npm-global\node_modules\.bin\openclaw.cmd"),
    (Join-Path $env:APPDATA "npm\openclaw.cmd"),
    (Join-Path $env:LOCALAPPDATA "npm\openclaw.cmd"),
    (Join-Path $env:USERPROFILE ".openclaw\bin\openclaw.cmd")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

$openclaw = Find-OpenClaw
if (-not $openclaw) {
  Write-Host "OpenClaw CLI not found. Install first:" -ForegroundColor Yellow
  Write-Host "  npm install -g openclaw@latest"
  Write-Host "  or use repo portable: .tools\node + .tools\npm-global"
  exit 1
}
Write-Host "OpenClaw: $openclaw"

if (-not (Test-Path $OpenClawDir)) {
  New-Item -ItemType Directory -Path $OpenClawDir | Out-Null
}

$token = -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Maximum 256) })
if (Test-Path $ConfigPath) {
  try {
    $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    if ($existing.gateway.auth.token) {
      $token = [string]$existing.gateway.auth.token
      Write-Host "Keeping existing gateway token"
    }
  } catch {
    Write-Host "Existing openclaw.json parse failed; writing fresh template" -ForegroundColor Yellow
  }
}

$template = Get-Content $TemplatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$template.gateway.auth.token = $token

# Standalone by default: only load optional WorkBuddy skills dir IF it exists.
$extraDirs = @()
$RepoSkills = Join-Path $RepoRoot "skills"
$WbSkillsDir = Join-Path $env:USERPROFILE ".workbuddy\skills"
if (Test-Path $RepoSkills) { $extraDirs += $RepoSkills.Replace("\", "/") }
if (Test-Path $WbSkillsDir) {
  $extraDirs += "~/.workbuddy/skills"
  Write-Host "Optional: detected WorkBuddy skills at $WbSkillsDir"
} else {
  Write-Host "Standalone mode: WorkBuddy not required / not found"
}
$template.skills.load.extraDirs = $extraDirs

$json = $template | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($ConfigPath, $json + "`n")
Write-Host "Wrote $ConfigPath"

if (-not (Test-Path $WorkspaceSkills)) {
  New-Item -ItemType Directory -Path $WorkspaceSkills -Force | Out-Null
}

# Prefer repo-bundled skills (independent of WorkBuddy)
if (Test-Path $RepoSkills) {
  Get-ChildItem $RepoSkills -Directory | ForEach-Object {
    $dest = Join-Path $WorkspaceSkills $_.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse -Force
    Write-Host "Synced repo skill $($_.Name) -> $dest"
  }
}

# Optional bonus: if WorkBuddy user skill exists and not already synced, import it
$WorkbuddySkill = Join-Path $env:USERPROFILE ".workbuddy\skills\image-to-cad-dxf"
if ((Test-Path $WorkbuddySkill) -and -not (Test-Path (Join-Path $WorkspaceSkills "image-to-cad-dxf"))) {
  Copy-Item $WorkbuddySkill (Join-Path $WorkspaceSkills "image-to-cad-dxf") -Recurse -Force
  Write-Host "Optional import: image-to-cad-dxf from WorkBuddy"
}

# P1 library roots (self-owned; WorkBuddy import is optional via UI)
$LibraryRoot = Join-Path $OpenClawDir "workspace\library"
foreach ($d in @("mine", "imports", "outputs")) {
  $p = Join-Path $LibraryRoot $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
# keep legacy workbuddy folder name for compatibility, but don't require it
$legacyWb = Join-Path $LibraryRoot "workbuddy"
if (-not (Test-Path $legacyWb)) { New-Item -ItemType Directory -Path $legacyWb -Force | Out-Null }

$AgentsMd = Join-Path $OpenClawDir "workspace\AGENTS.md"
$LibHint = @"

## AgentDesk Library

AgentDesk runs standalone (OpenClaw + local Web). WorkBuddy is optional.

- library/mine — personal docs
- library/imports — optional imported external workspaces (including WorkBuddy)
- library/workbuddy — optional WorkBuddy links (compat)
- library/outputs — write task artifacts here
"@
if (Test-Path $AgentsMd) {
  $cur = Get-Content $AgentsMd -Raw
  if ($cur -notmatch "AgentDesk Library") { Add-Content -Path $AgentsMd -Value $LibHint }
} else {
  Set-Content -Path $AgentsMd -Value ("# AGENTS.md`n" + $LibHint) -Encoding UTF8
}
Write-Host "Prepared library at $LibraryRoot"

@(
  "AGENTDESK_GATEWAY_URL=http://127.0.0.1:18789"
  "AGENTDESK_GATEWAY_TOKEN=$token"
  "AGENTDESK_BRIDGE_URL=http://127.0.0.1:3090"
) | Set-Content -Path $EnvFile -Encoding UTF8
Write-Host "Wrote $EnvFile"

Push-Location (Join-Path $RepoRoot "apps\web")
try {
  if (-not (Test-Path "node_modules")) {
    npm install
  }
  npm run build
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1. Configure model: openclaw onboard"
Write-Host "  2. Start:           .\scripts\start.ps1"
Write-Host "  3. Open http://127.0.0.1:3080 (or http://<LAN-IP>:3080 from other PCs) and paste token:"
Write-Host "     $token"
