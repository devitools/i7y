import json
import pathlib
import re
import shutil
import subprocess


class Failure(Exception):
    def __init__(self, reason):
        self.reason = reason


def executable(name):
    for location in ['/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, shutil.which(name)]:
        if location and pathlib.Path(location).is_file():
            return location
    raise Failure('runtime_unavailable')


def text(value, required=False):
    if not isinstance(value, str) or value != value.strip() or len(value) > 240 or value.startswith('-') or re.search(r'[\x00-\x1f]', value) or required and not value:
        raise Failure('invalid_target')
    return value


def normalize(value):
    if value is None or value == '':
        return None
    if not isinstance(value, dict):
        raise Failure('invalid_target')
    canonical = 'version' in value
    allowed = ['version', 'vault', 'account', 'item', 'options'] if canonical else ['provider', 'account', 'vault', 'item']
    if any(key not in allowed for key in value) or canonical and (type(value['version']) is not int or value['version'] != 2):
        raise Failure('invalid_target')
    manager = value.get('vault') if canonical else value.get('provider', '1password')
    if not isinstance(manager, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,39}', manager):
        raise Failure('invalid_target')
    reference = {'version': 2, 'vault': manager, 'account': text(value.get('account', '')), 'item': text(value.get('item'), True)}
    options = value.get('options', {}) if canonical else {'vault': text(value.get('vault'), True)}
    if not isinstance(options, dict) or len(options) > 8 or any(not isinstance(key, str) for key in options):
        raise Failure('invalid_target')
    normalized = {}
    for key in sorted(options):
        if not isinstance(key, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', key) or re.search(r'password|token|secret|credential|authorization|private|passphrase|otp|api_key', key, re.I):
            raise Failure('invalid_target')
        part = text(options[key])
        if part:
            normalized[key] = part
    if reference['vault'] == '1password' and any(key != 'vault' for key in normalized):
        raise Failure('invalid_target')
    if normalized:
        reference['options'] = normalized
    return reference


class OnePassword:
    def __init__(self, reference):
        if any(key != 'vault' for key in reference.get('options', {})):
            raise Failure('invalid_target')
        self.reference = reference

    def item(self, otp=False, metadata=False):
        reference = self.reference
        args = [executable('op'), 'item', 'get', reference['item']]
        if reference.get('options', {}).get('vault'):
            args += ['--vault', reference['options']['vault']]
        if reference.get('account'):
            args += ['--account', reference['account']]
        if metadata:
            args += ['--fields', 'type=STRING,type=URL']
        args += ['--otp'] if otp else ['--format', 'json']
        try:
            result = subprocess.run(args, capture_output=True, timeout=120, check=False)
            if result.returncode or len(result.stdout) > 1048576:
                raise Failure('vault_unavailable')
            value = result.stdout.decode().strip() if otp else json.loads(result.stdout)
            if metadata:
                if isinstance(value, list):
                    return {'fields': value}
                if isinstance(value, dict) and 'fields' not in value and ('id' in value or 'label' in value):
                    return {'fields': [value]}
            return value
        except (OSError, subprocess.TimeoutExpired, UnicodeError, ValueError):
            raise Failure('vault_unavailable') from None


def adapter(reference):
    reference = normalize(reference)
    if reference is None:
        raise Failure('invalid_target')
    adapters = {'1password': OnePassword}
    selected = adapters.get(reference['vault'])
    if selected is None:
        raise Failure('vault_unsupported')
    return selected(reference)
