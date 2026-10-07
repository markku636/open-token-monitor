<#
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

.SYNOPSIS
    One step from this checkout to the company client installer (Windows).

.DESCRIPTION
    Builds the company Token Monitor client installer on Windows and puts it,
    with its checksum, in release\client\<version>\ (docs/client-build.zh-TW.md,
    the local build section):

      1. checks Windows, git and Node.js >= 22.15 (a WinGet or Program Files
         Node.js is used when node is not on PATH);
      2. -Pull: fast-forwards this branch first (refused with local changes);
      3. takes the hub URL and client key from the hub's .env.ubuntu
         (TOKEN_MONITOR_HUB_URL and the first of TOKEN_MONITOR_CLIENT_SECRETS;
         -HubEnvFile picks another file), then makes sure .env.client exists
         for the other values and has the update source (TM_CLIENT_UPDATE_*,
         added from .env.client.example to an older file); when the hub URL
         or key is still missing, it asks for them (non-interactive runs stop
         with instructions instead);
      4. npm ci when node_modules is missing or older than package-lock.json;
      5. checks the build values (packaging/build-client.js --dry-run);
      6. npm run verify (upstream seams, lint, tests) unless -SkipVerify;
      7. node packaging/build-client.js --platform win (dist\client\);
      8. copies the installer to release\client\<version>\ with SHA256SUMS.txt,
         BUILD-INFO.txt (commit, upstream version, hub URL - never the key)
         and the build log.

    The key in .env.client ends up inside the installer (app.asar): hand the
    installer out inside the company only, and never put the admin key
    TOKEN_MONITOR_SECRET there.

    Same build as `npm run build:client -- --platform win`, plus the checks
    and the release folder.

    Where each value comes from, first match wins: this script's parameters,
    TM_CLIENT_* environment variables (as in GitLab CI), the hub env file
    (.env.ubuntu), .env.client.

    Without -Version (or TM_CLIENT_VERSION), the version counts up by itself:
    <upstream>-corp.N one past the highest N already in the output folder
    (release\client\<version>\) or the client-v* git tags, from corp.0 for a
    new upstream version.

.EXAMPLE
    .\packaging\build-client.ps1
    Build the next <upstream>-corp.N from the current checkout.

.EXAMPLE
    .\packaging\build-client.ps1 -Version 0.63.1-corp.2 -Pull -Open
    Update the branch, build 0.63.1-corp.2, open the output folder.

.EXAMPLE
    .\packaging\build-client.ps1 -DryRun
    Check the build values only (the key is shown as ***).

.EXAMPLE
    .\packaging\build-client.ps1 -HubUrl http://192.0.2.30 -StartAtLogin 0
    Build for another hub URL (key still from .env.ubuntu), without autostart.

.EXAMPLE
    .\packaging\build-client.ps1 -HubEnvFile ''
    Ignore .env.ubuntu and take everything from .env.client.
