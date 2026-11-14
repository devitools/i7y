from pathlib import Path
source = Path(__file__).with_name('alerts.integration.py').read_text()
exec(source[:source.index('\norg = create(')])

orgs = [create('organizations', {'name': 'Inbox ' + secrets.token_hex(6)})['id'] for _ in range(3)]
actor, session, _ = person('admin', orgs[0])
second_membership = create('organization_memberships', {'organization': orgs[1], 'user': actor['id'], 'role': 'admin'})
outsider, other_session, _ = person('admin', orgs[2])
_, source_only, _ = person('admin', orgs[0])
claimed_user, claim_session, _ = person('editor', orgs[0])
reader, reader_session, _ = person('reader', orgs[0])
create('organization_memberships', {'organization': orgs[1], 'user': reader['id'], 'role': 'reader'})
central = prefix + '/inbox'
ok(central, status=401)
one = ok(prefix + '/incidents', 'POST', {'title': 'First visible incident'}, session, orgs[0], 201)
two = ok(prefix + '/incidents', 'POST', {'title': 'Second visible incident'}, session, orgs[1], 201)
hidden = ok(prefix + '/incidents', 'POST', {'title': 'Private third organization'}, other_session, orgs[2], 201)
page = ok(central + '?perPage=1', token=session, org=orgs[0])
assert page['totalItems'] == 2
next_page = ok(central + '?perPage=1&page=2', token=session)
assert {page['items'][0]['id'], next_page['items'][0]['id']} == {one['id'], two['id']}
assert all(item['organization_role'] == 'admin' and item['organization_name'] for item in page['items'])
filtered = ok(central + '?organization=' + orgs[1], token=session)
assert [item['id'] for item in filtered['items']] == [two['id']]
ok(central + '?organization=' + orgs[2], token=session, status=403)
ok(central + '?organization=invalid', token=session, status=400)
assert len(ok(central, token=reader_session)['items']) == 2
token = ok('/api/i7y/tokens', 'POST', {'label': 'Inbox scoped token', 'days': 1, 'scope': 'read', 'capabilities': ['incidents:read']}, session, orgs[0], 201)['token']
code, _ = call(central, token=token, org=orgs[0])
assert code in [401, 403]
notifications = central + '/notification-events'
first_notice = ok(notifications + '?limit=1', token=session)
second_notice = ok(notifications + '?limit=1&cursor=' + first_notice['cursor'], token=session)
assert len(first_notice['items']) == len(second_notice['items']) == 1
assert {first_notice['items'][0]['incident_id'], second_notice['items'][0]['incident_id']} == {one['id'], two['id']}
assert first_notice['open_count'] == second_notice['open_count'] == 2
assert not ok(notifications + '?cursor=' + second_notice['cursor'], token=session)['items']
ok(notifications + '?cursor=abc', token=session, status=400)
ok(notifications + '?limit=0', token=session, status=400)

workspace = create('workspaces', {'organization': orgs[0], 'login': 'transfer-' + secrets.token_hex(6)})
binding = ok('/api/i7y/mobile/v1/devices', 'POST', {'connection_id': str(__import__('uuid').uuid4()), 'binding_id': secrets.token_hex(16), 'send_token': secrets.token_hex(24)}, session)
integration = ok(prefix + '/integrations', 'POST', {'name': 'Movable GCP source', 'kind': 'gcp', 'workspace_id': workspace['id']}, session, orgs[0], 201)
endpoint = prefix + '/integrations/' + integration['id']
credential = 'Basic ' + base64.b64encode((integration['id'] + ':' + integration['token']).encode()).decode()
def event(identity, state='open'):
    return {'version': '1.2', 'incident': {'incident_id': identity, 'state': state, 'summary': 'GCP transfer fixture ' + identity, 'resource': {'type': 'cloudsql_database'}}}
