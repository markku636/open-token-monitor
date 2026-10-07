# Shared by 1.token-monitor-release.ps1, 2.deploy-local.ps1 and
# 3.deploy-ubuntu.ps1, which dot-source it: assembling the release folder and
# building the hub image. See docs/hub.zh-TW.md, "部署". install-runner-macos.ps1 and
# install-runner-ubuntu.ps1 use its SSH and runner functions at the end.

$ErrorActionPreference = 'Stop'

$Image = 'token-monitor-hub'
# compose.yml pins the project name, so these names do not depend on the folder.
$PostgresContainer = 'token-monitor-postgres'
$HubContainer = 'token-monitor-hub'
$PostgresVolume = 'token-monitor_postgres-data'
$Marker = 'RELEASE-INFO.txt'
# Kept when a release folder is refreshed: local settings, data, backups.
$Keep = @('.env', '.env.ubuntu', 'data', 'backups')
# Committed but left out of a release folder: developer tooling the hub never runs.
$ReleaseExclude = @('api-testing')
# Filled with generated values in a first .env; the rest stay as in .env.example.
$GeneratedKeys = @('TOKEN_MONITOR_SECRET', 'TOKEN_MONITOR_CLIENT_SECRETS', 'POSTGRES_PASSWORD', 'TOKEN_MONITOR_DB_PASSWORD')
# Only take effect when the database volume is created (docs/postgres.zh-TW.md).
$DatabaseKeys = @('POSTGRES_PASSWORD', 'TOKEN_MONITOR_DB_PASSWORD')
# Commented out in .env.example, switched on in a first .env (New-EnvLines).
$PublicDashboard = 'TOKEN_MONITOR_PUBLIC_DASHBOARD=1'
$HealthProbe = "fetch('http://127.0.0.1:17321/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Windows' own bsdtar: Git's GNU tar would read the drive letter in D:\... as a remote host.
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

function Write-Info { param([string]$Message) Write-Host $Message }
function Write-Ok { param([string]$Message) Write-Host $Message -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host $Message -ForegroundColor Red }

function Stop-Deploy {
    param([string]$Message)
    Write-Err $Message
    exit 1
}

# Runs a native command and fails the deploy on a non-zero exit. Its output
# goes to the console, never into a function's return value. Only the exit
# code counts: docker and ssh write progress to stderr, which Windows
# PowerShell would turn into a terminating error when the deploy's output is
# redirected.
function Invoke-Native {
    param([string]$What, [scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # A stderr line arrives as an ErrorRecord holding the line as its target.
        & $Command 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "$($_.TargetObject)" } else { $_ } } | Out-Host
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { Stop-Deploy "$What failed (exit $code)." }
}

# True when a native command succeeds; its output is discarded. Windows
# PowerShell turns redirected stderr into errors, so relax that meanwhile.
function Test-Native {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $previous
    }
}

