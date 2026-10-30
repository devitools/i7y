import base64
import concurrent.futures
import datetime
import json
import os
import pathlib
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

access = json.loads(pathlib.Path(os.environ['I7Y_TEST_ACCESS']).read_text())
base = access['url']
assert base.startswith('http://127.0.0.1:'), 'Use a disposable loopback backend'
admin = access['admin_token']
prefix = '/api/i7y/alerts/v1'
checks = 0
passwords = {}
def call(path, method='GET', body=None, token=None, org=None, headers=None):
    h = {'Content-Type': 'application/json', **(headers or {})}
    if token:
        h['Authorization'] = token
    if org:
        h['X-I7y-Organization'] = org
    request = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read() or '{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or '{}')
def ok(path, method='GET', body=None, token=None, org=None, status=200, headers=None):
    global checks
    code, result = call(path, method, body, token, org, headers)
    assert code == status, (path, code, result)
    checks += 1
    return result
def create(collection, body):
    return ok('/api/collections/' + collection + '/records', 'POST', body, admin)
def patch(collection, identity, body):
    return ok('/api/collections/' + collection + '/records/' + identity, 'PATCH', body, admin)
def iso(seconds=0):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()
def person(role, org):
    password = secrets.token_hex(20)
    user = create('users', {'email': 'alerts-' + secrets.token_hex(8) + '@example.test', 'password': password, 'passwordConfirm': password})
    member = create('organization_memberships', {'organization': org, 'user': user['id'], 'role': role})
    token = ok('/api/collections/users/auth-with-password', 'POST', {'identity': user['email'], 'password': password})['token']
    passwords[user['id']] = password
    return user, token, member
def snapshot(agent, server, disk=95, observed=None, sample=None):
    time.sleep(0.005)
    body = {'version': 1, 'sample_id': sample or secrets.token_hex(16), 'observed_at': observed or iso(), 'agent_version': 'integration-test', 'collection_mode': 'host', 'metrics_complete': True, 'host': {'cpu_percent': 12, 'memory_total_bytes': 1000, 'memory_available_bytes': 400, 'disks': [{'path': '/', 'total_bytes': 1000, 'available_bytes': 1000 - disk * 10}]}, 'docker_complete': False, 'discovery_complete': False, 'projects': [], 'containers': [], 'errors': []}
    return ok('/api/i7y/telemetry/v1/snapshots', 'POST', body, agent), body
def notices(token, org, cursor=0):
    return ok(prefix + '/notification-events?cursor=' + str(cursor), token=token, org=org)
def incidents(token, org, status='open'):
    return ok(prefix + '/incidents?status=' + status, token=token, org=org)['items']

org = create('organizations', {'name': 'Alerts HTTP fixture ' + secrets.token_hex(4)})['id']
other_org = create('organizations', {'name': 'Alerts isolated fixture ' + secrets.token_hex(4)})['id']
editor, session, membership = person('editor', org)
reader, reader_session, reader_membership = person('reader', org)
other_editor, other_session, other_membership = person('editor', org)
outsider, outsider_session, _ = person('admin', other_org)
workspace = create('workspaces', {'organization': org, 'login': 'alerts-fixture-' + secrets.token_hex(4)})
server = create('servers', {'workspace': workspace['id'], 'name': 'Capacity fixture', 'type': 'VPS'})
agent = ok('/api/i7y/agents', 'POST', {'server': server['id']}, session, org, 201)['token']
key = 'disk-' + secrets.token_hex(4)
rule_body = {'name': 'Disk capacity', 'scope_type': 'workspace', 'scope_id': workspace['id'], 'condition': {'metric': 'host.disk_percent', 'operator': 'gt', 'value': 90}, 'duration_seconds': 0, 'reminder_seconds': 900, 'severity': 'critical', 'enabled': True}

