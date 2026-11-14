from pathlib import Path
source = Path(__file__).with_name('alerts.integration.py').read_text()
exec(source[:source.index('\norg = create(')])
v2 = '/api/i7y/alerts/v2'
org = create('organizations', {'name': 'Type migration ' + secrets.token_hex(4)})['id']
other = create('organizations', {'name': 'Type isolation ' + secrets.token_hex(4)})['id']
editor, session, _ = person('editor', org)
reader, reader_session, _ = person('reader', org)
_, outsider, _ = person('admin', other)
workspaces = [create('workspaces', {'organization': org, 'login': 'type-' + secrets.token_hex(6)}) for _ in range(2)]
servers = [create('servers', {'workspace': workspace['id'], 'name': name, 'type': 'VPS'}) for workspace, name in zip(workspaces, ['Jack', 'Siacom'])]
agents = [ok('/api/i7y/agents', 'POST', {'server': server['id']}, session, org, 201)['token'] for server in servers]
legacy = []
for index, workspace in enumerate(workspaces):
    for metric in ['host.cpu_percent', 'host.memory_percent', 'host.disk_percent']:
        body = {'name': metric, 'scope_type': 'workspace', 'scope_id': workspace['id'], 'condition': {'metric': metric, 'operator': 'gt', 'value': 80, 'critical_value': 90}, 'severity': 'warning', 'duration_seconds': 300 if metric != 'host.disk_percent' else 0, 'reminder_seconds': 300 if index == 0 and metric == 'host.disk_percent' else 900, 'enabled': True}
        legacy.append(ok(prefix + '/rules/legacy-' + str(index) + '-' + metric.replace('.', '-'), 'PUT', body, session, org))
for index, metric, severity in [(0, 'host.memory_percent', 'critical'), (1, 'host.disk_percent', 'warning')]:
    rule = next(rule for rule in legacy if rule['condition']['metric'] == metric and rule['scope_id'] == workspaces[index]['id'])
    incident = create('incidents', {'organization': org, 'rule': rule['id'], 'origin': 'rule', 'title': metric, 'severity': severity, 'status': 'open', 'resource_type': 'server', 'resource_id': servers[index]['id'], 'server_id': servers[index]['id'], 'workspace_id': workspaces[index]['id'], 'resource_name': servers[index]['name'], 'opened_at': iso(-3600), 'evidence': {'metric': metric, 'value': 97 if index == 0 else 85}, 'version': 1, 'schedule_generation': 1, 'rule_revision': rule['revision'], 'reminder_seconds': rule['reminder_seconds'], 'next_reminder_at': iso(300)})
    if index == 0:
        jack = incident
    else:
        siacom = ok(prefix + '/incidents/' + incident['id'] + '/claim', 'POST', {'version': incident['version'], 'claim_until': iso(3600)}, session, org)
