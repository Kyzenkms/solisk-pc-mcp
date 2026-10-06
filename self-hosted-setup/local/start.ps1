<#
.SYNOPSIS
  PC Control MCP — Local Relay Start
  Starts the MCP server AND the relay server on the same Windows machine.
  No VPS, no domain, no Docker needed.
#>

param(
  [string]$DeviceName,
  [string]$ApiKey,
  [switch]$Headless
)

$ErrorActionPreference = "Stop"
$root = (Get-Item (Split-Path -Parent $PSScriptRoot)).Parent.FullName

# ── Generate defaults if not provided ──────────────────────────────────────────
if (-not $DeviceName) { $DeviceName = "$env:COMPUTERNAME-pc".ToLowerInvariant() -replace '[^a-z0-9-]','-' -replace '^-+|-+$','' }
if (-not $DeviceName) { $DeviceName = "my-pc" }
if (-not $ApiKey) {
  $buffer = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  $ApiKey = ($buffer | ForEach-Object { $_.ToString("x2") }) -join ""
}

$mcpPort = 3000
$relayPort = 3100
$relayUrl = "http://127.0.0.1:$relayPort"

# ── Check prerequisites ────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed. Install from https://nodejs.org" }
$modPath = Join-Path $root "node_modules"
if (-not (Test-Path -LiteralPath (Join-Path $modPath "@modelcontextprotocol\sdk\package.json"))) {
  Write-Host "Installing dependencies..." -ForegroundColor Yellow
  Push-Location $root
  npm install --no-audit --no-fund 2>&1 | Out-Null
  Pop-Location
}

$relayModPath = Join-Path $root "relay-server\node_modules"
if (-not (Test-Path -LiteralPath $relayModPath)) {
  Write-Host "Installing relay dependencies..." -ForegroundColor Yellow
  Push-Location (Join-Path $root "relay-server")
  npm install --no-audit --no-fund 2>&1 | Out-Null
  Pop-Location
}

# ── Write desktop config ───────────────────────────────────────────────────────
$config = [ordered]@{
  api_key = $ApiKey
  port = $mcpPort
  autostart = $true
  name = $DeviceName
  relay_url = $relayUrl
  quick_tunnel = $false
  allowed_paths = @()
  denied_paths = @("C:\Windows\System32", "C:\Windows\SysWOW64")
  permission_mode = "ask"
  ready = $true
}
$configJson = $config | ConvertTo-Json -Depth 8

$configDir = Join-Path $env:APPDATA "pc-control-mcp-desktop"
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$configPath = Join-Path $configDir "config.json"
if (Test-Path -LiteralPath $configPath) {
  $backup = "$configPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $configPath -Destination $backup
  Write-Host "Backed up existing config to $backup" -ForegroundColor DarkGray
}
[IO.File]::WriteAllText($configPath, $configJson, (New-Object Text.UTF8Encoding($false)))
Write-Host "Config written: $configPath" -ForegroundColor DarkGray

# ── Start relay server ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Starting relay server on port $relayPort ..." -ForegroundColor Green
$env:PORT = "$relayPort"
$env:DATA_DIR = Join-Path $configDir "relay-data"
New-Item -ItemType Directory -Path $env:DATA_DIR -Force | Out-Null
$relayProc = Start-Process -FilePath node -ArgumentList (Join-Path $root "relay-server\server.js") -PassThru -WindowStyle $(if ($Headless) { "Hidden" } else { "Normal" })
$relayProc | Export-Clixml -Path (Join-Path $env:TEMP "pc-control-relay-proc.xml") -Force
Write-Host "  Relay PID: $($relayProc.Id)" -ForegroundColor DarkGray

# ── Start MCP server ──────────────────────────────────────────────────────────
Write-Host "Starting MCP server on port $mcpPort ..." -ForegroundColor Green
$env:MCP_CONFIG_PATH = $configPath
$env:MCP_PORT = "$mcpPort"
$mcpProc = Start-Process -FilePath node -ArgumentList "$(Join-Path $root 'index.js')", "--mode=http", "--port=$mcpPort" -PassThru -WindowStyle $(if ($Headless) { "Hidden" } else { "Normal" })
$mcpProc | Export-Clixml -Path (Join-Path $env:TEMP "pc-control-mcp-proc.xml") -Force
Write-Host "  MCP PID: $($mcpProc.Id)" -ForegroundColor DarkGray

# ── Start Electron app (if installed) ─────────────────────────────────────────
$electronPath = Join-Path $root "desktop-app"
if (Test-Path -LiteralPath (Join-Path $electronPath "node_modules\electron\dist\electron.exe")) {
  Write-Host "Starting desktop app..." -ForegroundColor Green
  $electronProc = Start-Process -FilePath (Join-Path $electronPath "node_modules\.bin\electron.cmd") -ArgumentList "." -WorkingDirectory $electronPath -PassThru -WindowStyle $(if ($Headless) { "Hidden" } else { "Normal" })
}

# ── Connection info ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗"
Write-Host "║  LOCAL RELAY RUNNING                                       ║"
Write-Host "╚══════════════════════════════════════════════════════════════╝"
Write-Host ""
Write-Host "  Device name:   $DeviceName"
Write-Host "  MCP port:      $mcpPort"
Write-Host "  Relay port:    $relayPort"
Write-Host "  API key:       $ApiKey"
Write-Host ""
Write-Host "  MCP URL:       $relayUrl/mcp/$DeviceName"
Write-Host ""
Write-Host "  Relay health:  http://127.0.0.1:$relayPort/health"
Write-Host ""
Write-Host "  Press Enter to stop everything."
Write-Host ""

# ── Wait for Ctrl+C ───────────────────────────────────────────────────────────
try {
  if (-not $Headless) { Read-Host "Press Enter to stop..." }
} finally {
  Write-Host "Stopping processes..." -ForegroundColor Yellow
  Get-Process -Id $relayProc.Id -ErrorAction 0 | Stop-Process -Force -ErrorAction 0
  Get-Process -Id $mcpProc.Id -ErrorAction 0 | Stop-Process -Force -ErrorAction 0
}