#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ProjectRoot,
    [switch]$Json,
    [ValidateRange(1, 30)][int]$TimeoutSeconds = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Join-Path $PSScriptRoot '..' }

function Get-WebCodexProperty {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Test-WebCodexSafePath {
    param([string]$Path, [string]$Root)
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'unsafe_path'
    }
    # Reject junctions/symlinks at every ancestor, including the project root.
    $current = $full
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe_path' }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
    return $full
}

function ConvertTo-WebCodexLoopbackUri {
    param([string]$Value)
    # Match the literal URL before URI canonicalization: reject localhost DNS,
    # shorthand IPv4, escaped paths, backslashes, query, fragment and userinfo.
    $value = $Value.Trim()
    if ($value -cnotmatch '^http://(127\.0\.0\.1|\[::1\]):([0-9]{1,5})/?$') { throw 'unsafe_health_url' }
    $port = [int]$Matches[2]
    if ($port -lt 1 -or $port -gt 65535) { throw 'unsafe_health_url' }
    return [Uri]$value
}

function Get-WebCodexMetric {
    param([string]$Metrics, [string]$Name, [hashtable]$Labels = @{})
    $values = @()
    $pattern = '^' + [regex]::Escape($Name) + '(?:\{(?<labels>[^\r\n]*)\})?\s+(?<value>[+\-0-9.eE]+)(?:\s+\d+)?\s*$'
    foreach ($line in ($Metrics -split "`n")) {
        $match = [regex]::Match($line.TrimEnd("`r"), $pattern)
        if (-not $match.Success) { continue }
        $accept = $true
        foreach ($key in $Labels.Keys) {
            $labelPattern = '(?:^|,)' + [regex]::Escape($key) + '="' + [regex]::Escape([string]$Labels[$key]) + '"(?:,|$)'
            if (-not [regex]::IsMatch($match.Groups['labels'].Value, $labelPattern)) { $accept = $false; break }
        }
        if (-not $accept) { continue }
        $number = 0.0
        if ([double]::TryParse($match.Groups['value'].Value, [Globalization.NumberStyles]::Float,
                [Globalization.CultureInfo]::InvariantCulture, [ref]$number) -and
            -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)) {
            $values += $number
        }
    }
    if ($values.Count -eq 0) { return $null }
    return ($values | Measure-Object -Sum).Sum
}

function Get-WebCodexErrorCategory {
    param($Status)
    # Only inspect explicit error fields. Never return server-controlled text,
    # metadata, route targets, proxy URLs, IDs or credentials to the caller.
    $messages = @()
    foreach ($name in @('tunnel_metadata_error', 'control_plane_error', 'last_error', 'error')) {
        $value = Get-WebCodexProperty $Status $name
        if ($value -is [string]) { $messages += $value.Substring(0, [Math]::Min($value.Length, 8192)) }
        elseif ($null -ne $value) {
            foreach ($field in @('message', 'error', 'code', 'status', 'status_code')) {
                $part = Get-WebCodexProperty $value $field
                if ($part -is [string] -or $part -is [int] -or $part -is [long]) { $messages += [string]$part }
            }
        }
    }
    $combined = $messages -join ' '
    if ($combined -match '(?i)\b(401|403|unauthorized|forbidden|permission.denied|access.denied)\b') { return 'authentication_or_permission' }
    if ($combined -match '(?i)(timed?\s*out|timeout|deadline exceeded)') { return 'network_timeout' }
    if ($combined -match '(?i)(connection refused|connection reset|no such host|network is unreachable|TLS handshake|certificate)') { return 'network_error' }
    if ($messages.Count -gt 0) { return 'unclassified' }
    return 'none_observed'
}