ok(prefix + '/metrics', status=401)
ok(prefix + '/metrics', token=reader_session, org=org)
ok(prefix + '/rules/' + key, 'PUT', rule_body, reader_session, org, 403)
rule = ok(prefix + '/rules/' + key, 'PUT', rule_body, session, org)
ok(prefix + '/rules/' + key, token=outsider_session, org=org, status=403)
ok('/api/collections/alert_rules/records', token=session, status=403)
before = incidents(session, org)
preview = ok(prefix + '/rules/simulate', 'POST', rule_body, session, org)
assert len(incidents(session, org)) == len(before)
_, stale = snapshot(agent, server, observed=iso(-86400))
assert incidents(session, org) == []
accepted, raw = snapshot(agent, server)
assert not accepted['duplicate']
incident = incidents(session, org)[0]
assert incident['rule'] == rule['id'] and incident['resource_id'] == server['id']
assert notices(reader_session, org)['items'][0]['incident_id'] == incident['id']
duplicate = ok('/api/i7y/telemetry/v1/snapshots', 'POST', raw, agent)
assert duplicate['duplicate'] and len(incidents(session, org)) == 1
ok(prefix + '/incidents/' + incident['id'] + '/claim', 'POST', {'version': incident['version'], 'claim_until': iso(3600)}, reader_session, org, 403)
claim_body = {'version': incident['version'], 'claim_until': iso(3600)}
with concurrent.futures.ThreadPoolExecutor() as pool:
    claims = list(pool.map(lambda token: call(prefix + '/incidents/' + incident['id'] + '/claim', 'POST', claim_body, token, org), [session, other_session]))
assert sorted(code for code, _ in claims) == [200, 409], claims
claimed = next(result for code, result in claims if code == 200)
owner_session = session if claimed['assignee'] == editor['id'] else other_session
assert notices(reader_session, org)['items'] == []
extended = ok(prefix + '/incidents/' + incident['id'] + '/claim', 'POST', {'version': claimed['version'], 'claim_until': iso(7200)}, owner_session, org)
assert not any(row['id'] == incident['id'] for row in ok(prefix + '/incidents?overdue=true', token=session, org=org)['items'])
patch('incidents', incident['id'], {'claim_until': iso(-60)})
assert any(row['id'] == incident['id'] for row in ok(prefix + '/incidents?overdue=true', token=session, org=org)['items'])
resolved = ok(prefix + '/incidents/' + incident['id'] + '/resolve', 'POST', {'version': extended['version']}, session, org)
assert resolved['status'] == 'resolved'
assert notices(reader_session, org)['items'] == []
snapshot(agent, server)
reopened = incidents(session, org)[0]
assert reopened['id'] != incident['id']
snapshot(agent, server, disk=50)
assert incidents(session, org) == []
detail = ok(prefix + '/incidents/' + reopened['id'], token=session, org=org)
assert detail['resolution_reason'] == 'recovered' and detail['events']

second = create('servers', {'workspace': workspace['id'], 'name': 'New dynamic target', 'type': 'VPS'})
second_agent = ok('/api/i7y/agents', 'POST', {'server': second['id']}, session, org, 201)['token']
snapshot(second_agent, second)
dynamic = next(row for row in incidents(session, org) if row['resource_id'] == second['id'])
disabled = ok(prefix + '/rules/' + key, 'PUT', {**rule_body, 'enabled': False}, session, org)
assert notices(session, org)['items'] == []
assert ok(prefix + '/incidents/' + dynamic['id'], token=session, org=org)['status'] == 'open'
ok(prefix + '/rules/' + key, 'PUT', rule_body, session, org)
snapshot(second_agent, second, disk=50)
assert incidents(session, org) == []
snapshot(second_agent, second)
active = incidents(session, org)[0]
changed = ok(prefix + '/rules/' + key, 'PUT', {**rule_body, 'condition': {**rule_body['condition'], 'value': 97}}, session, org)
assert changed['revision'] > rule['revision']
assert ok(prefix + '/incidents/' + active['id'], token=session, org=org)['resolution_reason'] == 'rule_changed'

