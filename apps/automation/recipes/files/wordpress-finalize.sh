#!/bin/sh
. /opt/i7y/tools/wordpress-common.sh
[ "$#" -eq 4 ] || exit 64
root=$1
source_domain=$2
destination_domain=$3
database_host=$4
domain "$source_domain" && domain "$destination_domain" || exit 64
[ "$source_domain" != "$destination_domain" ] || exit 64
[ "$(wp config get DB_HOST)" = "$database_host" ] || exit 66
[ "$(wp config get I7Y_CLONE_REVIEW_REQUIRED --format=json)" = true ] || exit 66
restore_quarantine() {
    for entry in mu-plugins db.php object-cache.php advanced-cache.php sunrise.php; do
        if [ -e "/opt/i7y/state/quarantine/$entry" ]; then
            [ ! -e "$root/wp-content/$entry" ] || exit 66
            mv "/opt/i7y/state/quarantine/$entry" "$root/wp-content/$entry"
        fi
    done
}
if php -r '$p="/opt/i7y/state/domain-contract.json"; $v=is_file($p)?json_decode(file_get_contents($p),true):null; exit(is_array($v) && ($v["verified"]??false)===true && ($v["source"]??null)===$argv[1] && ($v["destination"]??null)===$argv[2] && !is_file("/opt/i7y/state/temporary-columns.json") ? 0 : 1);' "$source_domain" "$destination_domain"; then
    mkdir -p /opt/i7y/state/quarantine
    trap restore_quarantine EXIT
    for entry in mu-plugins db.php object-cache.php advanced-cache.php sunrise.php; do
        if [ -e "$root/wp-content/$entry" ]; then
            [ ! -e "/opt/i7y/state/quarantine/$entry" ] || exit 66
            mv "$root/wp-content/$entry" "/opt/i7y/state/quarantine/$entry"
        fi
    done
    wp eval-file /opt/i7y/tools/wordpress-domain-contract.php verify "$source_domain" "$destination_domain"
    restore_quarantine
    trap - EXIT
    exit 0
fi
wp core is-installed
wp eval-file /opt/i7y/tools/wordpress-domain-contract.php begin "$source_domain" "$destination_domain"
trap 'wp eval-file /opt/i7y/tools/wordpress-database-check.php cleanup' EXIT
wp eval-file /opt/i7y/tools/wordpress-database-check.php
for option in home siteurl; do
    value=$(wp option get "$option")
    case "$value" in
        "https://$destination_domain"|"http://$destination_domain"|"http://$source_domain"|"https://$source_domain"|"http://www.$source_domain"|"https://www.$source_domain") ;;
        *) exit 67 ;;
    esac
done
new_url="https://$destination_domain"
wp eval-file /opt/i7y/tools/wordpress-domain-replace.php "$source_domain" "$destination_domain"
wp option update home "$new_url"
wp option update siteurl "$new_url"
[ "$(wp option get home)" = "$new_url" ] || exit 68
[ "$(wp option get siteurl)" = "$new_url" ] || exit 68
wp eval-file /opt/i7y/tools/wordpress-database-check.php cleanup
wp eval-file /opt/i7y/tools/wordpress-domain-contract.php verify "$source_domain" "$destination_domain"
trap - EXIT
restore_quarantine
