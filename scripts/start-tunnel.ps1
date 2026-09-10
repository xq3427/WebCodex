#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^tunnel_[A-Za-z0-9_-]+$')]
    [string]$TunnelId = $env:CONTROL_PLANE_TUNNEL_ID,
    [string]$Config,
    [string]$NodePath,
    [string]$ProxyUrl,
    [string]$ApiKeyConfig,
    [switch]$DoctorOnly,
    [switch]$NoPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Version 2 uses the same single-file configuration and Node entry point on all
# platforms. The legacy branch below is retained only for unmigrated v1 setups.
$compatProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$selectedConfig = if ($Config) { $Config } elseif ($env:WEBCODEX_CONFIG) { $env:WEBCODEX_CONFIG } else { $null }
if ($selectedConfig) {
    $candidateConfig = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($selectedConfig)
} else {
    $candidateToml = Join-Path $compatProjectRoot '.webcodex\config.toml'
    $candidateJson = Join-Path $compatProjectRoot '.webcodex\config.json'
    if ((Test-Path -LiteralPath $candidateToml -PathType Leaf) -and (Test-Path -LiteralPath $candidateJson -PathType Leaf)) {
        throw 'Both config.toml and config.json exist. Select one with -Config.'
    }
    $candidateConfig = if (Test-Path -LiteralPath $candidateToml -PathType Leaf) { $candidateToml } else { $candidateJson }
}
$candidate = $null
$isToml = [IO.Path]::GetExtension($candidateConfig) -ieq '.toml'
if (-not $isToml -and (Test-Path -LiteralPath $candidateConfig -PathType Leaf)) {
    try { $candidate = Get-Content -LiteralPath $candidateConfig -Raw | ConvertFrom-Json }
    catch { throw 'The local configuration JSON could not be parsed. Configuration contents are not displayed.' }
}
if ($isToml -or ($null -ne $candidate -and $null -ne $candidate.PSObject.Properties['version'] -and $candidate.version -eq 2)) {
    foreach ($legacyOption in @('TunnelId', 'ProxyUrl', 'ApiKeyConfig', 'NodePath')) {
        if ($PSBoundParameters.ContainsKey($legacyOption)) { throw 'Version 2 reads connection settings only from the configuration file. Remove legacy connection overrides.' }
    }
    $bootstrapNode = $null
    if ($null -ne $candidate -and $null -ne $candidate.PSObject.Properties['nodePath'] -and $candidate.nodePath -and $candidate.nodePath -ne 'auto') {
        try {
            $bootstrapNode = [string]$candidate.nodePath
            $bootstrapConfigDir = Split-Path -Parent $candidateConfig
            $bootstrapUserDir = [Environment]::GetFolderPath('UserProfile')
            $bootstrapNode = $bootstrapNode.Replace('${configDir}', $bootstrapConfigDir).Replace('${userHome}', $bootstrapUserDir)
            if ($bootstrapNode -match '^~[\\/]') { $bootstrapNode = Join-Path $bootstrapUserDir $bootstrapNode.Substring(2) }
            if ($bootstrapNode.Contains('${')) { throw 'Unresolved path reference.' }
            if (-not [IO.Path]::IsPathRooted($bootstrapNode)) { $bootstrapNode = Join-Path $bootstrapConfigDir $bootstrapNode }
            $bootstrapNode = (Resolve-Path -LiteralPath $bootstrapNode).ProviderPath
            if ([IO.Path]::GetExtension($bootstrapNode) -ine '.exe') { throw 'Not a native Windows executable.' }
        } catch { throw 'Cannot resolve the configured native Node executable. Use a valid local path or invoke the Node CLI directly.' }
    } else {
        $foundNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $foundNode) { throw 'Install Node.js on PATH to bootstrap this wrapper, or invoke the Node CLI directly with your local Node executable.' }
        $bootstrapNode = $foundNode.Source
    }
    $nodeArguments = @((Join-Path $compatProjectRoot 'dist\src\cli.js'), 'connect', '--config', $candidateConfig)
    if ($DoctorOnly) { $nodeArguments += '--doctor-only' }
    # No credential or connection setting is transferred through argv here.
    $candidate = $null
    & $bootstrapNode @nodeArguments
    if ($LASTEXITCODE -ne 0) { throw 'WebCodex connect did not complete successfully. Check the unified configuration.' }
    return
}
if ($ProxyUrl) {
    $proxyUri = $null
    if ($ProxyUrl -match '[\x00-\x20\x7f]' -or
        -not [Uri]::TryCreate($ProxyUrl, [UriKind]::Absolute, [ref]$proxyUri) -or
        $proxyUri.Scheme -notin @('http', 'https') -or
        -not $proxyUri.Host -or $proxyUri.UserInfo -or $proxyUri.Query -or $proxyUri.Fragment) {
        throw 'ProxyUrl must be an HTTP or HTTPS proxy URL without credentials, a query, or a fragment.'
    }
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateRoot = Join-Path $projectRoot '.webcodex\private'
$explicitApiKeyConfig = $PSBoundParameters.ContainsKey('ApiKeyConfig')
if ($explicitApiKeyConfig -and [string]::IsNullOrWhiteSpace($ApiKeyConfig)) { throw 'ApiKeyConfig must name a local credential configuration file.' }
if (-not $ApiKeyConfig) { $ApiKeyConfig = Join-Path $privateRoot 'tunnel-auth.json' }
$ApiKeyConfig = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ApiKeyConfig)
. (Join-Path $PSScriptRoot 'tunnel-auth.ps1')
if (-not $Config) { $Config = Join-Path $projectRoot '.webcodex\config.json' }
$configPath = (Resolve-Path -LiteralPath $Config).ProviderPath
$cliPath = Join-Path $projectRoot 'dist\src\cli.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'Run npm.cmd run build first.' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
if (-not $TunnelId) { throw 'Supply -TunnelId from Platform tunnel settings, or set CONTROL_PLANE_TUNNEL_ID.' }

