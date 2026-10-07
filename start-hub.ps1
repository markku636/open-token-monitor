<#
.SYNOPSIS
    Start, stop, or check the Token Monitor Node hub on Windows.

.DESCRIPTION
    A thin wrapper around `node hub\server.js` — the upstream hub that
    `npm run hub` runs, plus the dashboard overlay (see docs/hub.zh-TW.md). It
    adds the checks that are easy to forget on Windows: Node version,
    dependencies, whether the port is already taken, and whether the hub is
    about to be silently downgraded to localhost-only because no secret is set.

    Configuration still follows the project's own precedence:
    CLI flag -> env var (real or .env) -> built-in default.
    This script never injects env vars; -Port / -BindHost are passed through as
    CLI flags so there is only ever one source of truth.

.EXAMPLE
    .\start-hub.ps1
    Run the hub in the foreground. Ctrl+C stops it.

.EXAMPLE
    .\start-hub.ps1 -Background
    Run detached, logging to tmp\hub.log.

.EXAMPLE
    .\start-hub.ps1 -Stop
#>
[CmdletBinding(DefaultParameterSetName = 'Start')]
param(
    [Parameter(ParameterSetName = 'Start')]
    [ValidateRange(1, 65535)]
    [int]$Port,

    # Not named -Host: $Host is a reserved PowerShell automatic variable.
    [Parameter(ParameterSetName = 'Start')]
    [string]$BindHost,

    [Parameter(ParameterSetName = 'Start')]
    [switch]$Background,

    [Parameter(ParameterSetName = 'Stop', Mandatory = $true)]
    [switch]$Stop,

    [Parameter(ParameterSetName = 'Status', Mandatory = $true)]
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

# This script lives at the root of the repository; upstream is its upstream/
# subtree, as upstream.js finds it.
$RootDir = $PSScriptRoot
$UpstreamDir = Join-Path $RootDir 'upstream'
$TmpDir = Join-Path $RootDir 'tmp'
$PidFile = Join-Path $TmpDir 'hub.pid'
$LogFile = Join-Path $TmpDir 'hub.log'
$ServerJs = Join-Path $RootDir 'hub\server.js'
$EnvFile = Join-Path $RootDir '.env'

$DefaultPort = 17321
$DefaultBindHost = '0.0.0.0'
$MinNodeMajor = 22
$LoopbackHosts = @('127.0.0.1', 'localhost', '::1')

function Write-Info { param([string]$Message) Write-Host $Message }
function Write-Ok { param([string]$Message) Write-Host $Message -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host $Message -ForegroundColor Red }

# Minimal KEY=VALUE reader, used only to *report* what the hub will do.
# The hub itself loads this repository's .env in hub/server.js.
function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim()
        if ($value.Length -ge 2) {
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $map[$key] = $value
    }
    return $map
}

# Mirrors the CLI flag -> real env -> .env -> default precedence the hub uses.
function Resolve-Setting {
    param([string]$FlagValue, [string]$Name, [hashtable]$DotEnv, [string]$Default)
    if ($FlagValue) { return $FlagValue }
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    if ($DotEnv.ContainsKey($Name) -and $DotEnv[$Name]) { return $DotEnv[$Name] }
    return $Default
}

# Mirrors resolveBindHost() in src/hub/server.js: without a secret the hub
# cannot tell its own widget from any other caller, so a non-loopback bind is
# clamped to 127.0.0.1 to keep account identity off the network.
function Resolve-BindHost {
    param([string]$Requested, [string]$Secret)
    $value = $Requested.Trim()
    if (-not $value) { $value = $DefaultBindHost }
    if ($Secret) { return $value }
    if ($LoopbackHosts -contains $value.ToLower()) { return $value }
    return '127.0.0.1'
}

function Get-HubHealth {
    param([int]$HealthPort)
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/api/health" -TimeoutSec 3
    } catch {
        return $null
    }
}

