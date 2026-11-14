import http.client
import ipaddress
import json
import os
import pathlib
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import urllib.parse


try:
    import i7y_vault as vaults
except ModuleNotFoundError:
    import importlib.util
    spec = importlib.util.spec_from_file_location('i7y_vault', pathlib.Path(__file__).with_name('i7y_vault.py'))
    vaults = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vaults)
Failure = vaults.Failure


def emit(**value):
    print(json.dumps(value), flush=True)


def executable(name):
    for location in ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, shutil.which(name)]:
        if location and pathlib.Path(location).is_file():
            return location
    raise Failure('runtime_unavailable')


def validate_reference(reference):
    vaults.adapter(reference)


def vault_item(reference, otp=False, metadata=False):
    return vaults.adapter(reference).item(otp=otp, metadata=metadata)


def field(item, name):
    fields = item.get('fields', [])
    primary = [entry for entry in fields if entry.get('id') == name]
    if primary:
        if len(primary) != 1 or not isinstance(primary[0].get('value'), str) or not primary[0]['value']:
            raise Failure('vault_unavailable')
        return primary[0]['value']
    values = [entry.get('value') for entry in fields if entry.get('label', '').lower() == name.lower()]
    values = list(dict.fromkeys(x for x in values if isinstance(x, str) and x))
    if len(values) != 1:
        raise Failure('vault_unavailable')
    return values[0]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, target):
        return None


class Provider:
    def __init__(self, target):
        self.target = target
        self.token = None
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, body=None, token=None):
        headers = {'Content-Type': 'application/json', 'User-Agent': 'i7y-server-power/1'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request('https://my.snel.com/api/' + path, headers=headers, data=None if body is None else json.dumps(body).encode())
        try:
            with self.opener.open(request, timeout=25) as response:
                value = response.read(1048577)
                if len(value) > 1048576:
                    raise Failure('provider_unavailable')
                data = json.loads(value)
                if not isinstance(data, dict) or data.get('error') or data.get('errors') or data.get('success') is False:
                    raise Failure('provider_rejected')
                return data
        except urllib.error.HTTPError as error:
            raise Failure('provider_rejected' if error.code in [400, 401, 403, 404, 422] else 'provider_unavailable') from None
        except (OSError, ValueError, http.client.HTTPException):
            raise Failure('provider_unavailable') from None

    def login(self):
        reference = self.target['provider_credential']
        item = vault_item(reference)
        response = self.request('login', {'username': field(item, 'username'), 'password': field(item, 'password')})
        mfa = response.get('mfa')
        if mfa:
            if 'google_authenticator' not in mfa.get('methods', []):
                raise Failure('vault_unavailable')
            response = self.request('mfa/verify', {'method': 'google_authenticator', 'payload': {'code': vault_item(reference, otp=True)}}, mfa['token'])
        if not isinstance(response.get('token'), str) or not response['token']:
            raise Failure('provider_rejected')
        self.token = response['token']

    def state(self):
        rows = self.request('service/' + self.target['service_id'] + '/vms', token=self.token).get('vms', {})
        vm = rows.get(self.target['vm_id']) if isinstance(rows, dict) else None
        if not isinstance(vm, dict) or not isinstance(vm.get('power'), bool):
            raise Failure('provider_target_missing')
        return vm['power']

    def change(self, action):
        if action not in ['start', 'shutdown']:
            raise Failure('invalid_target')
        return self.request('service/' + self.target['service_id'] + '/vms/' + self.target['vm_id'] + '/' + action, {'vmid': self.target['vm_id']}, self.token)


def validate(request):
    if request.get('action') not in ['inspect', 'start', 'shutdown']:
        raise Failure('invalid_target')
    target = request['target']
    ipaddress.ip_address(target['address'])
    for key in ['service_id', 'vm_id']:
        if not isinstance(target[key], str) or not re.fullmatch(r'[1-9][0-9]{0,15}', target[key]):
            raise Failure('invalid_target')
    for key in ['provider_credential', 'disk_credential']:
        validate_reference(target[key])
    if not isinstance(target['boot_port'], int) or not 1 <= target['boot_port'] <= 65535:
        raise Failure('invalid_target')
    if target.get('boot_host_key') and not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+', target['boot_host_key']):
        raise Failure('invalid_target')
    if target.get('luks_uuid') and not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', target['luks_uuid']):
        raise Failure('invalid_target')


def configuration(request):
    target = request['target']
    validate_reference(target['disk_credential'])
    address = ipaddress.ip_address(target['address'])
    item = vault_item(target['disk_credential'], metadata=True)
    if not isinstance(item, dict):
        raise Failure('vault_metadata_invalid')
    fields = item.get('fields', [])
    if not isinstance(fields, list) or any(not isinstance(entry, dict) for entry in fields):
        raise Failure('vault_metadata_invalid')

    def metadata(*names):
        names = {name.lower() for name in names}
        values = [entry.get('value') for entry in fields if str(entry.get('label', '')).lower() in names or str(entry.get('id', '')).lower() in names]
        values = list(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))
        if len(values) > 1:
            raise Failure('vault_metadata_invalid')
        return values[0] if values else ''

    service = metadata('SNEL service ID', 'service_id')
    linked = []
    urls = item.get('urls', [])
    if not isinstance(urls, list):
        raise Failure('vault_metadata_invalid')
    urls = urls + [{'href': entry.get('value')} for entry in fields if entry.get('type') == 'URL' or str(entry.get('label', '')).lower() in ['website', 'snel service url']]
    for entry in urls:
        if not isinstance(entry, dict) or not isinstance(entry.get('href'), str):
            continue
        try:
            url = urllib.parse.urlsplit(entry['href'])
            match = re.fullmatch(r'/clientarea/services/cloudvps/([1-9][0-9]{0,15})/?', url.path)
            if url.scheme == 'https' and url.netloc == 'my.snel.com' and match:
                linked.append(match[1])
        except ValueError:
            raise Failure('vault_metadata_invalid') from None
    services = set(linked + ([service] if service else []))
    if len(services) > 1:
        raise Failure('vault_metadata_invalid')
    service = next(iter(services), '')
    vm = metadata('SNEL VM ID', 'vm_id')
    if not service or not vm:
        raise Failure('vault_metadata_missing')
    declared = metadata('IP address', 'ip_address', 'IP')
    if declared:
        try:
            if ipaddress.ip_address(declared) != address:
                raise Failure('vault_target_mismatch')
        except ValueError:
            raise Failure('vault_metadata_invalid') from None
    port = metadata('Boot SSH port', 'boot_port') or '2222'
    if not port.isascii() or not port.isdigit():
        raise Failure('vault_metadata_invalid')
    result = {'service_id': service, 'vm_id': vm, 'boot_port': int(port), 'boot_host_key': metadata('Verified boot SSH public key', 'boot_host_key'), 'luks_uuid': metadata('LUKS disk UUID', 'luks_uuid').lower()}
    try:
        validate({'action': 'inspect', 'target': {**target, **result, 'provider_credential': target['disk_credential']}})
        if bool(result['boot_host_key']) != bool(result['luks_uuid']):
            raise Failure('invalid_target')
    except (Failure, ValueError, KeyError):
        raise Failure('vault_metadata_invalid') from None
    return result


