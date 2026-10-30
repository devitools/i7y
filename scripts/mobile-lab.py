import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
LAB = ROOT / '.local/mobile-lab'
ACCESS = LAB / 'access.json'
LABEL = 'io.i7y.mobile-lab.run'


def command(arguments, **options):
    return subprocess.run(arguments, check=True, text=True, capture_output=True, **options).stdout.strip()


def save_access(value):
    temporary = LAB / 'access.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
    temporary.replace(ACCESS)
    ACCESS.chmod(0o600)


def request(base, path, body=None, token='', method='GET', expected=200, organization=None):
    headers = {'Accept': 'application/json'}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if organization:
        headers['X-I7y-Organization'] = organization
    call = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(call, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    if response.status != expected:
        raise RuntimeError(f'{method} {path} returned {response.status}; expected {expected}')
    if not raw:
        return None
    if response.headers.get_content_type() == 'application/json':
        return json.loads(raw)
    return raw.decode()


def login(base, account, superuser=False):
    collection = '_superusers' if superuser else 'users'
    return request(base, f'/api/collections/{collection}/auth-with-password', {'identity': account['email'], 'password': account['password']}, method='POST')['token']


def wait_ready(base):
    for attempt in range(200):
        try:
            return request(base, '/api/i7y/mobile/v1/info')
        except (OSError, ValueError, RuntimeError):
            time.sleep(0.1)
    raise RuntimeError('Disposable PocketBase did not become ready')


def free_ports():
    with contextlib.ExitStack() as stack:
        handles = [stack.enter_context(socket.socket()) for index in range(2)]
        for handle in handles:
            handle.bind(('127.0.0.1', 0))
        return [handle.getsockname()[1] for handle in handles]


def identity(label, kind):
    return ('lab' + label + kind).ljust(15, '0')[:15]


def timestamp(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def docker_prefix(state):
    return ['docker', 'run', '--platform', state['platform'], '--user', f'{os.getuid()}:{os.getgid()}', '--label', LABEL + '=' + state['run_id'], '-e', 'I7Y_LOCAL_REHEARSAL=1', '-v', f'{LAB / "common"}:/lab/common:ro']


def container_belongs(name, run_id):
    result = subprocess.run(['docker', 'inspect', '--format', '{{ index .Config.Labels "' + LABEL + '" }}', name], text=True, capture_output=True)
    return result.returncode == 0 and result.stdout.strip() == run_id


def remove_containers(state):
    command(['docker', 'info', '--format', '{{.ServerVersion}}'])
    for instance in state['instances'].values():
        name = instance['container']
        if container_belongs(name, state['run_id']):
            command(['docker', 'rm', '-f', name])


def seed(instance):
    base, label = instance['url'], instance['label'].lower()
    admin = login(base, instance['superuser'], True)

    def create(collection, values):
        return request(base, '/api/collections/' + collection + '/records', values, admin, 'POST')

    organizations = {}
    for kind, name in [('primary', 'Primary'), ('secondary', 'Secondary')]:
        record = create('organizations', {'id': identity(label, kind), 'name': f'Mobile Lab {label.upper()} {name}'})
        organizations[kind] = record['id']
    instance['organizations'] = organizations
    for name, account in instance['accounts'].items():
        record = create('users', {'id': identity(label, name), 'email': account['email'], 'password': account['password'], 'passwordConfirm': account['password'], 'name': f'Lab {label.upper()} {name.title()}', 'verified': True, 'global_admin': False})
        account['id'] = record['id']
        create('organization_memberships', {'organization': organizations['primary'], 'user': record['id'], 'role': account['role']})
        if name != 'viewer':
            create('organization_memberships', {'organization': organizations['secondary'], 'user': record['id'], 'role': account['role']})
    now = datetime.now(timezone.utc)
    incidents = {}
    for sequence, kind in enumerate(['primary', 'secondary'], 1):
        incident = create('incidents', {'id': identity(label, 'open' + kind), 'organization': organizations[kind], 'origin': 'api', 'title': f'Lab {label.upper()}: synthetic {kind} service unavailable', 'severity': 'critical' if kind == 'primary' else 'warning', 'status': 'open', 'resource_type': 'service', 'resource_id': f'lab-{label}-{kind}-service', 'resource_name': f'Synthetic {kind} service {label.upper()}', 'evidence': {'summary': 'Synthetic simulator fixture. No production data.', 'sample': 42}, 'opened_at': timestamp(now - timedelta(minutes=2)), 'reminder_seconds': 60, 'next_reminder_at': timestamp(now + timedelta(seconds=60)), 'schedule_generation': 1, 'version': 1})
        incidents[kind] = incident['id']
        create('incident_events', {'organization': organizations[kind], 'incident': incident['id'], 'kind': 'opened', 'actor': instance['accounts']['operator']['id'], 'occurred_at': timestamp(now - timedelta(minutes=2)), 'data': {'summary': 'Synthetic lab opening'}})
        create('incident_notifications', {'organization': organizations[kind], 'incident': incident['id'], 'kind': 'opening', 'sequence': sequence, 'schedule_generation': 1, 'valid': True, 'occurred_at': timestamp(now - timedelta(minutes=2))})
    instance['incidents'] = incidents


def verify(instance):
    base = instance['url']
    discovered = request(base, '/api/i7y/mobile/v1/info')
    page = request(base, '/')
    if '<div id="app"' not in page or '/assets/' not in page:
        raise RuntimeError('The production web application is not being served')
    operator = login(base, instance['accounts']['operator'])
    viewer = login(base, instance['accounts']['viewer'])
    org = instance['organizations']['primary']
    incidents = request(base, '/api/i7y/alerts/v1/incidents', token=operator, organization=org)
    if not any(item['id'] == instance['incidents']['primary'] for item in incidents['items']):
        raise RuntimeError('The seeded incident is not visible to the operator')
    request(base, '/api/i7y/alerts/v1/incidents/' + instance['incidents']['primary'] + '/claim', {'claim_until': timestamp(datetime.now(timezone.utc) + timedelta(hours=1)), 'version': 1}, viewer, 'POST', 403, org)
    verification = request(base, '/api/i7y/alerts/v1/incidents', {'title': f'Lab {instance["label"]}: resolved action verification', 'severity': 'info', 'evidence': {'fixture': True}}, operator, 'POST', 201, org)
    claimed = request(base, '/api/i7y/alerts/v1/incidents/' + verification['id'] + '/claim', {'claim_until': timestamp(datetime.now(timezone.utc) + timedelta(hours=1)), 'version': verification['version']}, operator, 'POST', organization=org)
    request(base, '/api/i7y/alerts/v1/incidents/' + verification['id'] + '/resolve', {'version': claimed['version']}, operator, 'POST', organization=org)
    verifier, proof_request = secrets.token_hex(32), secrets.token_hex(32)
    request(base, '/api/i7y/mobile/v1/auth/authorize', {'request': proof_request, 'challenge': hashlib.sha256(verifier.encode()).hexdigest(), 'instance_id': discovered['instance_id']}, operator, 'POST', 204)
    proof = {'request': proof_request, 'verifier': verifier, 'instance_id': discovered['instance_id']}
    exchanged = request(base, '/api/i7y/mobile/v1/auth/exchange', proof, method='POST')
    if exchanged['record']['id'] != instance['accounts']['operator']['id'] or exchanged['meta']['instance_id'] != discovered['instance_id']:
        raise RuntimeError('Mobile authorization returned the wrong context')
    request(base, '/api/i7y/mobile/v1/auth/exchange', proof, method='POST', expected=400)
    notices = request(base, '/api/i7y/alerts/v1/notification-events', token=operator, organization=org)
    if not any(item['incident_id'] == instance['incidents']['primary'] for item in notices['items']):
        raise RuntimeError('The synthetic notice queue is unavailable')
    instance['instance_id'] = discovered['instance_id']
    instance['verification'] = {'production_web': True, 'password_login': True, 'mobile_consent_exchange': True, 'proof_replay_rejected': True, 'incident_list': True, 'operator_claim_resolve': True, 'viewer_claim_forbidden': True, 'notification_queue': True}


def status(state):
    result = {'credentials_path': str(ACCESS), 'instances': {}}
    for label, instance in state['instances'].items():
        item = {'url': instance['url'], 'container': instance['container'], 'running': False}
        if container_belongs(instance['container'], state['run_id']):
            try:
                info = request(instance['url'], '/api/i7y/mobile/v1/info')
                item.update(running=True, instance_id=info['instance_id'], capabilities=info['capabilities'])
            except (OSError, RuntimeError, ValueError):
                pass
        result['instances'][label] = item
    print(json.dumps(result, indent=2))
    return all(item['running'] for item in result['instances'].values())


def start(arguments):
    if ACCESS.exists():
        state = json.loads(ACCESS.read_text())
        if not status(state):
            raise RuntimeError('An existing lab is incomplete. Stop it before starting a fresh lab.')
        return
    if LAB.exists():
        raise RuntimeError('The lab directory exists without its manifest. Inspect or remove that lab directory before starting.')
    if not arguments.pocketbase_binary:
        raise RuntimeError('Set I7Y_TEST_POCKETBASE_BINARY or pass --pocketbase-binary with a Linux PocketBase 0.40.4 binary')
    binary = pathlib.Path(arguments.pocketbase_binary).expanduser().resolve()
    with binary.open('rb') as handle:
        header = handle.read(64)
    if header[:4] != b'\x7fELF':
        raise RuntimeError('The lab requires a Linux ELF PocketBase binary')
    machine = int.from_bytes(header[18:20], 'little')
    platform = {62: 'linux/amd64', 183: 'linux/arm64'}.get(machine)
    if not platform:
        raise RuntimeError('The PocketBase binary must target Linux amd64 or arm64')
    command(['docker', 'info', '--format', '{{.ServerVersion}}'])
    LAB.mkdir(mode=0o700, parents=True)
    common = LAB / 'common'
    common.mkdir(mode=0o700)
    shutil.copy2(binary, common / 'pocketbase')
    (common / 'pocketbase').chmod(0o755)
    shutil.copytree(ROOT / 'apps/backend/hooks', common / 'hooks')
    shutil.copytree(ROOT / 'apps/backend/migrations', common / 'migrations')
    run_id = secrets.token_hex(5)
    state = {'run_id': run_id, 'platform': platform, 'instances': {}}
    for label, port in zip(['A', 'B'], free_ports()):
        lower = label.lower()
        directory = LAB / lower
        directory.mkdir(mode=0o700)
        state['instances'][label] = {'label': label, 'container': f'i7y-mobile-lab-{run_id}-{lower}', 'url': f'http://127.0.0.1:{port}', 'port': port, 'superuser': {'email': f'superuser-{lower}@mobile-lab.example.test', 'password': secrets.token_hex(24)}, 'accounts': {name: {'email': f'{name}-{lower}@mobile-lab.example.test', 'password': secrets.token_hex(20), 'role': role} for name, role in [('admin', 'admin'), ('operator', 'editor'), ('viewer', 'reader')]}}
    save_access(state)
    try:
        environment = {**os.environ, 'VITE_POCKETBASE_URL': '/'}
        result = subprocess.run(['npm', 'run', 'build', '--workspace', '@i7y/web', '--', '--outDir', str(common / 'public')], cwd=ROOT, env=environment, text=True, capture_output=True)
        (LAB / 'web-build.log').write_text(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('The web build failed; inspect the ignored web-build.log')
        if not (common / 'public/index.html').exists():
            raise RuntimeError('The production web build does not contain index.html')
        version = command(docker_prefix(state) + ['--rm', 'alpine:3.22', '/lab/common/pocketbase', '--version'])
        if '0.40.4' not in version:
            raise RuntimeError('The lab requires PocketBase 0.40.4')
        for instance in state['instances'].values():
            directory = LAB / instance['label'].lower()
            mounts = ['-v', f'{directory}:/lab/state']
            flags = ['--dir=/lab/state/data', '--hooksDir=/lab/common/hooks', '--migrationsDir=/lab/common/migrations']
            credentials = instance['superuser']
            command(docker_prefix(state) + mounts + ['--rm', 'alpine:3.22', '/lab/common/pocketbase', 'superuser', 'upsert', credentials['email'], credentials['password']] + flags)
            command(docker_prefix(state) + mounts + ['-d', '--name', instance['container'], '-p', f'127.0.0.1:{instance["port"]}:8090', 'alpine:3.22', '/lab/common/pocketbase', 'serve', '--http=0.0.0.0:8090', '--publicDir=/lab/common/public'] + flags)
            wait_ready(instance['url'])
            seed(instance)
            verify(instance)
            save_access(state)
        if state['instances']['A']['instance_id'] == state['instances']['B']['instance_id']:
            raise RuntimeError('Disposable installations unexpectedly share an identity')
        state['ready'] = True
        save_access(state)
        status(state)
    except BaseException:
        remove_containers(state)
        raise


def main():
    parser = argparse.ArgumentParser(description='Two disposable local i7y installations with synthetic simulator fixtures')
    parser.add_argument('action', choices=['start', 'status', 'stop'])
    parser.add_argument('--pocketbase-binary', default=os.environ.get('I7Y_TEST_POCKETBASE_BINARY'))
    arguments = parser.parse_args()
    (ROOT / '.local').mkdir(exist_ok=True)
    descriptor = os.open(ROOT / '.local/mobile-lab.lock', os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if arguments.action == 'start':
            start(arguments)
        elif ACCESS.exists():
            state = json.loads(ACCESS.read_text())
            if arguments.action == 'status':
                if not status(state):
                    sys.exit(1)
            else:
                remove_containers(state)
                shutil.rmtree(LAB)
                print('Stopped both disposable installations and removed their databases and generated credentials.')
        else:
            print('No mobile lab is running.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            message = 'A local setup command failed; no credentials were printed. Run stop before trying again.'
        else:
            message = str(error)
        print(message, file=sys.stderr)
        sys.exit(1)
