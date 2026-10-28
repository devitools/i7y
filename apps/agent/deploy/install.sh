#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ "$#" = 3 ] || [ "$#" = 4 ] || { echo 'Usage: install.sh BINARY CONFIG SERVICE [docker|host]' >&2; exit 1; }
mode=${4:-docker}
case "$mode" in
  docker) getent group docker >/dev/null ;;
  host) if grep -q "^SupplementaryGroups=.*docker" "$3"; then echo "Use the host-only service unit" >&2; exit 1; fi ;;
  *) echo "Invalid installation mode" >&2; exit 1 ;;
esac
id i7y-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/i7y-agent --shell /sbin/nologin i7y-agent
install -d -m 0700 -o i7y-agent -g i7y-agent /etc/i7y-agent /var/lib/i7y-agent
install -m 0755 "$1" /usr/local/bin/i7y-agent
install -m 0600 -o i7y-agent -g i7y-agent "$2" /etc/i7y-agent/config.json
install -m 0644 "$3" /etc/systemd/system/i7y-agent.service
systemctl daemon-reload
systemctl enable i7y-agent
systemctl restart i7y-agent
