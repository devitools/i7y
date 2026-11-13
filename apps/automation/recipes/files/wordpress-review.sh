#!/bin/sh
. /opt/i7y/tools/wordpress-common.sh
[ "$#" -eq 1 ] || exit 64
root=$1
[ -f /opt/i7y/state/cron-original.json ] || exit 66
set_constant DISABLE_WP_CRON true --raw