function Get-PortListener {
    param([int]$ListenPort)
    try {
        $conn = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop | Select-Object -First 1
    } catch {
        return $null
    }
    if (-not $conn) { return $null }
    $name = 'unknown'
    try {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        $name = $proc.ProcessName
    } catch {}
    return [pscustomobject]@{ ProcessId = $conn.OwningProcess; ProcessName = $name }
}

function Get-TrackedHubProcess {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $parsed = 0
    if (-not [int]::TryParse($raw, [ref]$parsed)) { return $null }
    try {
        $proc = Get-Process -Id $parsed -ErrorAction Stop
    } catch {
        return $null
    }
    # Guard against the pid having been recycled by an unrelated process.
    if ($proc.ProcessName -ne 'node') { return $null }
    return $proc
}

# --- -Stop -------------------------------------------------------------------

if ($Stop) {
    $proc = Get-TrackedHubProcess
    if (-not $proc) {
        if (Test-Path $PidFile) {
            Remove-Item -LiteralPath $PidFile -Force
            Write-Warn 'No live hub process for the recorded pid; removed the stale tmp\hub.pid.'
        } else {
            Write-Info 'No background hub recorded in tmp\hub.pid - nothing to stop.'
        }
        exit 0
    }
    Stop-Process -Id $proc.Id -Force -Confirm:$false
    Remove-Item -LiteralPath $PidFile -Force
    Write-Ok "Stopped hub (pid $($proc.Id))."
    exit 0
}

# --- -Status -----------------------------------------------------------------

if ($Status) {
    $dotEnv = Read-DotEnv -Path $EnvFile
    $statusPort = [int](Resolve-Setting -FlagValue '' -Name 'TOKEN_MONITOR_PORT' -DotEnv $dotEnv -Default "$DefaultPort")
    $health = Get-HubHealth -HealthPort $statusPort

    if ($health) {
        Write-Ok "Hub is running on http://127.0.0.1:$statusPort"
        $health | Format-List | Out-String | Write-Host
    } else {
        Write-Info "No hub responding on http://127.0.0.1:$statusPort/api/health."
        $listener = Get-PortListener -ListenPort $statusPort
        if ($listener) {
            Write-Warn "Port $statusPort is held by $($listener.ProcessName) (pid $($listener.ProcessId)), but it is not answering as a hub."
        }
    }

    $tracked = Get-TrackedHubProcess
    if ($tracked) {
        Write-Info "Background hub pid from tmp\hub.pid: $($tracked.Id)"
    }
    exit 0
}

# --- Preflight ---------------------------------------------------------------

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err 'node was not found on PATH. Install Node.js >= 22.15.0 and try again.'
    exit 1
}

$nodeVersion = (& node -v).Trim()
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt $MinNodeMajor) {
    Write-Err "Node $nodeVersion is too old; package.json requires >= 22.15.0."
    exit 1
}

if (-not (Test-Path $ServerJs)) {
    Write-Err "Could not find $ServerJs. Keep this script at the root of the open-token-monitor checkout; it locates the repo relative to its own path."
    exit 1
}

# The hub needs only upstream's dotenv at startup and deliberately skips
# ensure:tokscale; this repository's node_modules carries dotenv and the
# database driver, and upstream/ installs nothing of its own.
if (-not (Test-Path (Join-Path $UpstreamDir 'package.json'))) {
    Write-Err "No upstream tree at $UpstreamDir. It is a git subtree of this repository; restore it with git."
    exit 1
}
if (-not (Test-Path (Join-Path $RootDir 'node_modules'))) {
    Write-Err 'node_modules is missing. Run `npm ci` in this repository first.'
    exit 1
}

$dotEnv = Read-DotEnv -Path $EnvFile
if (-not (Test-Path $EnvFile)) {
    Write-Warn "No .env found - falling back to built-in defaults. Start one from $UpstreamDir\.env.example (plus the overlay settings in docs/hub.zh-TW.md) to configure a secret."
}

