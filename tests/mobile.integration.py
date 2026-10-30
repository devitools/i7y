import concurrent.futures
import hashlib
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
BINARY = pathlib.Path(os.environ['I7Y_TEST_POCKETBASE_BINARY']).resolve()
NAME = 'i7y-mobile-test-' + secrets.token_hex(5)
ADMIN_PASSWORD = secrets.token_hex(24)


def free_port():
    with socket.socket() as handle:
        handle.bind(('127.0.0.1', 0))
        return handle.getsockname()[1]


def run(directory, port, push):
    environment = ['-e', 'I7Y_LOCAL_REHEARSAL=1']
    if push:
        environment += ['-e', 'I7Y_MOBILE_ENCRYPTION_KEY=' + 'k' * 32, '-e', 'I7Y_PUSH_GATEWAY_URL=http://127.0.0.1:8090', '-e', 'I7Y_MOBILE_TEST_MODE=1']
    subprocess.run(['docker', 'run', '-d', '--name', NAME, '-p', f'127.0.0.1:{port}:8090', '-v', f'{directory}:/test', *environment, 'alpine:3.22', '/test/pocketbase', 'serve', '--http=0.0.0.0:8090', '--dir=/test/data', '--hooksDir=/test/hooks', '--migrationsDir=/test/migrations'], check=True, stdout=subprocess.DEVNULL)