#>
[CmdletBinding()]
param(
    # X.Y.Z-corp.N (or client-vX.Y.Z-corp.N); X.Y.Z must be upstream's version.
    # Empty: TM_CLIENT_VERSION from the environment / .env.client, else the next
    # X.Y.Z-corp.N after the release folders and client-v* tags.
    [string]$Version = '',

    # The hub's env file the hub URL (TOKEN_MONITOR_HUB_URL) and client key
    # (first of TOKEN_MONITOR_CLIENT_SECRETS) are read from; relative paths are
    # resolved from this repository's root. '' uses .env.client only.
    [string]$HubEnvFile = '.env.ubuntu',

    # The hub URL the client connects to, over every other source.
    [string]$HubUrl = '',

    # Launch at login on each machine's first launch of this build (1 or 0).
    # Empty: TM_CLIENT_START_AT_LOGIN from the environment / .env.client, else 1.
    [ValidateSet('', '0', '1')]
    [string]$StartAtLogin = '',

    # Fast-forward the current branch from its remote before building.
    [switch]$Pull,

    # Skip `npm run verify`.
    [switch]$SkipVerify,

    # Where the installer is copied; relative paths are resolved from this repository's root.
    [string]$Output = 'release\client',

    # Print the build configuration and stop (nothing is built).
    [switch]$DryRun,

    # Keep tmp\client-build\ for debugging (the key file is still deleted).
    [switch]$KeepWork,

    # Open the output folder when done.
    [switch]$Open
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$started = Get-Date
# The values set below go to build-client.js as TM_CLIENT_* environment
# variables; they are put back on exit so they do not stay in the caller's
# session and win over .env.client on the next run.
$savedClientEnv = @{}
Get-ChildItem Env: | Where-Object { $_.Name -like 'TM_CLIENT_*' } | ForEach-Object { $savedClientEnv[$_.Name] = $_.Value }

function Write-Step { param([string]$Message) Write-Host "`n== $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host $Message -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host $Message -ForegroundColor Yellow }
function Stop-Build {
    param([string]$Message)
    Write-Host "build-client: $Message" -ForegroundColor Red
    exit 1
}

# Runs a native command and stops the build on a non-zero exit. npm and git
# write progress to stderr, which Windows PowerShell would otherwise turn into
# a terminating error when the output is redirected. With -Log the output is
# also written to that file.
function Invoke-Native {
    param([string]$What, [scriptblock]$Command, [string]$Log = '')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Streamed line by line: the build runs for minutes and should show its progress.
        $toText = { if ($_ -is [System.Management.Automation.ErrorRecord]) { "$($_.TargetObject)" } else { "$_" } }
        if ($Log) { & $Command 2>&1 | ForEach-Object $toText | Tee-Object -FilePath $Log | Out-Host }
        else { & $Command 2>&1 | ForEach-Object $toText | Out-Host }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        $where = if ($Log) { " Log: $Log" } else { '' }
        Stop-Build "$What failed (exit $code).$where"
    }
}

# A native command's stdout (stderr dropped); empty when it fails.
function Get-NativeOutput {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return (& $Command 2>$null) } finally { $ErrorActionPreference = $previous }
}

# node on PATH, else the WinGet Node.js LTS or the Program Files install.
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return (Split-Path -Parent $cmd.Source) }
    $candidates = @()
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $winget) {
        $candidates += Get-ChildItem $winget -Directory -Filter 'OpenJS.NodeJS*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem $_.FullName -Directory -Filter 'node-v*' -ErrorAction SilentlyContinue } |
            Sort-Object Name -Descending | ForEach-Object { $_.FullName }
    }
    $candidates += (Join-Path $env:ProgramFiles 'nodejs')
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir 'node.exe')) { return $dir }
    }
    return $null
}

function Read-Secret {
    param([string]$Prompt)
    $secure = Read-Host $Prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Sets KEY=value in .env.client, keeping UTF-8 without a BOM and LF line ends
# like the committed example.
function Set-EnvLine {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = [System.IO.File]::ReadAllLines($Path)
    $found = $false
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match "^\s*$([regex]::Escape($Key))=") { $lines[$i] = "$Key=$Value"; $found = $true }
    }
    if (-not $found) { $lines += "$Key=$Value" }
    [System.IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

function Get-EnvFileValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return '' }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") { return $Matches[1].Trim() }
    }
    return ''
}

# Whether KEY= is in the file at all; Get-EnvFileValue reads a missing key and
# an empty one alike.
function Test-EnvFileKey {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $false }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match "^\s*$([regex]::Escape($Key))=") { return $true }
    }
    return $false
}

# The next <upstream>-corp.N: one past the highest N among the release folders
# in $OutRoot and the client-v* git tags, 0 when there is none yet.
function Get-NextCorpVersion {
    param([string]$Upstream, [string]$OutRoot)
    $pattern = "^(client-v)?$([regex]::Escape($Upstream))-corp\.(\d+)$"
    $names = @()
    if (Test-Path $OutRoot) { $names += Get-ChildItem $OutRoot -Directory | ForEach-Object { $_.Name } }
    $names += Get-NativeOutput { git tag --list "client-v$Upstream-corp.*" }
    # Counted, not tested for truth: a lone corp.0 would read as false.
    $used = @($names | Where-Object { $_ -match $pattern } | ForEach-Object { [int]($_ -replace $pattern, '$2') })
    $next = if ($used.Count) { ($used | Measure-Object -Maximum).Maximum + 1 } else { 0 }
    return "$Upstream-corp.$next"
}

