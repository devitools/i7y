<?php
require 'phar:///opt/i7y/tools/wp-cli.phar/vendor/wp-cli/wp-config-transformer/src/WPConfigTransformer.php';
try {
    $config = new WPConfigTransformer($argv[1], true);
    foreach (['WP_CONTENT_DIR', 'WP_PLUGIN_DIR', 'WPMU_PLUGIN_DIR', 'SUNRISE'] as $constant) {
        if ($config->exists('constant', $constant)) {
            exit(67);
        }
    }
    if ($config->exists('constant', 'MULTISITE') && !in_array(strtolower(trim($config->get_value('constant', 'MULTISITE'))), ['false', '0'], true)) {
        exit(67);
    }
    foreach (['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_HOST'] as $constant) {
        if (!$config->exists('constant', $constant)) {
            exit(67);
        }
    }
} catch (Throwable $error) {
    exit(67);
}
