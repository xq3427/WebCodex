#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load only function definitions through PowerShell's parser. Never execute the
# script entry point or read the developer's live installation/account files.
$scriptPath = Join-Path $PSScriptRoot 'check-tunnel.ps1'
$tokens = $null; $parseErrors = $null
$tree = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'check-tunnel.ps1 parse failed' }
$definitions = $tree.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
$checks = 0
function Assert-Equal($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label failed: expected '$Expected', received '$Actual'" }
    $script:checks++
}
function Assert-Rejected([scriptblock]$Action, [string]$Label) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-Equal $rejected $true $Label
}
function New-TestStatus([string]$ErrorText = '') {
    return [pscustomobject]@{
        control_plane_route = [pscustomobject]@{ route_mode = 'proxy'; proxy_url = 'http://secret:do-not-print@127.0.0.1:9999'; target = 'private-account' }
        control_plane_tunnel_id = 'tunnel_fake_test_fixture'
        tunnel_metadata_error = $ErrorText
        channels = @([pscustomobject]@{ name = 'main'; enabled = $true; probe_status = 'ok' })
    }
}
function New-TestMetrics([double]$Last = 990, [int]$Readiness = 1, [int]$Calls = 0) {
    $body = "liveness 1`nreadiness $Readiness`ncommands_poll_last_successful_timestamp_seconds $Last`n"
    if ($Calls -gt 0) {
        $body += 'command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_response",request_method="tools/call",tunnel_service_status="200"} ' + $Calls + "`n"
    }
    # Other latency phases, failed HTTP responses, and discovery are not calls.
    $body += 'command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_dispatch",request_method="tools/call",tunnel_service_status="200"} 17' + "`n"
    $body += 'command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_response",request_method="tools/list",tunnel_service_status="200"} 12' + "`n"
    $body += 'command_end_to_end_latency_milliseconds_count{latency_type="enqueue_to_response",request_method="tools/call",tunnel_service_status="500"} 9' + "`n"
    return $body
}
function Get-TestAssessment($Status = (New-TestStatus), [string]$Metrics = (New-TestMetrics), [bool]$Live = $true, [bool]$Ready = $true) {
    return Get-WebCodexTunnelAssessment $Status $Metrics $Live $Ready 1000 800
}

Assert-Equal (ConvertTo-WebCodexLoopbackUri 'http://127.0.0.1:12345').Port 12345 'literal IPv4 URL'
Assert-Equal (ConvertTo-WebCodexLoopbackUri "http://[::1]:12345/`r`n").Port 12345 'literal IPv6 URL'
foreach ($url in @('https://127.0.0.1:1234', 'http://example.com:1234', 'http://localhost:1234', 'http://127.1:1234',
    'http://2130706433:1234', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:1234/api/status',
    'http://127.0.0.1:1234/../', 'http://127.0.0.1:1234/%2e%2e', 'http://127.0.0.1:1234/?key=fake',
    'http://user:password@127.0.0.1:1234', 'http://127.0.0.1:1234/#fake', 'http://127.0.0.1:1234\@example.com',
    "http://127.0.0.1:12`n34")) {
    Assert-Rejected { ConvertTo-WebCodexLoopbackUri $url } ('reject URL ' + $url)
}

