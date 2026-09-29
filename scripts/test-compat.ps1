#Requires -Version 5.1
$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PortableNode = Join-Path $RepoRoot ".tools\node"
$PortableNpmGlobal = Join-Path $RepoRoot ".tools\npm-global"
if (Test-Path (Join-Path $PortableNode "node.exe")) {
  $env:Path = "$PortableNpmGlobal;$PortableNode;" + $env:Path
}

$results = @()
function Add-Result($name, $ok, $detail) {
  $script:results += [pscustomobject]@{ Test = $name; OK = [bool]$ok; Detail = "$detail" }
  Write-Host ("[{0}] {1} :: {2}" -f ($(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail))
}

$token = $null
if (Test-Path (Join-Path $RepoRoot ".env.local")) {
  $m = Select-String -Path (Join-Path $RepoRoot ".env.local") -Pattern '^AGENTDESK_GATEWAY_TOKEN=(.+)$'
  if ($m) { $token = $m.Matches.Groups[1].Value }
}

# ensure bridge
if (-not (netstat -ano | Select-String ":3090\s+.*LISTENING")) {
  $nodeExe = Join-Path $PortableNode "node.exe"
  if (-not (Test-Path $nodeExe)) { $nodeExe = "node" }
  Start-Process -FilePath $nodeExe -ArgumentList @((Join-Path $RepoRoot "apps\bridge\src\server.mjs")) -WorkingDirectory (Join-Path $RepoRoot "apps\bridge") -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 3
}

try {
  $h = Invoke-WebRequest "http://127.0.0.1:3090/api/health" -UseBasicParsing -TimeoutSec 10
  Add-Result "Bridge health" ($h.StatusCode -eq 200) $h.Content.Substring(0, [Math]::Min(120, $h.Content.Length))
} catch { Add-Result "Bridge health" $false $_.Exception.Message }

try {
  $imp = Invoke-WebRequest "http://127.0.0.1:3090/api/workbuddy/import" -Method POST -ContentType "application/json" -Body "{}" -UseBasicParsing -TimeoutSec 30
  Add-Result "Import WorkBuddy workspaces" ($imp.StatusCode -eq 200) $imp.Content.Substring(0, [Math]::Min(200, $imp.Content.Length))
} catch { Add-Result "Import WorkBuddy workspaces" $false $_.Exception.Message }

try {
  $tree = Invoke-WebRequest "http://127.0.0.1:3090/api/library/tree" -UseBasicParsing -TimeoutSec 20
  $hasWb = $tree.Content -match "workbuddy"
  Add-Result "Library tree has workbuddy" ($tree.StatusCode -eq 200 -and $hasWb) $tree.Content.Substring(0, [Math]::Min(180, $tree.Content.Length))
} catch { Add-Result "Library tree has workbuddy" $false $_.Exception.Message }

try {
  $compat = Invoke-WebRequest "http://127.0.0.1:3090/api/compat/skills" -UseBasicParsing -TimeoutSec 20
  $hasMatch = $compat.Content -match "image-to-cad-dxf"
  Add-Result "Skill compat image-to-cad" ($compat.StatusCode -eq 200 -and $hasMatch) $compat.Content.Substring(0, [Math]::Min(220, $compat.Content.Length))
} catch { Add-Result "Skill compat image-to-cad" $false $_.Exception.Message }

# find a file via bridge tree API (follows junctions reliably)
$sampleRel = $null
try {
  $treeJson = (Invoke-WebRequest "http://127.0.0.1:3090/api/library/tree" -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
  function Find-File($nodes, $prefix) {
    foreach ($n in $nodes) {
      $p = if ($prefix) { "$prefix/$($n.name)" } else { $n.path }
      if ($n.type -eq "file" -and $n.name -match '\.(md|py|txt|json|csv)$') { return $n.path }
      if ($n.children) {
        $hit = Find-File $n.children $n.path
        if ($hit) { return $hit }
      }
    }
    return $null
  }
  $wbNode = $treeJson.tree | Where-Object { $_.name -eq "workbuddy" }
  if ($wbNode) { $sampleRel = Find-File $wbNode.children "workbuddy" }
} catch {}


if ($sampleRel) {
  try {
    $body = @{ paths = @($sampleRel) } | ConvertTo-Json
    $att = Invoke-WebRequest "http://127.0.0.1:3090/api/library/attach" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 15
    Add-Result "Attach library file" ($att.StatusCode -eq 200 -and $att.Content -match "AgentDesk Library" -and $att.Content -match [regex]::Escape($sampleRel.Replace('\','/'))) $sampleRel
  } catch { Add-Result "Attach library file" $false $_.Exception.Message }
} else {
  Add-Result "Attach library file" $false "no sample file under library/workbuddy"
}

try {
  $sess = Invoke-WebRequest "http://127.0.0.1:3090/api/workbuddy/sessions" -UseBasicParsing -TimeoutSec 15
  $ok = $sess.StatusCode -eq 200 -and $sess.Content -match "sessions"
  Add-Result "Read WorkBuddy sessions" $ok $sess.Content.Substring(0, [Math]::Min(160, $sess.Content.Length))
} catch { Add-Result "Read WorkBuddy sessions" $false $_.Exception.Message }

# cron create + run
try {
  $cronBody = @{ name = "p1p2-compat-smoke"; prompt = "Reply with exactly: CRONOK"; everyMs = 3600000; enabled = $true } | ConvertTo-Json
  $cj = Invoke-WebRequest "http://127.0.0.1:3090/api/cron" -Method POST -ContentType "application/json" -Body $cronBody -UseBasicParsing -TimeoutSec 20
  $job = $cj.Content | ConvertFrom-Json
  $run = Invoke-WebRequest ("http://127.0.0.1:3090/api/cron/" + $job.id + "/run") -Method POST -UseBasicParsing -TimeoutSec 180
  Add-Result "Cron create+run" ($run.StatusCode -eq 200) $run.Content.Substring(0, [Math]::Min(220, $run.Content.Length))
} catch { Add-Result "Cron create+run" $false $_.Exception.Message }

# gateway still chat
if ($token -and (netstat -ano | Select-String ":18789\s+.*LISTENING")) {
  try {
    $chatBody = '{"model":"openclaw/default","user":"conv:p1p2","messages":[{"role":"user","content":"Reply with exactly: P12OK"}]}'
    $c = Invoke-WebRequest "http://127.0.0.1:18789/v1/chat/completions" -Method POST -Headers @{ Authorization = "Bearer $token"; "Content-Type"="application/json" } -Body $chatBody -UseBasicParsing -TimeoutSec 180
    Add-Result "Gateway chat still works" ($c.StatusCode -eq 200 -and $c.Content -match "P12OK") $c.Content.Substring(0, [Math]::Min(180, $c.Content.Length))
  } catch { Add-Result "Gateway chat still works" $false $_.Exception.Message }
} else {
  Add-Result "Gateway chat still works" $false "gateway/token unavailable"
}

# skill SKILL.md byte compare for image-to-cad
$wbSkill = Join-Path $env:USERPROFILE ".workbuddy\skills\image-to-cad-dxf\SKILL.md"
$ocSkill = Join-Path $env:USERPROFILE ".openclaw\workspace\skills\image-to-cad-dxf\SKILL.md"
if ((Test-Path $wbSkill) -and (Test-Path $ocSkill)) {
  $h1 = (Get-FileHash $wbSkill -Algorithm SHA256).Hash
  $h2 = (Get-FileHash $ocSkill -Algorithm SHA256).Hash
  Add-Result "SKILL.md hash equal" ($h1 -eq $h2) "wb=$($h1.Substring(0,12)) oc=$($h2.Substring(0,12))"
} else {
  Add-Result "SKILL.md hash equal" $false "missing skill file"
}

Write-Host ""
Write-Host "==== P1/P2 COMPAT SUMMARY ===="
$pass = @($results | Where-Object OK).Count
$fail = @($results | Where-Object { -not $_.OK }).Count
Write-Host "PASS=$pass FAIL=$fail TOTAL=$($results.Count)"
$results | Format-Table -AutoSize | Out-String | Write-Host
$results | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $RepoRoot ".tools\p1p2-compat-results.json") -Encoding UTF8
if ($fail -gt 0) { exit 1 } else { exit 0 }