function Get-WebCodexTunnelAssessment {
    param($Status, [string]$Metrics, [bool]$Live, [bool]$Ready, [double]$NowUnix, [double]$ProcessStartUnix)
    $result = [ordered]@{
        state = 'diagnostics_unavailable'; exit_code = 4; connected = $false
        process_verified = $true; live = $Live; mcp_ready = $Ready
        route_mode = 'unknown'; poll_fresh = $false; poll_age_seconds = $null
        poll_freshness_limit_seconds = 120; successful_tool_calls = $null
        last_error_category = (Get-WebCodexErrorCategory $Status)
        summary = '本地诊断数据不完整，暂时无法确认连接。'
    }
    $route = Get-WebCodexProperty $Status 'control_plane_route'
    $mode = Get-WebCodexProperty $route 'route_mode'
    if ($mode -in @('direct', 'proxy')) { $result.route_mode = $mode }
    if (-not $Live) {
        $result.state = 'local_unhealthy'; $result.exit_code = 3
        $result.summary = '隧道进程存在，但本地存活检查未通过。'
        return [pscustomobject]$result
    }
    $last = Get-WebCodexMetric $Metrics 'commands_poll_last_successful_timestamp_seconds'
    $liveness = Get-WebCodexMetric $Metrics 'liveness'
    $readiness = Get-WebCodexMetric $Metrics 'readiness'
    if ($null -eq $last -or $null -eq $liveness -or $null -eq $readiness -or $null -eq $Status) { return [pscustomobject]$result }
    if ($last -gt 0) {
        $age = $NowUnix - $last
        $result.poll_age_seconds = [Math]::Round($age, 1)
        $result.poll_fresh = ($age -ge -5 -and $age -le 120 -and $last -ge ($ProcessStartUnix - 5))
    }
    # A successful /readyz alone is insufficient: the client retains old poll success.
    if (-not $result.poll_fresh) {
        $result.exit_code = 5
        switch ($result.last_error_category) {
            'authentication_or_permission' { $result.state = 'authentication_or_permission_denied'; $result.summary = '尚无新鲜的云端轮询成功记录；诊断记录包含认证或权限拒绝。' }
            'network_timeout' { $result.state = 'network_timeout'; $result.summary = '尚无新鲜的云端轮询成功记录；诊断记录包含网络超时。' }
            'network_error' { $result.state = 'network_error'; $result.summary = '尚无新鲜的云端轮询成功记录；诊断记录包含网络连接错误。' }
            default {
                if ($last -le 0) { $result.state = 'awaiting_control_plane'; $result.summary = '本地进程已启动，尚未观测到云端轮询成功。' }
                else { $result.state = 'poll_stale'; $result.summary = '云端轮询成功记录已过期或时间异常，当前连接尚未确认。' }
            }
        }
        return [pscustomobject]$result
    }
    $main = @(Get-WebCodexProperty $Status 'channels' @()) | Where-Object { (Get-WebCodexProperty $_ 'name') -eq 'main' }
    $mainReady = @($main | Where-Object { (Get-WebCodexProperty $_ 'enabled') -eq $true -and (Get-WebCodexProperty $_ 'probe_status') -eq 'ok' }).Count -gt 0
    if (-not $Ready -or $readiness -ne 1 -or $liveness -ne 1 -or -not $mainReady) {
        $result.state = 'mcp_not_ready'; $result.exit_code = 6; $result.mcp_ready = $false
        $result.summary = '云端轮询正常，但本地 MCP 尚未就绪。'
        return [pscustomobject]$result
    }
    $calls = Get-WebCodexMetric $Metrics 'command_end_to_end_latency_milliseconds_count' @{
        latency_type = 'enqueue_to_response'; request_method = 'tools/call'; tunnel_service_status = '200'
    }
    # Prometheus omits a label series until its first observation. A valid live
    # metrics response with the required gauges but no matching series means 0.
    if ($null -eq $calls) { $calls = 0 }
    $result.successful_tool_calls = [long]$calls
    $result.connected = $true; $result.exit_code = 0
    if ($calls -gt 0) {
        $result.state = 'connected_tools_called'
        $result.summary = '隧道在线，MCP 已就绪，本次进程已收到工具调用并成功传回响应。'
    } else {
        $result.state = 'connected_no_tool_calls'
        $result.summary = '隧道在线，MCP 已就绪，本次进程尚未观测到工具调用成功响应。'
    }
    return [pscustomobject]$result
}

