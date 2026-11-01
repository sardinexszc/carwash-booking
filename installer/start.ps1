# Starts a Cloudflare quick tunnel, then n8n with the tunnel as its public webhook URL
# (Telegram needs HTTPS). Close this window to stop everything.
$ErrorActionPreference = 'Stop'
$host.UI.RawUI.WindowTitle = 'Carwash Booking - keep this window open'
$cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$log = Join-Path $PSScriptRoot 'tunnel.log'
$pidFile = Join-Path $PSScriptRoot 'tunnel.pid'

# Stop the tunnel from a previous run whose window was closed.
if (Test-Path $pidFile) {
  Stop-Process -Id (Get-Content $pidFile) -ErrorAction SilentlyContinue
  Remove-Item $pidFile
}
Remove-Item $log -ErrorAction SilentlyContinue

Write-Host 'Starting tunnel ...'
$tunnel = Start-Process cloudflared -ArgumentList 'tunnel', '--url', 'http://localhost:5678', '--logfile', "`"$log`"" -WindowStyle Hidden -PassThru
Set-Content $pidFile $tunnel.Id

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep -Milliseconds 500
  if ((Test-Path $log) -and ((Get-Content $log -Raw) -match 'https://[a-z0-9-]+\.trycloudflare\.com')) { $url = $Matches[0] }
}
if (-not $url) {
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  throw "Tunnel did not start. Check your internet, or see $log"
}
Write-Host "Public URL: $url"

$env:WEBHOOK_URL = "$url/"
$env:GENERIC_TIMEZONE = $cfg.timezone
$env:TZ = $cfg.timezone
Start-Job { Start-Sleep 20; Start-Process 'http://localhost:5678' } | Out-Null

try {
  n8n start
} finally {
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
