#requires -Version 5.1

function Read-WebCodexTunnelApiKey {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$PrivateRoot
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $stream = $null
    try {
        if (-not [IO.Path]::IsPathRooted($Path) -or -not [IO.Path]::IsPathRooted($PrivateRoot)) { throw 'invalid path' }
        $privatePath = [IO.Path]::GetFullPath($PrivateRoot).TrimEnd([char[]]@('\', '/'))
        $filePath = [IO.Path]::GetFullPath($Path)
        $privatePrefix = $privatePath + [IO.Path]::DirectorySeparatorChar
        if (-not $filePath.StartsWith($privatePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'outside private directory' }
        if (-not [IO.Directory]::Exists($privatePath)) { throw 'private directory missing' }

        # Check every component, including the configured private directory's ancestors.
        # Recheck after reading so a path changed to a junction is never accepted silently.
        $assertPath = {
            $volume = [IO.Path]::GetPathRoot($filePath)
            $current = $volume
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked path' }
            foreach ($component in $filePath.Substring($volume.Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
                if ($component.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $component -match '[. ]$') { throw 'invalid path component' }
                $current = [IO.Path]::Combine($current, $component)
                if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked path' }
            }
        }
        & $assertPath
        if (([IO.File]::GetAttributes($filePath) -band [IO.FileAttributes]::Directory) -ne 0) { throw 'not a file' }

        # FileShare.Read excludes cooperating writers while the bounded UTF-8 read is in progress.
        $stream = [IO.FileStream]::new($filePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $maxBytes = 16384
        if ($stream.Length -gt $maxBytes) { throw 'file too large' }
        $buffer = New-Object byte[] ($maxBytes + 1)
        $count = 0
        while ($count -lt $buffer.Length) {
            $read = $stream.Read($buffer, $count, $buffer.Length - $count)
            if ($read -eq 0) { break }
            $count += $read
        }
        if ($count -gt $maxBytes) { throw 'file too large' }
        & $assertPath
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $json = $utf8.GetString($buffer, 0, $count)
        if ($json.Length -gt 0 -and $json[0] -eq [char]0xFEFF) { $json = $json.Substring(1) }

        # A single string property also rules out duplicate/case-colliding JSON keys before
        # ConvertFrom-Json can collapse them. The field name must be the literal api_key.
        $format = '\A[ \t\r\n]*\{[ \t\r\n]*"api_key"[ \t\r\n]*:[ \t\r\n]*"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"[ \t\r\n]*\}[ \t\r\n]*\z'
        if (-not [Text.RegularExpressions.Regex]::IsMatch($json, $format)) { throw 'invalid JSON shape' }
        $parsed = ConvertFrom-Json -InputObject $json -ErrorAction Stop
        if ($parsed.api_key -isnot [string]) { throw 'invalid key type' }
        $key = $parsed.api_key.Trim()
        if ($key.Length -eq 0 -or $key.Length -gt 4096 -or $key -match '[\s\p{Cc}\p{Cf}]') { throw 'invalid key value' }
        return $key
    } catch {
        # Never forward parser/decoder exceptions: they can contain the supplied JSON or key.
        throw 'Tunnel API key file could not be read or validated. Use a regular UTF-8 JSON file under .webcodex/private containing only a non-empty api_key string, without embedded whitespace or control characters.'
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}
