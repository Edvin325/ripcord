# Speaks each line of a JSON file ({"name": "words", ...}) into its own WAV file, with a voice
# built into Windows. record-demo.mjs uses it for the demo's narration. Windows only.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File voice.ps1 -Lines lines.json -Out folder [-Voice Heera] [-Rate 0.9]
param(
  [Parameter(Mandatory = $true)] [string] $Lines,
  [Parameter(Mandatory = $true)] [string] $Out,
  [string] $Voice = 'Heera',
  [double] $Rate = 0.9
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

# Windows' speech engine only answers asynchronously, so wait on each call.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
  Select-Object -First 1
function Await($operation, [type] $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait() | Out-Null
  $task.Result
}

$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$chosen = $all | Where-Object { $_.DisplayName -like "*$Voice*" } | Select-Object -First 1
if (-not $chosen) { throw "No voice matching '$Voice'. Installed: $(($all | ForEach-Object { $_.DisplayName }) -join ', ')" }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $chosen
$synth.Options.SpeakingRate = $Rate
$synth.Options.AppendedSilence = [Windows.Media.SpeechSynthesis.SpeechAppendedSilence]::Min

$items = Get-Content -Raw -Encoding UTF8 -LiteralPath $Lines | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Out | Out-Null
foreach ($line in $items.PSObject.Properties) {
  $stream = Await ($synth.SynthesizeTextToStreamAsync($line.Value)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $reader = New-Object Windows.Storage.Streams.DataReader ($stream.GetInputStreamAt(0))
  $size = [uint32] $stream.Size
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes((Join-Path $Out "$($line.Name).wav"), $bytes)
  $reader.Dispose()
  $stream.Dispose()
}
Write-Output "$($chosen.DisplayName): $(@($items.PSObject.Properties).Count) lines"
