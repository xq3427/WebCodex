#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tunnel-auth.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('webcodex-auth-test-' + [guid]::NewGuid().ToString('N'))
$privateRoot = Join-Path $testRoot 'private'
$outsideRoot = Join-Path $testRoot 'outside'
$configPath = Join-Path $privateRoot 'tunnel-auth.json'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$bomUtf8 = [Text.UTF8Encoding]::new($true, $true)
$syntheticKey = 'synthetic-TEST-only-never-a-real-credential'
$checks = 0

function Assert-AuthFailure {
    param([string]$File = $configPath)
    $failed = $false
    try { $null = Read-WebCodexTunnelApiKey -Path $File -PrivateRoot $privateRoot }
    catch {
        $failed = $true
        $message = $_.Exception.Message
        if ($message -notlike 'Tunnel API key file could not be read or validated.*' -or $message.Contains($syntheticKey)) { throw 'An authentication failure did not produce a static redacted error.' }
    }
    if (-not $failed) { throw 'An invalid authentication fixture was accepted.' }
    $script:checks++
}

try {
    $null = [IO.Directory]::CreateDirectory($privateRoot)
    $null = [IO.Directory]::CreateDirectory($outsideRoot)
    foreach ($encoding in @($utf8, $bomUtf8)) {
        [IO.File]::WriteAllText($configPath, ('{"api_key":"  ' + $syntheticKey + '  "}'), $encoding)
        $result = @(Read-WebCodexTunnelApiKey -Path $configPath -PrivateRoot $privateRoot)
        if ($result.Count -ne 1 -or $result[0] -cne $syntheticKey) { throw 'Valid UTF-8 authentication data was not returned exactly once.' }
        $checks++
    }
    [IO.File]::WriteAllText($configPath, '{"api_key":"synthetic\u002dTEST"}', $utf8)
    if ((Read-WebCodexTunnelApiKey -Path $configPath -PrivateRoot $privateRoot) -cne 'synthetic-TEST') { throw 'JSON string escaping was not decoded.' }
    $checks++

    $invalidJson = @(
        ('{"api_key":"' + $syntheticKey),
        '{"api_key":123}', '{"api_key":null}', '{"api_key":true}', '{"api_key":[]}',
        '{"api_key":""}', '{"api_key":" \t\r\n "}',
        ('{"api_key":"' + $syntheticKey + ' embedded"}'),
        ('{"api_key":"' + $syntheticKey + '\u0000"}'),
        ('{"api_key":"' + $syntheticKey + '\nembedded"}'),
        ('{"api_key":"' + $syntheticKey + '\u200b"}'),
        ('{"api_key":"' + ('a' * 4097) + '"}'),
        ('{"api_key":"' + $syntheticKey + '","extra":"' + $syntheticKey + '"}'),
        ('{"API_KEY":"' + $syntheticKey + '"}'),
        ('{"api_key":"' + $syntheticKey + '","api_key":"other"}'),
        ('[{"api_key":"' + $syntheticKey + '"}]')
    )
    foreach ($json in $invalidJson) {
        [IO.File]::WriteAllText($configPath, $json, $utf8)
        Assert-AuthFailure
    }
    [IO.File]::WriteAllText($configPath, (' ' * 16385), $utf8)
    Assert-AuthFailure
    [IO.File]::WriteAllBytes($configPath, [byte[]]@(0xFF, 0xFE, 0xFF))
    Assert-AuthFailure
    $outsideFile = Join-Path $outsideRoot 'outside.json'
    [IO.File]::WriteAllText($outsideFile, ('{"api_key":"' + $syntheticKey + '"}'), $utf8)
    Assert-AuthFailure -File $outsideFile
    Assert-AuthFailure -File (Join-Path $privateRoot '..\outside\outside.json')
    Assert-AuthFailure -File (Join-Path $privateRoot 'missing.json')
    Assert-AuthFailure -File $privateRoot

    $jump = Join-Path $privateRoot 'jump'
    $null = New-Item -ItemType Junction -Path $jump -Target $outsideRoot
    Assert-AuthFailure -File (Join-Path $jump 'outside.json')
    # Remove only the junction itself; never recurse through a linked fixture directory.
    [IO.Directory]::Delete($jump)
    Write-Output ('Tunnel authentication tests passed: ' + $checks + ' checks (synthetic fixtures only).')
} finally {
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $actualRoot = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($actualRoot) -eq $expectedParent -and [IO.Path]::GetFileName($actualRoot).StartsWith('webcodex-auth-test-')) {
        $remainingJunction = Join-Path $privateRoot 'jump'
        if ([IO.Directory]::Exists($remainingJunction) -and (([IO.File]::GetAttributes($remainingJunction) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { [IO.Directory]::Delete($remainingJunction) }
        if ([IO.Directory]::Exists($actualRoot)) { Remove-Item -LiteralPath $actualRoot -Recurse -Force }
    } else { throw 'Test cleanup refused an unexpected directory.' }
}
