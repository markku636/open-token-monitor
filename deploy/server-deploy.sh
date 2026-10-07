#!/usr/bin/env bash
# The server's half of a hub deploy (docs/hub.zh-TW.md, "部署"), run with bash on the
# Docker host: by 3.deploy-ubuntu.ps1 over SSH, and by the deploy:hub job on
# the hub-deploy runner (.gitlab-ci.yml).
#
# Arguments: commit, ref, upstream version, image tag, the staged files'
# common name, release folder, server address for the final URL, and where
# the release came from. The staged files, in $STAGE_DIR ($HOME by default)
# and deleted on exit: <name>.src.tar, the release folder's files;
# <name>.image.tar, loaded when there is one, or else the image tag must be in
# Docker already; <name>.env, the server's .env, optional. The first line of
# stdin is the SSH password, for sudo when the account is not in the docker
# group. SKIP_BACKUP=1 and RESET_DATABASE=1 as in 3.deploy-ubuntu.ps1.
set -euo pipefail
commit=$1; ref=$2; upstream_version=$3; tag=$4; stage=$5; target=$6; server=$7; source=$8
STAGE_DIR=${STAGE_DIR:-$HOME}
IMAGE=token-monitor-hub
POSTGRES_CONTAINER=token-monitor-postgres
HUB_CONTAINER=token-monitor-hub
POSTGRES_VOLUME=token-monitor_postgres-data
MARKER=RELEASE-INFO.txt
GENERATED_KEYS=" TOKEN_MONITOR_SECRET TOKEN_MONITOR_CLIENT_SECRETS POSTGRES_PASSWORD TOKEN_MONITOR_DB_PASSWORD "
# Only take effect when the volume is created; the first two the hub needs.
DATABASE_KEYS=" POSTGRES_PASSWORD TOKEN_MONITOR_DB_PASSWORD TOKEN_MONITOR_DB_READONLY_PASSWORD "
REQUIRED_DATABASE_KEYS="POSTGRES_PASSWORD TOKEN_MONITOR_DB_PASSWORD"
PUBLIC_DASHBOARD=TOKEN_MONITOR_PUBLIC_DASHBOARD=1
HEALTH_PROBE="fetch('http://127.0.0.1:17321/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

