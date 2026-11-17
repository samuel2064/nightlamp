param(
  [switch]$Push,
  [string]$Branch = 'wip/integrate-tenant-isolation',
  [string]$ExpectedSha = ''
)

$ErrorActionPreference = 'Stop'
$Repo = 'D:\paperclip-pre-migration-restore\paperclip403-test-home\instances\default\workspaces\db225962-9ac2-4851-ac9b-0b88b50c7ae0\nightlamp-p0'
$Api = 'https://nightlamp-api.onrender.com'
$Web = 'https://nightlamp-frontend.onrender.com'
$browser = @{ Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

function Get-Status([string]$url, [string]$method = 'GET', [string]$body = '', [hashtable]$extraHeaders = $null) {
  $headers = @{}
  if ($extraHeaders) { foreach ($k in $extraHeaders.Keys) { $headers[$k] = $extraHeaders[$k] } }
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      if ($method -eq 'POST') {
        $r = Invoke-WebRequest -Uri $url -Method POST -Body $body -ContentType 'application/json' -Headers $headers -TimeoutSec 60 -UseBasicParsing
      } else {
        $r = Invoke-WebRequest -Uri $url -Method GET -Headers $headers -TimeoutSec 60 -UseBasicParsing
      }
      return @{ status = [int]$r.StatusCode; body = $r.Content }
    } catch {
      $resp = $_.Exception.Response
      if ($resp) {
        $code = [int]$resp.StatusCode
        $text = ''
        try {
          $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
          $text = $reader.ReadToEnd()
        } catch { }
        return @{ status = $code; body = $text }
      }
      if ($attempt -lt 4) {
        Start-Sleep -Seconds 10
        continue
      }
      return @{ status = 0; body = $_.Exception.Message }
    }
  }
  return @{ status = 0; body = 'unreachable' }
}

function Show([string]$label, [hashtable]$r, [int[]]$expected) {
  $ok = $expected -contains $r.status
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  $snippet = ($r.body -replace '\s+', ' ')
  if ($snippet.Length -gt 120) { $snippet = $snippet.Substring(0, 120) }
  Write-Host ("{0,-4} {1,-46} expected {2,-12} got {3,-4} {4}" -f $mark, $label, ($expected -join '/'), $r.status, $snippet)
  return $ok
}

Write-Output '=== PRE-DEPLOY: production right now ==='
$pre = Get-Status "$Api/api/events"
"pre-deploy /api/events -> $($pre.status)  $(if ($pre.status -eq 200) { '(the old no-gate build is serving - expected before the push)' } elseif ($pre.status -eq 401) { '(the gate is already live)' } else { '' })"

if (-not $Push) {
  Write-Output ''
  Write-Output '=== PROBE SELF-TEST (no push) - the same probes the deploy gate uses ==='
  $results = @()
  $results += Show 'GET /api/events (anonymous)' (Get-Status "$Api/api/events") @(401)
  $results += Show 'GET /api/remediation/runs (anonymous)' (Get-Status "$Api/api/remediation/runs") @(401)
  $results += Show 'POST /api/events/acknowledge (anonymous)' (Get-Status "$Api/api/events/acknowledge" 'POST' '{"id":"probe"}') @(401)
  $results += Show 'GET /api/health' (Get-Status "$Api/api/health") @(200)
  $results += Show 'GET /dashboard (browser accept)' (Get-Status "$Web/dashboard" 'GET' '' $browser) @(200, 307, 308)
  Write-Output ''
  "probe self-test: $(@($results | Where-Object { $_ }).Count)/$($results.Count) as expected on the CURRENT production build"
  Write-Output 'run with -Push to perform the real deploy'
  return
}

