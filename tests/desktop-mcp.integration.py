import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
binary = Path(os.environ['I7Y_TEST_POCKETBASE_BINARY']).resolve()
name = 'i7y-mcp-test-' + secrets.token_hex(6)
container = None
checks = 0


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


def call(path, method='GET', body=None, token=None, org=None, headers=None):
    values = {'Content-Type': 'application/json', **(headers or {})}
    if token:
        values['Authorization'] = 'Bearer ' + token
    if org:
        values['X-I7y-Organization'] = org
    request = urllib.request.Request(base + path, method=method, headers=values,
                                    data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read() or '{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or '{}')


def ok(path, method='GET', body=None, token=None, org=None, status=200, headers=None):
    global checks
    code, value = call(path, method, body, token, org, headers)
    assert code == status, (path, code, value)
    checks += 1
    return value


def create(collection, body):
    return ok('/api/collections/' + collection + '/records', 'POST', body, admin)


try:
    container = docker('run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::8090',
                       '-v', str(binary) + ':/pb/pocketbase:ro',
                       '-v', str(root / 'apps/backend/hooks') + ':/pb/hooks:ro',
                       '-v', str(root / 'apps/backend/migrations') + ':/pb/migrations:ro',
                       'alpine:3.21', '/pb/pocketbase', 'serve', '--http=0.0.0.0:8090',
                       '--dir=/data', '--hooksDir=/pb/hooks', '--migrationsDir=/pb/migrations')
    port = docker('port', container, '8090/tcp').rsplit(':', 1)[1]
    base = 'http://127.0.0.1:' + port
    for attempt in range(100):
        try:
            if call('/api/health')[0] == 200:
                break
        except Exception:
            time.sleep(.1)
    else:
        raise AssertionError('Disposable backend failed to start: ' + docker('logs', container)[-3000:])
    password = secrets.token_hex(24)
    docker('exec', container, '/pb/pocketbase', 'superuser', 'upsert', 'mcp-admin@example.test', password, '--dir=/data')
    admin = ok('/api/collections/_superusers/auth-with-password', 'POST', {'identity': 'mcp-admin@example.test', 'password': password})['token']
    org = create('organizations', {'name': 'MCP disposable test'})['id']
    other_org = create('organizations', {'name': 'MCP isolated test'})['id']
    user = create('users', {'email': 'mcp-user@example.test', 'password': password, 'passwordConfirm': password})
    membership = create('organization_memberships', {'user': user['id'], 'organization': org, 'role': 'admin'})
    token = ok('/api/collections/users/auth-with-password', 'POST', {'identity': user['email'], 'password': password})['token']
    workspace = create('workspaces', {'login': 'test@example.test', 'organization': org})
    server = create('servers', {'name': 'fixture', 'workspace': workspace['id'], 'type': 'VPS'})
    project = create('projects', {'name': 'fixture', 'server': server['id'], 'path': '/srv/example'})
    target = create('containers', {'name': 'fixture', 'project': project['id'], 'image': 'example/app:1'})
    prefix = '/api/i7y/operations/v1'
    operation = {'action': 'container.restart', 'target': target['id']}
    ok(prefix + '/check', 'POST', operation, token, org, status=403)
    grant = {'user': user['id'], **operation, 'enabled': True}
    ok(prefix + '/grants', 'PUT', grant, token, org)
    ok(prefix + '/check', 'POST', operation, token, org)
    ok(prefix + '/check', 'POST', operation, token, other_org, status=403)
    controller = ok(prefix + '/controllers', 'POST', {'principal': 'operator01'}, token, org)
    ticket_body = {**operation, 'principal': 'operator01', 'operation_id': 'test-operation', 'approval': 'a' * 64}
    ticket = ok(prefix + '/tickets', 'POST', ticket_body, token, org)['ticket']
    consume = {**ticket_body, 'ticket': ticket}
    ok(prefix + '/consume', 'POST', {**consume, 'approval': 'b' * 64}, controller['token'], status=403)
    with concurrent.futures.ThreadPoolExecutor() as executor:
        outcomes = list(executor.map(lambda _: call(prefix + '/consume', 'POST', consume, controller['token'])[0], range(2)))
    assert sorted(outcomes) == [200, 403], outcomes
    checks += 1
    ticket2 = ok(prefix + '/tickets', 'POST', ticket_body, token, org)['ticket']
    ok(prefix + '/grants', 'PUT', {**grant, 'enabled': False}, token, org)
    ok(prefix + '/consume', 'POST', {**consume, 'ticket': ticket2}, controller['token'], status=403)
    alerts = '/api/i7y/alerts/v1'
    rule = {'name': 'Disk fixture', 'scope_type': 'server', 'scope_id': server['id'],
            'condition': {'metric': 'host.disk_percent', 'operator': 'gt', 'value': 90},
            'severity': 'warning', 'duration_seconds': 0, 'reminder_seconds': 900, 'enabled': True}
    request_id = secrets.token_hex(16)
    headers = {'X-I7y-MCP-Request': request_id, 'Idempotency-Key': request_id, 'X-I7y-Expected-Revision': '0'}
    first = ok(alerts + '/rules/mcp-disk', 'PUT', rule, token, org, headers=headers)
    assert first['edit_version'] == 1
    recovered = ok('/api/i7y/mcp/v1/requests/' + request_id, token=token, org=org)
    assert recovered['state'] == 'completed' and recovered['result'] == first
    ok('/api/i7y/mcp/v1/requests/' + request_id, token=token, org=other_org, status=403)
    assert ok(alerts + '/rules/mcp-disk', 'PUT', rule, token, org, headers=headers) == first
    ok(alerts + '/rules/mcp-disk', 'PUT', {**rule, 'name': 'Changed'}, token, org, status=409, headers=headers)
    request2 = secrets.token_hex(16)
    stale = {**headers, 'X-I7y-MCP-Request': request2, 'Idempotency-Key': request2}
    ok(alerts + '/rules/mcp-disk', 'PUT', rule, token, org, status=409, headers=stale)
    stale['X-I7y-Expected-Revision'] = '1'
    second = ok(alerts + '/rules/mcp-disk', 'PUT', {**rule, 'name': 'Renamed'}, token, org, headers=stale)
    assert second['edit_version'] == 2
    incident_id = secrets.token_hex(16)
    ih = {'X-I7y-MCP-Request': incident_id, 'Idempotency-Key': incident_id}
    incident = ok(alerts + '/incidents', 'POST', {'title': 'MCP test', 'severity': 'warning'}, token, org, status=201, headers=ih)
    assert ok(alerts + '/incidents', 'POST', {'title': 'MCP test', 'severity': 'warning'}, token, org, status=201, headers=ih)['id'] == incident['id']
    claim = {'version': incident['version'], 'claim_until': '2099-01-01T00:00:00Z'}
    import datetime
    claim['claim_until'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat()
    claimed = ok(alerts + '/incidents/' + incident['id'] + '/claim', 'POST', claim, token, org)
    assert claimed['assignee'] == user['id']
    ok(alerts + '/incidents/' + incident['id'] + '/resolve', 'POST', {'version': incident['version']}, token, org, status=409)
    ok(alerts + '/incidents/' + incident['id'] + '/resolve', 'POST', {'version': claimed['version']}, token, org)
    records = ok('/api/i7y/mcp/v1/audit', token=token, org=org)['items']
    assert len(records) >= 3
    ok(prefix + '/status-access', 'POST', {'operation_id': 'test-operation'}, token, org)
    ok(prefix + '/status-access', 'POST', {'operation_id': 'unknown-operation'}, token, org, status=404)
    agent = ok('/api/i7y/tokens', 'POST', {'label': 'MCP boundary fixture', 'scope': 'read', 'days': 1}, token, org, status=201)
    ok('/api/i7y/mcp/v1/audit', token=agent['token'], org=org, status=403)
    ok(prefix + '/check', 'POST', operation, agent['token'], org, status=403)
    ok('/api/collections/users/records/' + user['id'], 'DELETE', token=admin, status=204)
    assert ok('/api/collections/mcp_audit/records', token=admin)['totalItems'] >= 3
    print('Desktop MCP integration checks passed:', checks)
finally:
    if container:
        docker('rm', '-f', container)