pw=
IFS= read -r pw || true
# Windows PowerShell's pipe can add a BOM and a CR.
pw=${pw#$'\xef\xbb\xbf'}
pw=${pw%$'\r'}
trap 'rm -f "$STAGE_DIR/$stage".*' EXIT

info() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
new_secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
# A setting's value in a .env file: the last one, unquoted.
env_value() { sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n 1 | tr -d "\"'\r"; }

if docker info >/dev/null 2>&1; then
  dk() { docker "$@"; }
elif [ -n "$pw" ] && printf '%s\n' "$pw" | sudo -S -p '' docker info >/dev/null 2>&1; then
  dk() { printf '%s\n' "$pw" | sudo -S -p '' docker "$@"; }
else
  die "Cannot run docker as $(id -un). Add the account to the docker group (sudo usermod -aG docker $(id -un)) or give its password."
fi
dk compose version >/dev/null 2>&1 || die "docker compose (v2) is not available: sudo apt install docker-compose-plugin"
# Checked before anything changes: without an uploaded image, the caller built it here.
image_tar="$STAGE_DIR/$stage.image.tar"
if [ ! -f "$image_tar" ] && ! dk image inspect "$tag" >/dev/null 2>&1; then
  die "No image to deploy: $image_tar was not uploaded and Docker has no $tag."
fi

case "$target" in /*) ;; *) target="$HOME/$target" ;; esac

# --- Release folder ---
if [ -e "$target" ]; then
  if [ -f "$target/$MARKER" ]; then
    find "$target" -mindepth 1 -maxdepth 1 ! -name .env ! -name data ! -name backups -exec rm -rf {} +
  # An empty folder is used as it is: install-runner-ubuntu.ps1 -HubDeploy
  # makes deploy:hub's in /opt, where the runner cannot move it aside.
  elif [ -n "$(ls -A "$target")" ]; then
    aside="$target.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$target" "$aside"
    info "$target was not made by the deploy scripts; moved it to $aside"
  fi
fi
mkdir -p "$target"
tar -xf "$STAGE_DIR/$stage.src.tar" -C "$target"
cat > "$target/$MARKER" <<EOF
Token Monitor company hub - release folder written by the deploy scripts.
Everything except .env, data/ and backups/ is replaced on the next deploy; change the source repository instead.

commit:   $commit
ref:      $ref
upstream: $upstream_version
source:   $source
created:  $(date +%Y-%m-%dT%H:%M:%S%z)
EOF
info "Release folder on $server: $target"

# --- Backup ---
backed_up=0
if [ "${SKIP_BACKUP:-0}" = 1 ]; then
  info "Skipping the database backup."
elif [ -n "$(dk ps -q --filter "name=^${POSTGRES_CONTAINER}\$")" ]; then
  mkdir -p "$target/backups"
  dump="$target/backups/token-monitor-$(date +%Y%m%d-%H%M%S).dump"
  dk exec "$POSTGRES_CONTAINER" pg_dump -U postgres -d token_monitor -n token_monitor -Fc -f /tmp/deploy-backup.dump \
    || die "pg_dump failed; fix it or deploy with -SkipBackup."
  dk cp "$POSTGRES_CONTAINER:/tmp/deploy-backup.dump" "$dump"
  dk exec "$POSTGRES_CONTAINER" rm -f /tmp/deploy-backup.dump >/dev/null 2>&1 || true
  info "Database backup: $dump"
  backed_up=1
else
  info "No running database container; nothing to back up."
fi

# --- Reset (-ResetDatabase) ---
# Deletes the database with all its data; the next start creates an empty one
# with the passwords in .env.
if [ "${RESET_DATABASE:-0}" = 1 ] && dk volume inspect "$POSTGRES_VOLUME" >/dev/null 2>&1; then
  if [ "$backed_up" = 0 ] && [ "${SKIP_BACKUP:-0}" != 1 ]; then
    die "The database container is not running, so the database cannot be backed up before it is deleted. Start it, or add -SkipBackup to delete it without a backup."
  fi
  dk rm -f "$HUB_CONTAINER" "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  dk volume rm "$POSTGRES_VOLUME" >/dev/null
  info "Deleted the database volume $POSTGRES_VOLUME."
fi

# --- .env ---
env_file="$target/.env"
uploaded="$STAGE_DIR/$stage.env"
volume=0
if dk volume inspect "$POSTGRES_VOLUME" >/dev/null 2>&1; then volume=1; fi
if [ -f "$uploaded" ]; then
  # The uploaded .env replaces the server's. Its blank database passwords keep
  # the server's, or are generated for a new database: the database only
  # accepts the ones it was created with.
  merged="$STAGE_DIR/$stage.env.merged"
  (umask 077
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      key="${line%%=*}"
      if [ "$line" = "$key=" ] && [ "${DATABASE_KEYS#* $key }" != "$DATABASE_KEYS" ]; then
        if [ -f "$env_file" ] && [ -n "$(env_value "$env_file" "$key")" ]; then
          grep -E "^[[:space:]]*$key[[:space:]]*=" "$env_file" | tail -n 1 | tr -d '\r'
        elif [ "$volume" = 0 ] && [ "${GENERATED_KEYS#* $key }" != "$GENERATED_KEYS" ]; then
          printf '%s=%s\n' "$key" "$(new_secret)"
        else
          printf '%s\n' "$line"
        fi
      else
        printf '%s\n' "$line"
      fi
    done < "$uploaded" > "$merged")
  if [ "$volume" = 1 ]; then
    for key in $REQUIRED_DATABASE_KEYS; do
      new="$(env_value "$merged" "$key")"
      [ -n "$new" ] || die "$key is blank in the uploaded .env and $env_file has none, but the database $POSTGRES_VOLUME only accepts the one it was created with."
      if [ -f "$env_file" ] && [ "$new" != "$(env_value "$env_file" "$key")" ]; then
        die "The uploaded .env has a different $key than $env_file, and the database only accepts the one it was created with. Leave it blank in the uploaded file to keep the server's."
      fi
    done
  fi
  if [ -f "$env_file" ] && cmp -s "$merged" "$env_file"; then
    info "The release folder's .env already matches the uploaded one."
  else
    if [ -f "$env_file" ]; then
      mkdir -p "$target/backups"
      saved="$target/backups/env-$(date +%Y%m%d-%H%M%S).bak"
      (umask 077; cp "$env_file" "$saved")
      info "Saved the previous .env as $saved."
    fi
    (umask 077; cp "$merged" "$env_file")
    info "Installed the uploaded .env (TOKEN_MONITOR_SECRET is the admin key, TOKEN_MONITOR_CLIENT_SECRETS goes to users)."
  fi
elif [ -f "$env_file" ]; then
  info "Keeping the release folder's .env."
else
  # The database passwords only take effect when the volume is created.
  if [ "$volume" = 1 ]; then
    die "The database volume $POSTGRES_VOLUME already exists, but $env_file does not. Deploy again with -EnvFile <the .env it was created with>."
  fi
  (umask 077
    while IFS= read -r line || [ -n "$line" ]; do
      key="${line%%=*}"
      if [ "$line" = "$key=" ] && [ "${GENERATED_KEYS#* $key }" != "$GENERATED_KEYS" ]; then
        printf '%s=%s\n' "$key" "$(new_secret)"
      elif [ "$line" = "# $PUBLIC_DASHBOARD" ]; then
        # The dashboard is public in a deployed hub, so users read usage without a key.
        printf '%s\n' "$PUBLIC_DASHBOARD"
      else
        printf '%s\n' "$line"
      fi
    done < "$target/.env.example" > "$env_file")
  info "Wrote $env_file with generated keys and passwords (TOKEN_MONITOR_SECRET is the admin key, TOKEN_MONITOR_CLIENT_SECRETS goes to users). Keep a copy somewhere safe."
fi

# --- Image ---
if [ -f "$image_tar" ]; then dk load -i "$image_tar"; fi
new_id="$(dk image inspect -f '{{.Id}}' "$tag")"
if old_id="$(dk image inspect -f '{{.Id}}' "$IMAGE:latest" 2>/dev/null)" && [ "$old_id" != "$new_id" ]; then
  dk tag "$IMAGE:latest" "$IMAGE:previous"
  info "Kept the old image as $IMAGE:previous."
fi
dk tag "$tag" "$IMAGE:latest"

# --- Start ---
compose="$target/docker/compose.yml"
dk compose -f "$compose" --env-file "$env_file" up -d
info "Waiting for the hub to answer /api/health..."
for _ in $(seq 1 45); do
  sleep 2
  if dk exec "$HUB_CONTAINER" node -e "$HEALTH_PROBE" >/dev/null 2>&1; then
    host_port="$(sed -n 's/^[[:space:]]*TOKEN_MONITOR_HOST_PORT[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n 1 | tr -d "\"'\r")"
    url="http://$server"
    if [ -n "$host_port" ] && [ "$host_port" != 80 ]; then url="$url:$host_port"; fi
    info "Hub deployed: $url/"
    info "Commands (on $server):  docker compose -f $compose --env-file $env_file ps|logs|stop"
    info "Roll back: docker tag $IMAGE:previous $IMAGE:latest; then the same compose up -d (see the release notes when migrations changed)."
    exit 0
  fi
done
printf 'The hub did not become healthy within 90s. Last log lines:\n' >&2
dk logs --tail 40 "$HUB_CONTAINER" >&2 || true
info "Roll back: docker tag $IMAGE:previous $IMAGE:latest, then docker compose up -d again (a release with new migrations needs the database backup restored first, see docs/postgres.zh-TW.md)."
exit 1
