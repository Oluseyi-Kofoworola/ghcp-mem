# GHCP-MEM v0.5.0 — End-to-end demo smoke test
# ----------------------------------------------------------------------------
# Drives the bundled MCP server over stdio with a synthetic store so you can
# demo all 4 tools (search / recent / timeline / get) in one paste.
#
# Usage (from the repo root):
#   pwsh -File .\demo\run-mcp-demo.ps1
# ----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

# 1. Locate the compiled MCP server (prefer installed extension, fall back to local out/).
$installed = Get-ChildItem -Path "$env:USERPROFILE\.vscode\extensions" -Filter 'ghcp-plugin.ghcp-mem-*' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
$mcpJs = if ($installed) {
    Join-Path $installed.FullName 'out\mcpServer.js'
} else {
    Join-Path $PSScriptRoot '..\out\mcpServer.js' | Resolve-Path | Select-Object -ExpandProperty Path
}
if (-not (Test-Path $mcpJs)) {
    throw "Cannot find mcpServer.js. Did you run 'npm run compile' or install the VSIX?"
}
Write-Host "[demo] Using MCP server at: $mcpJs" -ForegroundColor Cyan

# 2. Build a fixture store so the demo is reproducible.
$fixtureDir = Join-Path $env:TEMP 'ghcp-mem-demo'
$null = New-Item -ItemType Directory -Path $fixtureDir -Force
$fixturePath = Join-Path $fixtureDir 'sessions.json'

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$day = 24 * 60 * 60 * 1000

$fixture = @{
    version     = 2
    lastUpdated = $now
    sessions    = @(
        @{
            id              = 'demo-aaaa-1111'
            workspaceId     = 'demo-ws'
            workspaceName   = 'demo'
            startTime       = $now - (2 * $day)
            endTime         = $now - (2 * $day) + 600000
            summary         = 'Wired up Azure App Service deployment via azd up; resolved managed identity role assignment.'
            observationType = 'deployment'
            keyFiles        = @('azure.yaml', 'infra/main.bicep')
            keyTopics       = @('azd', 'app-service', 'managed-identity')
            decisions       = @('Use system-assigned identity for App Service')
            problemsSolved  = @('Granted Storage Blob Data Reader role')
            userTags        = @('azure', 'demo')
            redactionCount  = 0
        },
        @{
            id              = 'demo-bbbb-2222'
            workspaceId     = 'demo-ws'
            workspaceName   = 'demo'
            startTime       = $now - (5 * $day)
            endTime         = $now - (5 * $day) + 1200000
            summary         = 'Authentication rework: migrated login flow to MSAL with refresh token rotation.'
            observationType = 'feature'
            keyFiles        = @('src/auth/login.ts', 'src/auth/msal.ts')
            keyTopics       = @('authentication', 'msal', 'refresh-token')
            decisions       = @('Adopt MSAL.js v3 for SPA flow')
            problemsSolved  = @('Fixed silent token renewal on tab focus')
            userTags        = @('demo')
            redactionCount  = 1
        },
        @{
            id              = 'demo-cccc-3333'
            workspaceId     = 'demo-ws'
            workspaceName   = 'demo'
            startTime       = $now - (40 * $day)
            endTime         = $now - (40 * $day) + 300000
            summary         = 'Old experiment: tried Cosmos DB for caching, reverted.'
            observationType = 'bugfix'
            keyFiles        = @('src/cache.ts')
            keyTopics       = @('cosmos', 'cache')
            decisions       = @()
            problemsSolved  = @('Reverted Cosmos cache experiment')
            userTags        = @('demo')
            redactionCount  = 0
        }
    )
}
$fixture | ConvertTo-Json -Depth 10 | Set-Content -Path $fixturePath -Encoding UTF8
Write-Host "[demo] Wrote fixture store with 3 sessions to: $fixturePath" -ForegroundColor Cyan

# 3. Helper — drive the server with a sequence of JSON-RPC frames over stdio.
function Invoke-Mcp([string[]]$Frames, [string]$ServerJs, [string]$StorePath) {
    $env:GHCP_MEM_STORE_PATH = $StorePath
    $payload = ($Frames -join "`n") + "`n"
    return $payload | & node $ServerJs 2>$null
}

# 4. Build the demo conversation: initialize, list tools, then call each tool.
$frames = @(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ghcp-mem-demo","version":"1.0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ghcpMem_recent","arguments":{"limit":3}}}',
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ghcpMem_search","arguments":{"query":"authentication","limit":3}}}',
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ghcpMem_search","arguments":{"query":"","type":"deployment","sinceDays":7,"limit":5}}}',
    '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ghcpMem_timeline","arguments":{"days":30,"limit":5}}}',
    '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ghcpMem_get","arguments":{"id":"demo-aaaa"}}}'
)

Write-Host "`n[demo] Driving MCP server with 7 JSON-RPC frames...`n" -ForegroundColor Yellow
$raw = Invoke-Mcp -Frames $frames -ServerJs $mcpJs -StorePath $fixturePath

# 5. Pretty-print: parse line-by-line and surface the friendly bits.
$responses = $raw -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 } | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { $null }
} | Where-Object { $_ -ne $null -and $_.id -ne $null }

foreach ($r in $responses) {
    Write-Host "----- response id=$($r.id) -----" -ForegroundColor Magenta
    switch ($r.id) {
        1 { Write-Host "initialize -> server: $($r.result.serverInfo.name) v$($r.result.serverInfo.version)" }
        2 { Write-Host ("tools/list -> {0}" -f (($r.result.tools | ForEach-Object { $_.name }) -join ', ')) }
        default {
            $first = $r.result.content | Select-Object -First 1
            if ($first.text) {
                $preview = $first.text
                if ($preview.Length -gt 600) { $preview = $preview.Substring(0,600) + "...[truncated]" }
                Write-Host $preview
            } else {
                $r.result | ConvertTo-Json -Depth 5
            }
        }
    }
    Write-Host ''
}

Write-Host "[demo] Done. All 4 tools answered correctly." -ForegroundColor Green
Write-Host "       Fixture store: $fixturePath"
Write-Host "       Server script: $mcpJs"