def main(directory):
    shutil.copy2(BINARY, directory / 'pocketbase')
    shutil.copytree(ROOT / 'apps/backend/hooks', directory / 'hooks')
    shutil.copytree(ROOT / 'apps/backend/migrations', directory / 'migrations')
    (directory / 'hooks/mobile-test.pb.js').write_text("""
routerAdd('POST','/api/mobile-test/tick',e=>{const m=require(__hooks+'/lib/mobile.js');m.catchUp(e.app);m.dispatch(e.app);return e.json(200,{ok:true})},$apis.requireSuperuserAuth())
routerAdd('POST','/v1/bindings/{id}/notifications',e=>{const key=e.request.header.get('Idempotency-Key'),raw=toString(e.request.body),previous=$app.store().get('mobileTestPayload:'+key);if(previous && previous!==raw)return e.json(409,{code:'idempotency_conflict'});$app.store().set('mobileTestPayload:'+key,raw);$app.store().set('mobileTestDelivery',JSON.stringify({binding:e.request.pathValue('id'),authorization:e.request.header.get('Authorization'),payload:JSON.parse(raw),raw_payload:raw,idempotency:key}));const response=$app.store().get('mobileTestResponse') || {status:202,body:{status:'accepted'}};return e.json(response.status,response.body)})
routerAdd('POST','/api/mobile-test/response',e=>{$app.store().set('mobileTestResponse',e.requestInfo().body);return e.json(200,{ok:true})},$apis.requireSuperuserAuth())
routerAdd('GET','/api/mobile-test/delivery',e=>e.json(200,JSON.parse($app.store().get('mobileTestDelivery') || 'null')),$apis.requireSuperuserAuth())
""")
    port = free_port()
    run(directory, port, True)
    base = f'http://127.0.0.1:{port}'

    def send(path, body=None, token='', method='POST', expected=200, headers=None):
        request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {}), **(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read()
        value = json.loads(raw) if raw else None
        assert response.status == expected, (path, response.status, value)
        return value

    for attempt in range(100):
        try:
            info = send('/api/i7y/mobile/v1/info', method='GET')
            break
        except (OSError, AssertionError):
            time.sleep(0.1)
    else:
        raise AssertionError('Disposable PocketBase did not start')
    subprocess.run(['docker', 'exec', NAME, '/test/pocketbase', 'superuser', 'upsert', 'mobile-admin@example.com', ADMIN_PASSWORD, '--dir=/test/data', '--hooksDir=/test/hooks', '--migrationsDir=/test/migrations'], check=True, stdout=subprocess.DEVNULL)
    admin = send('/api/collections/_superusers/auth-with-password', {'identity': 'mobile-admin@example.com', 'password': ADMIN_PASSWORD})['token']
    create = lambda name, body: send('/api/collections/' + name + '/records', body, admin)
    patch = lambda name, identity, body: send('/api/collections/' + name + '/records/' + identity, body, admin, 'PATCH')
    delete = lambda name, identity: send('/api/collections/' + name + '/records/' + identity, token=admin, method='DELETE', expected=204)
    query = lambda name: send('/api/collections/' + name + '/records?perPage=100', token=admin, method='GET')['items']
    password = secrets.token_hex(24)
    user = create('users', {'email': 'mobile-user@example.com', 'password': password, 'passwordConfirm': password})
    other = create('users', {'email': 'mobile-other@example.com', 'password': password, 'passwordConfirm': password})
    token = send('/api/collections/users/auth-with-password', {'identity': user['email'], 'password': password})['token']
    other_token = send('/api/collections/users/auth-with-password', {'identity': other['email'], 'password': password})['token']
    organization = create('organizations', {'name': 'Mobile test'})
    membership = create('organization_memberships', {'organization': organization['id'], 'user': user['id'], 'role': 'reader'})
    instance = info['instance_id']
    assert info['protocol_version'] == 1 and 'push' in info['capabilities']
    verifier = secrets.token_hex(32)
    request = secrets.token_hex(32)
    authorize = {'request': request, 'challenge': hashlib.sha256(verifier.encode()).hexdigest(), 'instance_id': instance}
    exchange = {'request': request, 'verifier': verifier, 'instance_id': instance}
    send('/api/i7y/mobile/v1/auth/authorize', authorize, expected=401)
    send('/api/i7y/mobile/v1/auth/authorize', authorize, admin, expected=403)
    send('/api/i7y/mobile/v1/auth/exchange', exchange, expected=202)
    send('/api/i7y/mobile/v1/auth/authorize', {**authorize, 'instance_id': 'wrong'}, token, expected=400)
    send('/api/i7y/mobile/v1/auth/authorize', {**authorize, 'audience': 'desktop'}, token, expected=400)
    send('/api/i7y/mobile/v1/auth/authorize', authorize, token, expected=204)
    send('/api/i7y/mobile/v1/auth/authorize', authorize, token, expected=400)
    send('/api/i7y/mobile/v1/auth/exchange', {**exchange, 'verifier': '0' * 64}, expected=400)
    with concurrent.futures.ThreadPoolExecutor() as executor:
        def race(_):
            try:
                return send('/api/i7y/mobile/v1/auth/exchange', exchange)
            except AssertionError as error:
                assert error.args[0][1] == 400, error
                return None
        exchanged = list(executor.map(race, range(2)))
    assert len([value for value in exchanged if value]) == 1
    successful = next(value for value in exchanged if value)
    assert successful['record']['id'] == user['id'] and successful['meta']['instance_id'] == instance
    send('/api/i7y/mobile/v1/auth/exchange', exchange, expected=400)
    expired_request = secrets.token_hex(32)
    create('mobile_authorizations', {'request_hash': hashlib.sha256(expired_request.encode()).hexdigest(), 'challenge': authorize['challenge'], 'audience': 'mobile', 'instance_id': instance, 'user': user['id'], 'expires_at': '2020-01-01 00:00:00.000Z'})
    send('/api/i7y/mobile/v1/auth/exchange', {**exchange, 'request': expired_request}, expected=400)
    desktop_request = secrets.token_hex(32)
    send('/api/i7y/desktop/authorize', {'request': desktop_request, 'challenge': authorize['challenge']}, token, expected=204)
    send('/api/i7y/mobile/v1/auth/exchange', {**exchange, 'request': desktop_request}, expected=202)
    raw_api_token = 'i7y_' + secrets.token_hex(32)
    create('api_tokens', {'organization': organization['id'], 'user': user['id'], 'label': 'Test token', 'token_hash': hashlib.sha256(raw_api_token.encode()).hexdigest(), 'prefix': raw_api_token[:12], 'scope': 'read', 'expires_at': '2099-01-01 00:00:00.000Z'})
    send('/api/i7y/mobile/v1/auth/authorize', {**authorize, 'request': secrets.token_hex(32)}, raw_api_token, expected=403)
    send('/api/i7y/mobile/v1/devices', token=raw_api_token, method='GET', expected=403)
    binding = {'connection_id': str(uuid.uuid4()), 'binding_id': secrets.token_hex(16), 'send_token': secrets.token_hex(32)}
    send('/api/i7y/mobile/v1/devices', binding, expected=401)
    for name in ['mobile_installation', 'mobile_devices', 'mobile_authorizations', 'mobile_outbox']:
        send('/api/collections/' + name + '/records', token=token, method='GET', expected=403)
    incident = create('incidents', {'organization': organization['id'], 'origin': 'api', 'title': 'Full disk', 'resource_name': 'coin.hospic.io', 'severity': 'critical', 'status': 'open', 'resource_id': 'private resource', 'schedule_generation': 1, 'version': 1, 'opened_at': '2026-01-01 00:00:00.000Z'})
    def notice(sequence, valid=True, generation=1):
        return create('incident_notifications', {'organization': organization['id'], 'incident': incident['id'], 'kind': 'opening', 'sequence': sequence, 'schedule_generation': generation, 'valid': valid, 'occurred_at': '2026-01-01 00:00:00.000Z'})
    old_notice = notice(1)
    device = send('/api/i7y/mobile/v1/devices', binding, token)
    assert device['locale'] == 'en'
    localized = send('/api/i7y/mobile/v1/devices/' + device['id'], {'locale': 'pt-BR', 'time_zone': 'America/Fortaleza'}, token, method='PATCH')
    assert localized['locale'] == 'pt-BR' and localized['time_zone'] == 'America/Fortaleza'
    send('/api/i7y/mobile/v1/devices/' + device['id'], {'locale': 'uk'}, other_token, method='PATCH', expected=404)
    send('/api/i7y/mobile/v1/devices/' + device['id'], {'locale': 'unsupported'}, token, method='PATCH', expected=400)
    send('/api/i7y/mobile/v1/devices/' + device['id'], {'locale': 'en'}, token, method='PATCH')
    stored_device = query('mobile_devices')[0]
    assert binding['send_token'] not in stored_device['send_token_encrypted'] and stored_device['start_sequence'] == 1
    assert 'send_token' not in json.dumps(send('/api/i7y/mobile/v1/devices', token=token, method='GET'))
    assert send('/api/i7y/mobile/v1/devices', token=other_token, method='GET')['items'] == []
    send('/api/i7y/mobile/v1/devices', binding, other_token, expected=404)
    send('/api/i7y/mobile/v1/devices/' + device['id'], token=other_token, method='DELETE', expected=404)
    patch('incident_notifications', old_notice['id'], {'valid': False})
    fresh_notice = notice(2)
    assert len(query('mobile_outbox')) == 1
    delete('organization_memberships', membership['id'])
    send('/api/mobile-test/tick', token=admin)
    assert query('mobile_outbox')[0]['status'] == 'cancelled'
    create('organization_memberships', {'organization': organization['id'], 'user': user['id'], 'role': 'reader'})
    patch('incident_notifications', fresh_notice['id'], {'valid': False})
    stale_notice = notice(3, generation=0)
    send('/api/mobile-test/tick', token=admin)
    assert len(query('mobile_outbox')) == 1
    patch('incident_notifications', stale_notice['id'], {'valid': False})
    next_notice = notice(4)
    patch('incidents', incident['id'], {'claim_until': '2099-01-01 00:00:00.000Z'})
    send('/api/mobile-test/tick', token=admin)
    assert [entry for entry in query('mobile_outbox') if entry['notification'] == next_notice['id']][0]['status'] == 'cancelled'
    patch('incident_notifications', next_notice['id'], {'valid': False})
    patch('incidents', incident['id'], {'claim_until': ''})
    delivery_notice = notice(5)
    delete('mobile_outbox', next(entry for entry in query('mobile_outbox') if entry['notification'] == delivery_notice['id'])['id'])
    send('/api/mobile-test/tick', token=admin)
    assert [entry for entry in query('mobile_outbox') if entry['notification'] == delivery_notice['id']][0]['status'] == 'accepted'
    delivered = send('/api/mobile-test/delivery', token=admin, method='GET')
    assert delivered['authorization'] == 'Bearer ' + binding['send_token']
    assert delivered['binding'] == binding['binding_id']
    assert delivered['idempotency'] == delivery_notice['id'] + '-' + device['id']
    assert delivered['payload']['title'] == '[i7y] Full disk 🚨'
    assert delivered['payload']['resource'] == 'coin.hospic.io: Full disk — Critical incident is open.'
    assert 'Private' not in json.dumps(delivered['payload'])
    send('/api/mobile-test/tick', token=admin)
    assert len([entry for entry in query('mobile_outbox') if entry['notification'] == delivery_notice['id']]) == 1
    patch('incident_notifications', delivery_notice['id'], {'valid': False})
    retry_notice = notice(6)
    send('/api/mobile-test/response', {'status': 503, 'body': {'status': 'retryable', 'code': 'provider_unavailable'}}, admin)
    send('/api/mobile-test/tick', token=admin)
    retry_entry = next(entry for entry in query('mobile_outbox') if entry['notification'] == retry_notice['id'])
    assert retry_entry['status'] == 'pending' and retry_entry['attempts'] == 1
    initial_retry = send('/api/mobile-test/delivery', token=admin, method='GET')
    assert initial_retry['payload']['severity'] == 'critical'
    changed_incident = patch('incidents', incident['id'], {'severity': 'warning'})
    assert changed_incident['schedule_generation'] == 1
    patch('mobile_outbox', retry_entry['id'], {'next_attempt_at': '2020-01-01 00:00:00.000Z'})
    send('/api/mobile-test/response', {'status': 202, 'body': {'status': 'accepted', 'code': 'provider_accepted'}}, admin)
    send('/api/mobile-test/tick', token=admin)
    assert next(entry for entry in query('mobile_outbox') if entry['id'] == retry_entry['id'])['status'] == 'accepted'
    repeated_retry = send('/api/mobile-test/delivery', token=admin, method='GET')
    assert repeated_retry['raw_payload'] == initial_retry['raw_payload']
    assert repeated_retry['idempotency'] == initial_retry['idempotency']
    patch('incident_notifications', retry_notice['id'], {'valid': False})
    invalid_notice = notice(7)
    invalid_entry = next(entry for entry in query('mobile_outbox') if entry['notification'] == invalid_notice['id'])
    patch('mobile_outbox', invalid_entry['id'], {'next_attempt_at': '2020-01-01 00:00:00.000Z'})
    send('/api/mobile-test/response', {'status': 422, 'body': {'status': 'permanent_failure', 'code': 'invalid_token'}}, admin)
    send('/api/mobile-test/tick', token=admin)
    assert next(entry for entry in query('mobile_outbox') if entry['id'] == invalid_entry['id'])['status'] == 'invalid'
    assert send('/api/i7y/mobile/v1/devices', token=token, method='GET')['items'][0]['active'] is False
    send('/api/i7y/mobile/v1/devices', binding, token)
    patch('incident_notifications', invalid_notice['id'], {'valid': False})
    integration = create('alert_integrations', {'organization': organization['id'], 'name': 'Mobile source', 'kind': 'generic', 'enabled': True, 'reminder_seconds': 60})
    patch('incidents', incident['id'], {'integration': integration['id']})
    source_notice = notice(8)
    patch('alert_integrations', integration['id'], {'enabled': False})
    send('/api/mobile-test/tick', token=admin)
    assert next(entry for entry in query('mobile_outbox') if entry['notification'] == source_notice['id'])['status'] == 'cancelled'
    for member in query('organization_memberships'):
        if member['user'] == user['id'] and member['organization'] == organization['id']:
            patch('organization_memberships', member['id'], {'role': 'editor'})
    create('organization_memberships', {'organization': organization['id'], 'user': other['id'], 'role': 'reader'})
    second_binding = {'connection_id': str(uuid.uuid4()), 'binding_id': secrets.token_hex(16), 'send_token': secrets.token_hex(32)}
    second_device = send('/api/i7y/mobile/v1/devices', second_binding, other_token)
    responding = create('incidents', {'organization': organization['id'], 'origin': 'api', 'title': 'Claim broadcast', 'resource_name': 'service.example.com', 'severity': 'critical', 'status': 'open', 'schedule_generation': 1, 'version': 1})
    deadline = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() + 3600))
    claimed = send('/api/i7y/alerts/v1/incidents/' + responding['id'] + '/claim', {'version': 1, 'claim_until': deadline}, token, headers={'X-I7y-Organization': organization['id']})
    assert claimed['assignee'] == user['id']
    claimed_notice = next(entry for entry in query('incident_notifications') if entry['incident'] == responding['id'])
    assert claimed_notice['kind'] == 'claimed'
    send('/api/mobile-test/response', {'status': 202, 'body': {'status': 'accepted', 'code': 'provider_accepted'}}, admin)
    broadcast = [entry for entry in query('mobile_outbox') if entry['notification'] == claimed_notice['id']]
    assert {entry['device'] for entry in broadcast} == {device['id'], second_device['id']}
    for entry in broadcast:
        payload = json.loads(entry['payload_json'])
        assert 'being handled by' in payload['resource'] and payload['deadline_at'] == deadline
    send('/api/mobile-test/tick', token=admin)
    assert all(entry['status'] == 'accepted' for entry in query('mobile_outbox') if entry['notification'] == claimed_notice['id'])
    extended_deadline = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() + 7200))
    extended = send('/api/i7y/alerts/v1/incidents/' + responding['id'] + '/claim', {'version': claimed['version'], 'claim_until': extended_deadline}, token, headers={'X-I7y-Organization': organization['id']})
    extended_notice = next(entry for entry in query('incident_notifications') if entry['incident'] == responding['id'] and entry['kind'] == 'claim_extended')
    assert len([entry for entry in query('mobile_outbox') if entry['notification'] == extended_notice['id']]) == 2
    resolved = send('/api/i7y/alerts/v1/incidents/' + responding['id'] + '/resolve', {'version': extended['version']}, token, headers={'X-I7y-Organization': organization['id']})
    assert resolved['status'] == 'resolved'
    resolved_notice = next(entry for entry in query('incident_notifications') if entry['incident'] == responding['id'] and entry['kind'] == 'resolved')
    closing = [entry for entry in query('mobile_outbox') if entry['notification'] == resolved_notice['id']]
    assert {entry['device'] for entry in closing} == {device['id'], second_device['id']}
    for entry in closing:
        payload = json.loads(entry['payload_json'])
        assert payload['title'].endswith('✅') and 'resolved by' in payload['resource']
        assert payload['deadline_at'].replace('T',' ').replace('Z','') == resolved['resolved_at'].replace('T',' ').replace('Z','')
    send('/api/mobile-test/tick', token=admin)
    assert all(entry['status'] == 'accepted' for entry in query('mobile_outbox') if entry['notification'] == resolved_notice['id'])
    assert all(entry['status'] == 'cancelled' for entry in query('mobile_outbox') if entry['notification'] == extended_notice['id'])
    send('/api/i7y/mobile/v1/devices/' + device['id'], token=token, method='DELETE', expected=204)
    assert send('/api/i7y/mobile/v1/devices', token=token, method='GET')['items'][0]['active'] is False
    assert send('/api/i7y/mobile/v1/info', method='GET')['instance_id'] == instance
    subprocess.run(['docker', 'rm', '-f', NAME], check=True, stdout=subprocess.DEVNULL)
    run(directory, port, False)
    for attempt in range(100):
        try:
            unconfigured = send('/api/i7y/mobile/v1/info', method='GET')
            break
        except (OSError, AssertionError):
            time.sleep(0.1)
    else:
        raise AssertionError('Restarted PocketBase did not start')
    assert unconfigured['instance_id'] == instance and 'push' not in unconfigured['capabilities'] and 'push_gateway_url' not in unconfigured
    send('/api/i7y/mobile/v1/devices', binding, token, expected=503)
    assert send('/api/i7y/alerts/v1/incidents', token=token, method='GET', headers={'X-I7y-Organization': organization['id']})['totalItems'] == 1
    print('Mobile integration passed: single-use proofs, audience isolation, server binding, session-only routes, private records, device ownership, no historical replay, membership/source revocation, stale/claimed notices, catch-up repair, frozen-payload retries after severity changes, invalid-token deactivation and unconfigured restart.')


with tempfile.TemporaryDirectory(prefix='i7y-mobile-test-') as temporary:
    try:
        main(pathlib.Path(temporary))
    except Exception:
        subprocess.run(['docker', 'logs', '--tail', '5', NAME], check=False)
        raise
    finally:
        subprocess.run(['docker', 'rm', '-f', NAME], check=False, stdout=subprocess.DEVNULL)