legacy = ok('/api/i7y/tokens', 'POST', {'label': 'Legacy fixture', 'days': 1, 'scope': 'write'}, session, org, 201)['token']
creator = ok('/api/i7y/tokens', 'POST', {'label': 'Creator fixture', 'days': 1, 'scope': 'read', 'capabilities': ['incidents:create']}, session, org, 201)['token']
for path, method, body in [('/metrics', 'GET', None), ('/incidents', 'GET', None), ('/rules/' + key, 'PUT', rule_body)]:
    ok(prefix + path, method, body, legacy, org, 403)
direct_body = {'title': 'Direct incident', 'severity': 'warning'}
direct = ok(prefix + '/incidents', 'POST', direct_body, creator, org, 201, {'Idempotency-Key': 'direct-fixture'})
repeat = ok(prefix + '/incidents', 'POST', direct_body, creator, org, 201, {'Idempotency-Key': 'direct-fixture'})
assert direct['id'] == repeat['id']
ok(prefix + '/incidents', 'POST', {'title': 'Changed'}, creator, org, 409, {'Idempotency-Key': 'direct-fixture'})
ok(prefix + '/incidents', token=creator, org=org, status=403)
ok(prefix + '/incidents/' + direct['id'] + '/resolve', 'POST', {'version': direct['version']}, creator, org, 403)
ok(prefix + '/integrations', 'POST', {'name': 'Forbidden'}, creator, org, 403)
ok('/api/i7y/desktop/authorize', 'POST', {}, creator, org, 403)

integration = ok(prefix + '/integrations', 'POST', {'name': 'GCP fixture', 'kind': 'gcp', 'workspace_id': workspace['id'], 'enabled': True, 'reminder_seconds': 900}, session, org, 201)
integration2 = ok(prefix + '/integrations', 'POST', {'name': 'Second GCP fixture', 'kind': 'gcp', 'enabled': True}, session, org, 201)
def basic(integration):
    return 'Basic ' + base64.b64encode((integration['id'] + ':' + integration['token']).encode()).decode()
gcp = {'version': '1.2', 'incident': {'incident_id': 'external-shared', 'state': 'open', 'summary': '<script>unsafe</script>', 'url': 'javascript:alert(1)', 'resource': {'type': 'cloudsql_database'}}}
external = ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', gcp, basic(integration))
again = ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', gcp, basic(integration))
assert external['id'] == again['id']
separate = ok(prefix + '/integrations/' + integration2['id'] + '/gcp', 'POST', gcp, basic(integration2))
assert external['id'] != separate['id']
ok(prefix + '/integrations/' + integration2['id'] + '/gcp', 'POST', gcp, basic(integration), status=401)
ok(prefix + '/notification-events', token=integration['token'], status=401)
ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', {**gcp, 'version': '1.0'}, basic(integration), status=400)
external = ok(prefix + '/incidents/' + external['id'], token=session, org=org)
closed = ok(prefix + '/incidents/' + external['id'] + '/resolve', 'POST', {'version': external['version']}, session, org)
assert closed['status'] == 'resolved'
assert ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', gcp, basic(integration))['status'] == 'resolved'
closed_first = {**gcp, 'incident': {**gcp['incident'], 'incident_id': 'closed-first', 'state': 'closed'}}
first = ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', closed_first, basic(integration))
later = ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', {**closed_first, 'incident': {**closed_first['incident'], 'state': 'open'}}, basic(integration))
assert first['id'] == later['id'] and later['status'] == 'resolved'
rotated = ok(prefix + '/integrations/' + integration['id'] + '/rotate', 'POST', {}, session, org)
ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', gcp, basic(integration), status=401)
assert ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', gcp, basic(rotated))['id'] == external['id']
long_identity = {**gcp, 'incident': {**gcp['incident'], 'incident_id': 'x' * 240}}
long_event = ok(prefix + '/integrations/' + integration['id'] + '/gcp', 'POST', long_identity, basic(rotated))
assert long_event['external_id'] == 'x' * 240
listing = ok(prefix + '/integrations', token=session, org=org)
assert all('token' not in row and 'token_hash' not in row for row in listing['items'])
assert any(row.get('last_received_at') for row in listing['items'])

