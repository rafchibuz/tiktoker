$ErrorActionPreference = 'Stop'
$projectDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $projectDir '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

# Public upstream releases only; no browser cookies or Twitch credentials.
$downloader = Join-Path $runtimeDir 'yt-dlp.exe'
$sumFile = Join-Path $runtimeDir 'yt-dlp-SHA2-256SUMS'
Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $downloader
Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS' -OutFile $sumFile
$expected = ((Get-Content -LiteralPath $sumFile | Where-Object { $_ -match '\s+yt-dlp\.exe$' }) -split '\s+')[0]
if (-not $expected -or (Get-FileHash -LiteralPath $downloader -Algorithm SHA256).Hash -ne $expected) { throw 'yt-dlp checksum mismatch' }

$archive = Join-Path $runtimeDir 'ffmpeg.zip'
$archiveSum = Join-Path $runtimeDir 'ffmpeg.zip.sha256'
Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $archive
Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256' -OutFile $archiveSum
$expected = ((Get-Content -LiteralPath $archiveSum -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'FFmpeg checksum mismatch' }
$unpacked = Join-Path $runtimeDir 'ffmpeg-package'
Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
foreach ($name in @('ffmpeg.exe','ffprobe.exe')) {
  $found = Get-ChildItem -LiteralPath $unpacked -Filter $name -Recurse | Select-Object -First 1
  if (-not $found) { throw "Missing $name in archive" }
  Copy-Item -LiteralPath $found.FullName -Destination (Join-Path $runtimeDir $name)
}
& $downloader --version
& (Join-Path $runtimeDir 'ffmpeg.exe') -version | Select-Object -First 1
Write-Output 'Media tools installed locally in .runtime; no PATH changes.'
