<?php
if (!defined('ABSPATH')) {
    exit;
}
add_filter('pre_wp_mail', '__return_false', PHP_INT_MAX);
add_filter('pre_http_request', static function () {
    return new WP_Error('i7y_clone_review_required', 'External requests are disabled until this copy is reviewed.');
}, PHP_INT_MAX);
add_filter('automatic_updater_disabled', '__return_true', PHP_INT_MAX);
if (defined('DOING_CRON') && DOING_CRON) {
    exit;
}