def quoted(value):
    if not isinstance(value, str) or not value or re.search(r'[\x00-\x1f%$]', value):
        raise Failure('invalid_target')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


class Boot:
    def __init__(self, request):
        self.request = request
        self.target = request['target']
        self.directory = tempfile.TemporaryDirectory(prefix='i7y-boot-')
        directory = pathlib.Path(self.directory.name)
        known = directory / 'known_hosts'
        address, port = self.target['address'], self.target['boot_port']
        host_entry = address if port == 22 else '[' + address + ']:' + str(port)
        known.write_text(host_entry + ' ' + self.target['boot_host_key'] + '\n')
        common = ['BatchMode yes', 'IdentitiesOnly yes', 'StrictHostKeyChecking yes', 'ForwardAgent no', 'ConnectTimeout 5', 'ServerAliveInterval 5', 'ServerAliveCountMax 2', 'UserKnownHostsFile ' + quoted(str(known)), 'GlobalKnownHostsFile ' + quoted(os.devnull)]
        identity = str(pathlib.Path(request['identity_file']).resolve(strict=True))
        blocks = ['Host boot-target', 'HostName ' + quoted(address), 'Port ' + str(port), 'User root', 'IdentityFile ' + quoted(identity), *common]
        proxy = request.get('proxy')
        if proxy:
            if not re.fullmatch(r'[a-zA-Z0-9.-]+', proxy['host']) or not re.fullmatch(r'[a-zA-Z0-9_.-]+', proxy['user']) or not isinstance(proxy['port'], int) or not 1 <= proxy['port'] <= 65535:
                raise Failure('invalid_target')
            proxy_identity = str(pathlib.Path(proxy['identity_file']).resolve(strict=True))
            if '\n' in proxy['host_key'] or not re.fullmatch(r'(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+', proxy['host_key']):
                raise Failure('invalid_target')
            with known.open('a') as output:
                host_entry = proxy['host'] if proxy['port'] == 22 else '[' + proxy['host'] + ']:' + str(proxy['port'])
                output.write(host_entry + ' ' + proxy['host_key'] + '\n')
            blocks += ['ProxyJump i7y-automation', 'Host i7y-automation', 'HostName ' + quoted(proxy['host']), 'Port ' + str(proxy['port']), 'User ' + quoted(proxy['user']), 'IdentityFile ' + quoted(proxy_identity), *common]
        self.config = directory / 'ssh_config'
        self.config.write_text('\n'.join(blocks) + '\n')
        for path in [known, self.config]:
            path.chmod(0o600)

    def args(self, command):
        return [executable('ssh'), '-F', str(self.config), *(['-tt'] if command == 'unlock' else []), 'boot-target', command]

    def status(self):
        try:
            result = subprocess.run(self.args('status'), capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            return False
        if b'HOST IDENTIFICATION HAS CHANGED' in result.stderr or b'Host key verification failed' in result.stderr:
            raise Failure('boot_identity_mismatch')
        return result.returncode == 0 and len(result.stdout) <= 32768 and self.target['luks_uuid'].encode() in result.stdout.lower()

    def unlock(self, secret):
        if not secret or len(secret) > 4096 or re.search(r'[\r\n\x00]', secret):
            raise Failure('vault_unavailable')
        process = subprocess.Popen(self.args('unlock'), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        chunks = queue.Queue(maxsize=64)
        def read():
            try:
                while True:
                    chunk = process.stdout.read(1)
                    chunks.put(chunk)
                    if not chunk:
                        break
            except (OSError, ValueError):
                chunks.put(b'')
        threading.Thread(target=read, daemon=True).start()
        output = b''
        sent = False
        deadline = time.monotonic() + 60
        try:
            while time.monotonic() < deadline:
                try:
                    chunk = chunks.get(timeout=1)
                except queue.Empty:
                    continue
                if not chunk:
                    if sent:
                        return
                    raise Failure('unlock_unconfirmed')
                output += chunk
                if len(output) > 32768:
                    raise Failure('unlock_unconfirmed')
                if re.search(rb'(?i)(?:passphrase|password)[^\r\n]*:', output):
                    if sent:
                        raise Failure('disk_key_rejected')
                    if self.target['luks_uuid'].encode() not in output.lower():
                        raise Failure('unlock_unconfirmed')
                    process.stdin.write(secret.encode() + b'\n')
                    process.stdin.flush()
                    sent = True
                    output = b''
            raise Failure('unlock_unconfirmed')
        except (OSError, subprocess.TimeoutExpired):
            raise Failure('unlock_unconfirmed') from None
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            process.stdin.close()
            process.stdout.close()

    def close(self):
        self.directory.cleanup()


def run(request, provider_factory=Provider, boot_factory=Boot, sleep=time.sleep, clock=time.monotonic):
    validate(request)
    target, action = dict(request['target']), request['action']
    provider = provider_factory(target)
    emit(kind='progress', stage='checking_provider')
    provider.login()
    power = provider.state()
    if action == 'inspect':
        return {'status': 'observed', 'stage': 'provider_on' if power else 'provider_off'}
    if action == 'shutdown':
        if power:
            emit(kind='progress', stage='power_off_requested')
            try:
                provider.change('shutdown')
                deadline = clock() + 90
                while clock() < deadline:
                    if provider.state() is False:
                        return {'status': 'powered_off', 'stage': 'powered_off'}
                    sleep(3)
            except Exception:
                return {'status': 'unknown', 'stage': 'unknown', 'reason': 'provider_unavailable'}
            return {'status': 'unknown', 'stage': 'unknown', 'reason': 'provider_unavailable'}
        return {'status': 'powered_off', 'stage': 'powered_off'}
    if power is False:
        emit(kind='progress', stage='power_on_requested')
        try:
            provider.change('start')
            deadline = clock() + 90
            while clock() < deadline:
                if provider.state() is True:
                    break
                sleep(3)
            else:
                return {'status': 'unknown', 'stage': 'unknown', 'reason': 'provider_unavailable'}
        except Exception:
            return {'status': 'unknown', 'stage': 'unknown', 'reason': 'provider_unavailable'}
    if not target.get('boot_host_key') or not target.get('luks_uuid'):
        return {'status': 'requires_console', 'stage': 'requires_console', 'reason': 'boot_unavailable'}
    emit(kind='progress', stage='waiting_for_boot')
    boot = boot_factory(request)
    try:
        deadline = clock() + 120
        while clock() < deadline:
            if boot.status():
                break
            sleep(3)
        else:
            return {'status': 'requires_console', 'stage': 'requires_console', 'reason': 'boot_unavailable'}
        emit(kind='progress', stage='checking_boot')
        if not boot.status():
            return {'status': 'requires_console', 'stage': 'requires_console', 'reason': 'boot_unavailable'}
        secret = field(vault_item(target['disk_credential']), 'Disk Encryption Password')
        emit(kind='progress', stage='unlocking_disk')
        boot.unlock(secret)
        secret = None
        return {'status': 'awaiting_agent', 'stage': 'awaiting_agent'}
    finally:
        boot.close()


def main():
    try:
        raw = sys.stdin.buffer.readline(32769)
        if len(raw) > 32768:
            raise Failure('invalid_target')
        request = json.loads(raw)
        if request.get('action') == 'configuration':
            emit(kind='configuration', profile=configuration(request))
            return
        result = run(request)
    except Failure as error:
        uncertain = error.reason == 'unlock_unconfirmed'
        result = {'status': 'unknown' if uncertain else 'failed', 'stage': 'unknown' if uncertain else 'failed', 'reason': error.reason}
    except Exception:
        result = {'status': 'failed', 'stage': 'failed', 'reason': 'invalid_target'}
    emit(kind='result', **result)


if __name__ == '__main__':
    main()
