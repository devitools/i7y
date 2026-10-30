set -eu
: "${MYSQL_DATABASE:?Database configuration unavailable}"
: "${MYSQL_ROOT_PASSWORD:?Database credential unavailable}"
case "$MYSQL_DATABASE" in
    ''|*[!a-zA-Z0-9_]*) exit 65 ;;
esac
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
unset MYSQL_ROOT_PASSWORD MYSQL_PASSWORD
count=$(mysql --no-defaults --protocol=socket --user=root --batch --skip-column-names \
    --database="$MYSQL_DATABASE" --execute="SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()" 2>/dev/null) || exit 66
[ "$count" = 0 ] || exit 68
exec mysql --no-defaults --protocol=socket --user=root --database="$MYSQL_DATABASE" 2>/dev/null