Write-Output ''
Write-Output '=== DEPLOY ==='
Push-Location $Repo
try {
  $local = (git rev-parse HEAD).Trim()
  $remote = (git rev-parse "origin/$Branch").Trim()
  "local  $local"
  "remote $remote"
  if ($ExpectedSha) {
    $expectedFull = $null
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try { $expectedFull = (git rev-parse --verify "$ExpectedSha^{commit}" 2>$null) } finally { $ErrorActionPreference = $previousPreference }
    if ($LASTEXITCODE -ne 0 -or -not $expectedFull) { throw "the expected SHA $ExpectedSha could not be resolved in this repository" }
    $expectedFull = ($expectedFull | Select-Object -First 1).Trim()
    if ($expectedFull -notmatch '^[0-9a-f]{40}$') { throw "the expected SHA $ExpectedSha did not resolve to a commit" }
    "expect $expectedFull"
    if ($local -ne $expectedFull) { throw "local HEAD $local does not match the expected SHA $expectedFull" }
  }
  if ($local -ne $remote) { throw "local HEAD $local does not match origin/$Branch $remote - refusing to push" }
  $dirty = git status --porcelain
  if ($dirty) { throw "the working tree is not clean - refusing to push:`n$dirty" }
  git push origin "$Branch`:main"
  if ($LASTEXITCODE -ne 0) { throw 'the push to main failed' }
  "pushed $local to main"
} finally {
  Pop-Location
}

Write-Output ''
Write-Output '=== WAITING FOR THE GITHUB ACTIONS DEPLOY RUN ==='
$run = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 30
  try {
    $runs = Invoke-RestMethod -Uri "https://api.github.com/repos/samuel2064/nightlamp/actions/runs?branch=main&per_page=3" -Headers @{ 'User-Agent' = 'nightlamp-cto'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 45
    $candidate = $runs.workflow_runs | Where-Object { $_.head_sha -eq $local } | Select-Object -First 1
    if ($candidate) {
      $status = "$($candidate.status)/$($candidate.conclusion)"
      "run $($candidate.id) $status"
      if ($candidate.status -eq 'completed') { $run = $candidate; break }
    } else {
      "waiting for the run of $local to appear"
    }
  } catch {
    "poll failed: $($_.Exception.Message)"
  }
}

if ($run) {
  $jobs = Invoke-RestMethod -Uri "https://api.github.com/repos/samuel2064/nightlamp/actions/runs/$($run.id)/jobs" -Headers @{ 'User-Agent' = 'nightlamp-cto'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 45
  $jobs.jobs | ForEach-Object { "job {0,-24} {1}/{2}" -f $_.name, $_.status, $_.conclusion }
}

Write-Output ''
Write-Output '=== POST-DEPLOY PROBES ==='
$results = @()
$results += Show 'GET /api/events (anonymous)' (Get-Status "$Api/api/events") @(401)
$results += Show 'GET /api/remediation/runs (anonymous)' (Get-Status "$Api/api/remediation/runs") @(401)
$results += Show 'POST /api/events/acknowledge (anonymous)' (Get-Status "$Api/api/events/acknowledge" 'POST' '{"id":"probe"}') @(401)
$results += Show 'GET /api/health' (Get-Status "$Api/api/health") @(200)
$results += Show 'GET /dashboard (browser accept)' (Get-Status "$Web/dashboard" 'GET' '' $browser) @(200, 307, 308)
$results += Show 'GET /dashboard/playbooks (browser accept)' (Get-Status "$Web/dashboard/playbooks" 'GET' '' $browser) @(200, 307, 308)
$results += Show 'GET /dashboard/approvals (browser accept)' (Get-Status "$Web/dashboard/approvals" 'GET' '' $browser) @(200, 307, 308)

$passed = @($results | Where-Object { $_ }).Count
Write-Output ''
"post-deploy: $passed/$($results.Count) probes as expected"
if ($passed -eq $results.Count) {
  Write-Output 'VERDICT: the P0 gate is live and the new build is serving.'
  Write-Output 'Remaining, for a signed-in owner: the dashboard renders, the Playbook Reader renders QUESTION / INFO / ACTION from a real execution, the approvals page lists the pending runs of that tenant, and the billing portal reaches Stripe.'
} else {
  Write-Output 'VERDICT: something is wrong - fix forward, do not roll back (a rollback restores the no-gate build).'
}

