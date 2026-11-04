import ast
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid


def main():
    os.umask(0o077)
    payload = json.load(sys.stdin)
    if payload.get('phase') == 'status':
        operation = payload.get('operation_id', '')
        phase = payload.get('operation_phase', '')
        if not re.fullmatch(r'[a-f0-9]{32}', operation) or phase not in ('preview', 'execute'):
            raise ValueError('Invalid operation identifier')
        logfile = Path.home() / '.local/share/i7y/ansible' / ('operation-' + operation + '-' + phase + '.log')
        eventfile = logfile.with_suffix('.events.jsonl')
        if eventfile.is_file() and not eventfile.is_symlink():
            events = []
            for line in eventfile.read_text().splitlines():
                try:
                    events.append(json.loads(line))
                except ValueError:
                    continue
            if events:
                attempt = events[-1]['attempt']
                current = {}
                for event in events:
                    if event['attempt'] == attempt:
                        current[event['name']] = event
                steps = list(current.values())
                failed = next((step for step in reversed(steps) if step['state'] == 'failed'), None)
                print(json.dumps({'operation_id': operation, 'attempt': attempt, 'tasks': [step['name'] for step in steps], 'steps': steps, 'failed_task': failed['name'] if failed else None, 'error_detail': failed}))
                return 0
        tasks = []
        failed_task = None
        allowed = set(payload.get('task_names', []))
        if logfile.is_file() and not logfile.is_symlink():
            with logfile.open('rb') as stream:
                content = stream.read(2097152).decode('utf-8', errors='replace')
            has_attempt_marker = 'I7Y_ATTEMPT\n' in content
            content = content.rsplit('I7Y_ATTEMPT\n', 1)[-1]
            if not has_attempt_marker and '\nPLAY [' in content:
                content = content.rsplit('\nPLAY [', 1)[-1]
            steps = []
            current = None
            for line in content.splitlines():
                match = re.match(r'^TASK \[([^\]]+)\]', line)
                if match:
                    current = {'name': match.group(1), 'state': 'running'} if match.group(1) in allowed else None
                    if current:
                        steps.append(current)
                elif current:
                    if line.startswith('fatal:'):
                        current['state'] = 'failed'
                        failed_task = current['name']
                    elif line.startswith('skipping:'):
                        current['state'] = 'reused'
                    elif line.startswith(('ok:', 'changed:')):
                        current['state'] = 'completed'
            tasks = [step['name'] for step in steps]
        else:
            steps = []
        print(json.dumps({'tasks': tasks, 'failed_task': failed_task, 'steps': steps}))
        return 0
    address = str(ipaddress.IPv4Address(payload['address']))
    port = int(payload['port'])
    if not 1 <= port <= 65535 or payload['phase'] not in ('preview', 'execute'):
        raise ValueError('Invalid action parameters')
    runtime = subprocess.check_output(['/usr/bin/ansible-playbook', '--version'], env={'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'LC_ALL': 'C'}, timeout=15).decode().splitlines()[0]
    if payload['phase'] == 'execute' and payload.get('expected_runtime') != runtime:
        print(json.dumps({'error': 'The automation runtime changed. Review the copy again.'}))
        return 1
    files = payload['files']
    if len(files) > 32 or sum(len(v) for v in files.values()) > 262144:
        raise ValueError('Invalid release size')
    hasher = hashlib.sha256()
    for name, content in sorted(files.items()):
        if not re.fullmatch(r'[a-zA-Z0-9_./-]+', name) or '..' in name.split('/') or name.startswith('/'):
            raise ValueError('Invalid release path')
        hasher.update(name.encode() + b'\0' + content.encode() + b'\0')
    release_id = hasher.hexdigest()
    root = Path.home() / '.local/share/i7y/ansible'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.resolve() != root or root.stat().st_uid != os.geteuid():
        raise ValueError('Unsafe release storage')
    root.chmod(0o700)
    release = root / release_id
    release.mkdir(exist_ok=True, mode=0o700)
    if release.resolve() != release or release.stat().st_uid != os.geteuid():
        raise ValueError('Unsafe release directory')
    for name, content in files.items():
        path = release / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.resolve() != path:
            raise ValueError('Unsafe release file')
        if path.exists():
            if path.read_text() != content:
                raise ValueError('Release changed; restore the reviewed release')
        else:
            fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(content)
    with tempfile.TemporaryDirectory(prefix='request-', dir=str(root)) as temporary:
        request = Path(temporary)
        inventory = {'all': {'children': {'i7y_targets': {'hosts': {'selected': {
            'ansible_host': address, 'ansible_port': port, 'ansible_user': 'root',
            'ansible_ssh_common_args': '-o StrictHostKeyChecking=yes -o BatchMode=yes -o ForwardAgent=no'}}}}}}
        (request / 'inventory.json').write_text(json.dumps(inventory))
        result_path = request / 'result.json'
        parameters = {'i7y_request': payload['request'], 'i7y_phase': payload['phase'], 'i7y_result_path': str(result_path)}
        (request / 'parameters.json').write_text(json.dumps(parameters))
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(Path.home()), 'LANG': 'C'}
        env.update(LC_ALL='C', ANSIBLE_CONFIG=str(release / 'ansible/ansible.cfg'), ANSIBLE_HOST_KEY_CHECKING='True', ANSIBLE_NOCOLOR='1')
        logfile = root / ('operation-' + payload['request']['operation_id'] + '-' + payload['phase'] + '.log')
        env.update(I7Y_EVENTS_PATH=str(logfile.with_suffix('.events.jsonl')), I7Y_ATTEMPT_ID=uuid.uuid4().hex, ANSIBLE_FILTER_PLUGINS=str(release / 'ansible/filter_plugins'), ANSIBLE_CALLBACK_PLUGINS=str(release / 'ansible/callback_plugins'), ANSIBLE_CALLBACK_WHITELIST='i7y_progress', ANSIBLE_CALLBACKS_ENABLED='i7y_progress')
        execution_lock = (root / ('operation-' + payload['request']['operation_id'] + '.lock')).open('a')
        try:
            fcntl.flock(execution_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'error': 'This copy is already running. Wait for it to finish.'}))
            return 1
        with logfile.open('ab') as log:
            log.write(b'\nI7Y_ATTEMPT\n')
            log.flush()
            outcome = subprocess.run(['/usr/bin/ansible-playbook', '-i', str(request / 'inventory.json'),
                str(release / 'ansible/playbooks/project-copy.yml'), '-e', '@' + str(request / 'parameters.json')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, timeout=1100)
        if outcome.returncode != 0 or not result_path.is_file():
            attempt_log = logfile.read_text(errors='replace').rsplit('I7Y_ATTEMPT\n', 1)[-1]
            if '\nPLAY [' in attempt_log:
                attempt_log = attempt_log.rsplit('\nPLAY [', 1)[-1]
            message = 'This server needs a supported Python 3 runtime before project copy can run.' if 'I7Y_PYTHON_REQUIRED' in attempt_log else 'The playbook failed. Inspect the private operation log on the automation host.'
            if 'Privileged source containers require a dedicated adapter' in attempt_log:
                message = 'This project uses privileged containers. Copy requires a dedicated adapter.'
            tree = ast.parse(files['ansible/files/project_copy.py'])
            allowed_errors = {node.args[-1].s for node in ast.walk(tree)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id in ('require', 'CopyError') and node.args
                and isinstance(node.args[-1], ast.Str)}
            for line in attempt_log.splitlines():
                if line.startswith('fatal:') and '{' in line:
                    try:
                        detail = json.loads(line[line.index('{'):])
                        reason = json.loads(detail.get('stdout', '{}')).get('error')
                        if reason in allowed_errors:
                            message = reason
                    except (ValueError, TypeError, AttributeError):
                        pass
            error_detail = None
            eventfile = logfile.with_suffix('.events.jsonl')
            if eventfile.exists():
                for line in eventfile.read_text().splitlines():
                    try:
                        event = json.loads(line)
                        if event.get('attempt') == env['I7Y_ATTEMPT_ID'] and event.get('state') == 'failed':
                            message = event['error']
                            error_detail = event
                    except ValueError:
                        pass
            print(json.dumps({'error': message, 'error_detail': error_detail, 'operation_id': payload['request']['operation_id']}))
            return 1
        value = json.loads(result_path.read_text())
        value['release'] = release_id
        value['runtime'] = runtime
        print(json.dumps(value))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        print(json.dumps({'error': 'Automation request interrupted. Inspect operation state before retrying.'}))
        sys.exit(1)
