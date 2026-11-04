<?php
global $wpdb;
$journal = '/opt/i7y/state/temporary-columns.json';
$entries = is_file($journal) ? json_decode(file_get_contents($journal), true) : [];
if (!is_array($entries)) {
    WP_CLI::error('Invalid temporary column journal.');
}
$wpdb->suppress_errors(true);
foreach ($entries as $entry) {
    $table = $entry['table'];
    $column = $entry['column'];
    if (!preg_match('/^i7y_copy_[a-f0-9]{16}$/', $column)) {
        WP_CLI::error('Invalid temporary column journal.');
    }
    $exists = $wpdb->get_var($wpdb->prepare('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s AND COLUMN_NAME=%s', $table, $column));
    if ($exists && $wpdb->query('ALTER TABLE `' . str_replace('`', '``', $table) . '` DROP COLUMN `' . $column . '`') === false) {
        WP_CLI::error('Unable to remove the temporary copy identifier.');
    }
}
if (is_file($journal)) {
    unlink($journal);
}
if (isset($args[0]) && $args[0] === 'cleanup') {
    return;
}
$entries = [];
$tables = $wpdb->get_col("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'");
if ($wpdb->last_error) {
    WP_CLI::error('Unable to inspect copied database tables.');
}
foreach ($tables as $table) {
    $primary = $wpdb->get_var($wpdb->prepare("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s AND INDEX_NAME='PRIMARY' LIMIT 1", $table));
    if ($primary) {
        continue;
    }
    do {
        $column = 'i7y_copy_' . bin2hex(random_bytes(8));
        $exists = $wpdb->get_var($wpdb->prepare('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s AND COLUMN_NAME=%s', $table, $column));
    } while ($exists);
    $entries[] = ['table' => $table, 'column' => $column];
    $pending = $journal . '.pending';
    if (file_put_contents($pending, json_encode($entries), LOCK_EX) === false || !chmod($pending, 0600) || !rename($pending, $journal)) {
        WP_CLI::error('Unable to record the temporary copy identifier.');
    }
    $quoted = '`' . str_replace('`', '``', $table) . '`';
    foreach (["ALTER TABLE $quoted ADD COLUMN `$column` BIGINT UNSIGNED NOT NULL DEFAULT 0", 'SET @i7y_row_number=0', "UPDATE $quoted SET `$column`=(@i7y_row_number:=@i7y_row_number+1)", "ALTER TABLE $quoted ADD PRIMARY KEY (`$column`)"] as $query) {
        if ($wpdb->query($query) === false) {
            WP_CLI::error('Unable to prepare a copied table for URL replacement.');
        }
    }
}
