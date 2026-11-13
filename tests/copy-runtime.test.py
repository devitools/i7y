import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import tempfile
import subprocess
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('run_release', ROOT / 'apps/automation/ansible/files/run_release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeRejection(unittest.TestCase):
    def test_status_ignores_previous_attempt_after_start_marker(self):
        operation = 'a' * 32
        request = {'phase': 'status', 'operation_id': operation, 'operation_phase': 'execute'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / '.local/share/i7y/ansible'
            root.mkdir(parents=True)
            events = root / ('operation-' + operation + '-execute.events.jsonl')
            events.write_text(json.dumps({'attempt': 'old', 'name': 'Failed task', 'state': 'failed'}) + '\n' + json.dumps({'attempt': 'new', 'state': 'started'}) + '\n')
            output = io.StringIO()
            with patch.object(module.Path, 'home', return_value=Path(directory)), patch.object(module.sys, 'stdin', io.StringIO(json.dumps(request))), contextlib.redirect_stdout(output):
                self.assertEqual(module.main(), 0)
            result = json.loads(output.getvalue())
            self.assertEqual(result['attempt'], 'new')
            self.assertEqual(result['steps'], [])
            self.assertIsNone(result['failed_task'])

    def test_retry_requires_completed_remote_release_and_transient_health_failure(self):
        detail = {'name': 'Verify the copied site HTTP response', 'error': 'The copied site did not return a successful HTTP response'}
        event = {'attempt': 'first', 'name': 'Release the completed health-check attempt', 'state': 'completed'}
        self.assertTrue(module.retryable_failure(detail, [event], 'first', 'fatal'))
        self.assertFalse(module.retryable_failure(detail, [], 'first', 'fatal'))
        self.assertTrue(module.retryable_failure({'name':'Recheck the preview and reserve the operation'}, [], 'first', 'A previous copy attempt requires reconciliation before retry'))
        self.assertFalse(module.retryable_failure({'name':'Other task'}, [], 'first', 'A previous copy attempt requires reconciliation before retry'))
        self.assertTrue(module.retryable_failure({'name':'Recheck the preview and reserve the operation'}, [], 'first', 'Another project copy requires completion or reconciliation'))
        self.assertFalse(module.retryable_failure(detail, [event], 'other', 'fatal'))
        self.assertFalse(module.retryable_failure(detail, [event], 'first', 'UNREACHABLE!'))
        self.assertFalse(module.retryable_failure({'name': detail['name'], 'error': 'Review network changed'}, [event], 'first', 'fatal'))
        backup = {'name': 'Back up the source database without stopping it', 'rc': 137}
        released = {'attempt': 'first', 'name': 'Release the confirmed stopped backup attempt', 'state': 'completed'}
        self.assertTrue(module.retryable_failure(backup, [released], 'first', 'fatal'))
        self.assertFalse(module.retryable_failure(backup, [], 'first', 'fatal'))
        download = {'name': 'Fetch the checksum-pinned WP-CLI artifact'}
        downloaded = {'attempt': 'first', 'name': 'Release the completed download attempt', 'state': 'completed'}
        self.assertTrue(module.retryable_failure(download, [downloaded], 'first', 'fatal'))
        self.assertFalse(module.retryable_failure(download, [], 'first', 'fatal'))
        self.assertFalse(module.retryable_failure(download, [downloaded], 'first', 'UNREACHABLE!'))

    def test_runner_reports_retryable_after_realistic_health_events(self):
        helper = (ROOT / 'apps/automation/ansible/files/project_copy.py').read_text()
        request = {'address': '192.0.2.1', 'port': 10222, 'phase': 'execute', 'expected_runtime': 'fixture',
                   'request': {'operation_id': 'a' * 32}, 'files': {'ansible/files/project_copy.py': helper}}
        reason = 'The copied site did not return a successful HTTP response'
        def run(_args, **kwargs):
            kwargs['stdout'].write(('fatal: [selected]: FAILED! => ' + json.dumps({'stdout': json.dumps({'error': reason})}) + '\n').encode())
            kwargs['stdout'].flush()
            attempt = kwargs['env']['I7Y_ATTEMPT_ID']
            events = [
                {'attempt': attempt, 'name': 'Verify the copied site HTTP response', 'state': 'failed', 'error': 'generic', 'rc': 1},
                {'attempt': attempt, 'name': 'Release the completed health-check attempt', 'state': 'completed'},
                {'attempt': attempt, 'name': 'Verify the copied site HTTP response', 'state': 'failed', 'error': 'generic', 'rc': 1},
            ]
            with Path(kwargs['env']['I7Y_EVENTS_PATH']).open('a') as output:
                for event in events:
                    output.write(json.dumps(event) + '\n')
            return SimpleNamespace(returncode=1)
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with patch.object(module.Path, 'home', return_value=Path(directory).resolve()), patch.object(module.sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(module.subprocess, 'check_output', return_value=b'fixture\n'), patch.object(module.subprocess, 'run', side_effect=run), contextlib.redirect_stdout(output):
                self.assertEqual(module.main(), 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result['error'], reason)
            self.assertTrue(result['retryable'])

    def test_runner_reports_active_attempt_as_retryable(self):
        helper = (ROOT / 'apps/automation/ansible/files/project_copy.py').read_text()
        request = {'address': '192.0.2.1', 'port': 10222, 'phase': 'execute', 'expected_runtime': 'fixture',
                   'request': {'operation_id': 'b' * 32}, 'files': {'ansible/files/project_copy.py': helper}}
        pending = 'A previous copy attempt requires reconciliation before retry'
        def run(_args, **kwargs):
            kwargs['stdout'].write(('failure: ' + pending + '\n').encode())
            kwargs['stdout'].flush()
            event = {'attempt': kwargs['env']['I7Y_ATTEMPT_ID'], 'name': 'Recheck the preview and reserve the operation', 'state': 'failed', 'error': 'generic', 'rc': 1}
            with Path(kwargs['env']['I7Y_EVENTS_PATH']).open('a') as output:
                output.write(json.dumps(event) + '\n')
            return SimpleNamespace(returncode=1)
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with patch.object(module.Path, 'home', return_value=Path(directory).resolve()), patch.object(module.sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(module.subprocess, 'check_output', return_value=b'fixture\n'), patch.object(module.subprocess, 'run', side_effect=run), contextlib.redirect_stdout(output):
                self.assertEqual(module.main(), 1)
            result = json.loads(output.getvalue())
            self.assertEqual(result['error'], pending)
            self.assertEqual(result['error_detail']['error'], pending)
            self.assertTrue(result['retryable'])

    def test_helper_error_allowlist_supports_current_python(self):
        source = (ROOT / 'apps/automation/ansible/files/project_copy.py').read_text()
        errors = module.allowed_helper_errors(source)
        self.assertIn('The copied site did not return a successful HTTP response', errors)
        self.assertIn('A previous copy attempt requires reconciliation before retry', errors)

    def test_runtime_change_is_reported_before_playbook_starts(self):
        request = {'address': '192.0.2.1', 'port': 10222, 'phase': 'execute', 'expected_runtime': 'old runtime',
                   'request': {'operation_id': 'c' * 32}, 'files': {}}
        with tempfile.TemporaryDirectory() as directory:
            for was_started in (False, True):
                with self.subTest(started=was_started):
                    if was_started:
                        root = Path(directory) / '.local/share/i7y/ansible'
                        (root / ('operation-' + 'c' * 32 + '-started.json')).write_text('{}')
                    output = io.StringIO()
                    with patch.object(module.Path, 'home', return_value=Path(directory).resolve()), \
                         patch.object(module.sys, 'stdin', io.StringIO(json.dumps(request))), \
                         patch.object(module.subprocess, 'check_output', return_value=b'new runtime\n'), \
                         patch.object(module.subprocess, 'run') as run, contextlib.redirect_stdout(output):
                        self.assertEqual(module.main(), 1)
                    result = json.loads(output.getvalue())
                    self.assertEqual(result['error_code'], 'runtime_changed_before_execution')
                    self.assertEqual(result['execution_started'], was_started)
                    run.assert_not_called()

    def test_timeout_preserves_remote_start_receipt_and_reports_uncertain_outcome(self):
        request = {'address': '192.0.2.1', 'port': 10222, 'phase': 'execute', 'expected_runtime': 'fixture',
                   'request': {'operation_id': 'd' * 32}, 'files': {}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            receipt = root / '.local/share/i7y/ansible' / ('operation-' + 'd' * 32 + '-started.json')
            def timeout(_args, **kwargs):
                self.assertTrue(receipt.is_file())
                self.assertEqual(kwargs['timeout'], 14400)
                raise subprocess.TimeoutExpired(_args, kwargs['timeout'])
            output = io.StringIO()
            with patch.object(module.Path, 'home', return_value=root), patch.object(module.sys, 'stdin', io.StringIO(json.dumps(request))), patch.object(module.subprocess, 'check_output', return_value=b'fixture\n'), patch.object(module.subprocess, 'run', side_effect=timeout), contextlib.redirect_stdout(output):
                self.assertEqual(module.main(), 1)
            result = json.loads(output.getvalue())
            self.assertTrue(result['execution_started'])
            self.assertFalse(result['retryable'])
            self.assertTrue(receipt.exists())


if __name__ == '__main__':
    unittest.main()
