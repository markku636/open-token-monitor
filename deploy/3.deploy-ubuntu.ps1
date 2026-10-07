<#
.SYNOPSIS
    Deploy the company hub from this PC to the Ubuntu server's Docker over SSH.

.DESCRIPTION
    1. Assembles the local release folder (default ..\token-monitor-release)
       at -Ref (default HEAD, so the committed code), as
       1.token-monitor-release.ps1 does. With -AsIs it takes the folder that
       1.token-monitor-release.ps1 made as it is instead.
    2. Asks for the SSH account and password and logs in once to check them,
       so a typo fails now rather than after the build. Nothing else is
       asked after this.
    3. Builds the hub image on this PC's Docker Desktop (started when it is
       not running), so the server needs only Docker (with compose v2) - no
       git, Node or internet access.
    4. Uploads the release folder and
       the image, and on the server: refreshes ~/token-monitor-release (its
       .env, data/ and backups/ are kept), installs this checkout's
       .env.ubuntu (or -EnvFile) as its .env, backs up the database when its
       container is running, loads the image, keeps the old :latest as
       :previous, then `docker compose up -d` and waits for /api/health.

    The uploaded .env replaces the server's, which is saved in backups/
    first. Database passwords left blank in it keep the server's (or are
    generated for a new database): they only take effect when the volume is
    created. With no file to upload, the server keeps its .env, and a first
    deploy writes one with generated keys and passwords.

    The password is held in memory only, for ssh/scp and for sudo when the
    account is not in the docker group. Enter nothing to use an SSH key.

    2.deploy-local.ps1 deploys to this PC instead. Formal releases (version
    number, release notes, corp/v* tag) still go through `npm run build:image`;
    -SkipBuild deploys the token-monitor-hub:latest it produced.

.EXAMPLE
    deploy-ubuntu.cmd
    Double-clicked in the repository's root: the same as this script with no
    arguments; only the account and password are asked for.

.EXAMPLE
    .\deploy\3.deploy-ubuntu.ps1
    Assemble the committed HEAD into ..\token-monitor-release, then deploy that folder to 192.0.2.10.

.EXAMPLE
    .\deploy\1.token-monitor-release.ps1 -Ref feat/x; .\deploy\3.deploy-ubuntu.ps1 -AsIs
    Deploy the release folder that 1.token-monitor-release.ps1 made, without assembling it again.

.EXAMPLE
    .\deploy\3.deploy-ubuntu.ps1 -Server 192.0.2.11 -User deploy -Ref corp/v0.63.1-corp.1

.EXAMPLE
    .\deploy\3.deploy-ubuntu.ps1 -ResetDatabase
    Back up and delete the server's database, then deploy with an empty one.
#>
[CmdletBinding()]
param(
    # The Ubuntu server. Change the default here when the server moves.
    [string]$Server = '192.0.2.10',

    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,

    # SSH account; asked for when not given, and so is the password.
    [string]$User,

    # Account and password in one (Get-Credential), instead of being asked.
    [pscredential]$Credential,

    # Release folder on the server, relative to the SSH account's home.
    [string]$RemoteDir = 'token-monitor-release',

    # Local release folder (the image's build context); relative paths are
    # resolved from this repository's root.
    [string]$Target = '..\token-monitor-release',

    # Assemble the release folder at this committed revision (a branch, tag
    # or commit) before deploying.
    [string]$Ref = 'HEAD',

    # Deploy the release folder as 1.token-monitor-release.ps1 made it,
    # instead of assembling it at -Ref first.
    [switch]$AsIs,

    # The server's .env, instead of this checkout's .env.ubuntu.
    [string]$EnvFile,

    # Use the existing token-monitor-hub:latest instead of building one.
    [switch]$SkipBuild,

    [switch]$SkipBackup,

    # Delete the server's database, with all its data, and start an empty one
    # with the passwords in .env. It is backed up first unless -SkipBackup.
    [switch]$ResetDatabase
)

. (Join-Path $PSScriptRoot 'common.ps1')

# The server's half of the deploy, run there with bash; its header lists the
# arguments. The first line of stdin is the SSH password, for sudo when the
# account is not in the docker group.
$ServerScript = Join-Path $PSScriptRoot 'server-deploy.sh'
if (-not (Test-Path -LiteralPath $ServerScript -PathType Leaf)) { Stop-Deploy "$ServerScript is missing; keep it next to this script." }

if ($AsIs -and $PSBoundParameters.ContainsKey('Ref')) { Stop-Deploy '-AsIs deploys the release folder as it is, so it takes no -Ref; leave out one of them.' }
$deploy = Initialize-Deploy -RepoRoot (Split-Path -Parent $PSScriptRoot) -Target $Target -Ref $Ref -Tools @('docker', 'ssh', 'scp') -UseRelease $AsIs.IsPresent
# Run from a release folder, its own .env.ubuntu (kept across refreshes).
$envRoot = if ($deploy.Repo) { $deploy.Repo } else { $deploy.Target }
$EnvFile = Resolve-EnvFile -EnvFile $EnvFile -Repo $envRoot -Name '.env.ubuntu'
if ($EnvFile) { Write-Info "The server's .env: $EnvFile" }
else { Write-Warn "No .env.ubuntu in $envRoot; the server keeps its own .env." }

