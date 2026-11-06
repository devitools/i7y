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
if [ "$count" != 0 ]; then
    [ "${I7Y_RESTORE_RETRY:-}" = yes ] || exit 68
    tables=$(mysql --no-defaults --protocol=socket --user=root --batch --skip-column-names \
        --database="$MYSQL_DATABASE" --execute="SELECT CONCAT('DROP TABLE IF EXISTS \`', REPLACE(TABLE_NAME, '\`', '\`\`'), '\`;') FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()" 2>/dev/null) || exit 66
    printf 'SET FOREIGN_KEY_CHECKS=0;\n%s\nSET FOREIGN_KEY_CHECKS=1;\n' "$tables" | mysql --no-defaults --protocol=socket --user=root --database="$MYSQL_DATABASE" 2>/dev/null
fi
exec mysql --no-defaults --protocol=socket --user=root --database="$MYSQL_DATABASE" 2>/dev/null
