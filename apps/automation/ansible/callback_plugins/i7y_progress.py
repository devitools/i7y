from __future__ import absolute_import

import json
import os
import time
from ansible.plugins.callback import CallbackBase

STAGES = {
    'Back up the source database without stopping it': 'backup',
    'Copy files and generate independent private configuration': 'files',
    'Create only the destination database': 'database',
    'Wait for the new database': 'database',
    'Configure copied WordPress files with independent credentials': 'database',
    'Restore the logical backup into the empty destination database': 'restore',
    'Update the copied site domain while preserving plugins and theme': 'domain',
    'Remove transient operation mounts from the destination configuration': 'start',
    'Start the destination web service': 'start',
    'Confirm both destination containers are running': 'verify',
    'Verify the copied site HTTP response': 'verify',
    'Complete the project copy and release its lock': 'verify',
}


def safe_error(data):
    text = str(data.get('stderr', '')) + '\n' + str(data.get('stdout', '')) + '\n' + str(data.get('msg', ''))
    reasons = [
        ('Incorrect table definition', 'MySQL rejected the temporary table identifier.'),
        ('Multiple primary key', 'A copied table already has a primary key.'),
        ('Unable to prepare a copied table', 'Unable to prepare a copied table for URL replacement.'),
        ('Access denied', 'The copied database rejected its credentials.'),
        ('Error establishing a database connection', 'WordPress cannot connect to the copied database.'),
        ('Permission denied', 'The operation cannot access a required destination file.'),
        ('PHP Fatal error', 'PHP failed while loading the copied WordPress site.'),
        ('Failed opening required', 'A required WordPress file is missing in the copy.'),
        ('Could not connect', 'The copied service is not reachable.'),
    ]
    for token, message in reasons:
        if token in text:
            return message
    return 'The command failed. Diagnostic code: ' + str(data.get('rc', 'ansible'))


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = 'aggregate'
    CALLBACK_NAME = 'i7y_progress'
    CALLBACK_NEEDS_WHITELIST = True

    def emit(self, task, state, data=None):
        path = os.environ.get('I7Y_EVENTS_PATH')
        if not path:
            return
        name = task.get_name().strip()
        event = {'attempt': os.environ.get('I7Y_ATTEMPT_ID'), 'name': name, 'stage': STAGES.get(name), 'state': state, 'time': time.time()}
        if state == 'failed':
            detail = (data or {}).get('msg')
            if isinstance(detail, dict) and detail.get('i7y_safe_failure') is True:
                event.update(name=detail['name'], stage=STAGES.get(detail['name']), rc=detail.get('rc'), error=detail['error'], command=detail.get('command'))
            else:
                event.update(rc=(data or {}).get('rc'), error=safe_error(data or {}))
        with open(path, 'a') as stream:
            stream.write(json.dumps(event) + '\n')
            stream.flush()

    def v2_playbook_on_task_start(self, task, is_conditional):
        self.emit(task, 'running')

    def v2_runner_on_ok(self, result):
        self.emit(result._task, 'completed')

    def v2_runner_on_skipped(self, result):
        self.emit(result._task, 'reused' if result._task.get_name().strip() in STAGES else 'skipped')

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self.emit(result._task, 'failed', result._result)

    def v2_runner_on_unreachable(self, result):
        self.emit(result._task, 'failed', result._result)
