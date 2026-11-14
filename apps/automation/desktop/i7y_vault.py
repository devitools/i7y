import json
import pathlib
import re
import shutil
import subprocess
import time


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

    def failure(self, reason, metadata=False, stderr=b''):
        if not metadata:
            return Failure('vault_unavailable')
        detail = stderr[:8192].decode(errors='replace').casefold() if isinstance(stderr, bytes) else ''
        if any(value in detail for value in ['authorization denied', 'not authorized', 'authentication canceled', 'authentication cancelled']):
            reason = 'vault_access_denied'
        elif any(value in detail for value in ['no accounts configured', 'lostconnectiontoapp', 'connectionreset', "couldn't connect to the 1password desktop app", 'could not connect to the 1password desktop app', 'operation not permitted', 'permission denied']):
            reason = 'vault_app_unavailable'
        elif any(value in detail for value in ['more than one item', 'multiple items match']):
            reason = 'vault_item_ambiguous'
        return Failure(reason)

    def account_id(self, metadata=False):
        selector = self.reference.get('account', '')
        if not selector:
            return ''
        if re.fullmatch(r'[A-Za-z0-9]{26}', selector) or re.fullmatch(r'(?:https://)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+1password\.(?:com|ca|eu)/?', selector, re.I):
            return selector
        if '://' in selector or re.search(r'1password\.(?:com|ca|eu)(?:[:/?#]|$)', selector, re.I):
            raise Failure('invalid_target')
        cli = executable('op')
        deadline = time.monotonic() + 45

        def query(arguments):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise self.failure('vault_timeout', metadata)
            try:
                result = subprocess.run([cli, 'account', *arguments, '--format', 'json'], capture_output=True, timeout=min(15, remaining), check=False)
                if result.returncode:
                    raise self.failure('vault_accounts_unavailable', metadata, result.stderr)
                if len(result.stdout) > 1048576:
                    raise self.failure('vault_response_invalid', metadata)
                return json.loads(result.stdout)
            except subprocess.TimeoutExpired:
                raise self.failure('vault_timeout', metadata) from None
            except (OSError, UnicodeError, ValueError):
                raise self.failure('vault_accounts_unavailable', metadata) from None

        accounts = query(['list'])
        if not isinstance(accounts, list) or len(accounts) > 32:
            raise self.failure('vault_response_invalid', metadata)
        if not accounts:
            raise self.failure('vault_app_unavailable', metadata)
        known, direct = {}, set()
        wanted = selector.casefold().rstrip('/')
        for account in accounts:
            if not isinstance(account, dict):
                raise self.failure('vault_response_invalid', metadata)
            identifier = account.get('account_uuid')
            if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9]{26}', identifier):
                raise self.failure('vault_response_invalid', metadata)
            if identifier in known:
                raise self.failure('vault_account_ambiguous', metadata)
            known[identifier] = account
            selectors = [identifier, account.get('user_uuid'), account.get('shorthand')]
            url = account.get('url')
            if isinstance(url, str) and url:
                selectors += [url, 'https://' + url if '://' not in url else url]
            if any(isinstance(value, str) and value.casefold().rstrip('/') == wanted for value in selectors):
                direct.add(identifier)
        if direct:
            if len(direct) != 1:
                raise self.failure('vault_account_ambiguous', metadata)
            return next(iter(direct))
        matching = set()
        for identifier in known:
            details = query(['get', '--account', identifier])
            if not isinstance(details, dict) or details.get('id') != identifier or not isinstance(details.get('name'), str):
                raise self.failure('vault_response_invalid', metadata)
            if details['name'].strip().casefold() == selector.casefold():
                matching.add(identifier)
        if len(matching) == 1:
            return next(iter(matching))
        if matching:
            raise self.failure('vault_account_ambiguous', metadata)
        details = query(['get', '--account', selector])
        if not isinstance(details, dict) or details.get('id') not in known:
            raise self.failure('vault_accounts_unavailable', metadata)
        return details['id']

    def item(self, otp=False, metadata=False):
        reference = self.reference
        args = [executable('op'), 'item', 'get', reference['item']]
        if reference.get('options', {}).get('vault'):
            args += ['--vault', reference['options']['vault']]
        account = self.account_id(metadata=metadata)
        if account:
            args += ['--account', account]
        if metadata:
            args += ['--fields', 'type=STRING,type=URL']
        args += ['--otp'] if otp else ['--format', 'json']
        try:
            result = subprocess.run(args, capture_output=True, timeout=120, check=False)
            if result.returncode:
                raise self.failure('vault_item_unavailable', metadata, result.stderr)
            if len(result.stdout) > 1048576:
                raise self.failure('vault_response_invalid', metadata)
            value = result.stdout.decode().strip() if otp else json.loads(result.stdout)
            if metadata:
                if isinstance(value, list):
                    return {'fields': value}
                if isinstance(value, dict) and 'fields' not in value and ('id' in value or 'label' in value):
                    return {'fields': [value]}
            return value
        except subprocess.TimeoutExpired:
            raise self.failure('vault_timeout', metadata) from None
        except (OSError, UnicodeError, ValueError):
            raise self.failure('vault_item_unavailable', metadata) from None


def adapter(reference):
    reference = normalize(reference)
    if reference is None:
        raise Failure('invalid_target')
    adapters = {'1password': OnePassword}
    selected = adapters.get(reference['vault'])
    if selected is None:
        raise Failure('vault_unsupported')
    return selected(reference)