$assessment = Get-TestAssessment
Assert-Equal $assessment.state 'connected_no_tool_calls' 'connected without tool calls'
Assert-Equal $assessment.exit_code 0 'connected exit code'
Assert-Equal $assessment.route_mode 'proxy' 'route mode'
Assert-Equal $assessment.successful_tool_calls 0 'discovery and failed requests excluded'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Calls 5)).successful_tool_calls 5 'single latency phase counted'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Calls 5)).state 'connected_tools_called' 'successful tool response'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Last 879)).state 'poll_stale' '121 second old poll'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Last 880)).connected $true '120 second boundary'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Last 799)).connected $false 'old process poll is not online'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Last 1050)).state 'poll_stale' 'future poll timestamp'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Last 0)).state 'awaiting_control_plane' 'no poll success'
Assert-Equal (Get-TestAssessment -Metrics '').state 'diagnostics_unavailable' 'missing metrics'
Assert-Equal (Get-TestAssessment -Status $null).state 'diagnostics_unavailable' 'missing status'
Assert-Equal (Get-TestAssessment -Live $false).state 'local_unhealthy' 'liveness failure'
Assert-Equal (Get-TestAssessment -Ready $false).state 'mcp_not_ready' 'readiness failure'
Assert-Equal (Get-TestAssessment -Metrics (New-TestMetrics -Readiness 0)).state 'mcp_not_ready' 'readiness metric failure'
$status = New-TestStatus
$status.channels[0].probe_status = 'error'
Assert-Equal (Get-TestAssessment -Status $status).state 'mcp_not_ready' 'MCP probe not ready'
Assert-Equal (Get-TestAssessment -Status (New-TestStatus '403 forbidden fake-secret') -Metrics (New-TestMetrics -Last 0)).state 'authentication_or_permission_denied' 'permission error category'
Assert-Equal (Get-TestAssessment -Status (New-TestStatus 'context deadline exceeded fake-secret') -Metrics (New-TestMetrics -Last 0)).state 'network_timeout' 'network timeout category'
Assert-Equal (Get-TestAssessment -Status (New-TestStatus 'connection refused fake-secret') -Metrics (New-TestMetrics -Last 0)).state 'network_error' 'network connection error'
Assert-Equal (Get-TestAssessment -Status (New-TestStatus 'previous 403 forbidden fake-secret')).connected $true 'old error cannot override fresh success'
$redacted = Get-TestAssessment -Status (New-TestStatus '403 forbidden fake-secret') -Metrics (New-TestMetrics -Last 0) | ConvertTo-Json
Assert-Equal ($redacted -match 'fake-secret|do-not-print|private-account|tunnel_fake_test_fixture') $false 'no credential or account output'
Assert-Equal (Get-WebCodexMetric 'readiness NaN' 'readiness') $null 'NaN rejected'
Assert-Equal (Get-WebCodexMetric 'readiness 1e999' 'readiness') $null 'infinity rejected'

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('webcodex-tunnel-check-test-' + [guid]::NewGuid().ToString('N'))
try {
    [void](New-Item -ItemType Directory -Path $temporary)
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'installation_invalid' 'missing installation'
    $cliOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -ProjectRoot $temporary -Json -TimeoutSeconds 1
    Assert-Equal $LASTEXITCODE 2 'CLI nonzero exit code'
    Assert-Equal (($cliOutput -join "`n" | ConvertFrom-Json).state) 'installation_invalid' 'CLI JSON output'
    $toolsDir = Join-Path $temporary '.webcodex\tools\tunnel-client'
    [void](New-Item -ItemType Directory -Path $toolsDir -Force)
    $fakeExe = Join-Path $toolsDir 'tunnel-client.exe'
    [IO.File]::WriteAllText($fakeExe, 'inert test fixture; never executed')
    $fixtureInstall = @{ executable = $fakeExe; executableSha256 = (Get-FileHash -LiteralPath $fakeExe -Algorithm SHA256).Hash }
    $fixtureInstall | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $toolsDir 'install.json') -Encoding UTF8
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'not_running' 'no health file'
    Set-Content -LiteralPath (Join-Path $temporary '.webcodex\tunnel-health.url') -Value 'http://example.com:1234' -Encoding UTF8
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'unsafe_health_file' 'remote endpoint not requested'
    Set-Content -LiteralPath (Join-Path $temporary '.webcodex\tunnel-health.url') -Value 'http://127.0.0.1:65534' -Encoding UTF8
    # Mock OS process lookup for these negative states; these cases cannot make
    # an HTTP request or inspect the real local daemon.
    function Get-NetTCPConnection { [CmdletBinding()]param($State) return @() }
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'stale_health_file' 'stopped process health file'
    function Get-NetTCPConnection { [CmdletBinding()]param($State) throw 'fixture access denied' }
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'process_unverified' 'inspection denied is not stopped'
    function Get-NetTCPConnection { [CmdletBinding()]param($State) return [pscustomobject]@{LocalPort=65534; LocalAddress='127.0.0.1'; OwningProcess=12345} }
    function Get-Process { [CmdletBinding()]param($Id) return [pscustomobject]@{Path=$fakeExe; StartTime=[DateTime]::Now.AddMinutes(2)} }
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'stale_health_file' 'health file predates process'
    $fixtureInstall.executableSha256 = '0' * 64
    $fixtureInstall | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $toolsDir 'install.json') -Encoding UTF8
    Assert-Equal (Get-WebCodexTunnelDiagnostics $temporary 1).state 'installation_invalid' 'changed binary hash'
    Assert-Rejected { Test-WebCodexSafePath $env:WINDIR $temporary } 'outside project path'
} finally {
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $resolvedTestPath = [IO.Path]::GetFullPath($temporary)
    if (-not $resolvedTestPath.StartsWith($resolvedTempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTestPath) -notmatch '^webcodex-tunnel-check-test-[a-f0-9]{32}$') { throw 'unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolvedTestPath -Recurse -Force
}
Write-Output ("Tunnel diagnostics: $checks checks passed (pure functions and inert fixtures; no live account access).")
