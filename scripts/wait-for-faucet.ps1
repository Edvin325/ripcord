# Creates this project's testnet accounts once the NEAR faucet's rate limit resets.
# It waits for the reset, then makes one attempt every ten minutes. It never tries to get
# around the limit: a 429 simply means wait and try again later.
#
# It reuses the keys near-cli already saved in .near-credentials, so nothing new is stored.
param(
  [string]$ResetUtc = '2026-11-08T00:15:00Z',
  [int]$MaxHours = 6
)
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$suffix = (Get-Content (Join-Path $root 'wallets\suffix.txt')).Trim()
$names = "ripcord-$suffix", "rc-usdc-$suffix", "rc-fund-$suffix", "rc-borrower-$suffix", "rc-lender-$suffix", "rc-keeper-$suffix"
$credDir = Join-Path $env:USERPROFILE '.near-credentials\testnet'
$helper = 'https://helper.nearprotocol.com/account'
$rpc = 'https://test.rpc.fastnear.com'

function Say($m) { Write-Output ('[{0:u}] {1}' -f (Get-Date).ToUniversalTime(), $m) }

function Exists($id) {
  $body = @{ jsonrpc = '2.0'; id = 'x'; method = 'query'; params = @{ request_type = 'view_account'; finality = 'final'; account_id = $id } } | ConvertTo-Json -Depth 4
  try {
    $r = Invoke-RestMethod -Uri $rpc -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 20
    return [bool]$r.result.amount
  } catch { return $false }
}

$until = [DateTimeOffset]::Parse($ResetUtc).UtcDateTime
$wait = ($until - (Get-Date).ToUniversalTime()).TotalSeconds
if ($wait -gt 0) {
  Say "waiting $([int]($wait / 60)) minutes for the faucet reset"
  Start-Sleep -Seconds ([int]$wait)
}

$giveUp = (Get-Date).AddHours($MaxHours)
while ((Get-Date) -lt $giveUp) {
  $pending = $names | Where-Object { -not (Exists "$_.testnet") }
  if (-not $pending) { Say 'all accounts exist'; break }

  foreach ($name in $pending) {
    $id = "$name.testnet"
    $key = (Get-Content (Join-Path $credDir "$id.json") -Raw | ConvertFrom-Json).public_key
    $body = @{ newAccountId = $id; newAccountPublicKey = $key } | ConvertTo-Json
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $helper -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 60 -UserAgent 'near-cli-rs'
      Say "$id created (HTTP $($r.StatusCode))"
      Start-Sleep -Seconds 15
    } catch {
      Say "$id not created: $($_.Exception.Message)"
      break   # rate limited or down: stop this round and wait
    }
  }

  $still = $names | Where-Object { -not (Exists "$_.testnet") }
  if (-not $still) { Say 'all accounts exist'; break }
  Say "$($still.Count) still missing, next attempt in ten minutes"
  Start-Sleep -Seconds 600
}

$made = $names | Where-Object { Exists "$_.testnet" }
Say "finished with $($made.Count) of $($names.Count) accounts: $($made -join ', ')"
