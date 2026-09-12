<#
.SYNOPSIS
Installs WebCodex for the current user and opens its management page.
.PARAMETER InstallDir
Dedicated installation directory. Defaults to LOCALAPPDATA\WebCodex.
.PARAMETER Workspace
Workspace directory. Defaults to InstallDir\workspace.
.PARAMETER Config
Explicit JSON or TOML configuration path. Without this option, the sole existing
config.json or config.toml is retained; when both exist, selection is required.
.PARAMETER NoPanel
Prepare the installation and exit without starting the management page.
NoOpen is a compatibility alias with the same meaning.
.PARAMETER Proxy
HTTP(S) proxy origin used for this installation and passed to WebCodex setup.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [string]$Workspace = '',
    [Alias('NoOpen')][switch]$NoPanel,
    [string]$Proxy = '',
    [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$portableVersion = '22.23.2'
$minimumNode = [version]'22.16.0'
$staging = $null
$downloadDir = $null

function FullPath([string]$Value) { return [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)) }
function Assert-Child([string]$Child, [string]$Parent) {
    $resolvedChild = FullPath $Child
    $resolvedParent = (FullPath $Parent).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedChild.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The installation path escaped its intended directory.'
    }
}
function Remove-Temporary([string]$Target, [string]$Parent) {
    if ($Target -and (Test-Path -LiteralPath $Target)) {
        Assert-Child $Target $Parent
        if ([IO.Path]::GetFileName($Target) -notmatch '^\.install-[a-f0-9]+$') { throw 'Refusing to remove an unexpected temporary path.' }
        Remove-Item -LiteralPath $Target -Recurse -Force
    }
}
function Check-Sha([string]$File, [string]$Manifest, [string]$Name) {
    $matchesFound = @([IO.File]::ReadAllLines($Manifest) | Where-Object { $_ -match ('^[a-fA-F0-9]{64} [ *]' + [regex]::Escape($Name) + '$') })
    if ($matchesFound.Count -ne 1) { throw "Expected exactly one checksum for $Name in the checksum manifest." }
    $expected = $matchesFound[0].Substring(0, 64).ToLowerInvariant()
    $stream = [IO.File]::OpenRead($File)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    if ($actual -ne $expected) { throw "SHA-256 verification failed for $Name. Download the complete release again." }
    return $expected
}
function Download-Official([string]$Url, [string]$Destination) {
    $client = [Net.WebClient]::new()
    if ($Proxy) { $client.Proxy = [Net.WebProxy]::new($Proxy) }
    try { $client.DownloadFile($Url, $Destination) }
    finally { $client.Dispose() }
}
function Node-Compatible([string]$Executable) {
    try {
        $value = & $Executable --version 2>$null
        return $LASTEXITCODE -eq 0 -and ([version](([string]$value).Trim().TrimStart('v'))) -ge $minimumNode
    } catch { return $false }
}
function Quote-PowerShell([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

try {
    Write-Host 'WebCodex local installer'
    $packages = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'webcodex-mcp-*.tgz' -File)
    if ($packages.Count -ne 1) { throw 'Extract the full setup ZIP first. It must contain exactly one webcodex-mcp-*.tgz package.' }
    $package = $packages[0]
    if ($package.Name -notmatch '^webcodex-mcp-([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)\.tgz$') { throw 'The package filename does not contain a supported release version.' }
    $releaseVersion = $Matches[1]
    $packageHash = Check-Sha $package.FullName (Join-Path $PSScriptRoot 'SHA256SUMS') $package.Name
    Write-Host "[1/4] Package checksum verified: $releaseVersion"
    if ($Proxy) {
        $proxyUri = $null
        if (-not [Uri]::TryCreate($Proxy, [UriKind]::Absolute, [ref]$proxyUri) -or $proxyUri.Scheme -notin @('http', 'https') -or $proxyUri.UserInfo -or $proxyUri.AbsolutePath -ne '/' -or $proxyUri.Query -or $proxyUri.Fragment) {
            throw 'Use an HTTP(S) proxy origin without a username, password, path, query or fragment.'
        }
        $env:HTTP_PROXY = $Proxy
        $env:HTTPS_PROXY = $Proxy
        $env:npm_config_proxy = $Proxy
        $env:npm_config_https_proxy = $Proxy
    }

    if (-not $InstallDir) { $InstallDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WebCodex' }
    $InstallDir = FullPath $InstallDir
    if ($InstallDir.TrimEnd('\') -eq [IO.Path]::GetPathRoot($InstallDir).TrimEnd('\')) { throw 'Choose a dedicated installation directory, not a drive root.' }
    if ($Config) {
        $config = FullPath $Config
    } else {
        $jsonConfig = Join-Path $InstallDir 'config.json'
        $tomlConfig = Join-Path $InstallDir 'config.toml'
        $hasJson = Test-Path -LiteralPath $jsonConfig
        $hasToml = Test-Path -LiteralPath $tomlConfig
        if ($hasJson -and $hasToml) { throw 'Both config.json and config.toml exist. Run the installer with -Config PATH to explicitly select one. Both files have been preserved.' }
        $config = if ($hasJson) { $jsonConfig } else { $tomlConfig }
    }
    if ((Test-Path -LiteralPath $config) -and -not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "The selected configuration path is not a file: $config" }
    if (-not $Workspace) { $Workspace = Join-Path $InstallDir 'workspace' }
    $Workspace = FullPath $Workspace
    $null = New-Item -ItemType Directory -Path $InstallDir -Force
    $null = New-Item -ItemType Directory -Path $Workspace -Force

    $nodeExe = $null
    $npmCli = $null
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand -and (Node-Compatible $nodeCommand.Source)) {
        $nodeDirectory = Split-Path -Parent $nodeCommand.Source
        $npmCandidate = Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js'
        if (-not (Test-Path -LiteralPath $npmCandidate -PathType Leaf)) {
            $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($npmCommand) { $npmCandidate = Join-Path (Split-Path -Parent $npmCommand.Source) 'node_modules/npm/bin/npm-cli.js' }
        }
        if (Test-Path -LiteralPath $npmCandidate -PathType Leaf) { $nodeExe = $nodeCommand.Source; $npmCli = $npmCandidate }
    }
    if (-not $nodeExe) {
        $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        $nodeArchitecture = switch ($architecture.ToUpperInvariant()) { 'AMD64' { 'x64' }; 'ARM64' { 'arm64' }; default { throw 'This installer supports Windows x64 and ARM64.' } }
        $archiveRoot = "node-v$portableVersion-win-$nodeArchitecture"
        $runtimeRoot = Join-Path $InstallDir 'runtime'
        $runtime = Join-Path $runtimeRoot $archiveRoot
        Assert-Child $runtime $InstallDir
        $nodeExe = Join-Path $runtime 'node.exe'
        $npmCli = Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'
        if (-not (Test-Path -LiteralPath $runtime)) {
            Write-Host "[2/4] Downloading the official portable Node.js $portableVersion ($nodeArchitecture)..."
            $null = New-Item -ItemType Directory -Path $runtimeRoot -Force
            $downloadDir = Join-Path $runtimeRoot ('.install-' + [guid]::NewGuid().ToString('N'))
            $null = New-Item -ItemType Directory -Path $downloadDir
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $archiveName = "$archiveRoot.zip"
            $archivePath = Join-Path $downloadDir $archiveName
            $checksumPath = Join-Path $downloadDir 'SHASUMS256.txt'
            Download-Official "https://nodejs.org/dist/v$portableVersion/SHASUMS256.txt" $checksumPath
            Download-Official "https://nodejs.org/dist/v$portableVersion/$archiveName" $archivePath
            $archiveHash = Check-Sha $archivePath $checksumPath $archiveName
            Write-Host "[2/4] Portable Node.js checksum verified: $archiveHash"
            $null = [Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
            [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $downloadDir)
            $extracted = Join-Path $downloadDir $archiveRoot
            Assert-Child $extracted $downloadDir
            Assert-Child $runtime $runtimeRoot
            Move-Item -LiteralPath $extracted -Destination $runtime
            Remove-Temporary $downloadDir $runtimeRoot
            $downloadDir = $null
        }
        if (-not (Node-Compatible $nodeExe) -or -not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw "The portable Node.js installation is incomplete: $runtime" }
    }
    Write-Host "[2/4] Using Node.js $(& $nodeExe --version)"
    $env:PATH = (Split-Path -Parent $nodeExe) + [IO.Path]::PathSeparator + $env:PATH
    $appRoot = Join-Path $InstallDir 'app'
    $app = Join-Path $appRoot $releaseVersion
    $cli = Join-Path $app 'node_modules/webcodex-mcp/dist/src/cli.js'
    $marker = Join-Path $app '.webcodex-package.sha256'
    if (Test-Path -LiteralPath $app) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or ([IO.File]::ReadAllText($marker).Trim() -ne $packageHash) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
            throw "This release directory already exists with different or incomplete contents: $app. Use a new InstallDir; existing files have been preserved."
        }
        Write-Host '[3/4] Reusing this verified release; installed application files are unchanged.'
    } else {
        Write-Host '[3/4] Installing WebCodex and its production dependencies...'
        $null = New-Item -ItemType Directory -Path $appRoot -Force
        $staging = Join-Path $appRoot ('.install-' + [guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $staging
        & $nodeExe $npmCli install --prefix $staging $package.FullName --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm installation failed (exit $LASTEXITCODE)." }
        $stagedCli = Join-Path $staging 'node_modules/webcodex-mcp/dist/src/cli.js'
        if (-not (Test-Path -LiteralPath $stagedCli -PathType Leaf)) { throw 'The package does not include the built WebCodex CLI.' }
        [IO.File]::WriteAllText((Join-Path $staging '.webcodex-package.sha256'), $packageHash + "`n")
        Assert-Child $staging $appRoot
        Assert-Child $app $appRoot
        Move-Item -LiteralPath $staging -Destination $app
        $staging = $null
    }

    $launcher = Join-Path $InstallDir 'webcodex.ps1'
    $launcherBody = "`$ErrorActionPreference = 'Stop'"
    $launcherBody += "`n`$env:PATH = " + (Quote-PowerShell ((Split-Path -Parent $nodeExe) + ';')) + " + `$env:PATH`n"
    $launcherBody += "if (`$args.Count -eq 0) { `$args = @('setup') }`n"
    $launcherBody += '& ' + (Quote-PowerShell $nodeExe) + ' ' + (Quote-PowerShell $cli) + ' @args --config ' + (Quote-PowerShell $config) + "`nexit `$LASTEXITCODE`n"
    [IO.File]::WriteAllText($launcher, $launcherBody, [Text.UTF8Encoding]::new($true))
    [IO.File]::WriteAllText((Join-Path $InstallDir 'start-webcodex.cmd'), "@echo off`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0webcodex.ps1`" %*`r`n", [Text.Encoding]::ASCII)
    Write-Host "[4/4] Preparing workspace and configuration: $Workspace"
    Write-Host 'Existing configuration will be preserved. No system PATH or service settings are changed.'
    Write-Host ('Start the management page later: & ' + (Quote-PowerShell (Join-Path $InstallDir 'start-webcodex.cmd')))
    $setupArguments = @($cli, 'setup', '--workspace', $Workspace, '--config', $config)
    if ($NoPanel) { $setupArguments += '--no-panel' }
    if ($Proxy) { $setupArguments += @('--proxy', $Proxy) }
    & $nodeExe @setupArguments
    if ($LASTEXITCODE -ne 0) { throw "WebCodex setup failed (exit $LASTEXITCODE). The installed files are retained for retry." }
    exit 0
} catch {
    Write-Host ('Installation failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($staging) { Remove-Temporary $staging (Join-Path $InstallDir 'app') }
    if ($downloadDir) { Remove-Temporary $downloadDir (Join-Path $InstallDir 'runtime') }
}
