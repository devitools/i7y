import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('callback', ROOT / 'apps/automation/ansible/callback_plugins/i7y_progress.py')
callback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(callback)


class Progress(unittest.TestCase):
    def test_unchanged_success_is_completed_and_skipped_stage_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events'
            class Task:
                def get_name(self):
                    return 'Wait for the new database'
            class Result:
                _task = Task()
                _result = {'changed': False}
            with patch.dict(os.environ, {'I7Y_EVENTS_PATH': str(path), 'I7Y_ATTEMPT_ID': 'attempt'}):
                plugin = callback.CallbackModule()
                plugin.v2_runner_on_ok(Result())
                plugin.v2_runner_on_skipped(Result())
            self.assertEqual([json.loads(line)['state'] for line in path.read_text().splitlines()], ['completed', 'reused'])

    def test_no_log_failure_exposes_only_safe_reason_and_return_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'events'
            class Task:
                def get_name(self):
                    return 'Update the copied site domain while preserving plugins and theme'
            with patch.dict(os.environ, {'I7Y_EVENTS_PATH': str(path), 'I7Y_ATTEMPT_ID': 'attempt'}):
                callback.CallbackModule().emit(Task(), 'failed', {'_ansible_no_log': True, 'rc': 1, 'stderr': 'secret-token PHP Fatal error password=secret'})
            value = json.loads(path.read_text())
            self.assertEqual(value['stage'], 'domain')
            self.assertEqual(value['rc'], 1)
            self.assertNotIn('secret', path.read_text())


if __name__ == '__main__':
    unittest.main()
