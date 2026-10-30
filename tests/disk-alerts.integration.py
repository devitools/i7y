import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

root = Path(__file__).resolve().parent.parent
evidence = root / '.local/artifacts/disk-alerts/http'
evidence.mkdir(parents=True, exist_ok=True)
binary = Path(os.environ.get('I7Y_TEST_POCKETBASE_BINARY', root / '.local/artifacts/desktop-auth-test/pocketbase')).resolve()
assert binary.is_file(), 'Disposable PocketBase fixture binary is unavailable'
name = 'i7y-disk-alert-test-' + secrets.token_hex(8)
container = None
checks = 0
transitions = []
result = {'status': 'incomplete', 'methodology': 'Fresh disposable Docker container, copied hooks and migrations, empty ephemeral /data, random port bound only to 127.0.0.1, generated fixture-only credentials kept in memory.'}


def docker(*args):
    completed = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=40)
    if completed.returncode:
        raise RuntimeError('Disposable Docker command failed: ' + completed.stderr[-1000:])
    return completed.stdout.strip()


def redacted(value):
    if isinstance(value, dict):
        return {key: '[redacted]' if any(word in key.lower() for word in ['token', 'password', 'secret']) else redacted(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redacted(item) for item in value]
    return value


def call(path, method='GET', body=None, token=None, org=None):
    assert base.startswith('http://127.0.0.1:'), 'Only the disposable loopback backend is allowed'
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if org:
        headers['X-I7y-Organization'] = org
    request = urllib.request.Request(base + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read() or '{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or '{}')


def ok(path, method='GET', body=None, token=None, org=None, status=200):
    global checks
    code, value = call(path, method, body, token, org)
    assert code == status, (path, code, redacted(value))
    checks += 1
    return value


def create(collection, body):
    return ok('/api/collections/' + collection + '/records', 'POST', body, admin)


def iso(seconds=0):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()


def snapshot(agent, usage=None, disks=None, observed=None):
    time.sleep(0.01)
    if disks is None:
        disks = [{'path': '/', 'total_bytes': 1000000, 'available_bytes': 1000000 - round(usage * 10000)}]
    body = {'version': 1, 'sample_id': secrets.token_hex(16), 'observed_at': observed or iso(), 'agent_version': 'disk-escalation-http-test', 'collection_mode': 'host', 'metrics_complete': True, 'host': {'cpu_percent': 12, 'memory_total_bytes': 1000, 'memory_available_bytes': 400, 'disks': disks}, 'docker_complete': False, 'discovery_complete': False, 'projects': [], 'containers': [], 'errors': []}
    accepted = ok('/api/i7y/telemetry/v1/snapshots', 'POST', body, agent)
    assert accepted['accepted'] and not accepted['duplicate']
    return body


def detail(identity):
    return ok(prefix + '/incidents/' + identity, token=session, org=org)


def incidents(status='open'):
    return ok(prefix + '/incidents?status=' + status, token=session, org=org)['items']


def notices(identity):
    return [item for item in ok(prefix + '/notification-events', token=session, org=org)['items'] if item['incident_id'] == identity]


def stored_notices(identity):
    query = urllib.parse.urlencode({'filter': 'incident="' + identity + '"', 'sort': 'sequence', 'perPage': 100, 'fields': 'id,incident,kind,sequence,schedule_generation,valid'})
    return ok('/api/collections/incident_notifications/records?' + query, token=admin)['items']


def mark(label, incident):
    transitions.append({'label': label, 'id': incident['id'], 'severity': incident['severity'], 'status': incident['status'], 'version': incident['version'], 'schedule_generation': incident['schedule_generation']})


try:
    with tempfile.TemporaryDirectory(prefix='runtime-', dir=evidence) as temporary:
        runtime = Path(temporary)
        for directory in ['hooks', 'migrations']:
            shutil.copytree(root / 'apps/backend' / directory, runtime / directory)
        hashes = {str(path.relative_to(runtime)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(runtime.rglob('*')) if path.is_file()}
        result['runtime_source_hashes'] = hashes
        container = docker('run', '--pull=never', '--rm', '-d', '--name', name, '--label', 'i7y.fixture=disk-alert-escalation', '-p', '127.0.0.1::8090', '-v', str(binary) + ':/pb/pocketbase:ro', '-v', str(runtime / 'hooks') + ':/pb/hooks:ro', '-v', str(runtime / 'migrations') + ':/pb/migrations:ro', 'alpine:3.21', '/pb/pocketbase', 'serve', '--http=0.0.0.0:8090', '--dir=/data', '--hooksDir=/pb/hooks', '--migrationsDir=/pb/migrations')
        port = docker('port', container, '8090/tcp').rsplit(':', 1)[1]
        base = 'http://127.0.0.1:' + port
        for attempt in range(100):
            try:
                if call('/api/health')[0] == 200:
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        else:
            raise AssertionError('Disposable PocketBase did not become healthy')
        password = secrets.token_hex(24)
        admin_email = 'disk-admin-' + secrets.token_hex(6) + '@example.test'
        docker('exec', container, '/pb/pocketbase', 'superuser', 'upsert', admin_email, password, '--dir=/data')
        admin = ok('/api/collections/_superusers/auth-with-password', 'POST', {'identity': admin_email, 'password': password})['token']
        org = create('organizations', {'name': 'Disposable disk escalation HTTP fixture'})['id']
        user_email = 'disk-editor-' + secrets.token_hex(6) + '@example.test'
        user = create('users', {'email': user_email, 'password': password, 'passwordConfirm': password})
        create('organization_memberships', {'organization': org, 'user': user['id'], 'role': 'editor'})
        session = ok('/api/collections/users/auth-with-password', 'POST', {'identity': user_email, 'password': password})['token']
        workspace = create('workspaces', {'organization': org, 'login': 'disposable-disk-fixture'})
        server = create('servers', {'workspace': workspace['id'], 'name': 'Disk escalation fixture', 'type': 'VPS'})
        agent = ok('/api/i7y/agents', 'POST', {'server': server['id']}, session, org, 201)['token']
        prefix = '/api/i7y/alerts/v1'
        metric = next(item for item in ok(prefix + '/metrics', token=session, org=org)['items'] if item['id'] == 'host.disk_percent')
        assert metric['supports_critical_value'] is True
        rule_body = {'name': 'Disk usage escalating', 'scope_type': 'workspace', 'scope_id': workspace['id'], 'condition': {'metric': 'host.disk_percent', 'operator': 'gt', 'value': 80, 'critical_value': 90}, 'severity': 'warning', 'duration_seconds': 0, 'reminder_seconds': 900, 'enabled': True}
        key = 'disk-escalation'
        rule = ok(prefix + '/rules/' + key, 'PUT', rule_body, session, org)
        saved = ok(prefix + '/rules/' + key, token=session, org=org)
        assert saved['condition'] == {**rule_body['condition'], 'disk_path': '*'}
        assert saved['duration_seconds'] == 0 and saved['severity'] == 'warning'
        for changes in [{'critical_value': 80}, {'critical_value': 101}, {'critical_value': '90'}, {'operator': 'lt'}, {'metric': 'container.memory_percent'}]:
            ok(prefix + '/rules/' + key, 'PUT', {**rule_body, 'condition': {**rule_body['condition'], **changes}}, session, org, 400)
        ok(prefix + '/rules/' + key, 'PUT', {**rule_body, 'severity': 'critical'}, session, org, 400)
        assert ok(prefix + '/rules/' + key, token=session, org=org)['edit_version'] == saved['edit_version']
        preview = ok(prefix + '/rules/simulate', 'POST', rule_body, session, org)
        assert preview['items'][0]['severity'] is None and incidents() == []
        snapshot(agent, 80)
        assert incidents() == []
        assert ok(prefix + '/rules/simulate', 'POST', rule_body, session, org)['items'][0]['severity'] is None
        older = snapshot(agent, 80.0001)
        incident = incidents()[0]
        identity, opened = incident['id'], incident['opened_at']
        assert incident['severity'] == 'warning' and incident['version'] == 1 and incident['schedule_generation'] == 1
        mark('above80-warning', incident)
        assert notices(identity)[0]['kind'] == 'opening'
        snapshot(agent, 90)
        at90 = detail(identity)
        assert at90['severity'] == 'warning' and at90['version'] == 1
        assert ok(prefix + '/rules/simulate', 'POST', rule_body, session, org)['items'][0]['severity'] == 'warning'
        snapshot(agent, 90.0001)
        critical = detail(identity)
        assert critical['severity'] == 'critical' and critical['version'] == 2 and critical['schedule_generation'] == 2
        mark('above90-critical', critical)
        assert notices(identity)[0]['kind'] == 'reminder' and notices(identity)[0]['severity'] == 'critical'
        stored = stored_notices(identity)
        assert len(stored) == 2 and stored[0]['valid'] is False and stored[1]['valid'] is True and stored[1]['schedule_generation'] == 2
        assert ok(prefix + '/rules/simulate', 'POST', rule_body, session, org)['items'][0]['severity'] == 'critical'
        snapshot(agent, 95)
        assert detail(identity)['version'] == 2 and len(stored_notices(identity)) == 2
        snapshot(agent, 40, observed=older['observed_at'])
        assert detail(identity)['severity'] == 'critical' and detail(identity)['version'] == 2
        deadline = iso(3600)
        ok(prefix + '/incidents/' + identity + '/claim', 'POST', {'version': 1, 'claim_until': deadline}, session, org, 409)
        claimed = ok(prefix + '/incidents/' + identity + '/claim', 'POST', {'version': 2, 'claim_until': deadline}, session, org)
        assert claimed['version'] == 3 and claimed['assignee'] == user['id']
        snapshot(agent, disks=[{'path': '/other', 'total_bytes': 1000000, 'available_bytes': 150000}])
        retained = detail(identity)
        assert retained['severity'] == 'critical' and retained['version'] == 3
        assert any(item['path'] == '/' and item['value'] > 90 for item in retained['evidence']['affected_disks'])
        snapshot(agent, disks=[{'path': '/', 'total_bytes': 1000000, 'available_bytes': 100000}, {'path': '/other', 'total_bytes': 1000000, 'available_bytes': 150000}])
        warning = detail(identity)
        assert warning['severity'] == 'warning' and warning['version'] == 4 and warning['schedule_generation'] == 4
        assert warning['assignee'] == claimed['assignee'] and warning['claim_until'] == claimed['claim_until']
        assert warning['opened_at'] == opened and warning['id'] == identity
        assert notices(identity) == [] and not any(item['valid'] for item in stored_notices(identity))
        mark('at90-demoted-warning-claimed', warning)
        ok(prefix + '/incidents/' + identity + '/resolve', 'POST', {'version': 3}, session, org, 409)
        assert detail(identity)['status'] == 'open'
        snapshot(agent, disks=[{'path': '/', 'total_bytes': 1000000, 'available_bytes': 200000}, {'path': '/other', 'total_bytes': 1000000, 'available_bytes': 200000}])
        recovered = detail(identity)
        assert recovered['status'] == 'resolved' and recovered['resolution_reason'] == 'recovered'
        assert recovered['version'] == 5 and recovered['schedule_generation'] == 5
        assert recovered['id'] == identity and recovered['opened_at'] == opened
        mark('at80-recovered', recovered)
        changes = [event['data'] for event in recovered['events'] if event['kind'] == 'severity_changed']
        assert changes == [{'from': 'warning', 'to': 'critical'}, {'from': 'critical', 'to': 'warning'}]
        assert notices(identity)[0]['kind'] == 'resolved'
        assert sum(item['rule'] == rule['id'] and item['resource_id'] == server['id'] for item in incidents('all')) == 1
        second = create('servers', {'workspace': workspace['id'], 'name': 'Initial critical fixture', 'type': 'VPS'})
        second_agent = ok('/api/i7y/agents', 'POST', {'server': second['id']}, session, org, 201)['token']
        snapshot(second_agent, 95, observed=iso(-86400))
        assert incidents() == []
        snapshot(second_agent, 95)
        initial = incidents()[0]
        assert initial['resource_id'] == second['id'] and initial['severity'] == 'critical' and initial['version'] == 1
        mark('new-server-initial-critical', initial)
        assert ok(prefix + '/rules/' + key, token=session, org=org)['condition']['critical_value'] == 90
        result.update({'status': 'passed', 'http_assertions': checks, 'transitions': transitions, 'same_occurrence_verified': True, 'claim_preserved': True, 'stale_versions_rejected': True, 'severity_audits_verified': True, 'notice_generations_verified': True, 'runtime_removed': True})
        print('PASS:', checks, 'disposable HTTP assertions; saved thresholds, simulation, boundaries, same-ID escalation, claims, conflicts, audit and notification generations')
finally:
    if container:
        try:
            logs = docker('logs', container)
            (evidence / 'pocketbase.log').write_text(re.sub(r'https?://[^\s<>]+', '[fixture-url]', logs) + '\n')
        finally:
            docker('rm', '-f', container)
    result['test_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
