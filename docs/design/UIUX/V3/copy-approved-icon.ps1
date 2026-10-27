param(
    [string]$RepoRoot = 'F:\workplace\pi\SOXU'
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $RepoRoot 'apps\desktop\src\assets\soxu-256.png'
$destination = Join-Path $PSScriptRoot 'assets\soxu-approved-icon.png'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "SOXU approved icon not found: $source"
}
New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Host "Copied approved brand icon to: $destination"
