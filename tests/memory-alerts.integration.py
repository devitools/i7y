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
evidence = root / '.local/artifacts/memory-alerts/backend/http'
evidence.mkdir(parents=True, exist_ok=True)
binary = Path(os.environ.get('I7Y_TEST_POCKETBASE_BINARY', root / '.local/artifacts/desktop-auth-test/pocketbase')).resolve()
assert binary.is_file(), 'Disposable PocketBase fixture binary is unavailable'
name = 'i7y-memory-alert-test-' + secrets.token_hex(8)
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


def snapshot(agent, usage, seconds, host=None, metrics_complete=True):
    observed = (epoch + datetime.timedelta(seconds=seconds)).isoformat()
    body = {'version': 1, 'sample_id': secrets.token_hex(16), 'observed_at': observed, 'agent_version': 'memory-escalation-http-test', 'collection_mode': 'host', 'metrics_complete': metrics_complete, 'host': {'memory_total_bytes': 1000000, 'memory_available_bytes': None if usage is None else 1000000 - round(usage * 10000)} if host is None else host, 'docker_complete': False, 'discovery_complete': False, 'projects': [], 'containers': [], 'errors': []}
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
        result['runtime_source_hashes'] = {str(path.relative_to(runtime)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(runtime.rglob('*')) if path.is_file()}
        result['time_methodology'] = 'Normal telemetry HTTP endpoint with controlled fresh historical observations within15minutes; only disposable rule activated_at set earlier through fixture superuser API. No clock override or direct alert-state edits.'
        container = docker('run', '--pull=never', '--rm', '-d', '--name', name, '--label', 'i7y.fixture=memory-alert-escalation', '-p', '127.0.0.1::8090', '-v', str(binary) + ':/pb/pocketbase:ro', '-v', str(runtime / 'hooks') + ':/pb/hooks:ro', '-v', str(runtime / 'migrations') + ':/pb/migrations:ro', 'alpine:3.21', '/pb/pocketbase', 'serve', '--http=0.0.0.0:8090', '--dir=/data', '--hooksDir=/pb/hooks', '--migrationsDir=/pb/migrations')
        base = 'http://127.0.0.1:' + docker('port', container, '8090/tcp').rsplit(':', 1)[1]
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
        email = 'memory-admin-' + secrets.token_hex(6) + '@example.test'
        docker('exec', container, '/pb/pocketbase', 'superuser', 'upsert', email, password, '--dir=/data')
        admin = ok('/api/collections/_superusers/auth-with-password', 'POST', {'identity': email, 'password': password})['token']
        org = create('organizations', {'name': 'Disposable memory saturation HTTP fixture'})['id']
        email = 'memory-editor-' + secrets.token_hex(6) + '@example.test'
        user = create('users', {'email': email, 'password': password, 'passwordConfirm': password})
        create('organization_memberships', {'organization': org, 'user': user['id'], 'role': 'editor'})
        session = ok('/api/collections/users/auth-with-password', 'POST', {'identity': email, 'password': password})['token']
        workspace = create('workspaces', {'organization': org, 'login': 'disposable-memory-fixture'})
        server = create('servers', {'workspace': workspace['id'], 'name': 'Sustained memory fixture', 'type': 'VPS'})
        agent = ok('/api/i7y/agents', 'POST', {'server': server['id']}, session, org, 201)['token']
        prefix = '/api/i7y/alerts/v1'
        catalog = ok(prefix + '/metrics', token=session, org=org)['items']
        assert next(item for item in catalog if item['id'] == 'host.memory_percent')['supports_critical_value'] is True
        assert next(item for item in catalog if item['id'] == 'host.disk_percent')['supports_critical_value'] is True
        rule_body = {'name': 'memory saturation escalating', 'scope_type': 'workspace', 'scope_id': workspace['id'], 'condition': {'metric': 'host.memory_percent', 'operator': 'gt', 'value': 80, 'critical_value': 90}, 'severity': 'warning', 'duration_seconds': 300, 'reminder_seconds': 900, 'enabled': True}
        rule = ok(prefix + '/rules/memory-usage', 'PUT', rule_body, session, org)
        saved = ok(prefix + '/rules/memory-usage', token=session, org=org)
        assert saved['condition'] == rule_body['condition'] and saved['duration_seconds'] == 300
        for changes in [{'critical_value': 80}, {'critical_value': 101}, {'operator': 'lt'}, {'metric': 'container.memory_percent'}]:
            ok(prefix + '/rules/memory-usage', 'PUT', {**rule_body, 'condition': {**rule_body['condition'], **changes}}, session, org, 400)
        epoch = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=850)
        ok('/api/collections/alert_rules/records/' + rule['id'], 'PATCH', {'activated_at': (epoch - datetime.timedelta(seconds=60)).isoformat()}, admin)
        snapshot(agent, 80, 0)
        assert incidents() == []
        older = snapshot(agent, 80.0001, 1)
        snapshot(agent, 85, 300.999)
        assert incidents() == []
        snapshot(agent, 90, 301, host={'memory_total_bytes': 1000000, 'memory_available_bytes': 100000, 'memory_free_bytes': 0})
        warning = incidents()[0]
        identity, opened = warning['id'], warning['opened_at']
        assert warning['severity'] == 'warning' and warning['version'] == 1
        assert warning['evidence']['value'] == 90
        mark('warning-after300seconds', warning)
        spike = snapshot(agent, 95, 302)
        assert detail(identity)['severity'] == 'warning'
        preview = ok(prefix + '/rules/simulate', 'POST', rule_body, session, org)
        assert preview['items'][0]['severity'] == 'critical'
        assert detail(identity)['severity'] == 'warning'
        snapshot(agent, 90, 303)
        snapshot(agent, 95, 304)
        snapshot(agent, 95, 603.999)
        assert detail(identity)['severity'] == 'warning'
        critical_raw = snapshot(agent, 95, 604)
        critical = detail(identity)
        assert critical['severity'] == 'critical' and critical['version'] == 2 and critical['schedule_generation'] == 2
        mark('critical-after-independent300seconds', critical)
        assert notices(identity)[0]['severity'] == 'critical'
        original = stored_notices(identity)
        assert len(original) == 2 and original[0]['valid'] is False and original[1]['valid'] is True
        repeated = ok('/api/i7y/telemetry/v1/snapshots', 'POST', critical_raw, agent)
        assert repeated['duplicate'] is True
        snapshot(agent, 40, 100)
        snapshot(agent, 95, 605)
        assert detail(identity)['version'] == 2 and len(stored_notices(identity)) == 2
        deadline = iso(60)
        ok(prefix + '/incidents/' + identity + '/claim', 'POST', {'version': 1, 'claim_until': deadline}, session, org, 409)
        claimed = ok(prefix + '/incidents/' + identity + '/claim', 'POST', {'version': 2, 'claim_until': deadline}, session, org)
        snapshot(agent, 90, 606)
        demoted = detail(identity)
        assert demoted['severity'] == 'warning' and demoted['version'] == 4 and demoted['schedule_generation'] == 4
        assert demoted['assignee'] == user['id'] and demoted['claim_until'] == claimed['claim_until'] and demoted['next_reminder_at'] == claimed['claim_until']
        assert notices(identity) == []
        mark('fresh90-demoted-preserving-short-claim', demoted)
        snapshot(agent, 95, 607)
        assert detail(identity)['severity'] == 'warning'
        ok(prefix + '/incidents/' + identity + '/resolve', 'POST', {'version': 3}, session, org, 409)
        snapshot(agent, 80, 608)
        recovered = detail(identity)
        assert recovered['status'] == 'resolved' and recovered['resolution_reason'] == 'recovered' and recovered['version'] == 5
        assert recovered['id'] == identity and recovered['opened_at'] == opened
        assert [event['data'] for event in recovered['events'] if event['kind'] == 'severity_changed'] == [{'from': 'warning', 'to': 'critical'}, {'from': 'critical', 'to': 'warning'}]
        mark('at80-recovered-same-occurrence', recovered)
        second = create('servers', {'workspace': workspace['id'], 'name': 'Initial critical memory fixture', 'type': 'VPS'})
        second_agent = ok('/api/i7y/agents', 'POST', {'server': second['id']}, session, org, 201)['token']
        snapshot(second_agent, 95, -86400)
        assert incidents() == []
        snapshot(second_agent, 95, 350)
        snapshot(second_agent, 95, 649.999)
        assert incidents() == []
        snapshot(second_agent, 95, 650)
        initial = incidents()[0]
        assert initial['severity'] == 'critical' and initial['version'] == 1 and initial['resource_id'] == second['id']
        mark('initial-sustained-critical', initial)
        third = create('servers', {'workspace': workspace['id'], 'name': 'Unknown memory reset fixture', 'type': 'VPS'})
        third_agent = ok('/api/i7y/agents', 'POST', {'server': third['id']}, session, org, 201)['token']
        snapshot(third_agent, 95, 1)
        snapshot(third_agent, None, 201)
        snapshot(third_agent, 95, 301)
        snapshot(third_agent, None, 400, host={'memory_total_bytes': 1000000}, metrics_complete=False)
        snapshot(third_agent, 95, 401)
        snapshot(third_agent, 95, 700.999)
        assert not any(item['resource_id'] == third['id'] for item in incidents())
        snapshot(third_agent, 95, 701)
        reset = next(item for item in incidents() if item['resource_id'] == third['id'])
        assert reset['severity'] == 'critical' and reset['version'] == 1
        snapshot(third_agent, None, 702)
        snapshot(third_agent, 95, 703)
        assert detail(reset['id'])['severity'] == 'critical' and detail(reset['id'])['version'] == 1
        invalid_hosts = [
            {},
            {'memory_total_bytes': 0, 'memory_available_bytes': 0},
            {'memory_total_bytes': -1, 'memory_available_bytes': 0},
            {'memory_total_bytes': 100, 'memory_available_bytes': 101},
            {'memory_total_bytes': 100, 'memory_available_bytes': -1},
            {'memory_total_bytes': None, 'memory_available_bytes': 0},
            {'memory_total_bytes': 100},
            {'memory_available_bytes': 5},
            {'memory_total_bytes': '100', 'memory_available_bytes': 5},
            {'memory_total_bytes': 100, 'memory_available_bytes': '5'}
        ]
        for index, host in enumerate(invalid_hosts):
            snapshot(third_agent, None, 704 + index, host=host)
            unchanged = detail(reset['id'])
            assert unchanged['status'] == 'open' and unchanged['severity'] == 'critical' and unchanged['version'] == 1
        snapshot(third_agent, 95, 720)
        assert detail(reset['id'])['severity'] == 'critical' and detail(reset['id'])['version'] == 1
        mark('unknown-invalid-reset-then-critical-retained', detail(reset['id']))
        snapshot(third_agent, 85, 721)
        assert detail(reset['id'])['severity'] == 'warning' and detail(reset['id'])['version'] == 2
        snapshot(third_agent, 80, 722)
        assert detail(reset['id'])['status'] == 'resolved' and detail(reset['id'])['version'] == 3
        fourth = create('servers', {'workspace': workspace['id'], 'name': 'Event-only memory omission fixture', 'type': 'VPS'})
        fourth_agent = ok('/api/i7y/agents', 'POST', {'server': fourth['id']}, session, org, 201)['token']
        snapshot(fourth_agent, 95, 1)
        snapshot(fourth_agent, None, 101, host={}, metrics_complete=False)
        snapshot(fourth_agent, None, 301, host={}, metrics_complete=False)
        assert not any(item['resource_id'] == fourth['id'] for item in incidents())
        snapshot(fourth_agent, 95, 301.001)
        interleaved = next(item for item in incidents() if item['resource_id'] == fourth['id'])
        assert interleaved['severity'] == 'critical' and interleaved['version'] == 1
        mark('event-only-omissions-preserve-confirmation', interleaved)
        final = ok(prefix + '/rules/memory-usage', token=session, org=org)
        assert final['condition']['critical_value'] == 90 and final['duration_seconds'] == 300
        result.update({'status': 'passed', 'http_assertions': checks, 'transitions': transitions, 'independent_critical_duration_verified': True, 'invalid_memory_protected_incident': True, 'partial_event_memory_resets_confirmation': True, 'instantaneous_simulation_is_not_duration_proof': True, 'claim_deadline_preserved': True, 'runtime_removed': True})
        print('PASS:', checks, 'disposable memory HTTP assertions; saved thresholds, independent300second confirmation, brief spikes, unknown reset, same-ID transitions, claims, versions and notices')
finally:
    if container:
        try:
            logs = docker('logs', container)
            (evidence / 'pocketbase.log').write_text(re.sub(r'https?://[^\s<>]+', '[fixture-url]', logs) + '\n')
        finally:
            docker('rm', '-f', container)
    result['test_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (evidence / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
