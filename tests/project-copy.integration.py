import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import uuid
import yaml

ROOT = Path(__file__).resolve().parents[1]


class ProjectCopyPlaybook(unittest.TestCase):
    def run_command(self, args, data=None, check=True, timeout=240):
        result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise AssertionError(result.stdout.decode(errors='replace') + result.stderr.decode(errors='replace'))
        return result

    def test_complete_staging_copy_and_source_preservation(self):
        assets = ROOT / '.local/artifacts/wordpress'
        phar = assets / 'wp-cli-2.12.0.phar'
        self.assertEqual(hashlib.sha256(phar.read_bytes()).hexdigest(), 'ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c')
        temporary = tempfile.TemporaryDirectory(prefix='playbook-', dir=assets)
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        source = root / 'source.example.com'
        app = source / 'app'
        app.mkdir(parents=True)
        with tarfile.open(assets / 'wordpress-6.8.3.tar.gz') as archive:
            archive.extractall(app, filter='data')
        site = app / 'wordpress'
        (site / 'wp-config.php').write_text("""<?php
define('DB_NAME', 'source_site');
define('DB_USER', 'sourceuser');
define('DB_PASSWORD', 'disposable-source-password');
define('DB_HOST', 'database');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
$table_prefix = 'wp_';
if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }
require_once ABSPATH . 'wp-settings.php';
""")
        nonce = uuid.uuid4().hex
        project = 'i7y-copy-test-' + nonce[:12]
        proxy = 'i7y-copy-proxy-' + nonce[:12]
        self.run_command(['docker', 'network', 'create', proxy])
        self.addCleanup(self.run_command, ['docker', 'network', 'rm', proxy], check=False)
        compose = {'version': '3.5', 'services': {
            'database': {'image': 'mysql:5.7', 'environment': {'MYSQL_DATABASE': 'source_site', 'MYSQL_USER': 'sourceuser', 'MYSQL_PASSWORD': 'disposable-source-password', 'MYSQL_ROOT_PASSWORD': 'disposable-root-password'}, 'volumes': ['data:/var/lib/mysql'], 'networks': ['internal']},
            'web': {'image': 'webdevops/php-nginx:8.3', 'environment': {'WEB_DOCUMENT_ROOT': '/var/www/html'}, 'volumes': [str(site) + ':/var/www/html'], 'networks': ['internal', 'proxy']}},
            'volumes': {'data': {}}, 'networks': {'internal': {'internal': True}, 'proxy': {'external': {'name': proxy}}}}
        compose_path = app / 'docker-compose.yml'
        compose_path.write_text('# Source compose comment\n' + yaml.safe_dump(compose, sort_keys=False))
        base = ['docker-compose', '-p', project, '-f', str(compose_path)]
        self.addCleanup(self.run_command, base + ['down', '-v', '--remove-orphans'], check=False)
        self.run_command(base + ['up', '-d'])
        database = self.run_command(base + ['ps', '-q', 'database']).stdout.decode().strip()
        web = self.run_command(base + ['ps', '-q', 'web']).stdout.decode().strip()
        sql = ['docker', 'exec', database, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --no-defaults --protocol=tcp --host=127.0.0.1 --user=root --batch --skip-column-names source_site --execute="$1"', 'fixture']
        for _ in range(90):
            if self.run_command(sql + ['SELECT 1'], check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            self.fail('Source MySQL did not become ready')
        self.run_command(['docker', 'cp', str(phar), web + ':/tmp/wp-cli.phar'])
        wp = ['docker', 'exec', web, 'php', '/tmp/wp-cli.phar', '--allow-root', '--skip-packages', '--skip-plugins', '--skip-themes', '--path=/var/www/html']
        self.run_command(wp + ['core', 'install', '--url=https://source.example.com', '--title=Fixture', '--admin_user=fixture', '--admin_password=disposable-fixture-password', '--admin_email=admin@example.com', '--skip-email'])
        self.run_command(wp + ['option', 'add', 'nested', '{"url":"https://source.example.com/path"}', '--format=json'])
        plugin = site / 'wp-content/plugins/copy-fixture'
        plugin.mkdir()
        (plugin / 'fixture.php').write_text('<?php /* Plugin Name: Copy Fixture */')
        self.run_command(wp + ['option', 'update', 'active_plugins', '["copy-fixture/fixture.php"]', '--format=json'])
        self.run_command(wp + ['option', 'add', 'theme_settings', '{"logo":"https://source.example.com/logo.png","nested":{"enabled":true}}', '--format=json'])
        source_config = (site / 'wp-config.php').read_bytes()
        original_nested = self.run_command(sql + ["SELECT option_value FROM wp_options WHERE option_name='nested'"]).stdout
        inventory = root / 'inventory.json'
        inventory.write_text(json.dumps({'all': {'children': {'i7y_targets': {'hosts': {'localhost': {'ansible_connection': 'local', 'ansible_python_interpreter': sys.executable}}}}}}))
        parameters = root / 'parameters.json'
        result_path = root / 'result.json'
        operation = {'operation_id': nonce, 'source_path': str(app), 'source_domain': 'source.example.com', 'destination_domain': 'copy-' + nonce[:10] + '.example.com'}
        values = {'i7y_phase': 'preview', 'i7y_attempt_id': 'f' * 32, 'i7y_request': operation, 'i7y_result_path': str(result_path), 'i7y_python': sys.executable, 'i7y_compose': shutil.which('docker-compose'), 'i7y_helper': str(ROOT / 'apps/automation/ansible/files/project_copy.py'), 'i7y_tools': str(ROOT / 'apps/automation/recipes/files')}
        parameters.write_text(json.dumps(values))
        ansible = ROOT / '.local/artifacts/ansible-runtime/bin/ansible-playbook'
        fixture_playbook = root / 'fixture-playbook.yml'
        fixture_playbook.write_text((ROOT / 'apps/automation/ansible/playbooks/project-copy.yml').read_text().replace('no_log: true', 'no_log: false'))
        call = [str(ansible), '-i', str(inventory), str(fixture_playbook), '-e', '@' + str(parameters)]
        self.run_command(call)
        preview = json.loads(result_path.read_text())
        state = Path(preview['state_path'])
        self.addCleanup(shutil.rmtree, state, True)
        destination = Path(preview['destination_root'])
        self.addCleanup(shutil.rmtree, destination, True)
        def cleanup_destination():
            configuration = destination / 'app/docker-compose.yml'
            if configuration.exists():
                self.run_command(['docker-compose', '-f', str(configuration), 'down', '-v', '--remove-orphans'], check=False)
            lock = state.parent / 'copy.lock'
            if (lock / 'owner.json').exists() and json.loads((lock / 'owner.json').read_text()).get('operation_id') == nonce:
                shutil.rmtree(lock)
        self.addCleanup(cleanup_destination)
        self.assertFalse(destination.exists())
        self.assertNotIn('disposable-source-password', json.dumps(preview))
        operation['fingerprint'] = preview['fingerprint']
        values['i7y_phase'] = 'execute'
        parameters.write_text(json.dumps(values))
        full_playbook = fixture_playbook.read_text()
        pause = '                    - name: Update the copied site domain while preserving plugins and theme'
        self.assertIn(pause, full_playbook)
        fixture_playbook.write_text(full_playbook.replace(pause, '                    - name: Simulate interrupted copy\n                      ansible.builtin.fail:\n                        msg: Fixture interruption after database restoration\n' + pause))
        self.assertNotEqual(self.run_command(call, check=False, timeout=600).returncode, 0)
        self.assertTrue((state / 'restored').exists())
        active = state / 'attempt.active'
        self.assertTrue(active.exists())
        previous_attempt = json.loads(active.read_text())['attempt_id']
        fixture_playbook.write_text(full_playbook)
        values['i7y_attempt_id'] = 'e' * 32
        parameters.write_text(json.dumps(values))
        overlapping = self.run_command(call, check=False, timeout=600)
        self.assertNotEqual(overlapping.returncode, 0)
        self.assertIn(b'A previous copy attempt requires reconciliation before retry', overlapping.stdout)
        self.assertEqual(json.loads(active.read_text())['attempt_id'], previous_attempt)
        active.unlink()
        staged = json.loads((state / 'compose.json').read_text())
        review = staged['networks']['i7y_review']
        self.assertTrue(review['internal'])
        self.assertEqual(set(staged['networks']), {'i7y_review'})
        self.assertNotIn('ports', staged['services']['web'])
        self.assertEqual(review['driver_opts']['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated')
        prepared = json.loads((state / 'prepared.json').read_text())
        database_inspect = json.loads(self.run_command(['docker', 'inspect', prepared['database_name']]).stdout)[0]
        self.assertFalse(database_inspect['HostConfig']['PortBindings'])
        self.assertEqual(set(database_inspect['NetworkSettings']['Networks']), {review['name']})
        self.assertNotEqual(self.run_command(['docker', 'exec', prepared['database_name'], 'getent', 'hosts', 'example.com'], check=False).returncode, 0)
        self.assertIn("define( 'DISABLE_WP_CRON', true )", (destination / 'app/wordpress/wp-config.php').read_text())
        backup_digest = hashlib.sha256((state / 'database.sql').read_bytes()).hexdigest()
        health = '                    - name: Verify the copied site HTTP response'
        self.assertIn(health, full_playbook)
        failed_health = '                    - name: Verify the copied site HTTP response\n                      ansible.builtin.shell: \"echo The copied site did not return a successful HTTP response; exit 1\"\n' + health
        fixture_playbook.write_text(full_playbook.replace(health, failed_health))
        failed_result = self.run_command(call, check=False, timeout=600)
        self.assertNotEqual(failed_result.returncode, 0)
        self.assertFalse(active.exists(), failed_result.stdout.decode(errors='replace')[-12000:])
        self.assertFalse((state / 'activated.json').exists())
        isolated_web = json.loads(self.run_command(['docker', 'inspect', preview['web_name']]).stdout)[0]
        self.assertEqual(set(isolated_web['NetworkSettings']['Networks']), {review['name']})
        self.assertFalse(isolated_web['HostConfig']['PortBindings'])
        self.assertIn("define( 'DISABLE_WP_CRON', true )", (destination / 'app/wordpress/wp-config.php').read_text())
        values['i7y_attempt_id'] = 'd' * 32
        parameters.write_text(json.dumps(values))
        fixture_playbook.write_text(full_playbook)
        self.run_command(call, timeout=600)
        self.assertEqual(hashlib.sha256((state / 'database.sql').read_bytes()).hexdigest(), backup_digest)
        completed = json.loads(result_path.read_text())
        self.assertFalse(completed['review_required'])
        self.assertNotIn(review['name'], self.run_command(['docker', 'network', 'ls', '--format', '{{.Name}}']).stdout.decode().splitlines())
        self.assertEqual(source_config, (site / 'wp-config.php').read_bytes())
        self.assertEqual(original_nested, self.run_command(sql + ["SELECT option_value FROM wp_options WHERE option_name='nested'"]).stdout)
        self.assertEqual(self.run_command(sql + ["SELECT option_value FROM wp_options WHERE option_name='home'"]).stdout.strip(), b'https://source.example.com')
        new_compose = json.loads((state / 'compose.json').read_text())
        self.assertNotIn('disposable-source-password', json.dumps(new_compose))
        new_web = completed['web_name']
        published_web = json.loads(self.run_command(['docker', 'inspect', new_web]).stdout)[0]
        self.assertIn(proxy, published_web['NetworkSettings']['Networks'])
        self.run_command(['docker', 'cp', str(phar), new_web + ':/tmp/wp-cli.phar'])
        new_wp = ['docker', 'exec', '-e', 'WP_CLI_CONFIG_PATH=/dev/null', new_web, 'php', '/tmp/wp-cli.phar', '--allow-root', '--skip-packages', '--skip-plugins', '--skip-themes', '--path=/var/www/html']
        self.assertTrue(all('/opt/i7y/' not in mount for mount in new_compose['services']['web']['volumes']))
        self.assertNotEqual(self.run_command(new_wp + ['config', 'has', 'DISABLE_WP_CRON'], check=False).returncode, 0)
        self.assertEqual(self.run_command(new_wp + ['option', 'get', 'home']).stdout.strip().decode(), 'https://' + operation['destination_domain'])
        self.assertEqual(json.loads(self.run_command(new_wp + ['option', 'get', 'nested', '--format=json']).stdout), {'url': 'https://' + operation['destination_domain'] + '/path'})
        self.assertEqual(json.loads(self.run_command(new_wp + ['option', 'get', 'active_plugins', '--format=json']).stdout), ['copy-fixture/fixture.php'])
        self.assertEqual(json.loads(self.run_command(new_wp + ['option', 'get', 'theme_settings', '--format=json']).stdout), {'logo': 'https://' + operation['destination_domain'] + '/logo.png', 'nested': {'enabled': True}})
        destination_compose = destination / 'app/docker-compose.yml'
        self.assertIn('# Source compose comment', destination_compose.read_text())
        edited_compose = destination_compose.read_bytes() + b'\n# User change after completion\n'
        destination_compose.write_bytes(edited_compose)
        self.run_command(call, timeout=600)
        self.assertTrue(json.loads(result_path.read_text())['completed'])
        self.assertEqual(destination_compose.read_bytes(), edited_compose)


if __name__ == '__main__':
    unittest.main()