gcp = create('incidents', {'organization': org, 'origin': 'gcp', 'title': 'External GCP', 'status': 'open', 'severity': 'critical', 'version': 4})
settings = {'exclusions': [{'metric': 'host.memory_percent', 'resource_type': 'server', 'resource_id': servers[0]['id'], 'reason': 'Accepted Windows saturation'}]}
plan = ok(v2 + '/migration/preview', 'POST', {'options': settings}, session, org)
assert plan['can_apply'] and plan['source_count'] == 6 and plan['destination_count'] == 4, plan
ok(v2 + '/migration/apply', 'POST', {'plan_hash': plan['plan_hash'], 'options': plan['options']}, reader_session, org, 403)
ok(v2 + '/migration/apply', 'POST', {'plan_hash': '0' * 64, 'options': plan['options']}, session, org, 409)
changed = legacy[0]
body = {key: changed[key] for key in ['name', 'scope_type', 'scope_id', 'condition', 'severity', 'duration_seconds', 'reminder_seconds', 'enabled']}
body['name'] += ' edited'
ok(prefix + '/rules/' + changed['key'], 'PUT', body, session, org)
ok(v2 + '/migration/apply', 'POST', {'plan_hash': plan['plan_hash'], 'options': plan['options']}, session, org, 409)
plan = ok(v2 + '/migration/preview', 'POST', {'options': settings}, session, org)
request = {'plan_hash': plan['plan_hash'], 'options': plan['options']}
result = ok(v2 + '/migration/apply', 'POST', request, session, org)
repeated = ok(v2 + '/migration/apply', 'POST', request, session, org)
assert result == repeated and result['incidents_preserved'] == [siacom['id']] and result['incidents_excluded'] == [jack['id']], result
rules = ok(v2 + '/rules', token=session, org=org)['items']
assert len(rules) == 4 and all(rule['model_version'] == 2 for rule in rules)
remaining = ok(prefix + '/incidents/' + siacom['id'], token=session, org=org)
assert remaining['status'] == 'open' and remaining['assignee'] == siacom['assignee'] and remaining['claim_until'] == siacom['claim_until'] and remaining['opened_at'] == siacom['opened_at']
assert ok(prefix + '/incidents/' + jack['id'], token=session, org=org)['resolution_reason'] == 'resource_excluded'
assert ok(prefix + '/incidents/' + gcp['id'], token=session, org=org)['version'] == 4
memory = next(rule for rule in rules if rule['condition']['metric'] == 'host.memory_percent')
assert memory['exclusions'][0]['resource_id'] == servers[0]['id'] and memory['coverage']['included'] == 1
body = {key: memory[key] for key in ['name', 'target_type', 'condition', 'severity', 'duration_seconds', 'reminder_intervals', 'enabled', 'exclusions']}
headers = {'X-I7y-Expected-Revision': str(memory['edit_version'])}
body['exclusions'] = [{key: item[key] for key in ['resource_type', 'resource_id', 'reason']} for item in body['exclusions']]
ok(v2 + '/rules/' + memory['key'], 'PUT', body, session, org, 400)
ok(v2 + '/rules/' + memory['key'], 'PUT', body, session, org, headers={'X-I7y-Expected-Revision': '0'}, status=409)
updated = ok(v2 + '/rules/' + memory['key'], 'PUT', body, session, org, headers=headers)
assert updated['edit_version'] == memory['edit_version'] + 1 and updated['revision'] == memory['revision']
ok(prefix + '/rules/legacy-create', 'PUT', {**body, 'scope_type': 'server', 'scope_id': servers[0]['id'], 'reminder_seconds': 900}, session, org, 409)
ok(v2 + '/rules/' + memory['key'], token=outsider, org=org, status=403)
foreign_workspace = create('workspaces', {'organization': other, 'login': 'foreign-' + secrets.token_hex(6)})
foreign = create('servers', {'workspace': foreign_workspace['id'], 'name': 'Foreign'})
body['exclusions'].append({'resource_type': 'server', 'resource_id': foreign['id'], 'reason': 'Invalid cross-organization exception'})
ok(v2 + '/rules/' + memory['key'], 'PUT', body, session, org, 404, {'X-I7y-Expected-Revision': str(updated['edit_version'])})
body['exclusions'].pop()
preview = ok(v2 + '/rules/simulate', 'POST', body, session, org)
assert preview['coverage']['excluded'] == 1 and any(item['result'] == 'excluded' for item in preview['items'])
assert ok(v2 + '/metrics', token=session, org=org)['capabilities']['severity_reminders']
for collection in ['alert_rule_exclusions', 'alert_rule_events', 'alert_rule_migrations']:
    ok('/api/collections/' + collection + '/records', token=session, status=403)
if os.environ.get('I7Y_TEST_TICK') == '1':
    agent_rows = ok('/api/i7y/agents', token=session, org=org)['items']
    agent_record = next(item for item in agent_rows if item['server'] == servers[0]['id'])
    patch('servers', servers[0]['id'], {'telemetry': {'observed_at': iso(-1200)}, 'last_seen': iso(-1200)})
    ok('/test/alerts/tick', 'POST', {'age_agent': agent_record['id']}, admin)
    communication = next(item for item in incidents(session, org) if item['resource_id'] == servers[0]['id'] and item['evidence'].get('metric') == 'server.no_communication_seconds')
    snapshot(agents[0], servers[0], disk=20)
    assert ok(prefix + '/incidents/' + communication['id'], token=session, org=org)['resolution_reason'] == 'recovered'
print('Type rules integration passed:', checks, 'HTTP checks; atomic migration, replay, claims, isolation, exclusions, versions and legacy guards')