opened = ok(endpoint + '/gcp', 'POST', event('open-fixture'), credential, headers={'Idempotency-Key': 'transfer-event'})
closed = ok(endpoint + '/gcp', 'POST', event('closed-fixture'), credential)
closed = ok(endpoint + '/gcp', 'POST', event('closed-fixture', 'closed'), credential)
opened = ok(prefix + '/incidents/' + opened['id'] + '/claim', 'POST', {'claim_until': iso(600), 'version': opened['version']}, claim_session, orgs[0])
destination = {'destination_organization': orgs[1]}
preview_path = endpoint + '/transfer/preview'
ok(preview_path, 'POST', destination, source_only, orgs[0], 403)
ok(preview_path, 'POST', destination, reader_session, orgs[0], 403)
ok(preview_path, 'POST', {'destination_organization': orgs[0]}, session, orgs[0], 400)
plan = ok(preview_path, 'POST', destination, session, orgs[0])
assert plan['incident_count'] == 2 and plan['open_count'] == 1 and plan['clears_workspace'] == workspace['id']
assert {opened['id'], closed['id']} == set(plan['incident_ids'])
ok(endpoint + '/gcp', 'POST', event('new-fixture'), credential)
ok(endpoint + '/transfer', 'POST', {**destination, 'plan_hash': plan['plan_hash']}, session, orgs[0], 409)
plan = ok(preview_path, 'POST', destination, session, orgs[0])
pending_before = ok('/api/collections/mobile_outbox/records?perPage=100', token=admin)['items']
assert any(item['incident_id'] == opened['id'] and item['status'] == 'pending' for item in pending_before)
result = ok(endpoint + '/transfer', 'POST', {**destination, 'plan_hash': plan['plan_hash']}, session, orgs[0])
assert result['incident_count'] == 3 and result['receipt_id']
replay = ok(endpoint + '/transfer', 'POST', {**destination, 'plan_hash': plan['plan_hash']}, session, orgs[0])
assert result == replay
ok(endpoint, token=session, org=orgs[0], status=404)
moved_integration = ok(endpoint, token=session, org=orgs[1])
assert moved_integration['workspace_id'] == '' and moved_integration['organization'] == orgs[1]
moved = ok(prefix + '/incidents/' + opened['id'], token=session, org=orgs[1])
assert moved['id'] == opened['id'] and moved['organization'] == orgs[1]
assert moved['assignee'] == moved['claim_until'] == moved['workspace_id'] == ''
assert any(item['kind'] == 'claimed' for item in moved['events'])
assert any(item['kind'] == 'integration_transferred' for item in moved['events'])
assert all(item['organization'] == orgs[1] for item in moved['events'])
ok(prefix + '/incidents/' + opened['id'], token=claim_session, org=orgs[0], status=404)
history = ok(prefix + '/incidents/' + closed['id'], token=session, org=orgs[1])
assert history['status'] == 'resolved'
repeated = ok(endpoint + '/gcp', 'POST', event('open-fixture'), credential, headers={'Idempotency-Key': 'transfer-event'})
assert repeated['id'] == opened['id'] and repeated['organization'] == orgs[1]
assert repeated['workspace_id'] == repeated['server_id'] == repeated['container_id'] == repeated['assignee'] == ''
source_closed = ok(endpoint + '/gcp', 'POST', event('open-fixture', 'closed'), credential)
assert source_closed['id'] == opened['id'] and source_closed['organization'] == orgs[1] and source_closed['status'] == 'resolved'
source_incidents = incidents(session, orgs[0], 'all')
assert all(item['integration'] != integration['id'] for item in source_incidents)
pending_after = ok('/api/collections/mobile_outbox/records?perPage=100', token=admin)['items']
original_ids = {item['id'] for item in pending_before if item['incident_id'] == opened['id'] and item['status'] == 'pending'}
assert all(item['status'] == 'cancelled' for item in pending_after if item['id'] in original_ids)
generic = ok(prefix + '/integrations', 'POST', {'name': 'Explicit context source', 'kind': 'generic', 'workspace_id': workspace['id']}, session, orgs[0], 201)
generic_endpoint = prefix + '/integrations/' + generic['id']
generic_credential = 'Bearer ' + generic['token']
original_body = {'external_id': 'explicit-fixture', 'state': 'open', 'title': 'Explicit context fixture', 'organization': orgs[0], 'workspace_id': workspace['id']}
generic_incident = ok(generic_endpoint + '/events', 'POST', original_body, generic_credential, orgs[0], headers={'Idempotency-Key': 'explicit-replay'})
generic_plan = ok(generic_endpoint + '/transfer/preview', 'POST', destination, session, orgs[0])
ok(generic_endpoint + '/transfer', 'POST', {**destination, 'plan_hash': generic_plan['plan_hash']}, session, orgs[0])
replayed = ok(generic_endpoint + '/events', 'POST', original_body, generic_credential, orgs[0], headers={'Idempotency-Key': 'explicit-replay'})
assert replayed['id'] == generic_incident['id'] and replayed['organization'] == orgs[1] and replayed['workspace_id'] == ''
ok(generic_endpoint + '/events', 'POST', {**original_body, 'external_id': 'future-explicit'}, generic_credential, orgs[0], 403, {'Idempotency-Key': 'new-explicit'})
ok(generic_endpoint + '/events', 'POST', {**original_body, 'title': 'Changed replay'}, generic_credential, orgs[0], 409, {'Idempotency-Key': 'explicit-replay'})
future_body = {**original_body, 'external_id': 'future-explicit', 'organization': orgs[1], 'workspace_id': ''}
ok(generic_endpoint + '/events', 'POST', future_body, generic_credential, orgs[1], headers={'Idempotency-Key': 'new-explicit'})
assert ok(central + '?status=all', token=session)['totalItems'] == 7
ok('/api/collections/organization_memberships/records/' + second_membership['id'], 'DELETE', token=admin, status=204)
assert ok(central + '?status=all', token=session)['totalItems'] == 1
ok(endpoint + '/transfer', 'POST', {**destination, 'plan_hash': plan['plan_hash']}, session, orgs[0], 403)
assert hidden['id'] not in {item['id'] for item in ok(central, token=session)['items']}
print('Inbox and integration-transfer HTTP checks passed:', checks)