function New-HexSecret {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# UTF-8 without a BOM and LF line ends, like the committed files.
function Write-TextFile {
    param([string]$Path, [string[]]$Lines)
    $text = ($Lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-DotEnvValue {
    param([string]$Path, [string]$Name)
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ''
}

function Test-SamePathOrInside {
    param([string]$Path, [string]$Root)
    $p = $Path.TrimEnd('\') + '\'
    $r = $Root.TrimEnd('\') + '\'
    return $p.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ImageId {
    param([string]$Name)
    if (-not (Test-Native { docker image inspect $Name })) { return $null }
    return "$(& docker image inspect -f '{{.Id}}' $Name)".Trim()
}

function Get-ReleaseCommit {
    param([string]$Folder)
    foreach ($line in (Get-Content -LiteralPath (Join-Path $Folder $Marker))) {
        if ($line -match '^commit:\s*(\S+)') { return $Matches[1] }
    }
    return 'unknown'
}

function Get-ShortCommit {
    param([string]$Commit)
    if ($Commit.Length -gt 12) { return $Commit.Substring(0, 12) }
    return $Commit
}

# Tools, the repository, the release folder's path and the commit to deploy.
# Run from a release folder's own deploy\ (it has RELEASE-INFO.txt and no
# git), the release folder is that folder, deployed as it is: InRelease.
# With -UseRelease (the deploy scripts, unless given -Ref), a checkout deploys
# the release folder 1.token-monitor-release.ps1 made at -Target as it is too;
# Repo stays set, so the checkout's .env is still installed.
function Initialize-Deploy {
    param([string]$RepoRoot, [string]$Target, [string]$Ref, [string[]]$Tools, [bool]$UseRelease = $false)
    $inRelease = Test-Path (Join-Path $RepoRoot $Marker)
    $required = if ($inRelease) { $Tools } else { @('git') + $Tools }
    foreach ($tool in $required) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Deploy "$tool was not found on PATH." }
    }
    if (-not (Test-Path $Tar)) { Stop-Deploy "$Tar was not found (Windows 10 or later ships it)." }
    if (-not (Test-Path (Join-Path $RepoRoot 'upstream.js'))) {
        Stop-Deploy 'Keep the deploy scripts in deploy\ of the open-token-monitor checkout or of a release folder; they locate it relative to their own path.'
    }

    if ($inRelease) {
        $folder = [System.IO.Path]::GetFullPath($RepoRoot)
        $commit = Get-ReleaseCommit $folder
        $short = Get-ShortCommit $commit
        Write-Info "Deploying this release folder as it is ($short); -Ref and -Target apply only in an open-token-monitor checkout."
        return [pscustomobject]@{ InRelease = $true; Repo = $null; Target = $folder; Commit = $commit; Short = $short }
    }

    if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path $RepoRoot $Target }
    $Target = [System.IO.Path]::GetFullPath($Target)
    $repoFull = [System.IO.Path]::GetFullPath($RepoRoot)
    if ((Test-SamePathOrInside -Path $Target -Root $repoFull) -or (Test-SamePathOrInside -Path $repoFull -Root $Target)) {
        Stop-Deploy "The release folder must be outside the repository: $Target"
    }

    if ($UseRelease) {
        if (-not (Test-Path (Join-Path $Target $Marker))) {
            Stop-Deploy "$Target is not a release folder yet. Run .\deploy\1.token-monitor-release.ps1 first, or pass -Ref HEAD to assemble it now."
        }
        $commit = Get-ReleaseCommit $Target
        $short = Get-ShortCommit $commit
        Write-Info "Deploying the release folder $Target as it is ($short); -Ref <ref> assembles it again first."
        $head = "$(& git -C $RepoRoot rev-parse --verify 'HEAD^{commit}')".Trim()
        if ($head -and $head -ne $commit) {
            Write-Warn "It is not this checkout's HEAD ($(Get-ShortCommit $head)); run .\deploy\1.token-monitor-release.ps1 to update it."
        }
        return [pscustomobject]@{ InRelease = $true; Repo = $repoFull; Target = $Target; Commit = $commit; Short = $short }
    }

    $commit = (& git -C $RepoRoot rev-parse --verify "$Ref^{commit}")
    if ($LASTEXITCODE -ne 0) { Stop-Deploy "Not a commit in this repository: $Ref" }
    $commit = "$commit".Trim()
    if (& git -C $RepoRoot status --porcelain) {
        Write-Warn "The working tree has uncommitted changes; they are not deployed (only $Ref = $($commit.Substring(0, 12)) is)."
    }
    return [pscustomobject]@{ InRelease = $false; Repo = $repoFull; Target = $Target; Commit = $commit; Short = $commit.Substring(0, 12) }
}

# Starts Docker Desktop when it is installed but not running, and waits for
# it, so a deploy does not depend on remembering to open it first.
function Assert-Docker {
    if (-not (Test-Native { docker info })) {
        $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktop)) { Stop-Deploy 'Docker is not running. Start Docker Desktop and try again.' }
        Write-Info 'Starting Docker Desktop...'
        Start-Process -FilePath $desktop
        $deadline = (Get-Date).AddMinutes(3)
        do {
            if ((Get-Date) -gt $deadline) { Stop-Deploy 'Docker Desktop did not come up within 3 minutes. Wait until it says it is running, then try again.' }
            Start-Sleep -Seconds 3
        } until (Test-Native { docker info })
        Write-Ok 'Docker Desktop is running.'
    }
    if (-not (Test-Native { docker compose version })) { Stop-Deploy 'docker compose (v2) is not available.' }
}

# A folder some process stands in (a shell opened in the release folder's
# deploy\) cannot be removed on Windows, but it can be emptied: that is enough,
# the refresh unpacks into it again.
function Remove-ReleaseItem {
    param([System.IO.FileSystemInfo]$Item)
    try {
        Remove-Item -LiteralPath $Item.FullName -Recurse -Force -Confirm:$false -ErrorAction Stop
    } catch {
        if (-not $Item.PSIsContainer) { throw }
        Get-ChildItem -LiteralPath $Item.FullName -Force | ForEach-Object { Remove-ReleaseItem $_ }
    }
}

# The release folder: upstream (pinned in upstream\) with the overlay at the
# root, exported from the commit with git archive into $Archive and unpacked
# into the target. Its .env, data\ and backups\ are kept; a folder this script
# did not make is moved aside, never deleted. Returns upstream's version.
function New-ReleaseFolder {
    param($Deploy, [string]$Ref, [string]$Archive)
    $target = $Deploy.Target
    if (Test-Path $target) {
        if (Test-Path (Join-Path $target $Marker)) {
            Get-ChildItem -LiteralPath $target -Force |
                Where-Object { $Keep -notcontains $_.Name } |
                ForEach-Object { Remove-ReleaseItem $_ }
        } else {
            $aside = "$target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Move-Item -LiteralPath $target -Destination $aside
            Write-Warn "$target was not made by the deploy scripts; moved it to $aside"
        }
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null

    # Through a file: Windows PowerShell re-encodes binary data piped between native commands.
    Invoke-Native 'git archive' { git -C $Deploy.Repo archive --format=tar -o $Archive $Deploy.Commit }
    $exclude = @($ReleaseExclude | ForEach-Object { '--exclude'; $_ })
    Invoke-Native 'tar' { & $Tar -xf $Archive @exclude -C $target }

    $upstreamVersion = (Get-Content -LiteralPath (Join-Path $target 'upstream\package.json') -Raw | ConvertFrom-Json).version
    Write-TextFile -Path (Join-Path $target $Marker) -Lines @(
        'Token Monitor company hub - release folder written by the deploy scripts.',
        'Everything except .env, data/ and backups/ is replaced on the next deploy; change the source repository instead.',
        '',
        "commit:   $($Deploy.Commit)",
        "ref:      $Ref",
        "upstream: $upstreamVersion",
        "source:   $($Deploy.Repo)",
        "created:  $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')"
    )
    Write-Ok "Release folder: $target ($($Deploy.Short), upstream $upstreamVersion)"
    return $upstreamVersion
}

# The release folder to deploy: assembled from the repository, or, run from a
# release folder, that folder as it is. $Archive then receives its files (the
# upload for deploy-ubuntu) without the local .env, data\ and backups\.
# Returns upstream's version.
function Resolve-ReleaseFolder {
    param($Deploy, [string]$Ref, [string]$Archive, [bool]$NeedArchive)
    if (-not $Deploy.InRelease) { return (New-ReleaseFolder -Deploy $Deploy -Ref $Ref -Archive $Archive) }
    if ($NeedArchive) {
        $exclude = @($Keep | ForEach-Object { '--exclude'; "./$_" })
        Invoke-Native 'tar' { & $Tar -cf $Archive @exclude -C $Deploy.Target . }
    }
    return (Get-Content -LiteralPath (Join-Path $Deploy.Target 'upstream\package.json') -Raw | ConvertFrom-Json).version
}

# .env.example with generated keys and passwords.
# The dashboard is public in a deployed hub, so users read usage without a key.
function New-EnvLines {
    param([string]$ExamplePath)
    foreach ($line in (Get-Content -LiteralPath $ExamplePath)) {
        $key = ($line -split '=', 2)[0]
        if ($GeneratedKeys -contains $key -and $line -eq "$key=") { "$key=$(New-HexSecret)" }
        elseif ($line -eq "# $PublicDashboard") { $PublicDashboard }
        else { $line }
    }
}

# The .env to deploy: -EnvFile, or else $Name in the checkout when it has one
# (.env: the settings `npm run hub` uses there too; .env.ubuntu: the server's).
function Resolve-EnvFile {
    param([string]$EnvFile, [string]$Repo, [string]$Name = '.env')
    if ($EnvFile) {
        if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { Stop-Deploy "No such file: $EnvFile" }
        return (Resolve-Path -LiteralPath $EnvFile).ProviderPath
    }
    if ($Repo) {
        $own = Join-Path $Repo $Name
        if (Test-Path -LiteralPath $own -PathType Leaf) { return $own }
    }
    return ''
}

# Makes $EnvFile the release folder's .env. A different one there goes to
# backups\ first, unless the two disagree on a database password: those only
# take effect when the volume is created, so a new one would lock the hub out.
function Install-ReleaseEnv {
    param([string]$Target, [string]$EnvFile)
    $targetEnv = Join-Path $Target '.env'
    if (-not (Test-Path -LiteralPath $targetEnv)) {
        Copy-Item -LiteralPath $EnvFile -Destination $targetEnv
        Write-Info "Copied $EnvFile to $targetEnv."
        return
    }
    if ([System.IO.Path]::GetFullPath($targetEnv) -eq [System.IO.Path]::GetFullPath($EnvFile)) { return }
    if ((Get-FileHash -LiteralPath $targetEnv).Hash -eq (Get-FileHash -LiteralPath $EnvFile).Hash) {
        Write-Info "The release folder's .env already matches $EnvFile."
        return
    }
    foreach ($key in $DatabaseKeys) {
        if ((Get-DotEnvValue -Path $targetEnv -Name $key) -ne (Get-DotEnvValue -Path $EnvFile -Name $key)) {
            Stop-Deploy "$EnvFile has a different $key than $targetEnv, and the database only accepts the one it was created with. Change it with ALTER ROLE first (docs/postgres.zh-TW.md), or, when the database is new, delete $targetEnv."
        }
    }
    $backupDir = Join-Path $Target 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $saved = Join-Path $backupDir "env-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    Copy-Item -LiteralPath $targetEnv -Destination $saved
    Copy-Item -LiteralPath $EnvFile -Destination $targetEnv -Force
    Write-Warn "Replaced $targetEnv with $EnvFile (the previous one: $saved)."
}

# Builds the image from the release folder as $Tag, or with -SkipBuild gives
# the existing :latest a tag of its own, so the deploy target keeps its current
# :latest until it has set it aside as :previous. Returns the tag to deploy.
function Resolve-HubImage {
    param([string]$ReleaseDir, [string]$Tag, [bool]$SkipBuild)
    if ($SkipBuild) {
        $id = Get-ImageId "${Image}:latest"
        if (-not $id) { Stop-Deploy "-SkipBuild needs an existing ${Image}:latest (npm run build:image, or docker load)." }
        $Tag = "${Image}:deploy-$($id.Replace('sha256:', '').Substring(0, 12))"
        Invoke-Native 'docker tag' { docker tag "${Image}:latest" $Tag }
        Write-Info "Using the existing ${Image}:latest ($Tag)."
        return $Tag
    }
    Invoke-Native 'docker build' { docker build -f (Join-Path $ReleaseDir 'docker\Dockerfile') -t $Tag $ReleaseDir }
    Write-Ok "Built $Tag."
    return $Tag
}

# --- GitLab runners (install-runner-*.ps1) ---

# The SSH account and its password, asked for when not given. The password is
# held in memory only; an empty one means an SSH key.
function Read-SshLogin {
    param([string]$Server, [string]$User, [pscredential]$Credential)
    if ($Credential) {
        $User = $Credential.UserName
        $securePassword = $Credential.Password
    } else {
        if (-not $User) { $User = Read-Host "SSH account on $Server" }
        if (-not $User) { Stop-Deploy 'No SSH account given.' }
        $securePassword = Read-Host "Password for $User@$Server (Enter alone: use an SSH key)" -AsSecureString
    }
    $plain = ''
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    return [pscustomobject]@{ User = $User; Password = $plain }
}

# A runner authentication token: -Token, or else $Name in .env.runner at the
# repository's root (gitignored, see .env.runner.example). '' when there is
# none: a runner that is already registered needs none.
function Resolve-RunnerToken {
    param([string]$Token, [string]$RepoRoot, [string]$Name)
    if ($Token) { return $Token.Trim() }
    $file = Join-Path $RepoRoot '.env.runner'
    if (Test-Path -LiteralPath $file -PathType Leaf) { return (Get-DotEnvValue -Path $file -Name $Name) }
    return ''
}

# Uploads $Script to the SSH account's home and runs it there with bash:
# $Arguments, then the upload's name (the script deletes it), single-quoted for
# the remote shell; $Stdin are its input lines, the password first (for sudo).
# $Prefix goes in front of bash, e.g. caffeinate on a Mac.
function Invoke-RemoteScript {
    param([string]$Server, [int]$Port, $Login, [string]$Name, [string]$Script, [string[]]$Arguments, [string[]]$Stdin, [string]$Prefix = '')
    $stage = "$Name-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $workDir = Join-Path ([System.IO.Path]::GetTempPath()) "token-monitor-$stage"
    New-Item -ItemType Directory -Path $workDir | Out-Null
    try {
        $scriptFile = Join-Path $workDir "$stage.sh"
        [System.IO.File]::WriteAllText($scriptFile, ($Script -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

        # As in 3.deploy-ubuntu.ps1: OpenSSH asks this helper instead of the
        # console, and it reads the password from this process's environment.
        $sshOptions = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'NumberOfPasswordPrompts=1')
        if ($Login.Password) {
            $askpass = Join-Path $workDir 'askpass.cmd'
            Set-Content -LiteralPath $askpass -Encoding ascii -Value '@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:TOKEN_MONITOR_DEPLOY_PASSWORD)"'
            $env:TOKEN_MONITOR_DEPLOY_PASSWORD = $Login.Password
            $env:SSH_ASKPASS = $askpass
            $env:SSH_ASKPASS_REQUIRE = 'force'
        }
        $destination = "$($Login.User)@$Server"
        Invoke-Native 'scp' { scp @sshOptions -P $Port $scriptFile "${destination}:" }

        # No double quotes: Windows PowerShell mangles them in native arguments.
        $quoted = @($Arguments) + $stage | ForEach-Object { "'" + "$_".Replace("'", "'\''") + "'" }
        $remoteCommand = "$Prefix bash ~/$stage.sh $($quoted -join ' ')".Trim()
        $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        Invoke-Native "The install on $Server" { $Stdin | & ssh @sshOptions -p $Port $destination $remoteCommand }
    } finally {
        Remove-Item Env:\TOKEN_MONITOR_DEPLOY_PASSWORD, Env:\SSH_ASKPASS, Env:\SSH_ASKPASS_REQUIRE -ErrorAction SilentlyContinue
        if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
    }
}
