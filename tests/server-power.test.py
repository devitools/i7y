import contextlib
import copy
import importlib.util
import http.client
import io
import json
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('server_power', ROOT / 'apps/automation/desktop/server_power.py')
power = importlib.util.module_from_spec(spec)
spec.loader.exec_module(power)
UUID = '479a241c-469d-4350-a9c6-bee3978c028d'
REQUEST = {'action': 'start', 'identity_file': '/unused', 'target': {'address': '192.0.2.10', 'service_id': '123', 'vm_id': '456', 'provider_credential': {'vault': 'Fixture', 'item': 'Account'}, 'disk_credential': {'vault': 'Fixture', 'item': 'VM'}, 'boot_port': 2222, 'boot_host_key': 'ssh-ed25519 AAAA', 'luks_uuid': UUID}}


class Provider:
    def __init__(self, target):
        self.power = False
        self.changes = []
        self.fail = False

    def login(self):
        pass

    def state(self):
        return self.power

    def change(self, action):
        self.changes.append(action)
        if self.fail:
            raise power.Failure('provider_unavailable')
        self.power = action == 'start'


class Boot:
    def __init__(self, request):
        self.reads = 0
        self.secrets = []
        self.available = True
        self.closed = False

    def status(self):
        self.reads += 1
        return self.available

    def unlock(self, secret):
        self.secrets.append(secret)

    def close(self):
        self.closed = True


