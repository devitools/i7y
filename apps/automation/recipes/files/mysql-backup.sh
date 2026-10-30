#!/bin/sh
set -eu

[ "$#" -eq 0 ] || exit 64
: "${MYSQL_DATABASE:?Database configuration unavailable}"
: "${MYSQL_ROOT_PASSWORD:?Database credential unavailable}"
case "$MYSQL_DATABASE" in
    ''|*[!a-zA-Z0-9_]*) exit 65 ;;
esac

export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"
unset MYSQL_ROOT_PASSWORD MYSQL_PASSWORD

query() {
    mysql --no-defaults --protocol=socket --user=root --batch --skip-column-names \
        --database="$MYSQL_DATABASE" --execute="$1" 2>/dev/null
}

version=$(query 'SELECT @@version') || exit 66
case "$version" in
    5.7.*) ;;
    *) exit 67 ;;
esac

shape=$(query "SELECT CONCAT(
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'), ':',
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_TYPE <> 'BASE TABLE' OR ENGINE IS NULL OR ENGINE <> 'InnoDB')), ':',
    (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()), ':',
    (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()), ':',
    (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()))") || exit 66
case "$shape" in
    *:0:0:0:0) ;;
    *) exit 68 ;;
esac
tables=${shape%%:*}
case "$tables" in
    ''|0|*[!0-9]*) exit 68 ;;
esac

exec mysqldump --no-defaults --protocol=socket --user=root \
    --single-transaction --quick --skip-lock-tables --hex-blob \
    --set-gtid-purged=OFF --no-create-db --skip-add-locks \
    --skip-comments --skip-dump-date --routines=false --events=false \
    --triggers=false -- "$MYSQL_DATABASE" 2>/dev/null
