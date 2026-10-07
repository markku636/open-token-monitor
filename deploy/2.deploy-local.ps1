<#
.SYNOPSIS
    Deploy the company hub to this PC's Docker Desktop.

.DESCRIPTION
    1. Deploys the release folder (default ..\token-monitor-release) that
       1.token-monitor-release.ps1 made, as it is. With -Ref it assembles the
       folder at that revision first, as 1.token-monitor-release.ps1 does. It
       keeps its own .env, data\ and backups\ across redeploys.
    2. Makes the checkout's .env (or -EnvFile) the release folder's .env, as
       1.token-monitor-release.ps1 does. Without either, a first deploy writes
       one from .env.example with generated keys and passwords.
    3. Backs up the database (when its container is running), builds the hub
       image from the release folder, keeps the old :latest as :previous, then
       `docker compose up -d` and waits for /api/health.

    3.deploy-ubuntu.ps1 deploys to the Ubuntu server instead. Formal releases
    (version number, release notes, corp/v* tag) still go through
    `npm run build:image`; -SkipBuild deploys the token-monitor-hub:latest it
    produced (docs/packaging.zh-TW.md).

.EXAMPLE
    .\deploy\1.token-monitor-release.ps1; .\deploy\2.deploy-local.ps1
    Assemble HEAD into ..\token-monitor-release, then deploy that folder.

.EXAMPLE
    .\deploy\2.deploy-local.ps1 -Ref corp/v0.63.1-corp.1 -SkipBuild
#>
[CmdletBinding()]
param(
    # Release folder; relative paths are resolved from this repository's root.
    [string]$Target = '..\token-monitor-release',

    # Assemble the release folder at this committed revision (a branch, tag
    # or commit) before deploying; without it the folder is deployed as it is.
    [string]$Ref = 'HEAD',

    # The .env for the release folder, instead of the checkout's own .env.
    [string]$EnvFile,

    # Use the existing token-monitor-hub:latest instead of building one.
    [switch]$SkipBuild,

    [switch]$SkipBackup
)

. (Join-Path $PSScriptRoot 'common.ps1')

$deploy = Initialize-Deploy -RepoRoot (Split-Path -Parent $PSScriptRoot) -Target $Target -Ref $Ref -Tools @('docker') -UseRelease (-not $PSBoundParameters.ContainsKey('Ref'))
$EnvFile = Resolve-EnvFile -EnvFile $EnvFile -Repo $deploy.Repo
Assert-Docker

$archive = Join-Path ([System.IO.Path]::GetTempPath()) "token-monitor-release-$($deploy.Short).tar"
try {
    $upstreamVersion = Resolve-ReleaseFolder -Deploy $deploy -Ref $Ref -Archive $archive -NeedArchive $false
} finally {
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
}
$target = $deploy.Target

# --- .env --------------------------------------------------------------------

$targetEnv = Join-Path $target '.env'
if ($EnvFile) {
    Install-ReleaseEnv -Target $target -EnvFile $EnvFile
} elseif (Test-Path $targetEnv) {
    Write-Info 'Keeping the release folder''s .env.'
} else {
    # The database passwords only take effect when the volume is created, so
    # new ones would lock the hub out of an existing database.
    if (Test-Native { docker volume inspect $PostgresVolume }) {
        Stop-Deploy "The database volume $PostgresVolume already exists, but $targetEnv does not. Pass the .env it was created with: .\deploy\2.deploy-local.ps1 -EnvFile <path>"
    }
    Write-TextFile -Path $targetEnv -Lines (New-EnvLines -ExamplePath (Join-Path $target '.env.example'))
    Write-Warn "Wrote $targetEnv with generated keys and passwords. Keep a copy somewhere safe:"
    Write-Warn '  TOKEN_MONITOR_SECRET is the admin key, TOKEN_MONITOR_CLIENT_SECRETS goes to users.'
}

# --- Backup ------------------------------------------------------------------

if ($SkipBackup) {
    Write-Warn 'Skipping the database backup (-SkipBackup).'
} elseif (& docker ps -q --filter "name=^$PostgresContainer$") {
    $backupDir = Join-Path $target 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $dump = Join-Path $backupDir "token-monitor-$(Get-Date -Format 'yyyyMMdd-HHmmss').dump"
    # Written inside the container and copied out: `>` would re-encode the binary dump.
    Invoke-Native 'pg_dump' { docker exec $PostgresContainer pg_dump -U postgres -d token_monitor -n token_monitor -Fc -f /tmp/deploy-backup.dump }
    Invoke-Native 'docker cp' { docker cp "${PostgresContainer}:/tmp/deploy-backup.dump" $dump }
    Test-Native { docker exec $PostgresContainer rm -f /tmp/deploy-backup.dump } | Out-Null
    Write-Ok "Database backup: $dump"
} else {
    Write-Info 'No running database container; nothing to back up.'
}

# --- Image -------------------------------------------------------------------

$deployTag = Resolve-HubImage -ReleaseDir $target -Tag "${Image}:$upstreamVersion-local.$($deploy.Short)" -SkipBuild $SkipBuild
$newId = Get-ImageId $deployTag
$oldId = Get-ImageId "${Image}:latest"
if ($oldId -and $oldId -ne $newId) {
    Invoke-Native 'docker tag' { docker tag "${Image}:latest" "${Image}:previous" }
    Write-Info "Kept the old image as ${Image}:previous."
}
Invoke-Native 'docker tag' { docker tag $deployTag "${Image}:latest" }

# --- Start -------------------------------------------------------------------

$compose = Join-Path $target 'docker\compose.yml'
Invoke-Native 'docker compose up' { docker compose -f $compose --env-file $targetEnv up -d }

Write-Info 'Waiting for the hub to answer /api/health...'
$healthy = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Native { docker exec $HubContainer node -e $HealthProbe }) {
        $healthy = $true
        break
    }
}
if (-not $healthy) {
    Write-Err 'The hub did not become healthy within 90s. Last log lines:'
    & docker logs --tail 40 $HubContainer
    Write-Info "Roll back: docker tag ${Image}:previous ${Image}:latest, then run docker compose up -d again (a release with new migrations needs the database backup restored first, see docs/postgres.zh-TW.md)."
    exit 1
}

$hostPort = Get-DotEnvValue -Path $targetEnv -Name 'TOKEN_MONITOR_HOST_PORT'
$url = if ($hostPort -and $hostPort -ne '80') { "http://localhost:$hostPort/" } else { 'http://localhost/' }
Write-Ok "Hub deployed: $url"
Write-Info "Commands:  docker compose -f `"$compose`" --env-file `"$targetEnv`" ps|logs|stop"
Write-Info "Roll back: docker tag ${Image}:previous ${Image}:latest; then the same compose up -d (see the release notes when migrations changed)."