class PowerTests(unittest.TestCase):
    def setUp(self):
        self.provider = Provider(None)
        self.boot = Boot(None)
        self.output = io.StringIO()
        self.secret = 'fixture-disk-secret'
        self.vault = patch.object(power, 'vault_item', return_value={'fields': [{'label': 'Disk Encryption Password', 'value': self.secret}]})
        self.read_vault = self.vault.start()
        self.addCleanup(self.vault.stop)

    def run_action(self, action='start', request=None, **options):
        data = copy.deepcopy(request or REQUEST)
        data['action'] = action
        with contextlib.redirect_stdout(self.output):
            return power.run(data, lambda _: self.provider, lambda _: self.boot, **options)

    def test_start_unlocks_once_then_requires_authoritative_agent_confirmation(self):
        result = self.run_action()
        self.assertEqual(result['status'], 'awaiting_agent')
        self.assertEqual(self.provider.changes, ['start'])
        self.assertEqual(self.boot.reads, 2)
        self.assertEqual(self.boot.secrets, [self.secret])
        self.assertTrue(self.boot.closed)
        self.assertNotIn(self.secret, self.output.getvalue() + json.dumps(result))

    def test_running_vm_is_not_rebooted_or_power_cycled(self):
        self.provider.power = True
        self.run_action()
        self.assertEqual(self.provider.changes, [])

    def test_missing_boot_configuration_requests_console_without_reading_disk_secret(self):
        request = copy.deepcopy(REQUEST)
        request['target']['boot_host_key'] = ''
        result = self.run_action(request=request)
        self.assertEqual(result['status'], 'requires_console')
        self.read_vault.assert_not_called()
        self.assertEqual(self.boot.secrets, [])

    def test_unavailable_boot_never_receives_a_password(self):
        self.provider.power = True
        self.boot.available = False
        ticks = iter([0, 0, 121])
        result = self.run_action(clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertEqual(result['status'], 'requires_console')
        self.read_vault.assert_not_called()

    def test_host_identity_failure_stops_before_vault_read(self):
        self.boot.status = lambda: (_ for _ in ()).throw(power.Failure('boot_identity_mismatch'))
        with self.assertRaises(power.Failure) as error:
            self.run_action()
        self.assertEqual(error.exception.reason, 'boot_identity_mismatch')
        self.read_vault.assert_not_called()

    def test_uncertain_provider_mutation_is_never_retried(self):
        self.provider.fail = True
        result = self.run_action()
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(self.provider.changes, ['start'])
        self.read_vault.assert_not_called()

    def test_incomplete_provider_response_is_classified_as_unavailable(self):
        provider = power.Provider(REQUEST['target'])
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.side_effect = http.client.IncompleteRead(b'partial')
        with patch.object(provider.opener, 'open', return_value=response) as opened:
            with self.assertRaises(power.Failure) as error:
                provider.change('start')
        self.assertEqual(error.exception.reason, 'provider_unavailable')
        self.assertEqual(opened.call_count, 1)

    def test_unexpected_exception_after_power_dispatch_preserves_unknown_outcome(self):
        for action in ['start', 'shutdown']:
            for failure in [http.client.IncompleteRead(b'partial'), RuntimeError('fixture')]:
                with self.subTest(action=action, failure=type(failure).__name__):
                    self.provider = Provider(None)
                    self.provider.power = action == 'shutdown'
                    def change(value):
                        self.provider.changes.append(value)
                        raise failure
                    self.provider.change = change
                    result = self.run_action(action)
                    self.assertEqual(result['status'], 'unknown')
                    self.assertEqual(self.provider.changes, [action])
        self.read_vault.assert_not_called()

    def test_exception_during_mutation_verification_preserves_unknown_outcome(self):
        for action in ['start', 'shutdown']:
            with self.subTest(action=action):
                self.provider = Provider(None)
                self.provider.power = action == 'shutdown'
                def change(value):
                    self.provider.changes.append(value)
                    self.provider.state = lambda: (_ for _ in ()).throw(http.client.RemoteDisconnected())
                self.provider.change = change
                result = self.run_action(action)
                self.assertEqual(result['status'], 'unknown')
                self.assertEqual(self.provider.changes, [action])
        self.read_vault.assert_not_called()

    def test_shutdown_is_graceful_and_verified(self):
        self.provider.power = True
        self.assertEqual(self.run_action('shutdown')['status'], 'powered_off')
        self.assertEqual(self.provider.changes, ['shutdown'])
        self.assertEqual(self.boot.secrets, [])
        self.read_vault.assert_not_called()

    def test_inspection_does_not_mutate_or_unlock(self):
        self.assertEqual(self.run_action('inspect'), {'status': 'observed', 'stage': 'provider_off'})
        self.assertEqual(self.provider.changes, [])
        self.read_vault.assert_not_called()

    def test_injected_target_values_are_rejected_before_provider_access(self):
        for key, value in [('address', '192.0.2.10; touch /tmp/invalid'), ('service_id', '../other'), ('vm_id', '1/start'), ('boot_host_key', 'ssh-ed25519 AAAA\nHost *')]:
            request = copy.deepcopy(REQUEST)
            request['target'][key] = value
            with self.assertRaises((power.Failure, ValueError)):
                self.run_action(request=request)
        with self.assertRaises(power.Failure):
            power.quoted('/tmp/identity%h')

    def test_remote_password_is_sent_only_after_the_bound_disk_prompt(self):
        boot = power.Boot.__new__(power.Boot)
        boot.target = {'luks_uuid': UUID}
        prompt = 'Please enter passphrase for disk luks-' + UUID + ': '
        script = 'import sys;sys.stdout.write(' + repr(prompt) + ');sys.stdout.flush();value=sys.stdin.readline().strip();sys.exit(0 if value==' + repr(self.secret) + ' else 1)'
        boot.args = lambda _: [sys.executable, '-u', '-c', script]
        boot.unlock(self.secret)
        boot.target = {'luks_uuid': '00000000-0000-0000-0000-000000000000'}
        with self.assertRaises(power.Failure) as error:
            boot.unlock(self.secret)
        self.assertEqual(error.exception.reason, 'unlock_unconfirmed')

    def test_repeated_password_prompt_is_not_answered(self):
        boot = power.Boot.__new__(power.Boot)
        boot.target = {'luks_uuid': UUID}
        prompt = 'Please enter passphrase for luks-' + UUID + ': '
        script = 'import sys;sys.stdout.write(' + repr(prompt) + ');sys.stdout.flush();sys.stdin.readline();sys.stdout.write(' + repr(prompt) + ');sys.stdout.flush();sys.stdin.readline()'
        boot.args = lambda _: [sys.executable, '-u', '-c', script]
        with self.assertRaises(power.Failure) as error:
            boot.unlock(self.secret)
        self.assertEqual(error.exception.reason, 'disk_key_rejected')


class VaultConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.reference = {'provider': '1password', 'account': 'team.example.com', 'vault': 'Infrastructure', 'item': 'VPN server'}
        self.request = {'action': 'configuration', 'target': {'address': '192.0.2.10', 'disk_credential': self.reference}}
        self.item = {'fields': [{'label': 'SNEL service ID', 'value': '123'}, {'label': 'SNEL VM ID', 'value': '456'}, {'id': 'password', 'value': 'never-output-this'}, {'label': 'Disk Encryption Password', 'value': 'another-secret'}]}

    def read(self):
        with patch.object(power, 'vault_item', return_value=self.item) as read:
            result = power.configuration(self.request)
        self.assertEqual(read.call_args.args[0], self.reference)
        self.assertEqual(read.call_args.kwargs, {'metadata': True})
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('password', json.dumps(result))
        return result

    def test_configuration_comes_from_the_linked_account_vault_item(self):
        result = self.read()
        self.assertEqual(result, {'service_id': '123', 'vm_id': '456', 'boot_port': 2222, 'boot_host_key': '', 'luks_uuid': ''})

    def test_existing_snel_service_url_supplies_its_identifier(self):
        self.item['fields'].pop(0)
        self.item['fields'].append({'type': 'URL', 'label': 'SNEL service URL', 'value': 'https://my.snel.com/clientarea/services/cloudvps/123/'})
        self.assertEqual(self.read()['service_id'], '123')
        self.item['fields'].append({'type': 'URL', 'label': 'Other URL', 'value': 'https://my.snel.com/clientarea/services/cloudvps/789/'})
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_metadata_invalid')

    def test_missing_or_conflicting_identifiers_never_select_a_vm(self):
        self.item['fields'].append({'label': 'SNEL VM ID', 'value': '999'})
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_metadata_invalid')
        self.item['fields'] = []
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_metadata_missing')

    def test_wrong_server_and_incomplete_boot_identity_are_rejected(self):
        self.item['fields'].append({'label': 'IP address', 'value': '192.0.2.11'})
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_target_mismatch')
        self.item['fields'].pop()
        self.item['fields'].append({'label': 'LUKS disk UUID', 'value': UUID})
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_metadata_invalid')

    def test_legacy_ip_label_is_checked_against_the_target(self):
        self.item['fields'].append({'label': 'IP', 'type': 'STRING', 'value': '192.0.2.10'})
        self.assertEqual(self.read()['vm_id'], '456')
        self.item['fields'][-1]['value'] = '192.0.2.11'
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_target_mismatch')

    def test_cli_reads_the_saved_account_and_rejects_option_injection(self):
        response = unittest.mock.Mock(returncode=0, stdout=b'{"fields":[]}')
        with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.OnePassword, 'account_id', return_value='team.example.com'), patch.object(power.subprocess, 'run', return_value=response) as run:
            power.vault_item(self.reference)
            self.assertEqual(run.call_args.args[0], ['/fixture/op', 'item', 'get', 'VPN server', '--vault', 'Infrastructure', '--account', 'team.example.com', '--format', 'json'])
            with self.assertRaises(power.Failure):
                power.vault_item({**self.reference, 'account': '--help'})
            self.assertEqual(run.call_count, 1)

    def test_metadata_cli_read_excludes_concealed_and_otp_fields(self):
        response = unittest.mock.Mock(returncode=0, stdout=b'[{"label":"SNEL VM ID","type":"STRING","value":"456"}]')
        with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.OnePassword, 'account_id', return_value='team.example.com'), patch.object(power.subprocess, 'run', return_value=response) as run:
            item = power.vault_item(self.reference, metadata=True)
        self.assertIn('type=STRING,type=URL', run.call_args.args[0])
        self.assertNotIn('--reveal', run.call_args.args[0])
        self.assertEqual(item['fields'][0]['value'], '456')

    def test_provider_and_disk_accounts_are_independent_of_legacy_global_selection(self):
        request = copy.deepcopy(REQUEST)
        request['op_account'] = 'wrong-global-account'
        request['target']['provider_credential']['account'] = 'provider-account'
        request['target']['disk_credential']['account'] = 'server-account'
        provider = Provider(None)
        targets = []
        with patch.object(power, 'vault_item', return_value={'fields': [{'label': 'Disk Encryption Password', 'value': 'fixture'}]}) as read, contextlib.redirect_stdout(io.StringIO()):
            power.run(request, lambda target: targets.append(target) or provider, lambda _: Boot(None))
        self.assertEqual(targets[0]['provider_credential']['account'], 'provider-account')
        self.assertEqual(read.call_args.args[0]['account'], 'server-account')


