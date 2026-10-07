<#
.SYNOPSIS
    Install the GitLab runner tagged ubuntu (Docker executor) on an Ubuntu server over SSH.

.DESCRIPTION
    Runs verify, build:client:windows, build:client:linux and release:client
    (.gitlab-ci.yml), each in a Docker container. On the server it:
      1. installs Docker (get.docker.com) when missing;
      2. installs gitlab-runner from GitLab's apt repository when missing
         (-UpgradeRunner: the latest one);
      3. keeps the runner registered in /etc/gitlab-runner/config.toml, or
         registers one with the token (-Token or .env.runner), executor
         docker, default image node:22;
      4. enables the gitlab-runner systemd service, so it starts at boot.

    With -HubDeploy it sets up the hub-deploy runner on the same server
    instead: build:hub and deploy:hub run in a shell there and use the
    server's own Docker. It has its own configuration
    (/etc/gitlab-runner/hub-deploy.toml) and systemd service
    (gitlab-runner-hub-deploy), so the ubuntu runner is left alone. It also
    installs git and Node.js 22 (NodeSource) when missing, adds the
    gitlab-runner account to the docker group and makes -DeployDir, the
    release folder deploy:hub deploys to.

    Run it again at any time: what is already in place is kept, and a running
    job is left alone unless gitlab-runner itself was installed or upgraded.

    The password is held in memory only, for ssh/scp and for sudo; the account
    must be able to sudo. A token comes from Settings -> CI/CD -> Runners -> New
    project runner (tag ubuntu, Run untagged jobs off, Protected off: verify
    runs for merge requests); a runner that is already registered needs none.
    docs/client-build.zh-TW.md has the details. The hub-deploy runner's token:
    tag hub-deploy, Run untagged jobs off, Protected ON - the docker group is
    root on the server, so only protected branches and tags may run there
    (docs/hub.zh-TW.md, "從 GitLab 部署").

.EXAMPLE
    .\deploy\install-runner-ubuntu.ps1
    Ask for the SSH account and password, then set up 192.0.2.10.

.EXAMPLE
    .\deploy\install-runner-ubuntu.ps1 -Server 192.0.2.11 -User deploy -Token glrt-xxxxxxxx
    Register a new runner on another server.

.EXAMPLE
    .\deploy\install-runner-ubuntu.ps1 -HubDeploy
    Set up the hub-deploy runner on 192.0.2.10 (token: TM_RUNNER_TOKEN_HUB_DEPLOY in .env.runner).
#>
[CmdletBinding()]
param(
    # The Ubuntu server, by default the hub's (3.deploy-ubuntu.ps1). Change the
    # default here when the runner moves.
    [string]$Server = '192.0.2.10',

    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,

    # SSH account; asked for when not given, and so is the password.
    [string]$User,

    # Account and password in one (Get-Credential), instead of being asked.
    [pscredential]$Credential,

    # Runner authentication token (glrt-...), only for registering; without it,
    # TM_RUNNER_TOKEN_UBUNTU in .env.runner (-HubDeploy: TM_RUNNER_TOKEN_HUB_DEPLOY).
    [string]$Token,

    [string]$GitLabUrl = 'https://gitlab.example.com',

    # The runner's description in GitLab; -HubDeploy: token-monitor-hub-deploy.
    [string]$Description = 'token-monitor-ubuntu',

    # Set up the hub-deploy runner (shell executor) instead of the ubuntu one.
    [switch]$HubDeploy,

    # The release folder deploy:hub deploys to: TM_HUB_DEPLOY_DIR in
    # .gitlab-ci.yml. Made for -HubDeploy, owned by gitlab-runner.
    [string]$DeployDir = '/opt/token-monitor',

    # The image of a job that names none; every job in .gitlab-ci.yml names one.
    [string]$DockerImage = 'node:22',

    # Register again even though config.toml has a runner for $GitLabUrl.
    [switch]$Reregister,

    # Upgrade gitlab-runner to the latest release.
    [switch]$UpgradeRunner
)

. (Join-Path $PSScriptRoot 'common.ps1')