function Invoke-WebCodexLocalProbe {
    param([Uri]$BaseUri, [string]$Endpoint, [Diagnostics.Stopwatch]$Clock, [int]$BudgetSeconds)
    $remaining = [int]($BudgetSeconds * 1000 - $Clock.ElapsedMilliseconds)
    if ($remaining -le 0) { return [pscustomobject]@{ status = 0; body = ''; error = 'local_timeout' } }
    $request = [Net.HttpWebRequest]::Create(($BaseUri.AbsoluteUri.TrimEnd('/') + $Endpoint))
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $remaining
    $request.ReadWriteTimeout = $remaining
    $response = $null; $stream = $null; $reader = $null
    try {
        try { $response = $request.GetResponse() }
        catch [Net.WebException] {
            if ($null -eq $_.Exception.Response) {
                $category = if ($_.Exception.Status -eq [Net.WebExceptionStatus]::Timeout) { 'local_timeout' } else { 'local_unreachable' }
                return [pscustomobject]@{ status = 0; body = ''; error = $category }
            }
            $response = $_.Exception.Response
        }
        $statusCode = [int]$response.StatusCode
        # Never follow a redirect or return any response body from failures.
        if ($statusCode -ne 200) { return [pscustomobject]@{ status = $statusCode; body = ''; error = 'local_http_error' } }
        if ($response.ContentLength -gt 524288) { throw 'response_too_large' }
        $stream = $response.GetResponseStream()
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $buffer = New-Object char[] 4096
        $builder = New-Object Text.StringBuilder
        while ($true) {
            $readBudget = [int]($BudgetSeconds * 1000 - $Clock.ElapsedMilliseconds)
            if ($readBudget -le 0) { throw 'local_timeout' }
            if ($stream.CanTimeout) { $stream.ReadTimeout = $readBudget }
            $count = $reader.Read($buffer, 0, $buffer.Length)
            if ($count -eq 0) { break }
            if (($builder.Length + $count) -gt 262144) { throw 'response_too_large' }
            [void]$builder.Append($buffer, 0, $count)
        }
        return [pscustomobject]@{ status = $statusCode; body = $builder.ToString(); error = $null }
    } catch {
        $category = if ($Clock.ElapsedMilliseconds -ge ($BudgetSeconds * 1000)) { 'local_timeout' } else { 'local_invalid_response' }
        return [pscustomobject]@{ status = 0; body = ''; error = $category }
    } finally {
        if ($null -ne $reader) { $reader.Dispose() }
        elseif ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $request.Abort()
    }
}

