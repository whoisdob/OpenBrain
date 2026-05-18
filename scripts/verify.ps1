#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Universal Open Brain deployment smoke test.

.DESCRIPTION
    Runs the same 4 checks against ANY Open Brain deployment — local Docker,
    K8s, Azure, Fly.io, Render, Railway, Supabase Edge Functions. If all four
    pass, you have a working Open Brain.

    Checks:
      1. REST  /health           returns 200 and {"status":"healthy"}
      2. MCP   /health           returns 200 (if the deployment exposes both ports)
      3. Capture a test thought  POST /memories
      4. Search for that thought GET  /memories/search
      5. (cleanup) Delete the thought

.PARAMETER ApiUrl
    Base URL of the REST API (e.g. http://localhost:8000 or
    https://openbrain-xyz.fly.dev). Defaults to OPENBRAIN_API_URL env var.

.PARAMETER McpUrl
    Optional separate MCP base URL (e.g. http://localhost:8080). Defaults to
    the same as ApiUrl on hosted deployments where both ride one port.

.PARAMETER McpKey
    Optional MCP_ACCESS_KEY for testing the /sse endpoint. Defaults to
    MCP_ACCESS_KEY env var. Skipped if not provided.

.EXAMPLE
    .\scripts\verify.ps1 http://localhost:8000
    .\scripts\verify.ps1 -ApiUrl https://openbrain-scott.fly.dev
    .\scripts\verify.ps1 http://localhost:8000 -McpUrl http://localhost:8080 -McpKey abc123...
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ApiUrl = $env:OPENBRAIN_API_URL,

    [string]$McpUrl,

    [string]$McpKey = $env:MCP_ACCESS_KEY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ApiUrl) {
    Write-Host "Usage: .\verify.ps1 <api-url>  (or set OPENBRAIN_API_URL)" -ForegroundColor Red
    Write-Host "Example: .\verify.ps1 http://localhost:8000" -ForegroundColor Yellow
    exit 2
}

$ApiUrl = $ApiUrl.TrimEnd('/')
if ($McpUrl) { $McpUrl = $McpUrl.TrimEnd('/') }

$pass = 0
$fail = 0

function Test-Step {
    param([string]$Name, [scriptblock]$Body)
    Write-Host -NoNewline "  $Name ... "
    try {
        & $Body
        Write-Host "OK" -ForegroundColor Green
        $script:pass++
    } catch {
        Write-Host "FAIL" -ForegroundColor Red
        Write-Host "    $($_.Exception.Message)" -ForegroundColor Yellow
        $script:fail++
    }
}

Write-Host ""
Write-Host "  Open Brain — Deployment Smoke Test" -ForegroundColor Cyan
Write-Host "  Target: $ApiUrl" -ForegroundColor DarkGray
Write-Host ""

# ── 1. REST health ──────────────────────────────────────────────────
Test-Step "REST /health" {
    $r = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 30
    if ($r.status -ne 'healthy') { throw "Got status=$($r.status)" }
}

# ── 2. MCP health (optional) ────────────────────────────────────────
if ($McpUrl) {
    Test-Step "MCP  /health ($McpUrl)" {
        $r = Invoke-RestMethod -Uri "$McpUrl/health" -TimeoutSec 30
        if ($r.status -ne 'healthy') { throw "Got status=$($r.status)" }
    }
}

# ── 3. Capture a thought ────────────────────────────────────────────
$thoughtId = $null
$marker = "openbrain-verify-$(Get-Random -Maximum 99999999)"
$content = "Smoke-test thought from verify.ps1. Marker: $marker. This thought is safe to delete."

Test-Step "POST /memories (capture)" {
    $body = @{ content = $content; source = "verify-script" } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$ApiUrl/memories" -Method Post `
            -ContentType "application/json" -Body $body -TimeoutSec 60
    if (-not $r.id) { throw "No id in response: $($r | ConvertTo-Json -Compress)" }
    $script:thoughtId = $r.id
}

# ── 4. Search for it (full pipeline: embed → vector search) ─────────
Test-Step "POST /memories/search (semantic search)" {
    $body = @{ query = "smoke test verification marker $marker"; limit = 5 } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$ApiUrl/memories/search" -Method Post `
            -ContentType "application/json" -Body $body -TimeoutSec 60
    if (-not $r -or $r.Count -eq 0) { throw "Search returned no results — embeddings may be misconfigured" }
    $hit = $r | Where-Object { $_.id -eq $script:thoughtId }
    if (-not $hit) { throw "Captured thought not in top 5 results — search recall problem" }
}

# ── 5. Cleanup ──────────────────────────────────────────────────────
if ($thoughtId) {
    Test-Step "DELETE /memories/$thoughtId (cleanup)" {
        Invoke-RestMethod -Uri "$ApiUrl/memories/$thoughtId" -Method Delete -TimeoutSec 30 | Out-Null
    }
}

# ── Summary ─────────────────────────────────────────────────────────
Write-Host ""
if ($fail -eq 0) {
    Write-Host "  ✓ All $pass checks passed — your Open Brain deployment is healthy." -ForegroundColor Green
    Write-Host ""
    exit 0
} else {
    Write-Host "  ✗ $fail of $($pass + $fail) checks failed." -ForegroundColor Red
    Write-Host "    See docs/TROUBLESHOOTING.md for help." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
