import contextlib
import copy
import importlib.util
import io
import json
import pathlib
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
        self.vault = patch.object(power, 'op_item', return_value={'fields': [{'label': 'Disk Encryption Password', 'value': self.secret}]})
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


if __name__ == '__main__':
    unittest.main()