class GenericVaultTests(unittest.TestCase):
    def test_python_matches_the_shared_reference_contract(self):
        fixture = json.loads((ROOT / 'tests/fixtures/credential-references.json').read_text())
        for case in fixture['valid']:
            with self.subTest(case=case):
                self.assertEqual(power.vaults.normalize(case['input']), case['expected'])
        for value in fixture['invalid']:
            with self.subTest(value=value), self.assertRaises(power.Failure):
                power.vaults.normalize(value)

    def test_unknown_manager_stops_before_any_cli_or_provider_access(self):
        reference = {'version': 2, 'vault': 'future-vault', 'account': 'Team', 'item': 'VM'}
        with patch.object(power.vaults, 'executable') as executable, patch.object(power.vaults.subprocess, 'run') as run:
            with self.assertRaises(power.Failure) as error:
                power.vault_item(reference)
            self.assertEqual(error.exception.reason, 'vault_unsupported')
            executable.assert_not_called()
            run.assert_not_called()
        request = copy.deepcopy(REQUEST)
        request['target']['provider_credential'] = reference
        with patch.object(power, 'Provider') as provider:
            with self.assertRaises(power.Failure):
                power.run(request, provider_factory=provider)
            provider.assert_not_called()

    def test_invalid_or_secret_references_never_reach_cli(self):
        fixture = json.loads((ROOT / 'tests/fixtures/credential-references.json').read_text())
        with patch.object(power.vaults, 'executable') as executable, patch.object(power.vaults.subprocess, 'run') as run:
            for value in fixture['invalid']:
                with self.subTest(value=value), self.assertRaises(power.Failure):
                    power.vault_item(value)
            executable.assert_not_called()
            run.assert_not_called()

    def test_manager_name_is_never_forwarded_as_the_onepassword_vault_name(self):
        reference = {'version': 2, 'vault': '1password', 'account': 'Disk Ninja', 'item': 'SNEL VPN VPS Server'}
        response = unittest.mock.Mock(returncode=0, stdout=b'{"fields":[]}')
        with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.OnePassword, 'account_id', return_value='Disk Ninja'), patch.object(power.vaults.subprocess, 'run', return_value=response) as run:
            power.vault_item(reference)
            self.assertEqual(run.call_args.args[0], ['/fixture/op', 'item', 'get', 'SNEL VPN VPS Server', '--account', 'Disk Ninja', '--format', 'json'])
            power.vault_item({**reference, 'options': {'vault': 'Real vault'}})
            self.assertIn('Real vault', run.call_args.args[0])
            self.assertNotIn('1password', run.call_args.args[0])

