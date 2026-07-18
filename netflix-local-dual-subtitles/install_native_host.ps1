<#
.SYNOPSIS
    Register the Chrome Native Messaging host on Windows.
.DESCRIPTION
    Creates the host manifest and registers it for the current Windows user.
    Load the unpacked extension first, then pass its 32-character ID.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install_native_host.ps1 abcdefghijklmnopabcdefghijklmnop
#>

#Requires -Version 5.1

if ($args.Count -ne 1) {
    Write-Error "Usage: powershell -ExecutionPolicy Bypass -File .\install_native_host.ps1 <extension-id>"
    exit 2
}

$extensionId = $args[0].Trim()
if ($extensionId -match '^chrome-extension://([a-p]{32})/?$') {
    $extensionId = $Matches[1]
}
if ($extensionId -notmatch '^[a-p]{32}$') {
    Write-Error "Invalid extension ID. Copy the 32-character ID from chrome://extensions."
    exit 2
}

$hostName = "com.netflix.local_dual_subtitles"
$origin = "chrome-extension://${extensionId}/"
$repoDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$hostLauncher = Join-Path $repoDir "native_host.cmd"
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
$manifestDir = Join-Path $localAppData "NetflixLocalDualSubtitles\NativeMessagingHosts"
$manifestPath = Join-Path $manifestDir "${hostName}.json"

if (-not (Test-Path -LiteralPath $hostLauncher -PathType Leaf)) {
    Write-Error "Windows host launcher not found: $hostLauncher"
    exit 1
}

try {
    New-Item -ItemType Directory -Path $manifestDir -Force -ErrorAction Stop | Out-Null

    $manifest = [ordered]@{
        name = $hostName
        description = "Netflix Local Dual Subtitles native host"
        path = $hostLauncher
        type = "stdio"
        allowed_origins = @($origin)
    }
    $json = $manifest | ConvertTo-Json -Depth 3
    $utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)

    $registryPath = "Software\Google\Chrome\NativeMessagingHosts\$hostName"
    $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
    if ($null -eq $registryKey) {
        throw "Unable to create registry key: HKCU\$registryPath"
    }
    try {
        $registryKey.SetValue("", $manifestPath, [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        $registryKey.Dispose()
    }
} catch {
    Write-Error "Failed to install Native Messaging host: $($_.Exception.Message)"
    exit 1
}

Write-Host "Native Messaging host installed."
Write-Host "Manifest: $manifestPath"
Write-Host "Registry: HKCU\$registryPath"
Write-Host "Reload the extension at chrome://extensions, then click the local-model start button."
