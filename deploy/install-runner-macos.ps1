<#
.SYNOPSIS
    Install the GitLab runner tagged macos on a Mac over SSH, started at boot.

.DESCRIPTION
    Builds the macOS client (build:client:macos in .gitlab-ci.yml). On the Mac,
    as the SSH account, it:
      1. installs the Xcode Command Line Tools (git, python3) when missing;
      2. installs Node <NodeMajor> from nodejs.org into /usr/local/bin when
         missing or older than the client build needs (22.15);
      3. installs gitlab-runner into /usr/local/bin when missing
         (-UpgradeRunner: the latest one);
      4. keeps the runner registered in ~/.gitlab-runner/config.toml, or
         registers one with the token (-Token or .env.runner);
      5. runs it as the LaunchDaemon /Library/LaunchDaemons/gitlab-runner.plist
         under the SSH account: it starts at boot, without anyone logging in,
         and restarts when it stops;
      6. keeps the Mac awake on the power adapter (pmset -c sleep 0), unless
         -AllowSleep: a sleeping Mac takes no jobs.

    Run it again at any time: what is already in place is kept. It restarts the
    runner, which cuts off a job that is running.

    The password is held in memory only, for ssh/scp and for sudo; the account
    must be an administrator. A token comes from Settings -> CI/CD -> Runners
    -> New project runner (tag macos, Run untagged jobs off); a runner that is
    already registered needs none. docs/client-build.zh-TW.md has the details.

.EXAMPLE
    .\deploy\install-runner-macos.ps1
    Ask for the SSH account and password, then set up 192.0.2.20.

.EXAMPLE
    .\deploy\install-runner-macos.ps1 -Server 192.0.2.21 -User admin -Token glrt-xxxxxxxx
    Register a new runner on another Mac.

.EXAMPLE
    .\deploy\install-runner-macos.ps1 -Reregister
    Register again with the token in .env.runner; the old config.toml is kept beside it.
#>
[CmdletBinding()]
param(
    # The Mac. Change the default here when it moves.
    [string]$Server = '192.0.2.20',

    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,

    # SSH account, the one that runs the builds; asked for when not given, and
    # so is the password.
    [string]$User,

    # Account and password in one (Get-Credential), instead of being asked.
    [pscredential]$Credential,

    # Runner authentication token (glrt-...), only for registering; without it,
    # TM_RUNNER_TOKEN_MACOS in .env.runner.
    [string]$Token,

    [string]$GitLabUrl = 'https://gitlab.example.com',

    # The runner's description in GitLab; default mac-<the Mac's host name>.
    [string]$Description,

    [ValidateRange(22, 99)]
    [int]$NodeMajor = 22,

    # Register again even though config.toml has a runner for $GitLabUrl.
    [switch]$Reregister,

    # Replace /usr/local/bin/gitlab-runner with the latest release.
    [switch]$UpgradeRunner,

    # Leave the Mac's sleep settings alone.
    [switch]$AllowSleep
)

. (Join-Path $PSScriptRoot 'common.ps1')

# Runs on the Mac with bash 3.2 (macOS's own). Arguments: GitLab URL,
# description, Node major version, then 1/0 for reregister, upgrade runner and
# allow sleep, and the upload's name in $HOME. Stdin: the password, the token.
$RemoteScript = @'
set -euo pipefail
gitlab_url=${1%/}; description=$2; node_major=$3; reregister=$4; upgrade_runner=$5; allow_sleep=$6; stage=$7
LABEL=gitlab-runner
PLIST=/Library/LaunchDaemons/$LABEL.plist
RUNNER=/usr/local/bin/gitlab-runner
CONFIG=$HOME/.gitlab-runner/config.toml
LOG=$HOME/Library/Logs/gitlab-runner.log
TAG=macos

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
as_root() { printf '%s\n' "$pw" | sudo -S -k -p '' "$@"; }

[ "$(uname -s)" = Darwin ] || die "$(hostname) is not a Mac."
[ "$(id -u)" != 0 ] || die "Log in as the account that runs the builds, not root."
as_root true 2>/dev/null || die "sudo failed for $(id -un): give the password of an administrator account."
user=$(id -un); group=$(id -gn); home=$HOME
[ -n "$description" ] || description="mac-$(hostname -s)"
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=amd64; warn "This is an Intel Mac; the client build makes an arm64 dmg." ;;
  *) die "Unknown CPU: $(uname -m)" ;;
esac
info "Mac: $(hostname -s), macOS $(sw_vers -productVersion), $(uname -m), account $user"

# --- Xcode Command Line Tools: git for the checkout, python3 for the dmg ---
clt_ok() { local dir; dir=$(xcode-select -p 2>/dev/null) && [ -x "$dir/usr/bin/git" ]; }
if clt_ok; then
  info "Xcode Command Line Tools: $(xcode-select -p)"