class OnePasswordAccountTests(unittest.TestCase):
    primary = 'A' * 26
    personal = 'B' * 26

    def setUp(self):
        self.calls = []
        self.accounts = [{'account_uuid': self.primary, 'url': 'fixture.1password.com', 'user_uuid': 'C' * 26}, {'account_uuid': self.personal, 'url': 'my.1password.com', 'user_uuid': 'D' * 26}]
        self.details = {self.primary: {'id': self.primary, 'name': 'Disk Ninja'}, self.personal: {'id': self.personal, 'name': 'Personal'}}
        self.reference = {'version': 2, 'vault': '1password', 'account': 'Disk Ninja', 'item': 'Fixture VM', 'options': {'vault': 'Infrastructure'}}

    def cli(self, args, **options):
        self.calls.append(args)
        if args[1:3] == ['account', 'list']:
            data = self.accounts
        elif args[1:3] == ['account', 'get']:
            data = self.details.get(args[args.index('--account') + 1])
            if isinstance(data, Exception):
                raise data
            if data is None:
                return unittest.mock.Mock(returncode=1, stdout=b'', stderr=b'Account unavailable')
        else:
            self.assertEqual(args[1:3], ['item', 'get'])
            data = [{'label': 'SNEL VM ID', 'type': 'STRING', 'value': '456'}]
        return unittest.mock.Mock(returncode=0, stdout=json.dumps(data).encode(), stderr=b'')

    def read(self, reference=None):
        with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.subprocess, 'run', side_effect=self.cli):
            return power.vault_item(reference or self.reference, metadata=True)

    def test_verified_friendly_name_resolves_to_uuid_before_item_read(self):
        self.read()
        self.assertEqual([args[1:3] for args in self.calls], [['account', 'list'], ['account', 'get'], ['account', 'get'], ['item', 'get']])
        item = self.calls[-1]
        self.assertEqual(item[item.index('--account') + 1], self.primary)
        self.assertEqual(item[item.index('--vault') + 1], 'Infrastructure')
        self.assertNotIn('Disk Ninja', item)
        self.assertIn('type=STRING,type=URL', item)
        self.assertEqual(self.reference['account'], 'Disk Ninja')

    def test_explicit_sign_in_address_and_id_go_directly_to_the_cli(self):
        for selector in ['fixture.1password.com', 'https://fixture.1password.com/', 'team.1password.ca', 'team.1password.eu', self.primary, 'C' * 26]:
            self.calls = []
            self.read({**self.reference, 'account': selector})
            self.assertEqual([args[1:3] for args in self.calls], [['item', 'get']])
            self.assertEqual(self.calls[-1][self.calls[-1].index('--account') + 1], selector)

    def test_explicit_address_does_not_depend_on_account_enumeration(self):
        self.accounts = []
        self.read({**self.reference, 'account': 'fixture.1password.com'})
        self.assertEqual([call[1:3] for call in self.calls], [['item', 'get']])
        self.assertIn('type=STRING,type=URL', self.calls[0])

    def test_malformed_addresses_are_rejected_before_any_cli_access(self):
        for selector in ['http://fixture.1password.com', 'https://user@fixture.1password.com', 'fixture.1password.com:443', 'fixture.1password.com/item', 'fixture.1password.com?x=1', 'fixture.1password.com#x', 'https://other.example.com']:
            self.calls = []
            with self.subTest(selector=selector), self.assertRaises(power.Failure) as error:
                self.read({**self.reference, 'account': selector})
            self.assertEqual(error.exception.reason, 'invalid_target')
            self.assertEqual(self.calls, [])

    def test_explicit_account_never_falls_back_to_another_account(self):
        reference = {**self.reference, 'account': 'fixture.1password.com'}
        response = unittest.mock.Mock(returncode=1, stdout=b'', stderr=b'No accounts configured')
        with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.subprocess, 'run', return_value=response) as run:
            with self.assertRaises(power.Failure):
                power.vault_item(reference, metadata=True)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][1:3], ['item', 'get'])
        self.assertEqual(run.call_args.args[0][run.call_args.args[0].index('--account') + 1], reference['account'])

    def test_ambiguous_missing_and_unverified_names_never_read_items(self):
        for mode in ['ambiguous', 'missing', 'unverified', 'wrong-id']:
            with self.subTest(mode=mode):
                self.calls = []
                self.details[self.personal] = {'id': self.personal, 'name': 'Personal'}
                reference = self.reference
                if mode == 'ambiguous':
                    self.details[self.personal]['name'] = 'Disk Ninja'
                elif mode == 'missing':
                    reference = {**reference, 'account': 'Missing team'}
                elif mode == 'unverified':
                    self.details[self.personal] = subprocess.TimeoutExpired('fixture', 15)
                else:
                    self.details[self.personal]['id'] = self.primary
                with self.assertRaises(power.Failure) as error:
                    self.read(reference)
                self.assertEqual(error.exception.reason, {'ambiguous': 'vault_account_ambiguous', 'missing': 'vault_accounts_unavailable', 'unverified': 'vault_timeout', 'wrong-id': 'vault_response_invalid'}[mode])
                self.assertFalse(any(args[1:3] == ['item', 'get'] for args in self.calls))

    def test_verified_cli_shorthand_is_supported_without_guessing_the_host(self):
        self.details['fixture-shortname'] = {'id': self.primary, 'name': 'Disk Ninja'}
        self.read({**self.reference, 'account': 'fixture-shortname'})
        self.assertEqual(self.calls[-1][self.calls[-1].index('--account') + 1], self.primary)
        self.calls = []
        with self.assertRaises(power.Failure):
            self.read({**self.reference, 'account': 'DiskNinja'})
        self.assertFalse(any(args[1:3] == ['item', 'get'] for args in self.calls))

    def test_duplicate_account_identifiers_never_select_a_default_user(self):
        self.accounts.append({**self.accounts[0], 'user_uuid': 'E' * 26})
        for selector in ['Disk Ninja', 'fixture-shortname']:
            with self.subTest(selector=selector):
                self.calls = []
                with self.assertRaises(power.Failure) as error:
                    self.read({**self.reference, 'account': selector})
                self.assertEqual(error.exception.reason, 'vault_account_ambiguous')
                self.assertFalse(any(args[1:3] == ['item', 'get'] for args in self.calls))

    def test_unavailable_app_never_attempts_an_item_read(self):
        self.accounts = []
        with self.assertRaises(power.Failure) as error:
            self.read()
        self.assertEqual(error.exception.reason, 'vault_app_unavailable')
        self.assertEqual([call[1:3] for call in self.calls], [['account', 'list']])

    def test_import_errors_identify_the_failed_step_without_exposing_cli_output(self):
        for phase, expected in [('accounts', 'vault_accounts_unavailable'), ('item', 'vault_item_unavailable')]:
            for detail, reason in [(b'fixture-secret', expected), (b'Authorization denied fixture-secret', 'vault_access_denied'), (b'No accounts configured for use with 1Password CLI fixture-secret', 'vault_app_unavailable'), (b'operation not permitted fixture-secret', 'vault_app_unavailable')]:
                with self.subTest(phase=phase, detail=detail):
                    def failed(args, **options):
                        if args[1:3] == ['account', 'list'] and phase == 'item':
                            return unittest.mock.Mock(returncode=0, stdout=json.dumps(self.accounts).encode())
                        return unittest.mock.Mock(returncode=1, stdout=b'fixture-secret', stderr=detail)
                    reference = {**self.reference, 'account': 'Disk Ninja' if phase == 'accounts' else 'fixture.1password.com'}
                    with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.subprocess, 'run', side_effect=failed):
                        with self.assertRaises(power.Failure) as error:
                            power.vault_item(reference, metadata=True)
                    self.assertEqual(error.exception.reason, reason)
                    self.assertNotIn('fixture-secret', str(error.exception))

    def test_power_operations_preserve_the_existing_failure_contract(self):
        response = unittest.mock.Mock(returncode=1, stdout=b'', stderr=b'Authorization denied')
        with patch.object(power.vaults, 'executable', return_value='/fixture/op'), patch.object(power.vaults.subprocess, 'run', return_value=response):
            with self.assertRaises(power.Failure) as error:
                power.vault_item(self.reference)
        self.assertEqual(error.exception.reason, 'vault_unavailable')

    def test_legacy_default_account_does_not_trigger_a_metadata_lookup(self):
        self.read({**self.reference, 'account': ''})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1:3], ['item', 'get'])
        self.assertNotIn('--account', self.calls[0])

if __name__ == '__main__':
    unittest.main()