if ($ResetDatabase) {
    $backupNote = if ($SkipBackup) { 'WITHOUT a backup (-SkipBackup)' } else { "after a backup to ~/$RemoteDir/backups" }
    Write-Warn "-ResetDatabase deletes the database on $Server, with all usage data, $backupNote."
    if ("$(Read-Host "Type $Server to confirm")".Trim() -ne $Server) { Stop-Deploy 'Cancelled; nothing was changed.' }
}

# Asked for up front, so the rest runs unattended.
if ($Credential) {
    $User = $Credential.UserName
    $securePassword = $Credential.Password
} else {
    if (-not $User) { $User = Read-Host "SSH account on $Server" }
    if (-not $User) { Stop-Deploy 'No SSH account given.' }
    $securePassword = Read-Host "Password for $User@$Server (Enter alone: use an SSH key)" -AsSecureString
}
$password = ''
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) "token-monitor-deploy-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $workDir | Out-Null
# The uploads land in the SSH account's home under this common name.
$stage = "token-monitor-deploy-$($deploy.Short)"

try {
    # One password for every ssh / scp below: OpenSSH asks this helper instead
    # of the console, and it reads the password from this process's
    # environment, so the password is never written to disk.
    $sshOptions = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'NumberOfPasswordPrompts=1')
    if ($password) {
        $askpass = Join-Path $workDir 'askpass.cmd'
        Set-Content -LiteralPath $askpass -Encoding ascii -Value '@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:TOKEN_MONITOR_DEPLOY_PASSWORD)"'
        $env:TOKEN_MONITOR_DEPLOY_PASSWORD = $password
        $env:SSH_ASKPASS = $askpass
        $env:SSH_ASKPASS_REQUIRE = 'force'
    }
    $destination = "$User@$Server"

    # A mistyped password or an unreachable server stops the deploy here,
    # before the minutes the build takes.
    Write-Info "Logging in to ${destination}..."
    Invoke-Native "The login to $destination" { ssh @sshOptions -p $SshPort $destination true }
    Write-Ok "Logged in to $destination."
    Assert-Docker

    $archive = Join-Path $workDir "$stage.src.tar"
    $upstreamVersion = Resolve-ReleaseFolder -Deploy $deploy -Ref $Ref -Archive $archive -NeedArchive $true

    $deployTag = Resolve-HubImage -ReleaseDir $deploy.Target -Tag "${Image}:$upstreamVersion-local.$($deploy.Short)" -SkipBuild $SkipBuild
    $imageTar = Join-Path $workDir "$stage.image.tar"
    Write-Info 'Saving the image for upload...'
    Invoke-Native 'docker save' { docker save -o $imageTar $deployTag }

    $scriptFile = Join-Path $workDir "$stage.sh"
    $serverText = [System.IO.File]::ReadAllText($ServerScript)
    [System.IO.File]::WriteAllText($scriptFile, ($serverText -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $uploads = @($archive, $imageTar, $scriptFile)
    if ($EnvFile) {
        $envUpload = Join-Path $workDir "$stage.env"
        Copy-Item -LiteralPath $EnvFile -Destination $envUpload
        $uploads += $envUpload
    }

    Write-Info "Uploading to ${destination}..."
    Invoke-Native 'scp' { scp @sshOptions -P $SshPort @uploads "${destination}:" }

    # Single-quoted for the remote shell. No double quotes: Windows PowerShell
    # mangles them in native arguments.
    $remoteArgs = @($deploy.Commit, $Ref, $upstreamVersion, $deployTag, $stage, $RemoteDir, $Server, "uploaded from $env:COMPUTERNAME") |
        ForEach-Object { "'" + "$_".Replace("'", "'\''") + "'" }
    $skip = if ($SkipBackup) { 'SKIP_BACKUP=1 ' } else { '' }
    $reset = if ($ResetDatabase) { 'RESET_DATABASE=1 ' } else { '' }
    $remoteCommand = "${skip}${reset}bash ~/$stage.sh $($remoteArgs -join ' ')"

    # The password goes on stdin, as the remote script's first line (sudo).
    $previousEncoding = $OutputEncoding
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    try {
        Invoke-Native "Deploy on $Server" { $password | & ssh @sshOptions -p $SshPort $destination $remoteCommand }
    } finally {
        $OutputEncoding = $previousEncoding
    }
    Write-Ok "Deployed $($deploy.Short) to $Server."
} finally {
    $password = $null
    Remove-Item Env:\TOKEN_MONITOR_DEPLOY_PASSWORD, Env:\SSH_ASKPASS, Env:\SSH_ASKPASS_REQUIRE -ErrorAction SilentlyContinue
    if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
}


PAUSE