$installationPath = Join-Path $projectRoot '.webcodex\tools\tunnel-client\install.json'
if (-not (Test-Path -LiteralPath $installationPath -PathType Leaf)) {
    throw 'Run scripts/install-tunnel.ps1 first.'
}
$installation = Get-Content -LiteralPath $installationPath -Raw | ConvertFrom-Json
$tunnelExecutable = [IO.Path]::GetFullPath([string]$installation.executable)
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '.webcodex\tools\tunnel-client'))
if (-not $tunnelExecutable.StartsWith($toolsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installed executable must remain under this project .webcodex/tools/tunnel-client directory.'
}
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tunnelExecutable).Hash.ToLowerInvariant()
if ($actualHash -cne $installation.executableSha256) { throw 'Tunnel executable changed since installation; reinstall the official client.' }

& $NodePath $cliPath doctor --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'WebCodex doctor failed; fix the local configuration before connecting.' }

# Forward slashes avoid backslash escaping in tunnel-client's command parser.
# Windows file paths cannot contain a double quote; reject control characters.
$commandParts = @($NodePath, $cliPath, 'serve', '--config', $configPath, '--transport', 'stdio')
$quotedParts = foreach ($part in $commandParts) {
    if ($part -match '["\r\n\x00]') { throw 'Unsupported quote or control character in an executable/config path.' }
    '"' + $part.Replace('\', '/') + '"'
}
$mcpCommand = $quotedParts -join ' '
$healthUrlFile = Join-Path $projectRoot '.webcodex\tunnel-health.url'
$arguments = @(
    '--control-plane.base-url', 'https://api.openai.com',
    '--control-plane.tunnel-id', $TunnelId,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--mcp.command', $mcpCommand,
    '--mcp.stdio-send-initialized-notification',
    '--health.listen-addr', '127.0.0.1:0',
    '--health.url-file', $healthUrlFile,
    '--allow-remote-ui=false',
    '--log.http-raw-unsafe=false'
)
if ($ProxyUrl) { $arguments += @('--control-plane.http-proxy', $ProxyUrl) }

# File credentials take precedence over the caller environment. An explicit,
# invalid, or empty credential file fails instead of silently selecting a key
# from another account. The file stays inside the MCP-protected private folder.
$runtimeKey = $null
if ($explicitApiKeyConfig -or (Test-Path -LiteralPath $ApiKeyConfig)) {
    $runtimeKey = Read-WebCodexTunnelApiKey -Path $ApiKeyConfig -PrivateRoot $privateRoot
} else {
    $runtimeKey = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
}
$savedEnvironment = @{}
# Do not let unrelated tunnel-client profiles, command bindings, or debug
# settings alter the dedicated stdio connection. Restore caller settings later.
$managedPattern = '^(CONTROL_PLANE_|MCP_|HARPOON_|CLOUDFLARED_|TUNNEL_CLIENT_|HEALTH_|LOG_|ADMIN_UI_|OPENAI_API_KEY$|OPENAI_ADMIN_KEY$|ALLOW_REMOTE_UI$|OPEN_WEB_UI$|PID_FILE$)'
try {
    foreach ($entry in (Get-ChildItem Env: | Where-Object { $_.Name -match $managedPattern })) {
        $savedEnvironment[$entry.Name] = $entry.Value
        [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
    }
    if (-not $runtimeKey -and -not $NoPrompt) {
        $secureKey = Read-Host 'Runtime API key (hidden; used only for this process)' -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try { $runtimeKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer) }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
            $secureKey.Dispose()
        }
    }
    if (-not $runtimeKey) { throw 'Runtime API key is missing. Set api_key in .webcodex/private/tunnel-auth.json or provide CONTROL_PLANE_API_KEY.' }
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $runtimeKey, 'Process')
    $runtimeKey = $null
    & $tunnelExecutable doctor @arguments --explain
    if ($LASTEXITCODE -ne 0) { throw 'Tunnel doctor failed; fix the reported configuration before startup.' }
    if (-not $DoctorOnly) {
        Write-Host 'Starting the foreground tunnel. Keep this terminal open; Ctrl+C stops it.'
        Write-Host "Health URL is written after startup to: $healthUrlFile"
        Write-Host 'Doctor validates configuration. Require a successful control-plane poll and a ChatGPT tool call before treating the connection as ready.'
        Write-Host ('Health check: & "{0}" health --url-file "{1}" --require-control-plane-poll --json' -f $tunnelExecutable, $healthUrlFile)
        & $tunnelExecutable run @arguments
        if ($LASTEXITCODE -ne 0) { throw "Tunnel exited with status $LASTEXITCODE." }
    }
} finally {
    $runtimeKey = $null
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $null, 'Process')
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    $savedEnvironment.Clear()
}
