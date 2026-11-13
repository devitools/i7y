import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FailureReporting(unittest.TestCase):
    def test_no_log_timeout_keeps_return_code_for_safe_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            playbook = root / 'playbook.yml'
            result_file = root / 'released'
            playbook.write_text("""- hosts: localhost
  gather_facts: false
  tasks:
    - block:
        - name: Back up the source database without stopping it
          shell: 'exit 137'
          no_log: true
      rescue:
        - name: Release the confirmed stopped backup attempt
          copy:
            content: released
            dest: '""" + str(result_file) + """'
          when:
            - (ansible_failed_result.rc | default(0) | int) in [124, 137]
        - name: Report safe copy failure
          fail:
            msg: 'failed'
""")
            result = subprocess.run([str(ROOT / '.local/artifacts/ansible-runtime/bin/ansible-playbook'), '-i', 'localhost,', '-c', 'local', str(playbook)], capture_output=True, timeout=120)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result_file.read_text(), 'released')

    def test_actual_no_log_failure_is_sanitized_in_rescue(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            playbook = root / 'playbook.yml'
            events = root / 'events.jsonl'
            playbook.write_text('''- hosts: localhost
  gather_facts: false
  tasks:
    - block:
        - name: Update the copied site domain while preserving plugins and theme
          shell: 'echo "secret-value PHP Fatal error I7Y_WP_COMMAND=search-replace" >&2; exit 23'
          no_log: true
      rescue:
        - name: Report safe copy failure
          fail:
            msg: '{{ ansible_failed_result | i7y_safe_failure(ansible_failed_task.name) }}'
''')
            env = dict(os.environ, ANSIBLE_CALLBACK_PLUGINS=str(ROOT / 'apps/automation/ansible/callback_plugins'), ANSIBLE_CONFIG=str(ROOT / 'apps/automation/ansible/ansible.cfg'), ANSIBLE_CALLBACKS_ENABLED='i7y_progress', I7Y_EVENTS_PATH=str(events), I7Y_ATTEMPT_ID='fixture')
            result = subprocess.run([str(ROOT / '.local/artifacts/ansible-runtime/bin/ansible-playbook'), '-i', 'localhost,', '-c', 'local', str(playbook)], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'secret-value', result.stdout)
            values = [json.loads(line) for line in events.read_text().splitlines()]
            failure = values[-1]
            self.assertEqual(failure['stage'], 'domain')
            self.assertEqual(failure['rc'], 23)
            self.assertEqual(failure['command'], 'wordpress.search-replace')
            self.assertNotIn('secret-value', events.read_text())


if __name__ == '__main__':
    unittest.main()