function Get-WebCodexTunnelDiagnostics {
    param([string]$Root, [int]$BudgetSeconds)
    $rootPath = [IO.Path]::GetFullPath($Root)
    $toolsRoot = Join-Path $rootPath '.webcodex\tools\tunnel-client'
    $installPath = Join-Path $toolsRoot 'install.json'
    $healthPath = Join-Path $rootPath '.webcodex\tunnel-health.url'
    $result = [ordered]@{ state = 'installation_invalid'; exit_code = 2; connected = $false; process_verified = $false; summary = '隧道安装记录缺失、路径不安全或程序校验未通过。' }
    try {
        [void](Test-WebCodexSafePath $installPath $rootPath)
        if ((Get-Item -LiteralPath $installPath).Length -gt 65536) { return [pscustomobject]$result }
        $installation = Get-Content -LiteralPath $installPath -Raw | ConvertFrom-Json
        $executable = Test-WebCodexSafePath ([string](Get-WebCodexProperty $installation 'executable')) $toolsRoot
        $expectedHash = [string](Get-WebCodexProperty $installation 'executableSha256')
        if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$' -or [IO.Path]::GetFileName($executable) -ine 'tunnel-client.exe') { return [pscustomobject]$result }
        if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ine $expectedHash) { return [pscustomobject]$result }
    } catch { return [pscustomobject]$result }
    if (-not (Test-Path -LiteralPath $healthPath -PathType Leaf)) {
        return [pscustomobject]@{ state = 'not_running'; exit_code = 3; connected = $false; process_verified = $false; summary = '未发现隧道健康地址文件，尚无启动证据。' }
    }
    try {
        [void](Test-WebCodexSafePath $healthPath $rootPath)
        if ((Get-Item -LiteralPath $healthPath).Length -gt 2048) { throw 'unsafe_health_url' }
        $baseUri = ConvertTo-WebCodexLoopbackUri (Get-Content -LiteralPath $healthPath -Raw)
    } catch {
        return [pscustomobject]@{ state = 'unsafe_health_file'; exit_code = 2; connected = $false; process_verified = $false; summary = '健康地址文件不安全；仅接受本机回环 HTTP 地址，未发出请求。' }
    }
    try {
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $baseUri.Port -and $_.LocalAddress -eq $baseUri.DnsSafeHost })
        $owners = @($listeners | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -ieq $executable })
        if ($owners.Count -ne 1) {
            return [pscustomobject]@{ state = 'stale_health_file'; exit_code = 3; connected = $false; process_verified = $false; summary = '健康地址没有对应的已校验隧道进程监听，文件可能来自已停止的进程。' }
        }
        $ownerStart = $owners[0].StartTime.ToUniversalTime()
        if ((Get-Item -LiteralPath $healthPath).LastWriteTimeUtc -lt $ownerStart.AddSeconds(-5)) {
            return [pscustomobject]@{ state = 'stale_health_file'; exit_code = 3; connected = $false; process_verified = $false; summary = '健康地址文件早于当前隧道进程启动，不能作为当前连接依据。' }
        }
    } catch {
        return [pscustomobject]@{ state = 'process_unverified'; exit_code = 4; connected = $false; process_verified = $false; summary = '无法核对本机监听端口的进程身份，未继续访问健康接口。' }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $health = Invoke-WebCodexLocalProbe $baseUri '/healthz' $clock $BudgetSeconds
    $ready = Invoke-WebCodexLocalProbe $baseUri '/readyz' $clock $BudgetSeconds
    $statusResponse = Invoke-WebCodexLocalProbe $baseUri '/api/status' $clock $BudgetSeconds
    $metricsResponse = Invoke-WebCodexLocalProbe $baseUri '/metrics' $clock $BudgetSeconds
    if (@($health, $ready, $statusResponse, $metricsResponse | Where-Object { $_.error -eq 'local_timeout' }).Count -gt 0) {
        return [pscustomobject]@{ state = 'local_probe_timeout'; exit_code = 4; connected = $false; process_verified = $true; summary = '本机诊断接口请求超时；无法据此判断云端认证或连接。' }
    }
    $status = $null
    if ($statusResponse.status -eq 200) { try { $status = $statusResponse.body | ConvertFrom-Json } catch {} }
    $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', [DateTimeKind]::Utc)
    return Get-WebCodexTunnelAssessment -Status $status -Metrics $metricsResponse.body `
        -Live ($health.status -eq 200 -and $health.body.Trim() -eq 'live') `
        -Ready ($ready.status -eq 200 -and $ready.body.Trim() -eq 'ready') `
        -NowUnix ([DateTime]::UtcNow - $epoch).TotalSeconds -ProcessStartUnix ($ownerStart - $epoch).TotalSeconds
}

try { $diagnostic = Get-WebCodexTunnelDiagnostics $ProjectRoot $TimeoutSeconds }
catch { $diagnostic = [pscustomobject]@{ state = 'diagnostics_unavailable'; exit_code = 4; connected = $false; process_verified = $false; summary = '本地诊断未完成；未输出可能包含凭据的底层错误。' } }
if ($Json) { $diagnostic | ConvertTo-Json -Depth 4 }
else {
    Write-Output $diagnostic.summary
    Write-Output ('状态: {0}；退出码: {1}' -f $diagnostic.state, $diagnostic.exit_code)
    if (Get-WebCodexProperty $diagnostic 'route_mode') {
        Write-Output ('路由: {0}；最后成功轮询距今(秒): {1}；本次工具成功响应: {2}' -f $diagnostic.route_mode, $diagnostic.poll_age_seconds, $diagnostic.successful_tool_calls)
    }
}
exit $diagnostic.exit_code
