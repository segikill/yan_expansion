param(
  [string]$Version = "1.13.2"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "release"
$tempBase = [System.IO.Path]::GetTempPath()
$buildRoot = Join-Path $tempBase "maps-export-overlay-cws-build-$Version"
$stageRoot = Join-Path $buildRoot "extension"
$zipPath = Join-Path $releaseRoot "maps-export-overlay-$Version-private.zip"

$releaseFull = [System.IO.Path]::GetFullPath($releaseRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$tempBaseFull = [System.IO.Path]::GetFullPath($tempBase).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$buildFull = [System.IO.Path]::GetFullPath($buildRoot)
$stageFull = [System.IO.Path]::GetFullPath($stageRoot)
$zipFull = [System.IO.Path]::GetFullPath($zipPath)
if (-not $buildFull.StartsWith($tempBaseFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe build path: $buildFull"
}
if (-not $stageFull.StartsWith($buildFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe staging path: $stageFull"
}
if (-not $zipFull.StartsWith($releaseFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe ZIP path: $zipFull"
}

$manifest = Get-Content -LiteralPath (Join-Path $projectRoot "manifest.json") -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) {
  throw "Manifest version $($manifest.version) does not match requested version $Version"
}

$files = @(
  "manifest.json",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "popup.html",
  "popup.js",
  "instructions.html",
  "privacy.html",
  "background.js",
  "content.js",
  "overlay.js",
  "google_content.js",
  "travel_parser.js",
  "travel_content.js",
  "yandex_coordinates.js",
  "detail_parser.js",
  "detail_content.js",
  "two_gis_detail_parser.js",
  "two_gis_detail_content.js",
  "two_gis_detail_bridge.js",
  "sniffer.js",
  "interceptor.js",
  "enrichment.html",
  "enrichment.css",
  "enrichment.js",
  "enrichment-summary.html",
  "enrichment-summary.js",
  "xlsx.full.min.js",
  "THIRD_PARTY_NOTICES.md"
)

Add-Type -AssemblyName System.Drawing
foreach ($size in (16, 32, 48, 128)) {
  $iconPath = Join-Path $projectRoot "icons/icon-$size.png"
  if (-not (Test-Path -LiteralPath $iconPath)) {
    throw "Required icon is missing: icons/icon-$size.png"
  }
  $image = [System.Drawing.Image]::FromFile($iconPath)
  try {
    if ($image.Width -ne $size -or $image.Height -ne $size) {
      throw "Icon icons/icon-$size.png has invalid dimensions $($image.Width)x$($image.Height)"
    }
  }
  finally {
    $image.Dispose()
  }
}

if (Test-Path -LiteralPath $buildRoot) {
  Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
foreach ($file in $files) {
  $source = Join-Path $projectRoot $file
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Required release file is missing: $file"
  }
  $destination = Join-Path $stageRoot $file
  $destinationParent = Split-Path -Parent $destination
  if (-not (Test-Path -LiteralPath $destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }
  Copy-Item -LiteralPath $source -Destination $destination
}

Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = @($archive.Entries | ForEach-Object FullName)
  if ($names -notcontains "manifest.json") {
    throw "manifest.json is not located at the ZIP root"
  }
  $forbidden = @($names | Where-Object { $_ -match '(^|/)(\.git|tests|release)(/|$)' -or $_ -match '\.(xlsx|xls|csv)$' })
  if ($forbidden.Count) {
    throw "Forbidden release entries: $($forbidden -join ', ')"
  }
}
finally {
  $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Remove-Item -LiteralPath $buildRoot -Recurse -Force
Write-Output "Created: $zipPath"
Write-Output "SHA256: $hash"
