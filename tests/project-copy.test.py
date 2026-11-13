import copy
import concurrent.futures
import threading
import time
import importlib.util
import json
import multiprocessing
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
        self.request = {'operation_id': 'e' * 32, 'source_path': str(self.root), 'source_domain': 'source.example.com', 'destination_domain': 'copy.example.com', 'attempt_id': 'f' * 32}

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

    def test_reservation_rechecks_collision_after_failure(self):
        state = self.root.parent / 'reservation'
        state.mkdir()
        value = self.model()
        plan = {'source': value, 'request': self.request, 'created_at': int(module.time.time())}
        def run(args):
            return value['database_name'] if args[:3] == ['docker', 'container', 'ls'] else ''
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'inspect', return_value=value), patch.object(module, 'check_space'), patch.object(module, 'command', side_effect=run):
            for _ in range(2):
                with self.assertRaisesRegex(module.CopyError, 'resource already exists'):
                    module.reserve(self.request)
                self.assertFalse((state / 'started.json').exists())
                self.assertFalse((state.parent / 'copy.lock').exists())

    def test_prepare_rejects_existing_actual_volume_name(self):
        state = self.root.parent / 'volume-collision'
        state.mkdir()
        (state / 'started.json').touch()
        (state / 'source-compose.json').write_text(json.dumps({'volumes': {'source.example.com-data': {}}}))
        value = dict(self.model(), files=module.manifest(self.root))
        plan = {'source': value}
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'command', return_value=value['volume_name'] + '-source.example.com-data\n'):
            for _ in range(2):
                with self.assertRaisesRegex(module.CopyError, 'resource already exists'):
                    module.prepare(self.request)
        self.assertFalse(Path(value['destination_root']).exists())

    def test_prepare_rejects_host_backed_named_volumes(self):
        state = self.root.parent / 'host-backed-volume'
        state.mkdir()
        (state / 'started.json').touch()
        (state / 'source-compose.json').write_text(json.dumps({'volumes': {'data': {'driver': 'local', 'driver_opts': {'type': 'none', 'o': 'bind', 'device': '/srv/source'}}}}))
        value = dict(self.model(), files=module.manifest(self.root))
        with patch.object(module, 'load_plan', return_value=(state, {'source': value})), patch.object(module, 'command', return_value=''):
            with self.assertRaisesRegex(module.CopyError, 'Custom or external source volumes'):
                module.prepare(self.request)
        self.assertFalse(Path(value['destination_root']).exists())

    def test_prepare_rejects_existing_generated_network_name(self):
        state = self.root.parent / 'network-collision'
        state.mkdir()
        (state / 'started.json').touch()
        (state / 'source-compose.json').write_text(json.dumps({'networks': {'internal': {}}}))
        value = dict(self.model(), files=module.manifest(self.root))
        actual_name = value['network_name'] + '-' + module.digest('internal')[:12]
        def run(args):
            return actual_name if args[:3] == ['docker', 'network', 'ls'] else ''
        with patch.object(module, 'load_plan', return_value=(state, {'source': value})), patch.object(module, 'command', side_effect=run):
            with self.assertRaisesRegex(module.CopyError, 'resource already exists'):
                module.prepare(self.request)
        self.assertFalse(Path(value['destination_root']).exists())

    def test_concurrent_attempts_cannot_both_reserve(self):
        state = self.root.parent / 'concurrent-attempts'
        state.mkdir()
        gate = threading.Barrier(2)
        requests = [dict(self.request, attempt_id=character * 32) for character in ('a', 'b')]
        def invoke(request):
            gate.wait(timeout=5)
            try:
                return module.reserve(request)
            except module.CopyError:
                return None
        with patch.object(module, 'load_plan', return_value=(state, {})), patch.object(module, 'reserve_started', return_value={'reserved': True}):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(invoke, requests))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertIn(json.loads((state / 'attempt.active').read_text())['attempt_id'], [request['attempt_id'] for request in requests])

    def test_retry_is_blocked_while_previous_reservation_is_running(self):
        state = self.root.parent / 'running-attempt'
        state.mkdir()
        entered, release = threading.Event(), threading.Event()
        def running(*_args):
            entered.set()
            self.assertTrue(release.wait(5))
            return {'reserved': True}
        with patch.object(module, 'load_plan', return_value=(state, {})), patch.object(module, 'reserve_started', side_effect=running):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                first = executor.submit(module.reserve, dict(self.request, attempt_id='a' * 32))
                self.assertTrue(entered.wait(5))
                try:
                    with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                        module.reserve(dict(self.request, attempt_id='b' * 32))
                finally:
                    release.set()
                self.assertEqual(first.result(timeout=5), {'reserved': True})

    def test_lost_controller_process_cannot_clear_the_remote_attempt(self):
        if 'fork' not in multiprocessing.get_all_start_methods():
            self.skipTest('Process-loss simulation requires fork')
        state = self.root.parent / 'lost-controller'
        state.mkdir()
        context = multiprocessing.get_context('fork')
        entered = context.Event()
        def running(*_args):
            entered.set()
            time.sleep(30)
            return {'reserved': True}
        with patch.object(module, 'load_plan', return_value=(state, {})), patch.object(module, 'reserve_started', side_effect=running):
            worker = context.Process(target=module.reserve, args=(dict(self.request, attempt_id='a' * 32),))
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                worker.terminate()
                worker.join(5)
                self.assertFalse(worker.is_alive())
                with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                    module.reserve(dict(self.request, attempt_id='b' * 32))
                self.assertTrue((state / 'attempt.active').exists())
            finally:
                if worker.is_alive():
                    worker.kill()
                    worker.join()

    def test_active_attempt_blocks_a_second_reservation(self):
        state = self.root.parent / 'active-attempt'
        state.mkdir()
        (state / 'started.json').touch()
        (state / 'attempt.active').write_text(json.dumps({'attempt_id': 'a' * 32}))
        with patch.object(module, 'load_plan', return_value=(state, {'source': self.model()})):
            with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                module.reserve(self.request)
        self.assertEqual(json.loads((state / 'attempt.active').read_text())['attempt_id'], 'a' * 32)

    def test_backup_attempt_releases_only_after_confirmed_cleanup(self):
        state = self.root.parent / 'backup-attempt'
        state.mkdir()
        (state / 'attempt.active').write_text(json.dumps({'attempt_id': self.request['attempt_id']}))
        (state / 'backup.stderr').write_text('I7Y_BACKUP_CLEAN\n')
        plan = {'source': self.model()}
        exec_id = '1' * 64
        (state / 'backup-exec.json').write_text(json.dumps({'attempt_id': self.request['attempt_id'], 'database_id': plan['source']['database_id'], 'exec_id': exec_id}))
        inspected = {'ID': exec_id, 'ContainerID': plan['source']['database_id'], 'Running': True}
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'docker_json', return_value=inspected):
            with self.assertRaisesRegex(module.CopyError, 'backup exec is still running'):
                module.release_backup_attempt(self.request)
        self.assertTrue((state / 'attempt.active').exists())
        inspected['Running'] = False
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'docker_json', return_value=inspected) as inspect_exec, patch.object(module, 'command', side_effect=AssertionError('Unrelated exec sessions must not be inspected')):
            self.assertTrue(module.release_backup_attempt(self.request)['released'])
            inspect_exec.assert_called_once_with('GET', '/exec/' + exec_id + '/json')
        self.assertFalse((state / 'attempt.active').exists())

    def test_download_failure_releases_only_matching_attempt_without_pending_backup(self):
        state = self.root.parent / 'download-attempt'
        state.mkdir()
        (state / 'attempt.active').write_text(json.dumps({'attempt_id': self.request['attempt_id']}))
        with patch.object(module, 'load_plan', return_value=(state, {})):
            with self.assertRaisesRegex(module.CopyError, 'owner mismatch'):
                module.release_download_attempt(dict(self.request, attempt_id='b' * 32))
            (state / 'backup.pending').touch()
            with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                module.release_download_attempt(self.request)
            (state / 'backup.pending').unlink()
            (state / 'preparation.pending').touch()
            with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                module.release_download_attempt(self.request)
            (state / 'preparation.pending').unlink()
            self.assertTrue(module.release_download_attempt(self.request)['released'])
        self.assertFalse((state / 'attempt.active').exists())

    def test_health_failure_releases_only_matching_completed_attempt(self):
        state = self.root.parent / 'health-attempt'
        state.mkdir()
        (state / 'attempt.active').write_text(json.dumps({'attempt_id': self.request['attempt_id']}))
        with patch.object(module, 'load_plan', return_value=(state, {})):
            with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                module.release_health_attempt(self.request)
            (state / 'restored').touch()
            (state / 'finalized').touch()
            self.assertTrue(module.release_health_attempt(self.request)['released'])
        self.assertFalse((state / 'attempt.active').exists())

    def test_started_reservation_requires_matching_lock_owner(self):
        state = self.root.parent / 'started'
        state.mkdir()
        (state / 'started.json').touch()
        lock = state.parent / 'copy.lock'
        lock.mkdir()
        (lock / 'owner.json').write_text(json.dumps({'operation_id': 'f' * 32}))
        value = self.model()
        plan = {'source': value, 'request': self.request, 'created_at': int(module.time.time())}
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'inspect', return_value=value):
            with self.assertRaisesRegex(module.CopyError, 'lock owner mismatch'):
                module.reserve(self.request)
            (lock / 'owner.json').write_text(json.dumps({'operation_id': self.request['operation_id']}))
            self.assertEqual(module.reserve(self.request)['database_id'], value['database_id'])

    def test_completed_reservation_returns_without_touching_source(self):
        state = self.root.parent / 'completed'
        state.mkdir()
        (state / 'started.json').touch()
        (state / 'completed.json').write_text(json.dumps({'review_required': False}))
        (state / 'verified.json').write_text(json.dumps({'source': 'source.example.com', 'destination': 'copy.example.com'}))
        value = self.model()
        plan = {'source': value, 'request': self.request, 'created_at': int(module.time.time())}
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'inspect', side_effect=AssertionError('Source must not be inspected')):
            self.assertTrue(module.reserve(self.request)['completed'])
        self.assertFalse((state.parent / 'copy.lock').exists())

    def completed_state(self):
        state = self.root.parent / 'completed-attempt'
        state.mkdir()
        destination = Path(self.model()['destination_root'])
        destination.mkdir()
        (state / 'attempt.active').write_text(json.dumps({'attempt_id': self.request['attempt_id']}))
        (state / 'verified.json').write_text(json.dumps({'source': 'source.example.com', 'destination': 'copy.example.com'}))
        lock = state.parent / 'copy.lock'
        lock.mkdir()
        (lock / 'owner.json').write_text(json.dumps({'operation_id': self.request['operation_id']}))
        return state, {'source': self.model(), 'request': self.request}

    def test_completed_cleanup_recovers_only_the_completed_attempt(self):
        state, plan = self.completed_state()
        with patch.object(module, 'load_plan', return_value=(state, plan)):
            with patch.object(module, 'cleanup_completed', side_effect=OSError('interrupted cleanup')):
                with self.assertRaises(OSError):
                    module.finish(self.request)
            self.assertTrue((state / 'completed.json').exists())
            with module.exclusive_lock(state / 'attempt.lock'):
                with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                    module.reserve(dict(self.request, attempt_id='b' * 32))
            with patch.object(module, 'inspect', side_effect=AssertionError('Completed source must not be inspected')):
                self.assertTrue(module.reserve(dict(self.request, attempt_id='b' * 32))['completed'])
        self.assertFalse((state / 'attempt.active').exists())
        self.assertFalse((state.parent / 'copy.lock').exists())

    def test_completion_does_not_remove_a_different_attempt(self):
        state, plan = self.completed_state()
        (state / 'completed.json').write_text(json.dumps({'review_required': False, 'attempt_id': 'b' * 32}))
        with patch.object(module, 'load_plan', return_value=(state, plan)):
            with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                module.reserve(self.request)
        self.assertTrue((state / 'attempt.active').exists())
        self.assertTrue((state.parent / 'copy.lock/owner.json').exists())

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

    def test_rejects_privileged_source_and_missing_wordpress(self):
        self.containers[1]['HostConfig']['Privileged'] = True
        with self.assertRaises(module.CopyError):
            self.model()
        self.containers[1]['HostConfig']['Privileged'] = False
        (self.root / 'app/public/wp-load.php').unlink()
        with self.assertRaises(module.CopyError):
            self.model()

    def test_refuses_symbolic_links_and_detects_changed_configuration(self):
        first = module.manifest(self.root)
        (self.root / 'app/public/wp-load.php').write_text('changed')
        self.assertNotEqual(first, module.manifest(self.root))
        self.assertEqual(module.configuration_files(self.model(), first), module.configuration_files(self.model(), module.manifest(self.root)))
        (self.root / 'app/public/wp-config.php').write_text('changed configuration')
        state = self.root.parent / 'changed-operation'
        state.mkdir()
        (state / 'started.json').write_text('{}')
        value = dict(self.model(), files=first)
        with patch.object(module, 'load_plan', return_value=(state, {'source': value, 'request': self.request})):
            with self.assertRaisesRegex(module.CopyError, 'Source configuration files changed'):
                module.prepare(self.request)
        self.assertFalse(Path(value['destination_root']).exists())
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

    def test_multiple_internal_networks_are_distinct(self):
        self.check_preparation(False, multiple_networks=True)

    def test_preparation_accepts_live_content_changes(self):
        self.check_preparation(False, live_files=True)

    def test_configuration_in_the_document_root_remains_protected(self):
        value = dict(self.model(), wordpress_root='/var/www/app')
        (self.root / 'app/.env').write_text('CONFIG=approved')
        approved = module.configuration_files(value, module.manifest(self.root))
        for relative in ('app/.env', 'app/docker-compose.yml'):
            with self.subTest(path=relative):
                path = self.root / relative
                original = path.read_text()
                path.write_text('Changed configuration')
                self.assertNotEqual(approved, module.configuration_files(value, module.manifest(self.root)))
                path.write_text(original)

    def test_preparation_supports_compose_long_volume_syntax(self):
        self.check_preparation(False, long_volume=True)

    def test_unsupported_database_volumes_fail_before_copying(self):
        state = self.root.parent / 'invalid-mount'
        state.mkdir()
        (state / 'started.json').touch()
        value = dict(self.model(), files=module.manifest(self.root))
        for mounts in [[{'type': 'bind', 'source': '/srv/data', 'target': '/var/lib/mysql'}],
                       [{'type': 'volume', 'source': 'undeclared', 'target': '/var/lib/mysql'}],
                       ['data:/var/lib/mysql', 'data:/var/lib/mysql'],
                       ['/var/lib/mysql'], [42]]:
            compose = {'services': {'database': {'volumes': mounts}, 'web': {}}, 'volumes': {'data': {}}}
            (state / 'source-compose.json').write_text(json.dumps(compose))
            with self.subTest(mounts=mounts), patch.object(module, 'load_plan', return_value=(state, {'source': value})), patch.object(module, 'command', return_value=''):
                with self.assertRaises(module.CopyError):
                    module.prepare(self.request)
                self.assertFalse(Path(value['destination_root']).exists())
                self.assertFalse((state / 'preparation.pending').exists())

    def test_domain_rewrite_preserves_longer_hosts(self):
        text = 'source.example.com www.source.example.com source.example.com.evil not-source.example.com source.example.com-db'
        self.assertEqual(module.replace_domain(text, 'source.example.com', 'copy.example.com'), 'copy.example.com www.copy.example.com source.example.com.evil not-source.example.com source.example.com-db')

    def test_isolated_compose_removes_external_routes_and_published_ports(self):
        source = {'services': {'db': {'image': 'mysql:5.7', 'networks': ['internal'], 'ports': ['3306:3306']},
            'web': {'image': 'web', 'networks': ['internal', 'reverse-proxy'], 'ports': ['8080:80']}},
            'networks': {'internal': {}, 'reverse-proxy': {'external': True}}}
        result = module.isolated_compose(source, 'db', 'web', 'review-network', '10.240.0.0/28')
        self.assertEqual(result['services']['db']['networks'], ['i7y_review'])
        self.assertEqual(result['services']['web']['networks'], ['i7y_review'])
        self.assertNotIn('ports', result['services']['web'])
        self.assertNotIn('ports', result['services']['db'])
        self.assertEqual(result['services']['web']['restart'], 'no')
        self.assertIn('NET_RAW', result['services']['web']['cap_drop'])
        self.assertIn('no-new-privileges:true', result['services']['web']['security_opt'])
        self.assertNotIn('depends_on', result['services']['db'])
        self.assertTrue(result['networks']['i7y_review']['internal'])
        self.assertEqual(result['networks']['i7y_review']['driver_opts']['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated')
        self.assertIn('ports', source['services']['web'])
        for override in [{'privileged': True}, {'cap_add': ['NET_ADMIN']}, {'network_mode': 'host'}, {'devices': ['/dev/net/tun']}, {'use_api_socket': True}]:
            changed = copy.deepcopy(source)
            changed['services']['web'].update(override)
            with self.assertRaises(module.CopyError):
                module.isolated_compose(changed, 'db', 'web', 'review-network', '10.240.0.0/28')

    def test_isolation_verification_rejects_unsafe_network_and_container_state(self):
        network = {'Name': 'review', 'Driver': 'bridge', 'Internal': True, 'EnableIPv6': False,
            'Options': {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'},
            'IPAM': {'Config': [{'Subnet': '10.240.0.0/28'}]}, 'Containers': {'db-id': {}}}
        container = {'Id': 'db-id', 'HostConfig': {'PortBindings': None, 'Privileged': False, 'CapDrop': ['NET_RAW', 'NET_ADMIN'], 'SecurityOpt': ['no-new-privileges:true']},
            'NetworkSettings': {'Networks': {'review': {}}}}
        module.require_isolated_network(network, [container], 'review')
        for mutate in [lambda n, c: n.update(Internal=False),
                       lambda n, c: n.update(EnableIPv6=True),
                       lambda n, c: n['Options'].update({'com.docker.network.bridge.gateway_mode_ipv4': 'nat'}),
                       lambda n, c: n['IPAM']['Config'][0].update(Gateway='10.240.0.1'),
                       lambda n, c: n['Containers'].update(other={}),
                       lambda n, c: c['HostConfig'].update(PortBindings={'80/tcp': [{}]}),
                       lambda n, c: c['HostConfig'].update(Privileged=True),
                       lambda n, c: c['HostConfig'].update(CapDrop=[]),
                       lambda n, c: c['HostConfig'].update(SecurityOpt=[]),
                       lambda n, c: c['HostConfig'].update(PublishAllPorts=True),
                       lambda n, c: c['NetworkSettings'].update(Ports={'80/tcp': [{'HostPort': '8080'}]}),
                       lambda n, c: c['NetworkSettings']['Networks'].update(proxy={})]:
            altered_network, altered_container = copy.deepcopy(network), copy.deepcopy(container)
            mutate(altered_network, altered_container)
            with self.assertRaises(module.CopyError):
                module.require_isolated_network(altered_network, [altered_container], 'review')

    def test_subnet_allocation_excludes_reserved_ranges(self):
        with patch.object(module, 'command', return_value=''):
            self.assertEqual(module.available_subnet(['10.240.0.0/28']), '10.240.0.16/28')

    def test_http_verification_requires_web_on_review_network(self):
        state = self.root.parent / 'isolation-check'
        state.mkdir()
        value = self.model()
        (state / 'prepared.json').write_text(json.dumps({'review_network': 'review'}))
        network = {'Containers': {'db-id': {}}}
        database = {'Id': 'db-id', 'Name': '/' + value['database_name'], 'Image': value['database_image']}
        with patch.object(module, 'load_plan', return_value=(state, {'source': value})), patch.object(module, 'command', side_effect=[json.dumps([network]), json.dumps([database])]):
            with self.assertRaisesRegex(module.CopyError, 'web service is not connected'):
                module.verify_isolation(self.request, True)
        database['Image'] = 'sha256:' + '0' * 64
        with patch.object(module, 'load_plan', return_value=(state, {'source': value})), patch.object(module, 'command', side_effect=[json.dumps([network]), json.dumps([database])]):
            with self.assertRaisesRegex(module.CopyError, 'unapproved image'):
                module.verify_isolation(self.request)

    def test_publication_requires_successful_isolated_verification(self):
        state = self.root.parent / 'publish-test'
        state.mkdir()
        (state / 'prepared.json').write_text('{}')
        with patch.object(module, 'load_plan', return_value=(state, {'source': self.model()})):
            with self.assertRaisesRegex(module.CopyError, 'must pass verification'):
                module.activate(self.request)
        self.assertFalse((state / 'activated.json').exists())

    def test_completion_requires_database_domain_and_http_verification(self):
        state = self.root.parent / 'verification'
        (state / 'wordpress').mkdir(parents=True)
        value = self.model()
        plan = {'source': value}
        for name in ['restored', 'finalized']:
            (state / name).touch()
        receipt = state / 'wordpress/domain-contract.json'
        receipt.write_text(json.dumps({'verified': True, 'source': 'source.example.com', 'destination': 'copy.example.com'}))
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'verify_isolation'), patch.object(module, 'command', side_effect=['true', 'true', '1', 'HTTP/1.1 200 OK\r\n\r\nI7Y_HTTP_CODE:200']):
            result = module.verify(self.request)
        self.assertEqual(result['http_status'], 200)
        self.assertTrue((state / 'verified.json').is_file())
        (state / 'verified.json').unlink()
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'verify_isolation'), patch.object(module, 'command', side_effect=['true', 'true', '1', 'HTTP/1.1 301 Moved\r\nLocation: https://source.example.com/\r\n\r\nI7Y_HTTP_CODE:301']):
            with self.assertRaisesRegex(module.CopyError, 'original domain'):
                module.verify(self.request)
        self.assertFalse((state / 'verified.json').exists())
        receipt.write_text('{}')
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'verify_isolation'):
            with self.assertRaisesRegex(module.CopyError, 'domain'):
                module.verify(self.request)

    def check_preparation(self, domain_services, multiple_networks=False, live_files=False, long_volume=False):
        state = self.root.parent / 'operation'
        state.mkdir(mode=0o700)
        (state / 'started.json').write_text('{}')
        (state / 'database.sql').write_text('disposable SQL fixture')
        (state / 'database.sha256').write_text(module.hashlib.sha256(b'disposable SQL fixture').hexdigest())
        source_compose = {'version': '3', 'services': {
            'database': {'image': 'mysql:5.7', 'environment': {'MYSQL_ROOT_PASSWORD': '${MYSQL_ROOT_PASSWORD}', 'MYSQL_DATABASE': '${MYSQL_DATABASE}', 'MYSQL_USER': '${MYSQL_USER}', 'MYSQL_PASSWORD': '${MYSQL_PASSWORD}'}, 'volumes': ['data:/var/lib/mysql'], 'networks': ['internal']},
            'web': {'image': 'webdevops/php-nginx:8.3', 'environment': {'VIRTUAL_HOST': 'source.example.com', 'MYSQL_PASSWORD': '${MYSQL_PASSWORD}'}, 'volumes': ['.:/var/www/app'], 'networks': ['internal', 'reverse-proxy']}},
            'volumes': {'data': {'driver': 'local'}}, 'networks': {'internal': {'driver': 'bridge'}, 'reverse-proxy': {'external': {'name': 'reverse-proxy'}}}}
        if long_volume:
            source_compose['services']['database']['volumes'] = [{'type': 'volume', 'source': 'data', 'target': '/var/lib/mysql', 'volume': {'nocopy': True}}]
        if multiple_networks:
            source_compose['networks']['other'] = {'driver': 'bridge'}
            source_compose['services']['web']['networks'].append('other')
        if domain_services:
            source_compose['services'] = {'source.example.com-' + key: service for key, service in source_compose['services'].items()}
            for container, service in zip(self.containers, ['database', 'web']):
                container['Config']['Labels']['com.docker.compose.service'] = 'source.example.com-' + service
        (state / 'source-compose.json').write_text(json.dumps(source_compose))
        (self.root / 'app/.env').write_text('SITE=source.example.com\nUNRELATED=source.example.com.evil\n')
        value = dict(self.model(), files=module.manifest(self.root))
        plan = {'source': value, 'fingerprint': module.digest(value), 'request': self.request}
        if live_files:
            (self.root / 'app/public/wp-content/uploads').mkdir(parents=True)
            (self.root / 'app/public/wp-content/uploads/new.txt').write_text('New live upload')
            (self.root / 'app/public/wp-load.php').write_text('Changed live content')
        original_config = (self.root / 'app/public/wp-config.php').read_bytes()
        original_command = module.command
        def run(args, timeout=60):
            return '' if args[:3] in (['docker', 'volume', 'ls'], ['docker', 'network', 'ls']) else original_command(args, timeout)
        with patch.object(module, 'load_plan', return_value=(state, plan)), patch.object(module, 'inspect', return_value=value), patch.object(module, 'available_subnet', side_effect=lambda reserved: '10.240.0.' + str(16 * len(reserved)) + '/28'), patch.object(module, 'command', side_effect=run):
            (state / 'backup.pending').touch()
            with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
                module.prepare(self.request)
            (state / 'backup.pending').unlink()
            (state / 'database.sql').write_text('tampered SQL fixture')
            with self.assertRaisesRegex(module.CopyError, 'backup checksum'):
                module.prepare(self.request)
            (state / 'database.sql').write_text('disposable SQL fixture')
            result = module.prepare(self.request)
            self.assertEqual(module.prepare(self.request), result)
        review = json.loads(Path(result['compose_path']).read_text())
        if long_volume:
            self.assertEqual(review['services'][result['database_service']]['volumes'], source_compose['services']['database']['volumes'])
        if live_files:
            self.assertEqual((Path(value['destination_root']) / 'app/public/wp-content/uploads/new.txt').read_text(), 'New live upload')
        self.assertEqual(review['services'][result['web_service']]['networks'], ['i7y_review'])
        compose = json.loads((state / 'publish-compose.json').read_text())
        review_subnet = review['networks']['i7y_review']['ipam']['config'][0]['subnet']
        final_subnets = [config['subnet'] for network in compose['networks'].values() for config in (network.get('ipam', {}).get('config') or [])]
        self.assertNotIn(review_subnet, final_subnets)
        database = compose['services'][result['database_service']]
        web = compose['services'][result['web_service']]
        self.assertNotIn('source-secret', json.dumps(compose))
        self.assertEqual(database['image'], value['database_image'])
        self.assertEqual(web['image'], value['web_image'])
        self.assertEqual(web['environment']['VIRTUAL_HOST'], 'copy.example.com')
        self.assertNotIn('privileged', web)
        self.assertEqual(database['environment']['MYSQL_ROOT_PASSWORD'], '${MYSQL_ROOT_PASSWORD}')
        self.assertEqual(web['environment']['MYSQL_PASSWORD'], '${MYSQL_PASSWORD}')
        self.assertEqual(compose['networks']['reverse-proxy'], source_compose['networks']['reverse-proxy'])
        if multiple_networks:
            self.assertNotEqual(compose['networks']['internal']['name'], compose['networks']['other']['name'])
            self.assertNotEqual(compose['networks']['internal']['ipam']['config'], compose['networks']['other']['ipam']['config'])
        self.assertNotIn('PHP_VERSION', web['environment'])
        destination_env = (Path(value['destination_root']) / 'app/.env').read_text()
        self.assertIn('COMPOSE_PROJECT_NAME=i7y-', destination_env)
        self.assertIn('SITE=copy.example.com\n', destination_env)
        self.assertIn('UNRELATED=source.example.com.evil\n', destination_env)
        self.assertEqual(os.stat(value['destination_root']).st_uid, self.root.stat().st_uid)
        self.assertEqual((self.root / 'app/public/wp-config.php').read_bytes(), original_config)
        self.assertEqual(os.stat(value['destination_root']).st_mode & 0o777, self.root.stat().st_mode & 0o777)
        self.assertEqual(os.stat(result['compose_path']).st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((Path(value['destination_root']) / 'app/docker-compose.yml').read_text()), review)


if __name__ == '__main__':
    unittest.main()
