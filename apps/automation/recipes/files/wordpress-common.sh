set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
cd /opt/i7y/tools
[ -d /opt/i7y/state ] || exit 64
actual=$(php -r 'echo hash_file("sha256", "/opt/i7y/tools/wp-cli.phar");')
[ "$actual" = ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c ] || exit 65

wp() {
    env -i PATH="$PATH" HOME=/opt/i7y/state WP_CLI_CONFIG_PATH=/dev/null \
        WP_CLI_CACHE_DIR=/opt/i7y/state/cache \
        MYSQL_DATABASE="${MYSQL_DATABASE:?Destination database unavailable}" \
        MYSQL_USER="${MYSQL_USER:?Destination database user unavailable}" \
        MYSQL_PASSWORD="${MYSQL_PASSWORD:?Destination database credential unavailable}" \
        php /opt/i7y/tools/wp-cli.phar --allow-root --no-color --skip-packages \
        --skip-plugins --skip-themes --path="$root" "$@"
}

set_constant() {
    wp config set "$@" --anchor='<?php' --placement=after --quiet
}

domain() {
    php -r '$d=$argv[1]; exit(strlen($d)<=253 && str_contains($d,".") && strtolower($d)===$d && filter_var($d,FILTER_VALIDATE_DOMAIN,FILTER_FLAG_HOSTNAME) ? 0 : 1);' "$1"
}