else
  info "Installing the Xcode Command Line Tools (about 1 GB, several minutes)..."
  # Makes softwareupdate offer them without the dialog of xcode-select --install.
  marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  touch "$marker"
  label=$(softwareupdate -l 2>/dev/null | sed -n 's/^[[:space:]]*\* Label: \(Command Line Tools.*\)$/\1/p' | grep -vi beta | tail -n 1 || true)
  if [ -z "$label" ]; then
    rm -f "$marker"
    die "softwareupdate offers no Command Line Tools. Install them on the Mac with xcode-select --install, then run this again."
  fi
  as_root softwareupdate -i "$label" --verbose
  rm -f "$marker"
  clt_ok || die "The Command Line Tools did not install ($label)."
  info "Installed $label."
fi

# --- Node, in /usr/local/bin: on every shell's PATH, nothing to configure ---
node_ok() {
  [ -x /usr/local/bin/node ] && /usr/local/bin/node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a === $node_major && (a > 22 || b >= 15) ? 0 : 1)"
}
if node_ok; then
  info "Node: $(/usr/local/bin/node -v)"
else
  base="https://nodejs.org/dist/latest-v$node_major.x"
  sums=$(curl -fsSL --retry 3 "$base/SHASUMS256.txt") || die "Cannot reach $base."
  pkg=$(printf '%s\n' "$sums" | awk '$2 ~ /^node-v[0-9.]+\.pkg$/ { print $2; exit }')
  sum=$(printf '%s\n' "$sums" | awk -v f="$pkg" '$2 == f { print $1; exit }')
  [ -n "$pkg" ] && [ -n "$sum" ] || die "No macOS installer in $base."
  info "Installing $pkg..."
  curl -fsSL --retry 3 -o "$work/$pkg" "$base/$pkg"
  [ "$(shasum -a 256 "$work/$pkg" | awk '{ print $1 }')" = "$sum" ] || die "$pkg does not match SHASUMS256.txt."
  as_root installer -pkg "$work/$pkg" -target / >/dev/null
  node_ok || die "Node $node_major (>= 22.15) is still not in /usr/local/bin."
  info "Node: $(/usr/local/bin/node -v)"
fi

# --- Stop the runner while its binary and service change ---
if as_root launchctl print "system/$LABEL" >/dev/null 2>&1; then
  as_root launchctl bootout "system/$LABEL" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    as_root launchctl print "system/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
fi
# A per-login copy (gitlab-runner install, brew services) would take the same
# jobs a second time, and only while someone is logged in.
for agent in "$home/Library/LaunchAgents/gitlab-runner.plist" "$home/Library/LaunchAgents/homebrew.mxcl.gitlab-runner.plist"; do
  [ -f "$agent" ] || continue
  launchctl bootout "gui/$(id -u)" "$agent" 2>/dev/null || true
  mv "$agent" "$agent.disabled"
  info "Disabled $agent (moved to $agent.disabled); the LaunchDaemon replaces it."
done

# --- gitlab-runner ---
if [ ! -x "$RUNNER" ] || [ "$upgrade_runner" = 1 ]; then
  url="https://s3.dualstack.us-east-1.amazonaws.com/gitlab-runner-downloads/latest/binaries/gitlab-runner-darwin-$arch"
  info "Downloading gitlab-runner ($arch)..."
  curl -fsSL --retry 3 -o "$work/gitlab-runner" "$url"
  chmod +x "$work/gitlab-runner"
  "$work/gitlab-runner" --version >/dev/null || die "The downloaded gitlab-runner does not run."
  as_root mkdir -p /usr/local/bin
  as_root install -m 755 -o root -g wheel "$work/gitlab-runner" "$RUNNER"
fi
info "gitlab-runner: $("$RUNNER" --version 2>/dev/null | sed -n 's/^Version:[[:space:]]*//p')"

# --- Registration ---
registered=0
if [ -f "$CONFIG" ] && grep -q '^\[\[runners\]\]' "$CONFIG" && grep -Fq "url = \"$gitlab_url" "$CONFIG"; then registered=1; fi
if [ "$registered" = 1 ] && [ "$reregister" != 1 ]; then
  info "Keeping the runner in $CONFIG: $(sed -n 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"\(.*\)"$/\1/p' "$CONFIG" | head -n 1)"
else
  [ -n "$token" ] || die "No runner token: create one in GitLab (Settings -> CI/CD -> Runners -> New project runner, tag $TAG) and pass -Token or set TM_RUNNER_TOKEN_MACOS in .env.runner."
  mkdir -p "$(dirname "$CONFIG")"
  if [ -f "$CONFIG" ]; then
    saved="$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$CONFIG" "$saved"
    info "Saved the previous configuration as $saved; remove its runner in GitLab if it is not used any more."
  fi
  case "$token" in
    # An old registration token: the tags are given here, not in GitLab.
    GR1348941*) auth="--registration-token $token --tag-list $TAG --run-untagged=false" ;;
    *) auth="--token $token" ;;
  esac
  # shellcheck disable=SC2086
  "$RUNNER" register --non-interactive --config "$CONFIG" --url "$gitlab_url" $auth \
    --executor shell --shell bash --description "$description" 2>&1 | grep -v -e 'Running in user-mode' -e 'Use sudo for system-mode' -e '\$ sudo gitlab-runner' || true
  grep -q '^\[\[runners\]\]' "$CONFIG" 2>/dev/null || die "Registration failed; check the token."
  info "Registered $description."
