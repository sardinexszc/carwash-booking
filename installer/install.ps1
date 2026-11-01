# Carwash Booking installer (Windows 10/11).
# Installs Node.js, n8n and cloudflared, imports the credentials and workflows into n8n,
# and adds a "Carwash Booking" desktop shortcut. Safe to run again to change settings.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$app = Join-Path $env:LOCALAPPDATA 'CarwashBooking'
New-Item -ItemType Directory -Force $app | Out-Null

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Install-IfMissing($cmd, $wingetId) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "  ${cmd}: already installed"; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store, then run install.cmd again."
  }
  Write-Host "  Installing $wingetId ..."
  winget install -e --id $wingetId --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "$cmd still not found after installing. Close this window and run install.cmd again."
  }
}

function Ask($question, $default) {
  $prompt = if ($default) { "$question [$default]" } else { $question }
  $answer = Read-Host $prompt
  if ($answer) { $answer.Trim() } else { $default }
}

function Write-Utf8($path, $text) {
  # No BOM: n8n's JSON parser rejects it.
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}

if (Get-NetTCPConnection -LocalPort 5678 -State Listen -ErrorAction SilentlyContinue) {
  throw 'n8n is running. Close the "Carwash Booking" window first, then run install.cmd again.'
}

Write-Host "`n== 1/5 Installing software =="
Install-IfMissing node 'OpenJS.NodeJS.LTS'
Install-IfMissing cloudflared 'Cloudflare.cloudflared'
if (Get-Command n8n -ErrorAction SilentlyContinue) {
  Write-Host '  n8n: already installed'
} else {
  Write-Host '  Installing n8n (a few minutes) ...'
  npm install -g n8n
  if ($LASTEXITCODE) { throw "npm install -g n8n failed (see above). n8n needs a supported Node.js version; check 'node -v' against docs.n8n.io." }
  Refresh-Path
}

Write-Host "`n== 2/5 Your details (press Enter to keep the value in brackets) =="
$cfgPath = Join-Path $app 'config.json'
$old = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { $null }
$first = -not $old

$sheetUrl = Ask 'Google Sheet URL (the form responses spreadsheet)' $old.sheetUrl
if ($sheetUrl -match '/d/([\w-]+)') { $sheetId = $Matches[1] } elseif ($sheetUrl -match '^[\w-]{20,}$') { $sheetId = $sheetUrl } else { throw 'That does not look like a Google Sheet URL.' }
$tab = Ask 'Sheet tab name' $(if ($old.tab) { $old.tab } else { 'Form Responses 1' })
$owner = Ask 'Owner Telegram chat ID (get it from @userinfobot)' $old.ownerChatId
if ($owner -notmatch '^-?\d+$') { throw 'Chat ID must be a number, e.g. 123456789 (groups start with -).' }
$tz = Ask 'Timezone' $(if ($old.timezone) { $old.timezone } else { 'Asia/Manila' })

$tokenHint = if ($first) { 'Telegram bot token from @BotFather' } else { 'Telegram bot token (Enter = keep current)' }
$token = (Read-Host $tokenHint).Trim()
if ($first -and -not $token) { throw 'Bot token is required.' }
$keyHint = if ($first) { 'Path to Google service account key file (.json)' } else { 'Path to Google service account key file (Enter = keep current)' }
$keyPath = (Read-Host $keyHint).Trim('"', ' ')
if ($first -and -not $keyPath) { throw 'Service account key file is required.' }

$cfg = [ordered]@{ sheetUrl = $sheetUrl; tab = $tab; ownerChatId = $owner; timezone = $tz; serviceAccount = $old.serviceAccount }

Write-Host "`n== 3/5 Saving credentials into n8n =="
$creds = @()
if ($token) {
  $creds += @{ id = 'carwashTelegram1'; name = 'Carwash Telegram Bot'; type = 'telegramApi'; data = @{ accessToken = $token } }
}
if ($keyPath) {
  $key = Get-Content $keyPath -Raw | ConvertFrom-Json
  if (-not $key.client_email -or -not $key.private_key) { throw 'Key file has no client_email/private_key. Download a JSON key for a service account.' }
  $creds += @{ id = 'carwashGoogle001'; name = 'Carwash Google Service Account'; type = 'googleApi'; data = @{ email = $key.client_email; privateKey = $key.private_key } }
  $cfg.serviceAccount = $key.client_email
}
if ($creds.Count) {
  # The temp file holds the bot token and private key in plain text: delete it right after import.
  $tmp = Join-Path $app 'credentials.tmp.json'
  try {
    Write-Utf8 $tmp (ConvertTo-Json -InputObject $creds -Depth 5)
    n8n import:credentials --input="$tmp"
    if ($LASTEXITCODE) { throw 'Credential import failed (see above).' }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
} else {
  Write-Host '  Keeping existing credentials.'
}
Write-Utf8 $cfgPath ($cfg | ConvertTo-Json)

Write-Host "`n== 4/5 Importing workflows =="
$wfDir = Join-Path $app 'workflows'
New-Item -ItemType Directory -Force $wfDir | Out-Null
$tabJson = ConvertTo-Json -InputObject $tab
foreach ($f in Get-ChildItem (Join-Path $root 'workflows') -Filter *.json) {
  $text = [IO.File]::ReadAllText($f.FullName)
  $text = $text.Replace('OWNER_CHAT_ID', $owner).Replace('"SHEET_ID"', "`"$sheetId`"").Replace('"Form Responses 1"', $tabJson)
  Write-Utf8 (Join-Path $wfDir $f.Name) $text
}
n8n import:workflow --separate --input="$wfDir"
if ($LASTEXITCODE) { throw 'Workflow import failed (see above).' }
n8n update:workflow --all --active=true
$activated = -not $LASTEXITCODE

Write-Host "`n== 5/5 Desktop shortcut =="
Copy-Item (Join-Path $PSScriptRoot 'start.ps1') $app -Force
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Carwash Booking.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = 'powershell.exe'
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$app\start.ps1`""
$s.WorkingDirectory = $app
$s.Save()
Write-Host "  Created $lnk"

Write-Host "`n== Done. Remaining steps =="
Write-Host "1. Share your Google Sheet with $($cfg.serviceAccount) as Editor."
Write-Host '2. Double-click "Carwash Booking" on the desktop. Keep that window open while the shop is open.'
Write-Host '3. First time only: n8n opens in the browser - create your n8n login.'
if (-not $activated) { Write-Host '4. In n8n, open each "Carwash" workflow and switch it to Active/Published.' }