cursor = notices(reader_session, org)['cursor']
ok('/api/collections/organization_memberships/records/' + reader_membership['id'], 'DELETE', token=admin, status=204)
ok(prefix + '/notification-events?cursor=' + str(cursor), token=reader_session, org=org, status=403)
patch('organization_memberships', membership['id'], {'role': 'reader'})
ok(prefix + '/incidents', 'POST', {'title': 'After downgrade'}, creator, org, 403, {'Idempotency-Key': 'after-downgrade'})
patch('organization_memberships', membership['id'], {'role': 'editor'})

claimable = ok(prefix + '/incidents', 'POST', {'title': 'Reminder fixture'}, session, org, 201)
patch('incidents', claimable['id'], {'next_reminder_at': iso(-60)})
tick = os.environ.get('I7Y_TEST_TICK') == '1'
if tick:
    ok('/api/alerts-fixture/tick', 'POST', {'now': int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)}, admin)
    first_cursor = notices(session, org)['cursor']
    ok('/api/alerts-fixture/tick', 'POST', {'now': int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)}, admin)
    assert notices(session, org, first_cursor)['items'] == []

snapshot(second_agent, second, disk=99)
deleting = next(row for row in incidents(session, org) if row['resource_id'] == second['id'])
ok('/api/collections/servers/records/' + second['id'], 'DELETE', token=session, org=org, status=204)
deleted_detail = ok(prefix + '/incidents/' + deleting['id'], token=session, org=org)
assert deleted_detail['status'] == 'resolved' and deleted_detail['resolution_reason'] == 'resource_removed'

if tick:
    no_data = ok(prefix + '/rules/no-data-' + secrets.token_hex(3), 'PUT', {'name': 'No communication fixture', 'scope_type': 'server', 'scope_id': server['id'], 'condition': {'metric': 'server.no_communication_seconds', 'operator': 'gte', 'value': 900}}, session, org)
    future = int((datetime.datetime.now(datetime.timezone.utc).timestamp() + 1000) * 1000)
    ok('/api/alerts-fixture/tick', 'POST', {'now': future}, admin)
    assert any(row['rule'] == no_data['id'] for row in incidents(session, org))

transfer_workspace = create('workspaces', {'organization': org, 'login': 'transfer-' + secrets.token_hex(4)})
transfer_server = create('servers', {'workspace': transfer_workspace['id'], 'name': 'Transfer fixture', 'type': 'VPS'})
transfer_agent = ok('/api/i7y/agents', 'POST', {'server': transfer_server['id']}, session, org, 201)['token']
transfer_rule = ok(prefix + '/rules/transfer-' + secrets.token_hex(4), 'PUT', {**rule_body, 'scope_id': transfer_workspace['id']}, session, org)
_, transfer_sample = snapshot(transfer_agent, transfer_server)
transfer_incident = next(row for row in incidents(session, org) if row['rule'] == transfer_rule['id'])
patch('users', outsider['id'], {'global_admin': True})
ok('/api/i7y/workspaces/' + transfer_workspace['id'] + '/transfer', 'POST', {'organization': other_org}, outsider_session, other_org, 204)
assert ok(prefix + '/incidents/' + transfer_incident['id'], token=session, org=org)['resolution_reason'] == 'resource_transferred'
ok('/api/i7y/telemetry/v1/snapshots', 'POST', transfer_sample, transfer_agent, status=401)
ok('/api/i7y/agents', 'POST', {'server': transfer_server['id']}, session, org, 403)
ok(prefix + '/incidents/' + transfer_incident['id'], token=outsider_session, org=other_org, status=404)

fixture_path = pathlib.Path(os.environ.get('I7Y_TEST_RESULT', '.local/artifacts/alerts/runtime/browser-fixture.json'))
fixture_path.write_text(json.dumps({'url': base, 'organization': org, 'token': session, 'user': editor, 'password': passwords[editor['id']], 'workspace': workspace['id'], 'server': server['id'], 'rule_key': key, 'incident': direct['id']}))
fixture_path.chmod(0o600)
print('PASS:', checks, 'HTTP assertions; lifecycle, roles, idempotency, dynamic scope, GCP, reminders, history and isolation')
