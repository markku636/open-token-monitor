#!/usr/bin/env bash
# Lets only the given networks reach PostgreSQL's published port, for a hub
# whose .env sets POSTGRES_HOST_BIND=0.0.0.0 (docs/postgres.zh-TW.md, "從其他
# 電腦連線"). Copy it to the Docker host and run it once with sudo, before the
# deploy that opens the port:
#
#   sudo bash postgres-lan-firewall.sh                       # 192.168.0.0/16, port 5432
#   sudo bash postgres-lan-firewall.sh 192.0.2.0/24,198.51.100.0/24 5432
#   sudo bash postgres-lan-firewall.sh --remove
#
# ufw does not see Docker's published ports: their traffic is forwarded to the
# container, and Docker's rules in FORWARD come before ufw's. Docker checks the
# DOCKER-USER chain first and leaves it to the administrator, so the rule goes
# there. It matches only connections Docker translated for the published port
# (conntrack DNAT), so the hub's own connections over the Compose network are
# untouched. IPv4 only, like POSTGRES_HOST_BIND=0.0.0.0. A systemd unit puts
# the rule back before Docker starts after a reboot.
set -euo pipefail

NAME=token-monitor-pg-firewall
CHAIN=TOKEN-MONITOR-PG
BIN=/usr/local/sbin/$NAME
UNIT=/etc/systemd/system/$NAME.service

info() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Takes this script's jumps out of DOCKER-USER, whatever port they were for.
remove_jumps() {
  local rules
  rules=$(iptables -S DOCKER-USER 2>/dev/null | grep -e "-j $CHAIN\$" | sed 's/^-A /-D /') || true
  [ -n "$rules" ] || return 0
  while read -r rule; do
    # shellcheck disable=SC2086 # iptables -S output is re-read word by word.
    iptables $rule
  done <<<"$rules"
}

apply() {
  local networks=$1 port=$2 net
  # Docker creates DOCKER-USER when it starts and keeps one that exists.
  iptables -N DOCKER-USER 2>/dev/null || true
  iptables -N "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN"
  IFS=, read -ra nets <<<"$networks"
  for net in "${nets[@]}"; do iptables -A "$CHAIN" -s "$net" -j RETURN; done
  iptables -A "$CHAIN" -j DROP
  remove_jumps
  iptables -I DOCKER-USER 1 -p tcp -m conntrack --ctstate DNAT --ctdir ORIGINAL --ctorigdstport "$port" -j "$CHAIN"
}

[ "$(id -u)" = 0 ] || die "Run it with sudo."
command -v iptables >/dev/null || die "iptables is not installed."

case "${1:-}" in
  --apply)
    # What the systemd unit runs.
    apply "$2" "$3"
    exit 0
    ;;
  --remove)
    remove_jumps
    iptables -F "$CHAIN" 2>/dev/null || true
    iptables -X "$CHAIN" 2>/dev/null || true
    systemctl disable "$NAME.service" >/dev/null 2>&1 || true
    rm -f "$UNIT" "$BIN"
    systemctl daemon-reload
    info "Removed. Set POSTGRES_HOST_BIND back to 127.0.0.1 (or delete it) and deploy, or PostgreSQL stays open to everyone who reaches this host."
    exit 0
    ;;
esac

networks=${1:-192.168.0.0/16}
port=${2:-5432}
IFS=, read -ra nets <<<"$networks"
for net in "${nets[@]}"; do
  [[ $net =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || die "Not an IPv4 network: $net"
done
[[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "Not a port: $port"
self=${BASH_SOURCE[0]}
[ -f "$self" ] || die "Run it from a file (sudo bash postgres-lan-firewall.sh), not from a pipe."

install -m 0755 "$self" "$BIN"
cat >"$UNIT" <<EOF
[Unit]
Description=Token Monitor: only $networks reach PostgreSQL's published port $port
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$BIN --apply $networks $port

[Install]
WantedBy=multi-user.target docker.service
EOF
systemctl daemon-reload
systemctl enable "$NAME.service" >/dev/null
systemctl restart "$NAME.service"

info "Only $networks reach port $port now, and again after every reboot ($UNIT):"
iptables -S DOCKER-USER | grep -e "-j $CHAIN\$"
iptables -S "$CHAIN"
if systemctl is-active --quiet docker && ! iptables -C FORWARD -j DOCKER-USER 2>/dev/null; then
  info "WARNING: FORWARD does not jump to DOCKER-USER, so Docker is not using these rules (its nftables firewall backend?). Do not open the port."
fi
