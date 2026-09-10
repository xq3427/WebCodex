#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$FixtureWorker,
    [string]$FixtureRoot,
    [string]$NodePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-StartEqual($Actual, $Expected, [string]$Label) {
    if ($Actual -cne $Expected) { throw "$Label failed (values omitted)." }
    $script:checks++
}

if ($FixtureWorker) {
    # This branch runs only in the clean child environment created below. There
    # is no inherited account key, user config, or live tunnel fixture.
    if ([IO.Path]::GetFileName($FixtureRoot) -notmatch '^webcodex-start-tunnel-test-[a-f0-9]{32}$' -or
        $env:WEBCODEX_START_TEST_WORKER -cne 'isolated-synthetic-fixture') { throw 'Invalid fixture worker context.' }
    $script:checks = 0
    $launcher = Join-Path $FixtureRoot 'scripts\start-tunnel.ps1'
    $privateRoot = Join-Path $FixtureRoot '.webcodex\private'
    $defaultFile = Join-Path $privateRoot 'tunnel-auth.json'
    $explicitFile = Join-Path $privateRoot 'alternate.json'
    $logPath = Join-Path $FixtureRoot 'fake-tunnel-observations.jsonl'
    $env:WEBCODEX_TEST_LOG = $logPath
    $env:CONTROL_PLANE_API_KEY = 'synthetic-env-key'
    $env:CONTROL_PLANE_HTTP_PROXY = 'synthetic-proxy-setting'
    $env:MCP_COMMAND = 'synthetic-command-setting'
    $env:OPENAI_API_KEY = 'synthetic-unrelated-key'
    $env:LOG_HTTP_RAW_UNSAFE = 'synthetic-log-setting'
    $env:WEBCODEX_TEST_TUNNEL_DOCTOR_EXIT = '0'
    $env:WEBCODEX_TEST_LOCAL_DOCTOR_EXIT = '0'
    $tracked = @('CONTROL_PLANE_API_KEY', 'CONTROL_PLANE_HTTP_PROXY', 'MCP_COMMAND', 'OPENAI_API_KEY', 'LOG_HTTP_RAW_UNSAFE')
    function Read-Host { throw 'Unexpected interactive prompt in offline test.' }
    function Write-TestCredential([string]$Path, [string]$Key) {
        @{ api_key = $Key } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
    }
    function Invoke-TestLauncher {
        param([hashtable]$Extra = @{}, [bool]$ShouldFail = $false, [int]$ExpectedCalls = 1, [string]$Label)
        [IO.File]::WriteAllText($logPath, '')
        $before = @{}
        foreach ($name in $tracked) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        $arguments = @{
            TunnelId = 'tunnel_synthetic_offline_test'; NodePath = $NodePath
            NoPrompt = $true; DoctorOnly = $true
        }
        foreach ($name in $Extra.Keys) { $arguments[$name] = $Extra[$name] }
        $failed = $false; $outputText = ''
        try { $captured = @(& $launcher @arguments 6>&1); $outputText = ($captured | Out-String) }
        catch {
            $failed = $true; $outputText = $_.ToString()
            if (-not $ShouldFail) {
                $safeError = $outputText -replace 'synthetic-(env|default|explicit|unrelated)-key', '[synthetic key omitted]'
                [Console]::Error.WriteLine("Unexpected fixture error: " + $safeError + "`n" + $_.ScriptStackTrace)
            }
        }
        Assert-StartEqual $failed $ShouldFail "$Label outcome"
        Assert-StartEqual ($outputText -match 'synthetic-(env|default|explicit|unrelated)-key') $false "$Label no key output"
        foreach ($name in $tracked) {
            Assert-StartEqual ([Environment]::GetEnvironmentVariable($name, 'Process')) $before[$name] "$Label restores $name"
        }
        $observations = @(Get-Content -LiteralPath $logPath | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
        Assert-StartEqual $observations.Count $ExpectedCalls "$Label invocation count"
        foreach ($observation in $observations) {
            Assert-StartEqual $observation.keyMatched $true "$Label chosen key"
            Assert-StartEqual $observation.keyInArguments $false "$Label excludes plaintext argv"
            Assert-StartEqual $observation.envReferenceOnly $true "$Label env reference flag"
            Assert-StartEqual $observation.otherManagedSettingsCleared $true "$Label clears unrelated settings"
        }
        return ,$observations
    }

    Write-TestCredential $defaultFile 'synthetic-default-key'
    Write-TestCredential $explicitFile 'synthetic-explicit-key'
    $env:WEBCODEX_TEST_EXPECTED_KEY = 'synthetic-default-key'
    $calls = Invoke-TestLauncher -Extra @{ DoctorOnly = $false } -ExpectedCalls 2 -Label 'default file before environment'
    Assert-StartEqual $calls[0].verb 'doctor' 'doctor precedes run'
    Assert-StartEqual $calls[1].verb 'run' 'run uses same file key'

    $env:WEBCODEX_TEST_EXPECTED_KEY = 'synthetic-explicit-key'
    [void](Invoke-TestLauncher -Extra @{ ApiKeyConfig = $explicitFile } -Label 'explicit file before default and environment')
    Push-Location -LiteralPath $FixtureRoot
    try { [void](Invoke-TestLauncher -Extra @{ ApiKeyConfig = '.webcodex/private/alternate.json' } -Label 'explicit relative file from caller directory') }
    finally { Pop-Location }
    [void](Invoke-TestLauncher -Extra @{ ApiKeyConfig = (Join-Path $privateRoot 'missing.json') } -ShouldFail $true -ExpectedCalls 0 -Label 'explicit missing has no fallback')
    Set-Content -LiteralPath $explicitFile -Value '{ invalid JSON' -Encoding UTF8
    [void](Invoke-TestLauncher -Extra @{ ApiKeyConfig = $explicitFile } -ShouldFail $true -ExpectedCalls 0 -Label 'explicit invalid has no fallback')
    [void](Invoke-TestLauncher -Extra @{ ApiKeyConfig = '' } -ShouldFail $true -ExpectedCalls 0 -Label 'explicit empty path has no fallback')
    $outsideFile = Join-Path $FixtureRoot 'outside-private.json'
    Write-TestCredential $outsideFile 'synthetic-explicit-key'
    [void](Invoke-TestLauncher -Extra @{ ApiKeyConfig = $outsideFile } -ShouldFail $true -ExpectedCalls 0 -Label 'explicit file outside protected directory')

    Set-Content -LiteralPath $defaultFile -Value '{ invalid JSON' -Encoding UTF8
    [void](Invoke-TestLauncher -ShouldFail $true -ExpectedCalls 0 -Label 'default invalid has no environment fallback')
    Write-TestCredential $defaultFile ''
    [void](Invoke-TestLauncher -ShouldFail $true -ExpectedCalls 0 -Label 'default empty key has no environment fallback')
    Remove-Item -LiteralPath $defaultFile
    $env:WEBCODEX_TEST_EXPECTED_KEY = 'synthetic-env-key'
    [void](Invoke-TestLauncher -Label 'NoPrompt environment compatibility')
    [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $null, 'Process')
    [void](Invoke-TestLauncher -ShouldFail $true -ExpectedCalls 0 -Label 'NoPrompt missing key restores environment')
    Write-TestCredential $defaultFile 'synthetic-default-key'
    $env:WEBCODEX_TEST_EXPECTED_KEY = 'synthetic-default-key'
    [void](Invoke-TestLauncher -Label 'file key leaves absent caller environment absent')

    $env:CONTROL_PLANE_API_KEY = 'synthetic-env-key'
    Write-TestCredential $defaultFile 'synthetic-default-key'
    $env:WEBCODEX_TEST_EXPECTED_KEY = 'synthetic-default-key'
    $env:WEBCODEX_TEST_TUNNEL_DOCTOR_EXIT = '7'
    [void](Invoke-TestLauncher -Extra @{ DoctorOnly = $false } -ShouldFail $true -ExpectedCalls 1 -Label 'tunnel doctor failure restores environment and skips run')
    $env:WEBCODEX_TEST_TUNNEL_DOCTOR_EXIT = '0'
    $env:WEBCODEX_TEST_LOCAL_DOCTOR_EXIT = '9'
    [void](Invoke-TestLauncher -ShouldFail $true -ExpectedCalls 0 -Label 'local doctor failure preserves environment')
    Write-Output ("Tunnel launcher: $checks checks passed (isolated process, synthetic keys, inert tunnel fixture).")
    exit 0
}

$sourceRoot = $PSScriptRoot
$helperPath = Join-Path $sourceRoot 'tunnel-auth.ps1'
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw 'scripts/tunnel-auth.ps1 must exist before running the launcher tests.' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('webcodex-start-tunnel-test-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($relative in @('scripts', 'dist\src', '.webcodex\private', '.webcodex\tools\tunnel-client')) {
        [void](New-Item -ItemType Directory -Path (Join-Path $temporary $relative) -Force)
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'start-tunnel.ps1') -Destination (Join-Path $temporary 'scripts\start-tunnel.ps1')
    Copy-Item -LiteralPath $helperPath -Destination (Join-Path $temporary 'scripts\tunnel-auth.ps1')
    [IO.File]::WriteAllText((Join-Path $temporary '.webcodex\config.json'), '{}')
    [IO.File]::WriteAllText((Join-Path $temporary 'dist\src\cli.js'), "process.exit(Number(process.env.WEBCODEX_TEST_LOCAL_DOCTOR_EXIT || '0'));`n")
    $fakeTunnel = Join-Path $temporary '.webcodex\tools\tunnel-client\fake-tunnel.ps1'
    $fakeSource = @'
# This inert fixture never opens sockets or starts a daemon.
$items = @($args)
$keyFlagIndex = [Array]::IndexOf($items, '--control-plane.api-key')
$onlyReference = $keyFlagIndex -ge 0 -and ($keyFlagIndex + 1) -lt $items.Count -and $items[$keyFlagIndex + 1] -ceq 'env:CONTROL_PLANE_API_KEY'
$otherManaged = @(Get-ChildItem Env: | Where-Object {
    $_.Name -match '^(CONTROL_PLANE_|MCP_|HARPOON_|CLOUDFLARED_|TUNNEL_CLIENT_|HEALTH_|LOG_|ADMIN_UI_|OPENAI_API_KEY$|OPENAI_ADMIN_KEY$|ALLOW_REMOTE_UI$|OPEN_WEB_UI$|PID_FILE$)' -and
    $_.Name -cne 'CONTROL_PLANE_API_KEY'
})
[pscustomobject]@{
    verb = $items[0]
    keyMatched = ($env:CONTROL_PLANE_API_KEY -ceq $env:WEBCODEX_TEST_EXPECTED_KEY)
    keyInArguments = [bool](@($items | Where-Object { $_ -match 'synthetic-(env|default|explicit|unrelated)-key' }).Count)
    envReferenceOnly = $onlyReference
    otherManagedSettingsCleared = ($otherManaged.Count -eq 0)
} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:WEBCODEX_TEST_LOG -Encoding UTF8
if ($items[0] -eq 'doctor') { exit ([int]$env:WEBCODEX_TEST_TUNNEL_DOCTOR_EXIT) }
exit 0
'@
    [IO.File]::WriteAllText($fakeTunnel, $fakeSource, (New-Object Text.UTF8Encoding($true)))
    @{ executable = $fakeTunnel; executableSha256 = (Get-FileHash -LiteralPath $fakeTunnel -Algorithm SHA256).Hash.ToLowerInvariant() } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $temporary '.webcodex\tools\tunnel-client\install.json') -Encoding UTF8

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $PSHOME 'powershell.exe'
    $startInfo.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -FixtureWorker -FixtureRoot "' + $temporary + '" -NodePath "' + $NodePath + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = $temporary
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # Deliberately discard every inherited environment variable. Only these
    # non-secret Windows runtime values and a fixture marker enter the worker.
    $startInfo.EnvironmentVariables.Clear()
    $startInfo.EnvironmentVariables['SystemRoot'] = [Environment]::GetFolderPath('Windows')
    $startInfo.EnvironmentVariables['SystemDrive'] = [IO.Path]::GetPathRoot($startInfo.EnvironmentVariables['SystemRoot']).TrimEnd('\')
    $startInfo.EnvironmentVariables['TEMP'] = [IO.Path]::GetTempPath()
    $startInfo.EnvironmentVariables['TMP'] = [IO.Path]::GetTempPath()
    $startInfo.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
    $startInfo.EnvironmentVariables['WEBCODEX_START_TEST_WORKER'] = 'isolated-synthetic-fixture'
    $worker = New-Object Diagnostics.Process
    $worker.StartInfo = $startInfo
    [void]$worker.Start()
    $stdoutTask = $worker.StandardOutput.ReadToEndAsync()
    $stderrTask = $worker.StandardError.ReadToEndAsync()
    if (-not $worker.WaitForExit(45000)) { $worker.Kill(); $worker.WaitForExit(); throw 'Offline launcher test worker timed out.' }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $worker.ExitCode
    $worker.Dispose()
    if ($stdout) { Write-Output $stdout.TrimEnd() }
    if ($exitCode -ne 0) { throw ('Offline launcher tests failed. ' + $stderr.TrimEnd()) }
} finally {
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $resolvedTestPath = [IO.Path]::GetFullPath($temporary)
    if (-not $resolvedTestPath.StartsWith($resolvedTempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTestPath) -notmatch '^webcodex-start-tunnel-test-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolvedTestPath) { Remove-Item -LiteralPath $resolvedTestPath -Recurse -Force }
}
