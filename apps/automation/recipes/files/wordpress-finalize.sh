#!/bin/sh
. /opt/i7y/tools/wordpress-common.sh
[ "$#" -eq 4 ] || exit 64
root=$1
source_domain=$2
destination_domain=$3
database_host=$4
domain "$source_domain" && domain "$destination_domain" || exit 64
[ "$source_domain" != "$destination_domain" ] || exit 64
[ -f "$root/wp-content/mu-plugins/000-i7y-clone-guard.php" ] || exit 66
[ "$(wp config get DB_HOST)" = "$database_host" ] || exit 66
[ "$(wp config get I7Y_CLONE_REVIEW_REQUIRED --format=json)" = true ] || exit 66
wp core is-installed
wp eval-file /opt/i7y/tools/wordpress-database-check.php
for option in home siteurl; do
    value=$(wp option get "$option")
    case "$value" in
        "http://$source_domain"|"https://$source_domain"|"http://www.$source_domain"|"https://www.$source_domain") ;;
        *) exit 67 ;;
    esac
done
new_url="https://$destination_domain"
escaped_source=$(php -r 'echo preg_quote($argv[1], "~");' "$source_domain")
wp search-replace "(?:https?://|//)(?:www\\.)?$escaped_source(?![a-z0-9.-])" "$new_url" \
    --regex --regex-flags=i --all-tables --precise --skip-columns=guid --report-changed-only --quiet
wp option update home "$new_url"
wp option update siteurl "$new_url"
wp option update active_plugins '[]' --format=json
wp option update blog_public 0
if wp option get cron >/dev/null; then wp option delete cron; fi
[ "$(wp option get home)" = "$new_url" ] || exit 68
[ "$(wp option get siteurl)" = "$new_url" ] || exit 68
[ "$(wp option get active_plugins --format=json)" = '[]' ] || exit 68
