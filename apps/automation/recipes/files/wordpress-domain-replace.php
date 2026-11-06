<?php
$source = $args[0] ?? '';
$destination = $args[1] ?? '';
if (!$source || !$destination || $source === $destination) {
    WP_CLI::error('Invalid WordPress domain replacement.');
}
if (!class_exists('WP_CLI\\SearchReplacer')) {
    require 'phar:///opt/i7y/tools/wp-cli.phar/vendor/wp-cli/search-replace-command/src/WP_CLI/SearchReplacer.php';
}
$hostPattern = '(?:www\\.)?' . preg_quote($source, '~') . '(?![a-z0-9.-])';
$pattern = '(?:http://' . $hostPattern . ':80(?![0-9])|(?:https?://|//)' . $hostPattern . ')';
$replacer = new \WP_CLI\SearchReplacer($pattern, 'https://' . $destination, true, true, 'i', '~');
$identifier = static function ($value) {
    return '`' . str_replace('`', '``', $value) . '`';
};
$fail = static function ($code) {
    WP_CLI::error('I7Y_DOMAIN_FAILURE=' . $code);
};
global $wpdb;
$wpdb->suppress_errors(true);
$tables = $wpdb->get_col("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
if ($wpdb->last_error) {
    $fail('read');
}
$scanned = 0;
$changed = 0;
foreach ($tables as $table) {
    $tableSql = $identifier($table);
    $description = $wpdb->get_results('DESCRIBE ' . $tableSql);
    if ($wpdb->last_error) {
        $fail('read');
    }
    $keys = [];
    $columns = [];
    foreach ($description as $column) {
        if ($column->Key === 'PRI') {
            $keys[] = $column->Field;
            if ($column->Field !== 'guid' && preg_match('/char|text|blob|binary|json/i', $column->Type)) {
                $matches = $wpdb->get_col($wpdb->prepare('SELECT ' . $identifier($column->Field) . ' FROM ' . $tableSql . ' WHERE LOWER(CONVERT(' . $identifier($column->Field) . ' USING utf8mb4)) LIKE %s', '%' . $wpdb->esc_like(strtolower($source)) . '%'));
                if ($wpdb->last_error) {
                    $fail('read');
                }
                foreach ($matches as $match) {
                    if (preg_match('~' . $pattern . '~i', $match)) {
                        $fail('primary_key_contains_domain');
                    }
                }
            }
        } elseif ($column->Field !== 'guid' && preg_match('/char|text|blob|binary|json/i', $column->Type)) {
            $columns[] = $column->Field;
        }
    }
    if (!$columns) {
        continue;
    }
    if (!$keys) {
        $fail('primary_key');
    }
    $candidates = [];
    foreach ($columns as $column) {
        $candidates[] = $wpdb->prepare('LOWER(CONVERT(' . $identifier($column) . ' USING utf8mb4)) LIKE %s', '%' . $wpdb->esc_like(strtolower($source)) . '%');
    }
    $candidateSql = '(' . implode(' OR ', $candidates) . ')';
    $selectSql = implode(', ', array_map($identifier, array_merge($keys, $columns)));
    $orderSql = implode(', ', array_map($identifier, $keys));
    $cursor = [];
    do {
        $afterSql = '';
        if ($cursor) {
            $alternatives = [];
            foreach ($keys as $index => $key) {
                $conditions = [];
                for ($previous = 0; $previous < $index; $previous++) {
                    $conditions[] = $wpdb->prepare($identifier($keys[$previous]) . ' = %s', $cursor[$keys[$previous]]);
                }
                $conditions[] = $wpdb->prepare($identifier($key) . ' > %s', $cursor[$key]);
                $alternatives[] = '(' . implode(' AND ', $conditions) . ')';
            }
            $afterSql = ' AND (' . implode(' OR ', $alternatives) . ')';
        }
        $rows = $wpdb->get_results('SELECT ' . $selectSql . ' FROM ' . $tableSql . ' WHERE ' . $candidateSql . $afterSql . ' ORDER BY ' . $orderSql . ' LIMIT 100', ARRAY_A);
        if ($wpdb->last_error) {
            $fail('read');
        }
        foreach ($rows as $row) {
            $where = [];
            foreach ($keys as $key) {
                $where[$key] = $row[$key];
            }
            $cursor = $where;
            $updates = [];
            $scanned++;
            foreach ($columns as $column) {
                $value = $row[$column];
                if (!is_string($value) || stripos($value, $source) === false) {
                    continue;
                }
                $next = $replacer->run($value);
                if (preg_match('~' . $pattern . '~i', $next)) {
                    $fail('serialization');
                }
                if ($next !== $value) {
                    $updates[$column] = $next;
                }
            }
            if ($updates) {
                if ($wpdb->update($table, $updates, $where) === false) {
                    $fail('write');
                }
                $changed++;
            }
        }
    } while (count($rows) === 100);
}
WP_CLI::log('I7Y_DOMAIN_ROWS=' . $scanned . ' I7Y_DOMAIN_UPDATED=' . $changed);
