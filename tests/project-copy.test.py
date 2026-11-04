import copy
import importlib.util
import json
import os
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('project_copy', ROOT / 'apps/automation/ansible/files/project_copy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProjectCopy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'source.example.com'
        (self.root / 'app/public').mkdir(parents=True)
        (self.root / 'app/public/wp-load.php').write_text('<?php')
        (self.root / 'app/public/wp-config.php').write_text('<?php source credential')
        (self.root / 'app/docker-compose.yml').write_text('source Compose credential')
        self.containers = [
            {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64, 'State': {'Running': True},
             'Config': {'Image': 'mysql:5.7', 'Env': ['MYSQL_ROOT_PASSWORD=source-secret', 'MYSQL_DATABASE=source_site'], 'Labels': {}},
             'HostConfig': {'NetworkMode': 'bridge'}, 'Mounts': [{'Type': 'volume', 'Destination': '/var/lib/mysql', 'Name': 'source_data'}]},
            {'Id': 'c' * 64, 'Image': 'sha256:' + 'd' * 64, 'State': {'Running': True},
             'Config': {'Image': 'webdevops/php-nginx:8.3', 'Env': ['WEB_DOCUMENT_ROOT=/var/www/app/public', 'VIRTUAL_HOST=source.example.com', 'MYSQL_PASSWORD=source-secret'], 'Labels': {}},
             'HostConfig': {'NetworkMode': 'bridge'}, 'Mounts': [{'Type': 'bind', 'Source': str(self.root / 'app'), 'Destination': '/var/www/app', 'RW': True}]}]
        self.request = {'operation_id': 'e' * 32, 'source_path': str(self.root), 'source_domain': 'source.example.com', 'destination_domain': 'copy.example.com'}

    def model(self):
        return module.model(self.root, 'source.example.com', 'copy.example.com', self.containers)

    def test_quoted_document_root_is_normalized_without_expanding_shell(self):
        for quote in ['"', "'"]:
            self.containers[1]['Config']['Env'][0] = 'WEB_DOCUMENT_ROOT=' + quote + '/var/www/app/public' + quote
            self.assertEqual(self.model()['wordpress_root'], '/var/www/app/public')
        self.containers[1]['Config']['Env'][0] = 'WEB_DOCUMENT_ROOT="$(id)"'
        with self.assertRaises(module.CopyError):
            self.model()

    def test_legacy_discovery_requires_one_mount_anchored_compose_group(self):
        for container in self.containers:
            container['Config']['Labels']['com.docker.compose.project'] = 'legacy-source'
        def run(args):
            if args[:3] == ['docker', 'ps', '-aq']:
                return '' if '--filter' in args else 'first second'
            return json.dumps(self.containers)
        with patch.object(module, 'command', side_effect=run), patch.object(module, 'model', return_value={}), patch.object(module, 'manifest', return_value=[]):
            for container in self.containers:
                container['Config']['Entrypoint'] = None
                container['Config']['Cmd'] = None
            def inspect_run(args):
                if args[:3] == ['docker', 'image', 'inspect']:
                    return json.dumps([{'Config': {}}])
                return run(args)
            with patch.object(module, 'command', side_effect=inspect_run):
                self.assertEqual(module.inspect(self.request)['files'], [])
                self.containers[1]['Config']['Labels'] = {}
                with self.assertRaises(module.CopyError):
                    module.inspect(self.request)

    def test_progress_exposes_only_allowed_task_names(self):
        import contextlib
        import io
        progress_spec = importlib.util.spec_from_file_location('run_release', ROOT / 'apps/automation/ansible/files/run_release.py')
        progress = importlib.util.module_from_spec(progress_spec)
        progress_spec.loader.exec_module(progress)
        home = Path(self.temp.name)
        logs = home / '.local/share/i7y/ansible'
        logs.mkdir(parents=True)
        operation = 'a' * 32
        (logs / ('operation-' + operation + '-preview.log')).write_text('TASK [Inspect source] ***\nfatal: secret-password\nTASK [Untrusted secret] ***\n')
        output = io.StringIO()
        payload = {'phase': 'status', 'operation_id': operation, 'operation_phase': 'preview', 'task_names': ['Inspect source']}
        with patch.object(progress.Path, 'home', return_value=home), patch.object(progress.sys, 'stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(output):
            self.assertEqual(progress.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {'tasks': ['Inspect source'], 'failed_task': 'Inspect source', 'steps': [{'name': 'Inspect source', 'state': 'failed'}]})

    def test_progress_shows_only_latest_attempt_and_skipped_steps(self):
        import contextlib
        import io
        spec = importlib.util.spec_from_file_location('progress', ROOT / 'apps/automation/ansible/files/run_release.py')
        progress = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(progress)
        home = Path(self.temp.name)
        logs = home / '.local/share/i7y/ansible'
        logs.mkdir(parents=True)
        operation = 'b' * 32
        (logs / ('operation-' + operation + '-execute.log')).write_text('I7Y_ATTEMPT\nTASK [Copy] ***\nfatal: old failure\nI7Y_ATTEMPT\nTASK [Backup] ***\nskipping: [selected]\nTASK [Copy] ***\n')
        output = io.StringIO()
        payload = {'phase': 'status', 'operation_id': operation, 'operation_phase': 'execute', 'task_names': ['Copy', 'Backup']}
        with patch.object(progress.Path, 'home', return_value=home), patch.object(progress.sys, 'stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(output):
            progress.main()
        result = json.loads(output.getvalue())
        self.assertIsNone(result['failed_task'])
        self.assertEqual(result['steps'], [{'name': 'Backup', 'state': 'reused'}, {'name': 'Copy', 'state': 'running'}])

    def test_preview_contains_no_source_credentials(self):
        value = self.model()
        self.assertNotIn('source-secret', json.dumps(value))
        self.assertNotEqual(value['database_name'], self.containers[0]['Id'])
        self.assertEqual(value['destination_root'], str(self.root.parent / 'copy.example.com'))

    def test_refuses_invalid_domains(self):
        for value in ['source.example.com', 'copy;id', '*.example.com', '-bad.example.com', 'a/../example.com', 'UPPER.example.com']:
            with self.subTest(value=value), self.assertRaises(module.CopyError):
                module.model(self.root, 'source.example.com', value, self.containers)

    def test_refuses_shared_or_external_mounts(self):
        for source in ['/etc', str(self.root.parent), '/var/run/docker.sock']:
            self.containers[1]['Mounts'][0]['Source'] = source
            with self.assertRaises(module.CopyError):
                self.model()

    def test_refuses_extra_services_and_database_bind_mounts(self):
        self.containers.append(copy.deepcopy(self.containers[1]))
        with self.assertRaises(module.CopyError):
            self.model()
        self.containers.pop()
        self.containers[0]['Mounts'][0]['Type'] = 'bind'
        with self.assertRaises(module.CopyError):
            self.model()

    def test_copies_project_owned_read_only_configuration_and_omits_database_app_mount(self):
        config = self.root / '.i7y-security/php83-session.ini'
        config.parent.mkdir()
        config.write_text('session.cookie_httponly=1')
        self.containers[1]['Mounts'].append({'Type': 'bind', 'Source': str(config), 'Destination': '/usr/local/etc/php/conf.d/security.ini', 'RW': False})
        self.containers[0]['Mounts'].append({'Type': 'bind', 'Source': str(self.root / 'app'), 'Destination': '/var/www/app', 'RW': True})
        value = self.model()
        self.assertEqual(value['mounts'][1]['relative'], '.i7y-security/php83-session.ini')
        self.assertTrue(value['mounts'][1]['read_only'])

    def test_accepts_privileged_source_without_copying_host_settings(self):
        self.containers[1]['HostConfig']['Privileged'] = True
        value = self.model()
        self.assertNotIn('Privileged', json.dumps(value))
        self.containers[1]['HostConfig']['Privileged'] = False
        (self.root / 'app/public/wp-load.php').unlink()
        with self.assertRaises(module.CopyError):
            self.model()

    def test_refuses_symbolic_links_and_detects_changed_files(self):
        first = module.manifest(self.root)
        (self.root / 'app/public/wp-load.php').write_text('changed')
        self.assertNotEqual(first, module.manifest(self.root))
        (self.root / 'escape').symlink_to('/etc/passwd')
        with self.assertRaises(module.CopyError):
            module.manifest(self.root)

    def test_normalizes_inventory_app_path_without_guessing_other_roots(self):
        self.assertEqual(module.source_root(str(self.root / 'app'), 'source.example.com'), self.root)
        with self.assertRaises(module.CopyError):
            module.source_root(str(self.root / 'app/public'), 'source.example.com')

    def test_insufficient_capacity_is_rejected_before_file_copy(self):
        value = dict(self.model(), files=module.manifest(self.root))
        usage = shutil.disk_usage(str(self.root))
        with patch.object(module, 'command', return_value='1024'), patch.object(module.shutil, 'disk_usage', return_value=usage._replace(free=0)):
            with self.assertRaises(module.CopyError):
                module.check_space(value, self.root.parent)
        self.assertFalse(Path(value['destination_root']).exists())

    def test_preparation_produces_isolated_independent_configuration(self):
        self.check_preparation(False)

    def test_service_names_containing_source_domain_are_validated_before_renaming(self):
        self.check_preparation(True)

    def test_completion_requires_database_domain_and_http_verification(self):
        state = self.root.parent / 'verification'
        (state / 'wordpress').mkdir(parents=True)
        value = self.model()
        plan = {'source': value}
        for name in ['restored', 'finalized']:
            (state / name).touch()
        receipt = state / 'wordpress/domain-contract.json'
        receipt.write_text(json.dumps({'verified': True, 'source': 'source.example.com', 'destination': 'copy.example.com'}))
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'command', side_effect=['true', 'true', '1', 'HTTP/1.1 200 OK\r\n\r\nI7Y_HTTP_CODE:200']):
            result = module.verify(self.request)
        self.assertEqual(result['http_status'], 200)
        self.assertTrue((state / 'verified.json').is_file())
        (state / 'verified.json').unlink()
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'command', side_effect=['true', 'true', '1', 'HTTP/1.1 301 Moved\r\nLocation: https://source.example.com/\r\n\r\nI7Y_HTTP_CODE:301']):
            with self.assertRaisesRegex(module.CopyError, 'original domain'):
                module.verify(self.request)
        self.assertFalse((state / 'verified.json').exists())
        receipt.write_text('{}')
        with patch.object(module, 'load_plan', return_value=(state, plan)):
            with self.assertRaisesRegex(module.CopyError, 'domain'):
                module.verify(self.request)

    def check_preparation(self, domain_services):
        state = self.root.parent / 'operation'
        state.mkdir(mode=0o700)
        (state / 'started.json').write_text('{}')
        (state / 'database.sql').write_text('disposable SQL fixture')
        source_compose = {'version': '3', 'services': {
            'database': {'image': 'mysql:5.7', 'environment': {'MYSQL_ROOT_PASSWORD': '${MYSQL_ROOT_PASSWORD}', 'MYSQL_DATABASE': '${MYSQL_DATABASE}', 'MYSQL_USER': '${MYSQL_USER}', 'MYSQL_PASSWORD': '${MYSQL_PASSWORD}'}, 'volumes': ['data:/var/lib/mysql'], 'networks': ['internal']},
            'web': {'image': 'webdevops/php-nginx:8.3', 'privileged': True, 'environment': {'VIRTUAL_HOST': 'source.example.com', 'MYSQL_PASSWORD': '${MYSQL_PASSWORD}'}, 'volumes': ['.:/var/www/app'], 'networks': ['internal', 'reverse-proxy']}},
            'volumes': {'data': {'driver': 'local'}}, 'networks': {'internal': {'driver': 'bridge'}, 'reverse-proxy': {'external': {'name': 'reverse-proxy'}}}}
        if domain_services:
            source_compose['services'] = {'source.example.com-' + key: service for key, service in source_compose['services'].items()}
            for container, service in zip(self.containers, ['database', 'web']):
                container['Config']['Labels']['com.docker.compose.service'] = 'source.example.com-' + service
        (state / 'source-compose.json').write_text(json.dumps(source_compose))
        value = dict(self.model(), files=module.manifest(self.root))
        plan = {'source': value, 'fingerprint': module.digest(value), 'request': self.request}
        original_config = (self.root / 'app/public/wp-config.php').read_bytes()
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'inspect', return_value=value), patch.object(module, 'available_subnet', return_value='10.240.0.0/28'):
            result = module.prepare(self.request)
            self.assertEqual(module.prepare(self.request), result)
        compose = json.loads(Path(result['compose_path']).read_text())
        database = compose['services'][result['database_service']]
        web = compose['services'][result['web_service']]
        self.assertNotIn('source-secret', json.dumps(compose))
        self.assertEqual(web['environment']['VIRTUAL_HOST'], 'copy.example.com')
        self.assertTrue(web['privileged'])
        self.assertEqual(database['environment']['MYSQL_ROOT_PASSWORD'], '${MYSQL_ROOT_PASSWORD}')
        self.assertEqual(web['environment']['MYSQL_PASSWORD'], '${MYSQL_PASSWORD}')
        self.assertEqual(compose['networks']['reverse-proxy'], source_compose['networks']['reverse-proxy'])
        self.assertNotIn('PHP_VERSION', web['environment'])
        self.assertIn('COMPOSE_PROJECT_NAME=i7y-', (Path(value['destination_root']) / 'app/.env').read_text())
        self.assertEqual(os.stat(value['destination_root']).st_uid, self.root.stat().st_uid)
        self.assertEqual((self.root / 'app/public/wp-config.php').read_bytes(), original_config)
        self.assertEqual(os.stat(value['destination_root']).st_mode & 0o777, self.root.stat().st_mode & 0o777)
        self.assertEqual(os.stat(result['compose_path']).st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((Path(value['destination_root']) / 'app/docker-compose.yml').read_text()), compose)


if __name__ == '__main__':
    unittest.main()
