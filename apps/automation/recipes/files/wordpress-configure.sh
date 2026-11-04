#!/bin/sh
. /opt/i7y/tools/wordpress-common.sh
[ "$#" -eq 2 ] || exit 64
root=$1
database_host=$2
case "$root" in /*) ;; *) exit 64 ;; esac
case "$database_host" in ''|*[!a-zA-Z0-9_.-]*) exit 64 ;; esac
[ -f "$root/wp-config.php" ] && [ -f "$root/wp-load.php" ] && [ -d "$root/wp-content" ] || exit 66
php /opt/i7y/tools/wordpress-config-check.php "$root/wp-config.php"
quarantine=/opt/i7y/state/quarantine
mkdir -p "$quarantine"
chmod 700 "$quarantine"
for entry in mu-plugins db.php object-cache.php advanced-cache.php sunrise.php; do
    if [ -e "$root/wp-content/$entry" ]; then
        [ ! -e "$quarantine/$entry" ] || exit 66
        mv "$root/wp-content/$entry" "$quarantine/$entry"
    fi
done
set_constant DB_NAME 'getenv("MYSQL_DATABASE")' --raw
set_constant DB_USER 'getenv("MYSQL_USER")' --raw
set_constant DB_PASSWORD 'getenv("MYSQL_PASSWORD")' --raw
set_constant DB_HOST "$database_host"
for constant in WP_HOME WP_SITEURL; do
    if wp config has "$constant"; then wp config delete "$constant"; fi
done
set_constant I7Y_CLONE_REVIEW_REQUIRED true --raw
for constant in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
    if ! wp config has "$constant"; then set_constant "$constant" i7y-clone-pending-salt; fi
done
wp config shuffle-salts
