<?php
$phase = $args[0] ?? '';
$source = $args[1] ?? '';
$destination = $args[2] ?? '';
$path = '/opt/i7y/state/domain-contract.json';
if (!in_array($phase, ['begin', 'verify'], true) || !$source || !$destination || $source === $destination) {
    WP_CLI::error('Invalid WordPress domain contract.');
}
$current = [
    'version' => 1,
    'source' => $source,
    'destination' => $destination,
    'plugins' => get_option('active_plugins'),
    'template' => get_option('template'),
    'stylesheet' => get_option('stylesheet'),
];
if (is_file($path)) {
    $baseline = json_decode(file_get_contents($path), true);
    if (!is_array($baseline) || array_diff_key($current, $baseline) || array_intersect_key($baseline, $current) !== $current) {
        WP_CLI::error('The copied WordPress configuration does not match its domain contract.');
    }
} elseif ($phase === 'begin') {
    $baseline = $current;
} else {
    WP_CLI::error('The WordPress domain contract is missing.');
}
if ($phase === 'verify') {
    foreach (['home', 'siteurl'] as $option) {
        if (get_option($option) !== 'https://' . $destination) {
            WP_CLI::error('The copied WordPress URL does not match its domain contract.');
        }
    }
    if (is_file('/opt/i7y/state/temporary-columns.json')) {
        WP_CLI::error('Temporary database identifiers have not been removed.');
    }
    $baseline['verified'] = true;
}
$pending = $path . '.pending';
if (file_put_contents($pending, json_encode($baseline), LOCK_EX) === false || !chmod($pending, 0600) || !rename($pending, $path)) {
    WP_CLI::error('Unable to persist the WordPress domain contract.');
}
