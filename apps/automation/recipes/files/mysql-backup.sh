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
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_TYPE <> 'BASE TABLE' OR ENGINE IS NULL OR ENGINE NOT IN ('InnoDB', 'MEMORY'))), ':',
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

memory=$(query "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND ENGINE = 'MEMORY'") || exit 66
if [ "$memory" = 0 ]; then
    exec mysqldump --no-defaults --protocol=socket --user=root \
        --single-transaction --skip-lock-tables --quick --hex-blob \
        --set-gtid-purged=OFF --no-create-db --skip-add-locks \
        --skip-comments --skip-dump-date --routines=false --events=false \
        --triggers=false -- "$MYSQL_DATABASE" 2>/dev/null
fi

command -v timeout >/dev/null || exit 69
random=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
case "$random" in *[!0-9a-f]*|'') exit 69 ;; esac
user="i7y_${random}"
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
case "$password" in *[!0-9a-f]*|'') exit 69 ;; esac
root_sql() {
    printf '%s\n' "$1" | timeout -s KILL 5s mysql --no-defaults --protocol=socket --user=root \
        --batch --skip-column-names 2>/dev/null
}
created=no
cleanup() {
    [ "$created" = no ] && return 0
    [ "$created" = yes ] || return 1
    remaining=5
    while [ "$remaining" -gt 0 ]; do
        ids=$(root_sql "SELECT ID FROM information_schema.PROCESSLIST WHERE USER='$user'") || return 1
        [ -n "$ids" ] || break
        for id in $ids; do
            case "$id" in *[!0-9]*|'') return 1 ;; esac
            root_sql "KILL CONNECTION $id" >/dev/null || :
        done
        remaining=$((remaining - 1))
        sleep 1
    done
    ids=$(root_sql "SELECT ID FROM information_schema.PROCESSLIST WHERE USER='$user'") || return 1
    [ -z "$ids" ] || return 1
    root_sql "DROP USER IF EXISTS '$user'@'localhost'" >/dev/null || return 1
    created=no
}
on_exit() {
    status=$?
    trap - EXIT HUP INT TERM
    cleanup || exit 70
    printf "I7Y_BACKUP_CLEAN\n" >&2
    exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
created=uncertain
root_sql "CREATE USER '$user'@'localhost' IDENTIFIED BY '$password'" >/dev/null || exit 69
created=yes
root_sql "GRANT RELOAD ON *.* TO '$user'@'localhost'" >/dev/null || exit 69
root_sql "GRANT SELECT, LOCK TABLES, SHOW VIEW ON \`$MYSQL_DATABASE\`.* TO '$user'@'localhost'" >/dev/null || exit 69
MYSQL_PWD="$password" timeout -s KILL 30s mysqldump --no-defaults --protocol=socket --user="$user" \
    --lock-all-tables --quick --hex-blob \
    --set-gtid-purged=OFF --no-create-db --skip-add-locks \
    --skip-comments --skip-dump-date --routines=false --events=false \
    --triggers=false -- "$MYSQL_DATABASE" 2>/dev/null