# Runs on the server with bash. Arguments: GitLab URL, description, Docker
# image, then 1/0 for reregister and upgrade runner, the mode (ubuntu or
# hub-deploy), the deploy folder, and the upload's name in $HOME. Stdin: the
# password, the token.
$RemoteScript = @'
set -euo pipefail
gitlab_url=${1%/}; description=$2; docker_image=$3; reregister=$4; upgrade_runner=$5; mode=$6; deploy_dir=$7; stage=$8
if [ "$mode" = hub-deploy ]; then
  # Its own configuration and service: the ubuntu runner's stay as they are.
  CONFIG=/etc/gitlab-runner/hub-deploy.toml
  SERVICE=gitlab-runner-hub-deploy
  TAG=hub-deploy
  TOKEN_NAME=TM_RUNNER_TOKEN_HUB_DEPLOY
  TOKEN_HINT="tag $TAG, Run untagged jobs off, Protected on"
  EXECUTOR=(--executor shell)
else
  CONFIG=/etc/gitlab-runner/config.toml
  SERVICE=gitlab-runner
  TAG=ubuntu
  TOKEN_NAME=TM_RUNNER_TOKEN_UBUNTU
  TOKEN_HINT="tag $TAG"
  EXECUTOR=(--executor docker --docker-image "$docker_image")
fi

pw=; token=
IFS= read -r pw || true
IFS= read -r token || true
# Windows PowerShell's pipe can add a BOM and a CR.
pw=${pw#$'\xef\xbb\xbf'}; pw=${pw%$'\r'}; token=${token%$'\r'}
work=$(mktemp -d)
trap 'rm -rf "$work" "$HOME/$stage".*' EXIT

info() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
# -k: always read the password, so it never reaches the command's stdin.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else printf '%s\n' "$pw" | sudo -S -k -p '' "$@"; fi
}

command -v apt-get >/dev/null 2>&1 || die "$(hostname) has no apt-get; this script is for Ubuntu (or Debian)."
as_root true 2>/dev/null || die "sudo failed for $(id -un): give the password of an account that can sudo."
. /etc/os-release
info "Server: $(hostname), ${PRETTY_NAME:-Linux}, $(uname -m), account $(id -un)"

# --- Docker ---
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker (get.docker.com)..."
  curl -fsSL --retry 3 -o "$work/get-docker.sh" https://get.docker.com
  as_root sh "$work/get-docker.sh"
fi
as_root systemctl enable --now docker >/dev/null 2>&1 || true
as_root docker info >/dev/null 2>&1 || die "Docker does not run: sudo systemctl status docker"
info "Docker: $(as_root docker version --format '{{.Server.Version}}' 2>/dev/null)"

# --- gitlab-runner ---
changed=0
if ! command -v gitlab-runner >/dev/null 2>&1 || [ "$upgrade_runner" = 1 ]; then
  info "Installing gitlab-runner from GitLab's apt repository..."
  # Adds the repository and runs apt-get update.
  curl -fsSL --retry 3 -o "$work/runner-repo.sh" https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh
  as_root bash "$work/runner-repo.sh" >/dev/null
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q gitlab-runner
  changed=1
fi
info "gitlab-runner: $(gitlab-runner --version 2>/dev/null | sed -n 's/^Version:[[:space:]]*//p')"

# --- What build:hub and deploy:hub need (hub-deploy) ---
if [ "$mode" = hub-deploy ]; then
  runner_home=$(getent passwd gitlab-runner | cut -d: -f6)
  [ -n "$runner_home" ] || die "The gitlab-runner account is missing; install gitlab-runner again with -UpgradeRunner."
  if ! command -v git >/dev/null 2>&1; then
    info "Installing git..."
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q git
  fi
  # build:hub runs scripts/build-hub-image.js: Node >= 22.15, as verify checks.
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)' >/dev/null 2>&1; then
    info "Installing Node.js 22 from NodeSource's apt repository..."
    # Adds the repository and runs apt-get update.
    curl -fsSL --retry 3 -o "$work/nodesource.sh" https://deb.nodesource.com/setup_22.x
    as_root bash "$work/nodesource.sh" >/dev/null
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
  fi
  info "Node.js: $(node --version)"
  # The jobs run docker on this server. The docker group is root here, which
  # is why this runner only takes protected branches and tags.
  as_root usermod -aG docker gitlab-runner
  # Ubuntu's .bash_logout runs clear_console, which fails every shell job.
  as_root rm -f "$runner_home/.bash_logout"
  as_root install -d -o gitlab-runner -g gitlab-runner -m 750 "$deploy_dir"
  info "deploy:hub deploys to $deploy_dir."
fi

# --- Registration ---
registered=0
if as_root grep -q '^\[\[runners\]\]' "$CONFIG" 2>/dev/null && as_root grep -Fq "url = \"$gitlab_url" "$CONFIG"; then registered=1; fi
if [ "$registered" = 1 ] && [ "$reregister" != 1 ]; then
  info "Keeping the runner in $CONFIG: $(as_root sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\(.*\)"$/\1/p' "$CONFIG" | head -n 1)"
