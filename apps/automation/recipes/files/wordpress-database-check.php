<?php
global $wpdb;
$unsupported = $wpdb->get_var("SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS p WHERE p.TABLE_SCHEMA = t.TABLE_SCHEMA AND p.TABLE_NAME = t.TABLE_NAME AND p.INDEX_NAME = 'PRIMARY')");
if ($wpdb->last_error || $unsupported === null || (int) $unsupported !== 0) {
    WP_CLI::warning('Every copied table needs a primary key for verified URL replacement.');
    WP_CLI::halt(67);
}
