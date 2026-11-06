#!/bin/sh
. /opt/i7y/tools/wordpress-common.sh
[ "$#" -eq 1 ] || exit 64
root=$1
[ -f /opt/i7y/state/cron-original.json ] || exit 66
exists=$(php -r '$v=json_decode(file_get_contents($argv[1]),true); if (!is_array($v) || !isset($v["exists"]) || !is_bool($v["exists"])) exit(1); echo $v["exists"] ? "yes" : "no";' /opt/i7y/state/cron-original.json)
if [ "$exists" = yes ]; then
    value=$(php -r '$v=json_decode(file_get_contents($argv[1]),true); if (!is_string($v["value"])) exit(1); echo $v["value"];' /opt/i7y/state/cron-original.json)
    set_constant DISABLE_WP_CRON "$value" --raw
else
    if wp config has DISABLE_WP_CRON; then wp config delete DISABLE_WP_CRON; fi
fi