fi
"$RUNNER" verify --config "$CONFIG" 2>&1 | grep -E 'Verifying runner|ERROR|FATAL' || true

# --- LaunchDaemon: at boot, as $user, restarted when it stops ---
mkdir -p "$(dirname "$LOG")"
touch "$LOG"
cat > "$work/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNNER</string>
    <string>run</string>
    <string>--config</string><string>$CONFIG</string>
    <string>--working-directory</string><string>$home</string>
    <string>--service</string><string>$LABEL</string>
  </array>
  <key>UserName</key><string>$user</string>
  <key>GroupName</key><string>$group</string>
  <key>WorkingDirectory</key><string>$home</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$home</string>
    <key>USER</key><string>$user</string>
    <key>LOGNAME</key><string>$user</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$work/$LABEL.plist" >/dev/null || die "The LaunchDaemon plist is not valid."
as_root install -m 644 -o root -g wheel "$work/$LABEL.plist" "$PLIST"
as_root launchctl enable "system/$LABEL"
as_root launchctl bootstrap system "$PLIST"
running=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if pgrep -f "$RUNNER run" >/dev/null; then running=1; break; fi
done
[ "$running" = 1 ] || { tail -n 20 "$LOG" >&2; die "The runner did not start; the lines above are from $LOG."; }
info "The runner is running as $user and starts at boot ($PLIST)."

# --- Power: a sleeping Mac takes no jobs ---
if [ "$allow_sleep" = 1 ]; then
  info "Leaving the sleep settings alone (-AllowSleep)."
else
  old=$(pmset -g custom | awk '/^AC Power/ { ac = 1; next } /^[A-Za-z]/ { ac = 0 } ac && $1 == "sleep" { print $2 }')
  if [ "$old" != 0 ]; then
    as_root pmset -c sleep 0
    info "On the power adapter the Mac no longer sleeps (it was ${old:-?} minutes; undo: sudo pmset -c sleep ${old:-1}). The display still turns off."
  fi
fi
pmset -g batt | grep -q "AC Power" || warn "The Mac is on battery: it still sleeps, and then the runner is offline. Keep it on the power adapter."
if command -v system_profiler >/dev/null && system_profiler SPHardwareDataType 2>/dev/null | grep -qi 'MacBook'; then
  warn "Closing the lid puts a MacBook to sleep anyway, unless an external display is connected."
fi
if fdesetup status 2>/dev/null | grep -q 'FileVault is On'; then
  warn "FileVault is on: after a restart the runner starts only once someone unlocks the disk at the login screen."
fi

# --- What the builds need from outside ---
for site in https://registry.npmjs.org/ https://github.com/ "$gitlab_url/"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$site" || true)
  [ "$code" != 000 ] || warn "Cannot reach $site from the Mac; the build needs it."
done

info ""
info "Runner $description on $(hostname -s): log $LOG"
info "  restart: sudo launchctl kickstart -k system/$LABEL"
info "  stop:    sudo launchctl bootout system/$LABEL   (start: sudo launchctl bootstrap system $PLIST)"
info "GitLab shows it online (a green dot) within a minute: Settings -> CI/CD -> Runners."
'@

$repoRoot = Split-Path -Parent $PSScriptRoot
foreach ($tool in @('ssh', 'scp')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Deploy "$tool was not found on PATH." }
}
$runnerToken = Resolve-RunnerToken -Token $Token -RepoRoot $repoRoot -Name 'TM_RUNNER_TOKEN_MACOS'
if ($Reregister -and -not $runnerToken) { Stop-Deploy '-Reregister needs a token: -Token, or TM_RUNNER_TOKEN_MACOS in .env.runner.' }
$login = Read-SshLogin -Server $Server -User $User -Credential $Credential
if (-not $login.Password) { Write-Warn 'No password: sudo on the Mac must not ask for one.' }

$flags = @($Reregister, $UpgradeRunner, $AllowSleep) | ForEach-Object { if ($_) { '1' } else { '0' } }
try {
    # caffeinate: the Mac must not fall asleep in the middle of the install.
    Invoke-RemoteScript -Server $Server -Port $SshPort -Login $login -Name 'install-runner-macos' -Script $RemoteScript `
        -Arguments (@($GitLabUrl, $Description, "$NodeMajor") + $flags) -Stdin @($login.Password, $runnerToken) -Prefix 'caffeinate -i'
    Write-Ok "The macos runner on $Server is installed."
} finally {
    $login.Password = $null
}

PAUSE
