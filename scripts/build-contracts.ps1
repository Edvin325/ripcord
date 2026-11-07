# Builds the three contracts into evidence-ready wasm under target\near\.
# One job at a time: this laptop has little free memory and link-time optimisation is heavy.
param([string[]]$Contracts = @('ripcord', 'endowment', 'test-usdc'))
$ErrorActionPreference = 'Continue'
. "$env:USERPROFILE\dev-tools\env.ps1"
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_INCREMENTAL = '0'
$root = Split-Path -Parent $PSScriptRoot
foreach ($c in $Contracts) {
  $started = Get-Date
  Write-Output "=== building $c at $($started.ToString('HH:mm:ss')) ==="
  $dir = Join-Path $root "contracts\$c"
  Push-Location $dir
  cmd /c "cargo near build non-reproducible-wasm --no-abi 2>&1" | Select-Object -Last 12
  $code = $LASTEXITCODE
  Pop-Location
  Write-Output ("=== {0} exit={1} took {2}s ===" -f $c, $code, [int]((Get-Date) - $started).TotalSeconds)
}
Get-ChildItem (Join-Path $root 'target\near') -Recurse -Filter '*.wasm' -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize -Wrap
