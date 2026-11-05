import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import tempfile
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

    def test_runtime_change_is_reported_before_playbook_starts(self):
        request = {'address': '192.0.2.1', 'port': 10222, 'phase': 'execute', 'expected_runtime': 'old runtime'}
        output = io.StringIO()
        with patch.object(module.sys, 'stdin', io.StringIO(json.dumps(request))), \
             patch.object(module.subprocess, 'check_output', return_value=b'new runtime\n'), \
             patch.object(module.subprocess, 'run') as run, contextlib.redirect_stdout(output):
            self.assertEqual(module.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['error_code'], 'runtime_changed_before_execution')
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
