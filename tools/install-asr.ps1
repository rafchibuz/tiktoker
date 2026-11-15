$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$whisperExe = Join-Path $runtimeDir 'whisper-bin\Release\whisper-cli.exe'
if (-not (Test-Path -LiteralPath $whisperExe)) {
  $zip = Join-Path $runtimeDir 'whisper-bin-x64.zip'
  Invoke-WebRequest -Uri 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' -OutFile $zip -TimeoutSec 180
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $runtimeDir 'whisper-bin') -Force
}
if (-not (Test-Path -LiteralPath $whisperExe)) { throw 'whisper-cli.exe отсутствует после распаковки' }

$model = Join-Path $runtimeDir 'ggml-small.bin'
if (-not (Test-Path -LiteralPath $model) -or (Get-Item -LiteralPath $model).Length -ne 487601967) {
  $partial = Join-Path $runtimeDir 'ggml-small.bin.partial'
  Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' -OutFile $partial -TimeoutSec 600
  if ((Get-Item -LiteralPath $partial).Length -ne 487601967) { throw 'Модель Whisper скачана не полностью' }
  Move-Item -LiteralPath $partial -Destination $model -Force
}
Write-Host 'Локальное распознавание речи готово.'
