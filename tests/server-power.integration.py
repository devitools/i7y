import concurrent.futures
import contextlib
import datetime
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
BINARY = pathlib.Path(os.environ['I7Y_TEST_POCKETBASE']).resolve()
NAME = 'i7y-power-test-' + secrets.token_hex(5)
NATIVE = os.environ.get('I7Y_TEST_NATIVE') == '1'
checks = 0


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


class FixtureRuntime:
    def __init__(self, directory):
        self.directory = directory
        self.process = None
        self.log = None
        self.container_started = False
        self.base = ''

    def start(self):
        for name in ['hooks', 'migrations']:
            shutil.copytree(ROOT / 'apps/backend' / name, self.directory / name)
        if NATIVE:
            (self.directory / 'hooks/main.pb.js').unlink()
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            self.base = 'http://127.0.0.1:' + str(port)
            self.log = (self.directory / 'pocketbase.log').open('w+')
            environment = {key: value for key, value in os.environ.items() if not key.startswith('I7Y_')}
            self.process = subprocess.Popen([
                str(BINARY), 'serve', '--http=127.0.0.1:' + str(port),
                '--dir=' + str(self.directory / 'data'),
                '--hooksDir=' + str(self.directory / 'hooks'),
                '--migrationsDir=' + str(self.directory / 'migrations'),
            ], cwd=self.directory, env=environment, stdout=self.log, stderr=subprocess.STDOUT)
        else:
            self.container_started = True
            docker('run', '--pull=never', '--rm', '-d', '--name', NAME, '-p', '127.0.0.1::8090', '-v', str(BINARY) + ':/pb/pocketbase:ro', '-v', str(self.directory) + ':/fixture:ro', 'alpine:3.22', '/pb/pocketbase', 'serve', '--http=0.0.0.0:8090', '--dir=/data', '--hooksDir=/fixture/hooks', '--migrationsDir=/fixture/migrations')
            self.base = 'http://127.0.0.1:' + docker('port', NAME, '8090/tcp').rsplit(':', 1)[1]

    def superuser(self, password):
        if NATIVE:
            subprocess.check_output([str(BINARY), 'superuser', 'upsert', 'power-admin@example.test', password, '--dir=' + str(self.directory / 'data')], cwd=self.directory, stderr=subprocess.STDOUT)
        else:
            docker('exec', NAME, '/pb/pocketbase', 'superuser', 'upsert', 'power-admin@example.test', password, '--dir=/data')

    def logs(self):
        if not NATIVE:
            return docker('logs', NAME)
        self.log.flush()
        return (self.directory / 'pocketbase.log').read_text()

    def close(self):
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            if self.container_started:
                subprocess.run(['docker', 'rm', '-f', NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        finally:
            if self.log is not None:
                self.log.close()


@contextlib.contextmanager
def fixture_runtime(directory):
    runtime = FixtureRuntime(directory)
    try:
        runtime.start()
        yield runtime
    finally:
        runtime.close()


def main(runtime):
    global checks
    base = runtime.base

    def call(path, method='GET', body=None, token=None, org=None, expected=200):
        nonlocal base
        global checks
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = token
        if org:
            headers['X-I7y-Organization'] = org
        request = urllib.request.Request(base + path, headers=headers, method=method, data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status, result = response.status, json.loads(response.read() or '{}')
        except urllib.error.HTTPError as error:
            status, result = error.code, json.load(error)
        assert status == expected, (path, status, result)
        checks += 1
        return result

    for _ in range(100):
        try:
            call('/api/health')
            break
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    else:
        raise AssertionError(runtime.logs())
    password = secrets.token_hex(24)
    runtime.superuser(password)
    admin = call('/api/collections/_superusers/auth-with-password', 'POST', {'identity': 'power-admin@example.test', 'password': password})['token']
    def create(collection, body):
        return call('/api/collections/' + collection + '/records', 'POST', body, admin)
    def person(role, org):
        user = create('users', {'email': secrets.token_hex(8) + '@example.test', 'password': password, 'passwordConfirm': password})
        create('organization_memberships', {'organization': org, 'user': user['id'], 'role': role})
        return call('/api/collections/users/auth-with-password', 'POST', {'identity': user['email'], 'password': password})['token']
    org = create('organizations', {'name': 'Power fixture'})['id']
    other_org = create('organizations', {'name': 'Power isolation'})['id']
    owner, editor, reader, outsider = person('admin', org), person('editor', org), person('reader', org), person('admin', other_org)
    credential = {'vault': 'Fixture vault', 'item': 'Fixture reference'}
    workspace = create('workspaces', {'organization': org, 'login': 'fixture@example.test', 'provider': 'SNEL', 'credential': credential})
    server = create('servers', {'workspace': workspace['id'], 'name': 'fixture.example.test', 'ip': '192.0.2.10', 'type': 'VPS', 'credential': credential})['id']
    path = '/api/i7y/server-power/v1/servers/' + server
    profile = {'version': 0, 'service_id': '123', 'vm_id': '456', 'boot_port': 2222, 'boot_host_key': '', 'luks_uuid': ''}
    call(path, expected=401)
    call(path, token=outsider, org=org, expected=403)
    call(path, token=reader, org=other_org, expected=403)
    call(path, token=reader, org=org)
    call(path, 'PUT', profile, editor, org, 403)
    call(path, 'PUT', {**profile, 'password': 'must-never-be-stored'}, owner, org, 400)
    call(path, 'PUT', profile, owner, org)
    alias = create('servers', {'workspace': workspace['id'], 'name': 'alias.example.test', 'ip': '192.0.2.10', 'type': 'VPS', 'credential': credential})['id']
    call('/api/i7y/server-power/v1/servers/' + alias, 'PUT', profile, owner, org, 409)
    call(path, 'PUT', profile, owner, org, 409)
    call('/api/collections/server_power_profiles/records', token=owner, expected=403)
    data = call(path, token=editor, org=org)
    assert data['profile']['version'] == 1 and 'password' not in json.dumps(data)
    request_id = str(uuid.uuid4())
    body = {'request_id': request_id, 'action': 'start', 'version': 1}
    call(path + '/jobs', 'POST', body, reader, org, 403)
    job = call(path + '/jobs', 'POST', body, editor, org, 201)
    assert job['target']['provider_credential'] == credential and not job['replayed']
    repeated = call(path + '/jobs', 'POST', body, editor, org, 201)
    assert repeated['replayed'] and repeated['id'] == job['id'] and 'target' not in repeated
    call(path + '/jobs', 'POST', {**body, 'action': 'shutdown'}, editor, org, 409)
    call(path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4())}, owner, org, 409)
    call(path, 'PUT', {**profile, 'version': 1}, owner, org, 409)
    operation = path + '/jobs/' + job['id']
    call(operation + '/finish', 'POST', {'status': 'recovered', 'stage': 'awaiting_agent'}, editor, org, 400)
    call(operation + '/finish', 'POST', {'status': 'awaiting_agent', 'stage': 'powered_off'}, editor, org, 400)
    call(operation + '/finish', 'POST', {'status': 'awaiting_agent', 'stage': 'awaiting_agent', 'password': 'not-accepted'}, editor, org, 400)
    call(operation + '/finish', 'POST', {'status': 'awaiting_agent', 'stage': 'awaiting_agent'}, owner, org, 403)
    call(operation + '/checkpoint', 'POST', {'stage': 'unlocking_disk'}, editor, org)
    call(operation + '/finish', 'POST', {'status': 'awaiting_agent', 'stage': 'awaiting_agent'}, editor, org)
    assert call(path, token=reader, org=org)['jobs'][0]['status'] == 'awaiting_agent'
    agent = call('/api/i7y/agents', 'POST', {'server': server}, owner, org, 201)['token']
    snapshot = {'version': 1, 'sample_id': secrets.token_hex(16), 'observed_at': (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).isoformat(), 'agent_version': 'fixture', 'collection_mode': 'host', 'metrics_complete': True, 'host': {'cpu_percent': 1, 'memory_total_bytes': 1000, 'memory_available_bytes': 900, 'disks': []}, 'docker_complete': False, 'discovery_complete': False, 'projects': [], 'containers': [], 'errors': []}
    call('/api/i7y/telemetry/v1/snapshots', 'POST', snapshot, agent)
    assert call(path, token=reader, org=org)['jobs'][0]['status'] == 'awaiting_agent'
    time.sleep(0.03)
    snapshot.update(sample_id=secrets.token_hex(16), observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    call('/api/i7y/telemetry/v1/snapshots', 'POST', snapshot, agent)
    assert call(path, token=reader, org=org)['jobs'][0]['status'] == 'recovered'
    unknown = call(path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4()), 'action': 'shutdown'}, owner, org, 201)
    unknown_path = path + '/jobs/' + unknown['id']
    call(unknown_path + '/finish', 'POST', {'status': 'unknown', 'stage': 'unknown', 'reason': 'provider_unavailable'}, owner, org)
    call(path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4())}, owner, org, 409)
    for _ in range(11):
        inspection = call(path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4()), 'action': 'inspect'}, owner, org, 201)
        call(path + '/jobs/' + inspection['id'] + '/finish', 'POST', {'status': 'observed', 'stage': 'provider_on'}, owner, org)
    assert any(job['id'] == unknown['id'] and job['status'] == 'unknown' for job in call(path, token=owner, org=org)['jobs'])
    call(unknown_path + '/reconcile', 'POST', {'inspected_console': True}, editor, org, 403)
    call(unknown_path + '/reconcile', 'POST', {}, owner, org, 409)
    assert call(unknown_path + '/reconcile', 'POST', {'inspected_console': True}, owner, org)['reconciled_by']
    def attempt(_):
        try:
            call(path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4())}, editor, org, 201)
            return True
        except AssertionError as error:
            assert error.args[0][1] == 409
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, [1, 2])) == [False, True]
    pending = next(job for job in call(path, token=editor, org=org)['jobs'] if job['status'] == 'running')
    call(path + '/jobs/' + pending['id'] + '/finish', 'POST', {'status': 'unknown', 'stage': 'unknown'}, editor, org)
    call('/api/collections/servers/records/' + server, 'DELETE', token=admin, expected=204)
    replacement = create('servers', {'workspace': workspace['id'], 'name': 'replacement.example.test', 'ip': '192.0.2.10', 'type': 'VPS', 'credential': credential})['id']
    replacement_path = '/api/i7y/server-power/v1/servers/' + replacement
    call(replacement_path, 'PUT', profile, owner, org)
    assert any(job['id'] == pending['id'] for job in call(replacement_path, token=owner, org=org)['jobs'])
    call(replacement_path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4())}, owner, org, 409)
    call(replacement_path + '/jobs/' + pending['id'] + '/reconcile', 'POST', {'inspected_console': True}, owner, org)
    call(replacement_path + '/jobs', 'POST', {**body, 'request_id': str(uuid.uuid4())}, owner, org, 201)
    print(json.dumps({'passed': True, 'http_checks': checks, 'backend': base}))


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='i7y-power-fixture-') as temporary:
        with fixture_runtime(pathlib.Path(temporary)) as runtime:
            main(runtime)
