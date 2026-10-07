
<#
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

.SYNOPSIS
    Assemble the release folder: upstream + the company overlay, ready to deploy.

.DESCRIPTION
    Exports a committed revision of this repository with `git archive` into a
    release folder (default ..\token-monitor-release): upstream, pinned in
    upstream\, with the overlay at the root - the layout upstream.js and the
    hub image expect. Uncommitted changes are never included; RELEASE-INFO.txt
    records the commit and upstream version.

    A refresh replaces everything except the folder's .env, data\ and
    backups\. A folder the deploy scripts did not make is moved aside to
    <folder>.bak-<time>, never deleted.

    The checkout's .env (or -EnvFile) then becomes the folder's .env; a
    different one already there is saved in backups\ first. It stops instead
    when the two have different database passwords.

    2.deploy-local.ps1 and 3.deploy-ubuntu.ps1 run this same step before they
    build and deploy, so this script is for when only the folder is wanted.

    Run from a release folder's own deploy\, it refreshes that folder at -Ref
    of a checkout: it asks which (the source in RELEASE-INFO.txt, its git
    worktrees, or a typed path). -Force takes the recorded source without
    asking; -Source names the checkout.

.EXAMPLE
    .\deploy\1.token-monitor-release.ps1
    Assemble HEAD into ..\token-monitor-release.

.EXAMPLE
    .\deploy\1.token-monitor-release.ps1 -Ref corp/v0.63.1-corp.1 -Target D:\releases\token-monitor

.EXAMPLE
    .\deploy\1.token-monitor-release.ps1 -Force
    In a release folder: refresh it from its source checkout's HEAD.
#>
[CmdletBinding()]
param(
    # Release folder; relative paths are resolved from this repository's root.
    [string]$Target = '..\token-monitor-release',

    # The committed revision to assemble: a branch, tag or commit.
    [string]$Ref = 'HEAD',

    # In a release folder: refresh it from the source in RELEASE-INFO.txt without asking.
    [switch]$Force,

    # In a release folder: the checkout to refresh from, without asking.
    [string]$Source = '',

    # The .env for the release folder, instead of the checkout's own .env.
    [string]$EnvFile
)

. (Join-Path $PSScriptRoot 'common.ps1')

# Resolved here: a refresh changes the current directory below.
$EnvFile = Resolve-EnvFile -EnvFile $EnvFile

# Asks which checkout to refresh the release folder from: the recorded source
# and its git worktrees by number, or a typed path. Enter cancels.
function Select-ReleaseSource {
    param([string]$Folder, [string]$Recorded)
    $choices = @()
    if ($Recorded -and (Test-Path (Join-Path $Recorded '.git'))) {
        $entry = $null
        foreach ($line in (& git -C $Recorded worktree list --porcelain)) {
            if ($line -match '^worktree (.+)$') {
                $entry = [pscustomobject]@{ Path = [System.IO.Path]::GetFullPath($Matches[1]); Branch = '(detached)'; Head = '' }
                $choices += $entry
            } elseif ($line -match '^HEAD (\S+)$') { $entry.Head = $Matches[1].Substring(0, 12) }
            elseif ($line -match '^branch refs/heads/(.+)$') { $entry.Branch = $Matches[1] }
        }
    }
    Write-Warn "$Folder is a release folder. Refresh it at $Ref of a checkout (.env, data\ and backups\ are kept):"
    for ($i = 0; $i -lt $choices.Count; $i++) {
        $c = $choices[$i]
        $mark = if ($c.Path -eq [System.IO.Path]::GetFullPath($Recorded)) { '  <- RELEASE-INFO.txt' } else { '' }
        Write-Info "  [$($i + 1)] $($c.Path)  $($c.Branch) $($c.Head)$mark"
    }
    Write-Info '  or type a checkout path; Enter alone cancels.'
    try {
        $answer = "$(Read-Host 'Refresh from')".Trim()
    } catch {
        Stop-Deploy 'Cannot ask here (no console input); pass -Force or -Source.'
    }
    if (-not $answer) { Stop-Deploy 'Cancelled; the release folder is unchanged.' }
    if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $choices.Count) {
        return $choices[[int]$answer - 1].Path
    }
    return $answer
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$inRelease = Test-Path (Join-Path $repoRoot $Marker)
if ($inRelease) {
    $recorded = ''
    foreach ($line in (Get-Content -LiteralPath (Join-Path $repoRoot $Marker))) {
        if ($line -match '^source:\s*(.+)$') { $recorded = $Matches[1].Trim() }
    }
    if (-not $Source) {
        if ($Force) {
            if (-not $recorded) { Stop-Deploy "$Marker names no source checkout; pass -Source <open-token-monitor checkout>." }
            $Source = $recorded
        } else {
            $Source = Select-ReleaseSource -Folder $repoRoot -Recorded $recorded
        }
    }
    if (-not [System.IO.Path]::IsPathRooted($Source)) {
        $Source = Join-Path (Get-Location).Path $Source
    }
    $Source = [System.IO.Path]::GetFullPath($Source)
    if (-not (Test-Path (Join-Path $Source '.git')) -or (Test-Path (Join-Path $Source $Marker))) {
        Stop-Deploy "Not a open-token-monitor checkout: $Source"
    }
    # The refresh deletes this folder's files, deploy\ among them: stand outside it meanwhile.
    Push-Location (Split-Path -Parent $repoRoot)
    [System.Environment]::CurrentDirectory = (Get-Location).Path
    $deploy = Initialize-Deploy -RepoRoot $Source -Target $repoRoot -Ref $Ref -Tools @()
} else {
    $deploy = Initialize-Deploy -RepoRoot $repoRoot -Target $Target -Ref $Ref -Tools @()
}
$archive = Join-Path ([System.IO.Path]::GetTempPath()) "token-monitor-release-$($deploy.Short).tar"
try {
    New-ReleaseFolder -Deploy $deploy -Ref $Ref -Archive $archive | Out-Null
} finally {
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
    if ($inRelease) { Pop-Location }
}

$EnvFile = Resolve-EnvFile -EnvFile $EnvFile -Repo $deploy.Repo
if ($EnvFile) {
    Install-ReleaseEnv -Target $deploy.Target -EnvFile $EnvFile
} elseif (-not (Test-Path (Join-Path $deploy.Target '.env'))) {
    Write-Warn "$($deploy.Repo) has no .env to copy; 2.deploy-local.ps1 writes one with generated keys."
}

PAUSE