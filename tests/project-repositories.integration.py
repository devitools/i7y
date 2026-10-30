import datetime
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid

base = os.environ['I7Y_TEST_URL']
assert urllib.parse.urlparse(base).hostname in ['127.0.0.1', 'localhost']
access = json.load(open(os.environ['I7Y_TEST_ACCESS']))
prefix = '/api/collections/'

def call(path, method='GET', data=None, token=None, expected=200):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = token
    request = urllib.request.Request(base + path, method=method, headers=headers, data=None if data is None else json.dumps(data).encode())
    try:
        response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        result = json.loads(response.read() or '{}')
        assert response.code == expected, (path, response.code, result)
        return result

admin = call(prefix + '_superusers/auth-with-password', 'POST', {'identity': access['email'], 'password': access['password']})['token']
organization = call(prefix + 'organizations/records', 'POST', {'name': 'Repository fixture ' + uuid.uuid4().hex}, admin)
users = []
try:
    sessions = {}
    for role in ['admin', 'reader', 'outsider']:
        user = call(prefix + 'users/records', 'POST', {'email': role + '-' + uuid.uuid4().hex + '@example.com', 'password': access['password'], 'passwordConfirm': access['password']}, admin)
        users.append(user)
        sessions[role] = call(prefix + 'users/auth-with-password', 'POST', {'identity': user['email'], 'password': access['password']})['token']
        if role != 'outsider':
            call(prefix + 'organization_memberships/records', 'POST', {'organization': organization['id'], 'user': user['id'], 'role': role}, admin)
    session = sessions['admin']
    workspace = call(prefix + 'workspaces/records', 'POST', {'organization': organization['id'], 'login': 'repo-' + uuid.uuid4().hex}, session)
    server = call(prefix + 'servers/records', 'POST', {'workspace': workspace['id'], 'name': 'Fixture host', 'type': 'VPS'}, session)
    project = call(prefix + 'projects/records', 'POST', {'server': server['id'], 'name': 'Fixture project', 'path': '/srv/fixture'}, session)
    path = prefix + 'projects/records/' + project['id']
    assert project['version_control_status'] == 'unknown'
    metadata = {'source_repository_url': 'https://git.example.com/team/repository', 'deployment_branch': 'release/fixture', 'deployment_template': '.environment/fixture/docker-compose.yml', 'version_control_status': 'versioned'}
    saved = call(path, 'PATCH', metadata, session)
    assert all(saved[k] == v for k, v in metadata.items())
    assert call(path, token=sessions['reader'])['source_repository_url'] == metadata['source_repository_url']
    call(path, 'PATCH', {'deployment_branch': 'forbidden'}, sessions['reader'], 403)
    call(path, token=sessions['outsider'], expected=404)
    call(path, expected=401)
    for url in ['javascript:alert(1)', 'https://user:secret@git.example.com/repo', 'https://git.example.com/repo?token=secret', 'https://git.example.com\\@evil.example/repo']:
        call(path, 'PATCH', {'source_repository_url': url}, session, 400)
    for template in ['/etc/passwd', '../secret', '.environment/../../secret', 'C:\\secret']:
        call(path, 'PATCH', {'deployment_template': template}, session, 400)
    call(path, 'PATCH', {'version_control_status': 'unversioned'}, session, 400)
    call(path, 'PATCH', {'version_control_status': 'invalid'}, session, 400)
    for term in ['team/repository', 'release/fixture', '.environment/fixture']:
        query = urllib.parse.urlencode({'filter': 'search_text ~ ' + json.dumps(term)})
        rows = call(prefix + 'i7y_projects/records?' + query, token=session)['items']
        row = next(r['payload'] for r in rows if r['id'] == project['id'])
        assert all(row[k] == v for k, v in metadata.items())
        assert not call(prefix + 'i7y_projects/records?' + query, token=sessions['outsider'])['items']
    agent = call('/api/i7y/agents', 'POST', {'server': server['id']}, session, 201)['token']
    snapshot = {'version': 1, 'sample_id': uuid.uuid4().hex, 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'agent_version': 'test', 'host': {'cpu_percent': 1}, 'docker_complete': True, 'discovery_complete': True, 'projects': [{'key': project['id'], 'name': 'Fixture refreshed', 'path': '/srv/refreshed', 'source_repository_url': 'https://wrong.example/repo', 'deployment_branch': 'wrong'}, {'key': '/srv/discovered', 'name': 'Discovered', 'path': '/srv/discovered'}], 'containers': [], 'errors': []}
    call('/api/i7y/telemetry/v1/snapshots', 'POST', snapshot, agent)
    refreshed = call(path, token=session)
    assert refreshed['path'] == '/srv/refreshed'
    assert all(refreshed[k] == v for k, v in metadata.items())
    discovered = next(r for r in call(prefix + 'projects/records', token=session)['items'] if r['name'] == 'Discovered')
    assert discovered['version_control_status'] == 'unknown'
    call(path, 'PATCH', dict.fromkeys(metadata, '') | {'version_control_status': 'unversioned'}, session)
    assert call(path, token=session)['version_control_status'] == 'unversioned'
finally:
    if 'workspace' in locals():
        call(prefix + 'workspaces/records/' + workspace['id'], 'DELETE', token=admin, expected=204)
    for user in users:
        call(prefix + 'users/records/' + user['id'], 'DELETE', token=admin, expected=204)
    call(prefix + 'organizations/records/' + organization['id'], 'DELETE', token=admin, expected=204)
print('PASS: repository CRUD, validation, organization permissions, search, unknown defaults and telemetry preservation')
