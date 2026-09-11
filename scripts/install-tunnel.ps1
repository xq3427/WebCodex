#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Config,
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+$')]
    [string]$Version,
    [ValidateSet('amd64', 'arm64')]
    [string]$Architecture,
    [switch]$ResolveOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node -ErrorAction Stop).Source
$resolver = Join-Path $PSScriptRoot 'resolve-tunnel-install.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\src\config.js') -PathType Leaf)) {
    throw 'Build WebCodex with npm run build and initialize a unified configuration before installing the tunnel client.'
}
$resolverArgs = @($resolver)
if ($PSBoundParameters.ContainsKey('Config')) {
    if ([string]::IsNullOrWhiteSpace($Config)) { throw 'Config must name the selected TOML or JSON configuration.' }
    $resolverArgs += @('--config', $Config)
}
if ($Architecture) { $resolverArgs += @('--architecture', $Architecture) }
$resolvedJson = & $node @resolverArgs 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the selected unified configuration. Run config validate with the same configuration selection before installing.' }
$resolved = ($resolvedJson -join "`n") | ConvertFrom-Json
$toolsRoot = [IO.Path]::GetFullPath([string]$resolved.client_root)
if (-not $Architecture) { $Architecture = [string]$resolved.architecture }
if ($Architecture -notin @('amd64', 'arm64')) { throw 'The selected Node runtime architecture is not supported by this installer.' }
if ($ResolveOnly) {
    Write-Output ($resolvedJson -join "`n")
    return
}
$curl = (Get-Command curl.exe -ErrorAction Stop).Source

function Get-PublicFile([string]$Url, [string]$Destination, [string]$Accept = 'application/vnd.github+json') {
    & $curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' `
        --retry 2 --connect-timeout 15 --max-time 180 `
        --header 'User-Agent: WebCodex-local-setup' --header "Accept: $Accept" --output $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $Url" }
}

function Assert-PlainDirectory([string]$Path) {
    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing an installation directory containing a reparse point: $candidate"
            }
        }
        $parent = Split-Path -Parent $candidate
        if (-not $parent -or $parent -eq $candidate) { break }
        $candidate = $parent
    }
}

Assert-PlainDirectory $toolsRoot
[void](New-Item -ItemType Directory -Path $toolsRoot -Force)
$releaseApi = 'https://api.github.com/repos/openai/tunnel-client/releases/latest'
if ($Version) { $releaseApi = "https://api.github.com/repos/openai/tunnel-client/releases/tags/$Version" }
$metadataPath = Join-Path $toolsRoot 'release-download.json'
Get-PublicFile $releaseApi $metadataPath
$release = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'Expected an official stable release with a semantic version tag.'
}
$tag = [string]$release.tag_name
$stem = "tunnel-client-$tag-windows-$Architecture"
$directory = Join-Path $toolsRoot "$tag-$Architecture"
Assert-PlainDirectory $directory
[void](New-Item -ItemType Directory -Path $directory -Force)
$assetNames = @('SHA256SUMS.txt', "$stem.zip", "$stem-licenses.txt", "$stem.spdx.json")
foreach ($name in $assetNames) {
    $assets = @($release.assets | Where-Object { $_.name -ceq $name })
    if ($assets.Count -ne 1) { throw "Release must contain exactly one $name asset." }
    $expectedUrl = "https://github.com/openai/tunnel-client/releases/download/$tag/$name"
    if ($assets[0].browser_download_url -cne $expectedUrl) { throw "Unexpected asset origin for $name" }
    Write-Host "Downloading $name"
    # The public asset API redirects to the official release CDN and also works
    # on networks where github.com release page downloads time out.
    $assetApi = [string]$assets[0].url
    if ($assetApi -notmatch '^https://api\.github\.com/repos/openai/tunnel-client/releases/assets/[0-9]+$') {
        throw "Unexpected asset API origin for $name"
    }
    Get-PublicFile $assetApi (Join-Path $directory $name) 'application/octet-stream'
}

$checksums = @{}
foreach ($line in (Get-Content -LiteralPath (Join-Path $directory 'SHA256SUMS.txt'))) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
        $entryName = $Matches[2].Trim()
        if ($checksums.ContainsKey($entryName)) { throw "Duplicate checksum entry: $entryName" }
        $checksums[$entryName] = $Matches[1].ToLowerInvariant()
    }
}
foreach ($name in $assetNames | Where-Object { $_ -ne 'SHA256SUMS.txt' }) {
    if (-not $checksums.ContainsKey($name)) { throw "Missing SHA256SUMS entry for $name; refusing installation." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $directory $name)).Hash.ToLowerInvariant()
    if ($actual -cne $checksums[$name]) { throw "SHA256 mismatch for $name; refusing installation." }
}

$extractPath = Join-Path $directory 'bin'
Assert-PlainDirectory $extractPath
[void](New-Item -ItemType Directory -Path $extractPath -Force)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $directory "$stem.zip"))
try {
    $seen = @{}
    foreach ($entry in $archive.Entries) {
        $member = $entry.FullName.Replace('/', '\')
        if ([IO.Path]::IsPathRooted($member) -or $member.Contains(':')) { throw "Unsafe archive member: $member" }
        $destination = [IO.Path]::GetFullPath((Join-Path $extractPath $member))
        if (-not $destination.StartsWith($extractPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Archive member escapes extraction directory: $member"
        }
        if ($seen.ContainsKey($destination)) { throw "Duplicate archive destination: $member" }
        $seen[$destination] = $true
        $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($unixType -notin @(0, 0x8000, 0x4000)) { throw "Non-regular archive member: $member" }
        Assert-PlainDirectory (Split-Path -Parent $destination)
        if (Test-Path -LiteralPath $destination) {
            if (((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing extraction over a reparse point: $destination"
            }
        }
    }
} finally { $archive.Dispose() }
Expand-Archive -LiteralPath (Join-Path $directory "$stem.zip") -DestinationPath $extractPath -Force
$executables = @(Get-ChildItem -LiteralPath $extractPath -Filter 'tunnel-client.exe' -Recurse -File)
if ($executables.Count -ne 1) { throw 'Expected exactly one tunnel-client.exe in the verified archive.' }
$executable = $executables[0].FullName
$installed = [ordered]@{
    version = $tag
    architecture = $Architecture
    releaseUrl = [string]$release.html_url
    checkedAt = [DateTime]::UtcNow.ToString('o')
    executable = $executable
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant()
    archive = Join-Path $directory "$stem.zip"
    archiveSha256 = $checksums["$stem.zip"]
    verification = 'SHA256SUMS from the same official release; cryptographic provenance signature not verified.'
}
Copy-Item -LiteralPath $metadataPath -Destination (Join-Path $directory 'release.json') -Force
$installed | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $toolsRoot 'install.json') -Encoding UTF8
& $executable --version
if ($LASTEXITCODE -ne 0) { throw 'Installed client failed --version.' }
Write-Host "Installed: $executable"
Write-Host 'Archive, checksums, license report and SPDX sidecar retained beside the binary directory.'
Write-Host 'SHA256 integrity was verified against the official release; provenance signatures were not verified.'
