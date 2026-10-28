#!/bin/sh
set -eu
systemctl disable --now i7y-agent
rm -f /etc/systemd/system/i7y-agent.service /usr/local/bin/i7y-agent
systemctl daemon-reload
printf '%s\n' 'Configuration and queue preserved in /etc/i7y-agent and /var/lib/i7y-agent'