$portFlagValue = ''
if ($PSBoundParameters.ContainsKey('Port')) { $portFlagValue = "$Port" }
$effectivePort = [int](Resolve-Setting -FlagValue $portFlagValue -Name 'TOKEN_MONITOR_PORT' -DotEnv $dotEnv -Default "$DefaultPort")
$requestedHost = Resolve-Setting -FlagValue $BindHost -Name 'TOKEN_MONITOR_HOST' -DotEnv $dotEnv -Default $DefaultBindHost
$secret = Resolve-Setting -FlagValue '' -Name 'TOKEN_MONITOR_SECRET' -DotEnv $dotEnv -Default ''
$effectiveHost = Resolve-BindHost -Requested $requestedHost -Secret $secret

Write-Info "Node $nodeVersion"
if ($secret) {
    Write-Info "Secret:   set ($($secret.Length) chars)"
} else {
    Write-Warn 'Secret:   NOT set'
}

if ($effectiveHost -ne $requestedHost) {
    Write-Warn "Bind:     $requestedHost requested, but with no TOKEN_MONITOR_SECRET the hub clamps to $effectiveHost (this machine only)."
    Write-Warn '          Set a secret in .env to accept connections from other devices.'
} elseif ($LoopbackHosts -contains $effectiveHost.ToLower()) {
    Write-Info "Bind:     $effectiveHost`:$effectivePort (this machine only)"
} else {
    Write-Info "Bind:     $effectiveHost`:$effectivePort (reachable from your LAN)"
}

$listener = Get-PortListener -ListenPort $effectivePort
if ($listener) {
    Write-Err "Port $effectivePort is already in use by $($listener.ProcessName) (pid $($listener.ProcessId))."
    if ($listener.ProcessName -eq 'node') {
        Write-Info 'That is probably an earlier hub. Stop it with: .\start-hub.ps1 -Stop'
    } else {
        Write-Info "That may be the Electron widget running in Host mode, which embeds its own hub."
    }
    Write-Info "Or pick another port: .\start-hub.ps1 -Port 17322"
    exit 1
}

# --- Launch ------------------------------------------------------------------

$nodeArgs = @($ServerJs)
if ($PSBoundParameters.ContainsKey('Port')) { $nodeArgs += "--port=$Port" }
if ($BindHost) { $nodeArgs += "--host=$BindHost" }

if (-not $Background) {
    Write-Info ''
    Write-Info 'Starting hub in the foreground - press Ctrl+C to stop.'
    Write-Info ''
    & node @nodeArgs
    exit $LASTEXITCODE
}

if (-not (Test-Path $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir | Out-Null }

$proc = Start-Process -FilePath $nodeCmd.Source `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError "$LogFile.err" `
    -PassThru

Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding utf8

Write-Info ''
Write-Info "Started node (pid $($proc.Id)); waiting for the hub to answer..."

$ready = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    $ready = Get-HubHealth -HealthPort $effectivePort
    if ($ready) { break }
}

if (-not $ready) {
    Write-Err "Hub did not become healthy within 10s."
    foreach ($file in @("$LogFile.err", $LogFile)) {
        if ((Test-Path $file) -and (Get-Item $file).Length -gt 0) {
            Write-Info "--- last lines of $file ---"
            Get-Content -LiteralPath $file -Tail 20 | Write-Host
        }
    }
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -Confirm:$false
    }
    if (Test-Path $PidFile) { Remove-Item -LiteralPath $PidFile -Force }
    exit 1
}

Write-Ok "Hub listening on http://$effectiveHost`:$effectivePort"
Write-Info "Dashboard: http://127.0.0.1:$effectivePort/"
Write-Info "Health:    http://127.0.0.1:$effectivePort/api/health"
Write-Info "Logs:      tmp\hub.log"
Write-Info "Stop:      .\start-hub.ps1 -Stop"