function Write-Utf8File {
    param([string]$Path, [string[]]$Lines)
    [System.IO.File]::WriteAllText($Path, (($Lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

Push-Location $root
try {
    # ---- 1. build machine ----
    Write-Step 'Checking the build machine'
    if ($env:OS -ne 'Windows_NT') { Stop-Build 'this script builds the Windows installer and must run on Windows (the macOS dmg is built by the GitLab macos runner).' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        $gitDir = Join-Path $env:ProgramFiles 'Git\cmd'
        if (Test-Path (Join-Path $gitDir 'git.exe')) { $env:PATH = "$gitDir;$env:PATH" } else { Stop-Build 'git was not found. Install Git for Windows.' }
    }
    $nodeDir = Find-Node
    if (-not $nodeDir) { Stop-Build 'Node.js was not found. Install Node.js 22.15 or later (winget install OpenJS.NodeJS.LTS).' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $env:PATH = "$nodeDir;$env:PATH" }
    $nodeVersion = "$(Get-NativeOutput { node -p 'process.versions.node' })".Trim()
    $parts = $nodeVersion.Split('.') | ForEach-Object { [int]$_ }
    if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 15)) { Stop-Build "Node.js >= 22.15 is required, found $nodeVersion." }
    Write-Ok "Node.js $nodeVersion ($nodeDir)"

    # ---- 2. source ----
    $dirty = Get-NativeOutput { git status --porcelain --untracked-files=no }
    if ($Pull) {
        Write-Step 'Updating the checkout (git pull --ff-only)'
        if ($dirty) { Stop-Build 'this checkout has uncommitted changes; commit or stash them before -Pull.' }
        Invoke-Native 'git pull' { git pull --ff-only }
        $dirty = $null
    }
    $commit = "$(Get-NativeOutput { git rev-parse --short HEAD })".Trim()
    $branch = "$(Get-NativeOutput { git rev-parse --abbrev-ref HEAD })".Trim()
    $upstreamVersion = "$(Get-NativeOutput { node -p "require('./upstream/package.json').version" })".Trim()
    Write-Ok "Source: $branch @ $commit, upstream $upstreamVersion"
    if ($dirty) { Write-Warn 'Uncommitted changes are included in this build: fine for a trial, not for a release.' }

    # ---- 3. hub env file, .env.client ----
    # Parameters win, then environment variables (as in GitLab CI), then the
    # hub env file, then .env.client; only values missing from all are asked
    # for. The hub env file's values are passed as environment variables, which
    # build-client.js reads over .env.client.
    $configSources = @()
    $hubSetHere = $false
    if ($HubEnvFile) {
        $hubEnv = if ([System.IO.Path]::IsPathRooted($HubEnvFile)) { $HubEnvFile } else { Join-Path $root $HubEnvFile }
        $hubEnvName = Split-Path -Leaf $hubEnv
        if (Test-Path $hubEnv) {
            $taken = @()
            if (-not $env:TM_CLIENT_SECRET) {
                $clientKey = "$((Get-EnvFileValue $hubEnv 'TOKEN_MONITOR_CLIENT_SECRETS').Split(',')[0])".Trim()
                if ($clientKey) {
                    if ($clientKey -eq (Get-EnvFileValue $hubEnv 'TOKEN_MONITOR_SECRET')) {
                        Stop-Build "the first TOKEN_MONITOR_CLIENT_SECRETS in $hubEnvName is the admin key TOKEN_MONITOR_SECRET; it must never go into an installer."
                    }
                    $env:TM_CLIENT_SECRET = $clientKey
                    $taken += 'client key'
                }
                $clientKey = $null
            }
            if (-not $env:TM_CLIENT_HUB_URL -and -not $HubUrl) {
                $hubFromFile = Get-EnvFileValue $hubEnv 'TOKEN_MONITOR_HUB_URL'
                if ($hubFromFile) {
                    $hubHost = try { ([Uri]$hubFromFile).Host.Trim('[', ']') } catch { '' }
                    if ($hubHost -in @('127.0.0.1', 'localhost', '::1', '0.0.0.0')) {
                        Stop-Build "TOKEN_MONITOR_HUB_URL in $hubEnvName is $hubFromFile, which other computers cannot reach. Set it to the hub address clients use (for example https://tokens.example.com), or pass -HubUrl."
                    }
                    $env:TM_CLIENT_HUB_URL = $hubFromFile
                    $taken += 'hub URL'
                    $hubSetHere = $true
                }
            }
            if ($taken) {
                Write-Ok "$($taken -join ' and ') from $hubEnvName"
                $configSources += $hubEnvName
            }
        } else {
            Write-Warn "No $hubEnvName in $root; the hub URL and client key come from .env.client."
        }
    }
    if ($HubUrl) {
        $env:TM_CLIENT_HUB_URL = $HubUrl.Trim()
        $configSources = @('-HubUrl') + $configSources
        $hubSetHere = $true
    }
    # An http hub URL given here allows http, as when it is typed in below.
    if ($hubSetHere -and $env:TM_CLIENT_HUB_URL -match '^http://' -and -not $env:TM_CLIENT_ALLOW_HTTP) {
        $env:TM_CLIENT_ALLOW_HTTP = '1'
    }
    if ($StartAtLogin) { $env:TM_CLIENT_START_AT_LOGIN = $StartAtLogin }

    $envFile = Join-Path $root '.env.client'
    if (-not (Test-Path $envFile)) {
        Write-Step 'Creating .env.client from .env.client.example'
        Copy-Item (Join-Path $root '.env.client.example') $envFile
    }
    # The update source came after the first .env.client files. An older file
    # lacks its keys, and a build from it has no app-update.yml: the installed
    # app could never update itself. Missing keys are taken from the example; a
    # key left empty on purpose stays empty.
    $updateKeys = @('TM_CLIENT_UPDATE_PROJECT_URL', 'TM_CLIENT_UPDATE_PROJECT_ID')
    $added = @()
    $hasUpdateSource = $false
    foreach ($key in $updateKeys) {
        if (-not [Environment]::GetEnvironmentVariable($key) -and -not (Test-EnvFileKey $envFile $key)) {
            Set-EnvLine $envFile $key (Get-EnvFileValue (Join-Path $root '.env.client.example') $key)
            $added += $key
        }
        if ([Environment]::GetEnvironmentVariable($key) -or (Get-EnvFileValue $envFile $key)) { $hasUpdateSource = $true }
    }
    if ($added) { Write-Ok ".env.client: added $($added -join ' and ') from .env.client.example (where the app looks for updates)." }
    if (-not $hasUpdateSource) { Write-Warn 'TM_CLIENT_UPDATE_PROJECT_URL / _ID are empty: this installer has no update source, and the installed app can never update itself.' }
    $needHub =-not $env:TM_CLIENT_HUB_URL -and -not (Get-EnvFileValue $envFile 'TM_CLIENT_HUB_URL')
    $needKey = -not $env:TM_CLIENT_SECRET -and -not (Get-EnvFileValue $envFile 'TM_CLIENT_SECRET')
    if ($needHub -or $needKey) {
        $names = @()
        if ($needHub) { $names += 'TM_CLIENT_HUB_URL' }
        if ($needKey) { $names += 'TM_CLIENT_SECRET' }
        $missing = $names -join ' and '
        if (-not [Environment]::UserInteractive -or $DryRun) {
            Stop-Build "$missing missing in .env.client. Fill in $missing (notepad .env.client) and run this again."
        }
        Write-Step "Filling in .env.client ($missing)"
        if ($needHub) {
            $hub = (Read-Host 'Hub URL (for example http://192.0.2.10 or https://tokens.example.internal)').Trim()
            if (-not $hub) { Stop-Build 'no hub URL given; fill in .env.client and run this again.' }
            Set-EnvLine $envFile 'TM_CLIENT_HUB_URL' $hub
            if ($hub -match '^http://') { Set-EnvLine $envFile 'TM_CLIENT_ALLOW_HTTP' '1' }
        }
        if ($needKey) {
            $key = Read-Secret 'Client key (one of the hub''s TOKEN_MONITOR_CLIENT_SECRETS, never the admin key TOKEN_MONITOR_SECRET)'
            if (-not $key) { Stop-Build 'no client key given; fill in .env.client and run this again.' }
            Set-EnvLine $envFile 'TM_CLIENT_SECRET' $key
            $key = $null
        }
        Write-Ok '.env.client updated (gitignored: do not commit or copy it).'
    }
    $outRoot = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $root $Output }
    if ($Version) {
        $env:TM_CLIENT_VERSION = $Version
    } elseif (-not $env:TM_CLIENT_VERSION -and -not (Get-EnvFileValue $envFile 'TM_CLIENT_VERSION')) {
        $env:TM_CLIENT_VERSION = Get-NextCorpVersion $upstreamVersion $outRoot
        Write-Ok "Version $env:TM_CLIENT_VERSION (next after $Output and the client-v* tags)"
    }
    $versionDir = Join-Path $outRoot ($env:TM_CLIENT_VERSION -replace '^client-v', '')
    if ($env:TM_CLIENT_VERSION -and (Test-Path $versionDir)) {
        Write-Warn "$versionDir already exists; this build replaces its installer."
    }

    # ---- 4. dependencies ----
    $stamp = Join-Path $root 'node_modules\.package-lock.json'
    $lock = Join-Path $root 'package-lock.json'
    if (-not (Test-Path $stamp) -or ((Get-Item $lock).LastWriteTime -gt (Get-Item $stamp).LastWriteTime)) {
        Write-Step 'Installing dependencies (npm ci)'
        Invoke-Native 'npm ci' { npm ci --no-audit --no-fund }
    }

    # ---- 5. build values ----
    # build-client.js validates the hub URL, key, interval and version before
    # anything is copied; the key is printed as ***.
    Write-Step 'Checking the build values'
    Invoke-Native 'Checking the build values' { node packaging/build-client.js --platform win --dry-run }
    if ($DryRun) { Write-Ok "`nDry run: nothing was built."; exit 0 }

    # ---- 6. verify ----
    if (-not $SkipVerify) {
        Write-Step 'Verifying (npm run verify)'
        Invoke-Native 'npm run verify' { npm run verify }
    }

    # ---- 7. build ----
    Write-Step 'Building the installer (the first build downloads Electron: 5-10 minutes)'
    $logDir = Join-Path $root 'tmp'
    New-Item -ItemType Directory -Force $logDir | Out-Null
    $log = Join-Path $logDir ('client-build-{0:yyyyMMdd-HHmmss}.log' -f $started)
    if ($KeepWork) {
        Invoke-Native 'The build' { node packaging/build-client.js --platform win --keep-work } -Log $log
    } else {
        Invoke-Native 'The build' { node packaging/build-client.js --platform win } -Log $log
    }

    # ---- 8. release folder ----
    $installer = Get-ChildItem (Join-Path $root 'dist\client') -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $installer) { Stop-Build "no installer in dist\client. Log: $log" }
    $builtVersion = if ($installer.Name -match '^Token-Monitor_(.+)_x64-setup\.exe$') { $Matches[1] } else { "$upstreamVersion-corp" }
    $outDir = Join-Path $outRoot $builtVersion
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $target = Join-Path $outDir $installer.Name
    Copy-Item $installer.FullName $target -Force
    Copy-Item $log (Join-Path $outDir 'build.log') -Force
    $hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
    Write-Utf8File (Join-Path $outDir 'SHA256SUMS.txt') @("$hash  $($installer.Name)")
    $hubUrl = if ($env:TM_CLIENT_HUB_URL) { $env:TM_CLIENT_HUB_URL } else { Get-EnvFileValue $envFile 'TM_CLIENT_HUB_URL' }
    $config = (@($configSources) + @('.env.client')) -join ' + '
    $source = "$commit ($branch)"
    if ($dirty) { $source += ' + uncommitted changes' }
    Write-Utf8File (Join-Path $outDir 'BUILD-INFO.txt') @(
        'Token Monitor company client - built by packaging\build-client.ps1.',
        '',
        "version:  $builtVersion",
        "upstream: $upstreamVersion",
        "commit:   $source",
        "hub:      $hubUrl",
        "config:   $config",
        "built:    $((Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')) on $env:COMPUTERNAME",
        "sha256:   $hash",
        '',
        'The installer carries the client key (inside app.asar): hand it out inside the company only.'
    )

    $minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
    Write-Host ''
    Write-Ok "Built Token Monitor $builtVersion in $minutes min:"
    Write-Ok "  $target"
    Write-Ok "  sha256 $hash"
    if ($dirty) { Write-Warn '  Built with uncommitted changes: not for release.' }
    if ($Open) { Invoke-Item $outDir }
    exit 0
} finally {
    Get-ChildItem Env: | Where-Object { $_.Name -like 'TM_CLIENT_*' -and -not $savedClientEnv.ContainsKey($_.Name) } |
        ForEach-Object { Remove-Item "Env:$($_.Name)" }
    foreach ($name in $savedClientEnv.Keys) { Set-Item "Env:$name" $savedClientEnv[$name] }
    Pop-Location
}
