import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('project_copy', ROOT / 'apps/automation/ansible/files/project_copy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DockerIsolation(unittest.TestCase):
    def docker(self, *args, check=True):
        return subprocess.run(['docker', *args], capture_output=True, text=True, check=check, timeout=30)

    def test_generated_compose_stays_on_the_isolated_network(self):
        suffix = uuid.uuid4().hex[:12]
        name = 'i7y-review-test-' + suffix
        compose = {'services': {'db': {'image': 'alpine:3.21', 'command': ['sh', '-c', 'while true; do echo database | nc -l -p 13306; done'], 'ports': ['13306:13306']},
                                'web': {'image': 'alpine:3.21', 'command': ['sleep', '120'], 'ports': ['8080:80']}},
                   'networks': {'proxy': {'external': True}}}
        stage = module.isolated_compose(compose, 'db', 'web', name, module.available_subnet())
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'compose.json'
            config.write_text(json.dumps(stage))
            base = ['compose', '-p', name, '-f', str(config)]
            try:
                self.docker(*base, 'up', '-d')
                web_id = self.docker(*base, 'ps', '-q', 'web').stdout.strip()
                web = json.loads(self.docker('inspect', web_id).stdout)[0]
                self.assertFalse(web['HostConfig']['PortBindings'])
                self.assertEqual(set(web['NetworkSettings']['Networks']), {name})
                db_id = self.docker(*base, 'ps', '-q', 'db').stdout.strip()
                database = json.loads(self.docker('inspect', db_id).stdout)[0]
                network = json.loads(self.docker('network', 'inspect', name).stdout)[0]
                module.require_isolated_network(network, [web, database], name)
                self.assertEqual(self.docker('exec', web_id, 'nc', '-w', '3', 'db', '13306').stdout.strip(), 'database')
                self.assertNotEqual(self.docker('exec', web_id, 'nslookup', 'example.com', check=False).returncode, 0)
            finally:
                self.docker(*base, 'down', '--remove-orphans', check=False)

    def test_isolated_bridge_allows_database_without_host_or_external_access(self):
        suffix = uuid.uuid4().hex[:12]
        network = 'i7y-isolation-test-' + suffix
        database = 'i7y-isolation-db-' + suffix
        probe = 'i7y-isolation-probe-' + suffix
        listener = 'i7y-isolation-host-' + suffix
        port = str(20000 + int(suffix, 16) % 20000)
        self.addCleanup(self.docker, 'network', 'rm', network, check=False)
        for container in [database, probe, listener]:
            self.addCleanup(self.docker, 'rm', '-f', container, check=False)
        self.docker('network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network)
        info = json.loads(self.docker('network', 'inspect', network).stdout)[0]
        self.assertTrue(info['Internal'])
        self.assertEqual(info['Options'].get('com.docker.network.bridge.gateway_mode_ipv4'), 'isolated')
        self.assertFalse(any(config.get('Gateway') for config in info['IPAM']['Config']))
        self.docker('run', '-d', '--name', listener, '--network', 'host', 'alpine:3.21', 'sh', '-c', 'while true; do echo host | nc -l -p ' + port + '; done')
        control = self.docker('run', '--rm', '--network', 'bridge', '--add-host', 'host-probe:host-gateway', 'alpine:3.21', 'nc', '-w', '3', 'host-probe', port)
        self.assertEqual(control.stdout.strip(), 'host')
        self.docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'database', 'alpine:3.21', 'sh', '-c', 'while true; do echo database | nc -l -p 13306; done')
        self.docker('run', '-d', '--name', probe, '--network', network, '--add-host', 'host-probe:host-gateway', 'alpine:3.21', 'sleep', '120')
        database_result = self.docker('exec', probe, 'sh', '-c', 'nc -w 3 database 13306')
        self.assertEqual(database_result.stdout.strip(), 'database')
        for host in ['host-probe', '1.1.1.1']:
            result = self.docker('exec', probe, 'sh', '-c', 'nc -w 3 "$1" "$2"', 'probe', host, port, check=False)
            self.assertNotEqual(result.returncode, 0, host)
        dns = self.docker('exec', probe, 'nslookup', 'example.com', check=False)
        self.assertNotEqual(dns.returncode, 0)
        for container in [database, probe]:
            info = json.loads(self.docker('inspect', container).stdout)[0]
            self.assertFalse(info['HostConfig']['PortBindings'])
            self.assertEqual(set(info['NetworkSettings']['Networks']), {network})


if __name__ == '__main__':
    unittest.main()