else
  [ -n "$token" ] || die "No runner token: create one in GitLab (Settings -> CI/CD -> Runners -> New project runner, $TOKEN_HINT) and pass -Token or set $TOKEN_NAME in .env.runner."
  if as_root test -f "$CONFIG"; then
    saved="$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
    as_root mv "$CONFIG" "$saved"
    info "Saved the previous configuration as $saved; remove its runner in GitLab if it is not used any more."
  fi
  case "$token" in
    # An old registration token: the tags are given here, not in GitLab.
    GR1348941*) auth="--registration-token $token --tag-list $TAG --run-untagged=false" ;;
    *) auth="--token $token" ;;
  esac
  # shellcheck disable=SC2086
  as_root gitlab-runner register --non-interactive --config "$CONFIG" --url "$gitlab_url" $auth \
    "${EXECUTOR[@]}" --description "$description" 2>&1 || true
  as_root grep -q '^\[\[runners\]\]' "$CONFIG" 2>/dev/null || die "Registration failed; check the token."
  info "Registered $description."
fi

# --- Service: systemd, at boot ---
# The package installs the ubuntu runner's; the hub-deploy runner's runs its
# jobs as gitlab-runner, with its own configuration.
if [ "$SERVICE" != gitlab-runner ] && ! as_root test -f "/etc/systemd/system/$SERVICE.service"; then
  as_root gitlab-runner install --service "$SERVICE" --config "$CONFIG" --user gitlab-runner --working-directory "$runner_home"
  changed=1
fi
as_root systemctl enable "$SERVICE" >/dev/null 2>&1
if [ "$changed" = 1 ]; then as_root systemctl restart "$SERVICE"; else as_root systemctl start "$SERVICE"; fi
as_root gitlab-runner verify --config "$CONFIG" 2>&1 | grep -E 'Verifying runner|ERROR|FATAL' || true
sleep 2
[ "$(as_root systemctl is-active "$SERVICE")" = active ] || { as_root journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true; die "$SERVICE did not start."; }
info "$SERVICE is running and starts at boot (systemd)."

# --- What the builds need ---
free_gb=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -n 1 | tr -dc '0-9')
[ -z "$free_gb" ] || [ "$free_gb" -ge 10 ] || warn "Only ${free_gb} GB free for Docker; a Windows client build pulls about 3 GB."
for site in https://registry.npmjs.org/ https://github.com/ https://registry-1.docker.io/ "$gitlab_url/"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$site" || true)
  [ "$code" != 000 ] || warn "Cannot reach $site from the server; the builds need it."
done

info ""
info "Runner $description on $(hostname):"
info "  status:  sudo systemctl status $SERVICE"
info "  log:     sudo journalctl -u $SERVICE -f"
info "GitLab shows it online (a green dot) within a minute: Settings -> CI/CD -> Runners."
'@

$repoRoot = Split-Path -Parent $PSScriptRoot
foreach ($tool in @('ssh', 'scp')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Deploy "$tool was not found on PATH." }
}
if ($HubDeploy) {
    $mode = 'hub-deploy'
    $tokenName = 'TM_RUNNER_TOKEN_HUB_DEPLOY'
    if (-not $PSBoundParameters.ContainsKey('Description')) { $Description = 'token-monitor-hub-deploy' }
} else {
    $mode = 'ubuntu'
    $tokenName = 'TM_RUNNER_TOKEN_UBUNTU'
}
$runnerToken = Resolve-RunnerToken -Token $Token -RepoRoot $repoRoot -Name $tokenName
if ($Reregister -and -not $runnerToken) { Stop-Deploy "-Reregister needs a token: -Token, or $tokenName in .env.runner." }
$login = Read-SshLogin -Server $Server -User $User -Credential $Credential
if (-not $login.Password) { Write-Warn 'No password: sudo on the server must not ask for one (or log in as root).' }

$flags = @($Reregister, $UpgradeRunner) | ForEach-Object { if ($_) { '1' } else { '0' } }
try {
    Invoke-RemoteScript -Server $Server -Port $SshPort -Login $login -Name 'install-runner-ubuntu' -Script $RemoteScript `
        -Arguments (@($GitLabUrl, $Description, $DockerImage) + $flags + @($mode, $DeployDir)) -Stdin @($login.Password, $runnerToken)
    Write-Ok "The $mode runner on $Server is installed."
} finally {
    $login.Password = $null
}

PAUSE
