import argparse
import contextlib
import importlib.util
import io
import json
import pathlib
import struct
import base64
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('prepare_boot_unlock', pathlib.Path(__file__).parents[1] / 'deploy/prepare-boot-unlock.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        key_type = b'ssh-ed25519'
        wire = struct.pack('>I', len(key_type)) + key_type + struct.pack('>I', 32) + bytes(range(32))
        self.key = pathlib.Path(self.directory.name) / 'client.pub'
        self.key.write_text('ssh-ed25519 ' + base64.b64encode(wire).decode() + ' operator\n')
        self.args = argparse.Namespace(address='192.0.2.10', interface='eth0',
                                       luks_uuid='00000000-0000-4000-8000-000000000001',
                                       authorized_key=str(self.key), allow_from=['198.51.100.2/32'],
                                       port=2222, expected_kernel=None, prepare=False)

    def test_rejects_shell_and_config_injection_before_access(self):
        for field, value in (('interface', 'eth0\nip=evil'), ('address', '192.0.2.10\nPort 22'),
                             ('luks_uuid', '../../boot'), ('allow_from', ['0.0.0.0/0']),
                             ('port', 22)):
            with self.subTest(field=field), patch.object(self.args, field, value):
                with self.assertRaises(ValueError):
                    prepare.validate(self.args)
        self.key.write_text('command="sh" ' + self.key.read_text())
        with self.assertRaises(ValueError):
            prepare.validate(self.args)

    def test_inspection_cannot_start_preparation(self):
        argv = ['prepare', '--address', self.args.address, '--interface', 'eth0',
                '--luks-uuid', self.args.luks_uuid, '--authorized-key', str(self.key),
                '--allow-from', '198.51.100.2']
        with patch('sys.argv', argv), patch.object(prepare, 'preflight', return_value={}), \
                patch.object(prepare, 'prepare') as build, contextlib.redirect_stdout(io.StringIO()) as output:
            prepare.main()
        build.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())['prepared'])

    def test_failed_build_and_changed_boot_never_report_validated(self):
        stage = pathlib.Path(self.directory.name) / 'stage'
        stage.mkdir()
        args = self.args
        with patch.object(prepare, 'snapshot', side_effect=[{'image': 'before'}, {'image': 'changed'}]), \
                patch.object(prepare.tempfile, 'mkdtemp', return_value=str(stage)), \
                patch.object(prepare.shutil, 'copytree', side_effect=OSError('fixture failure')), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'Protected files'):
                prepare.prepare(args, prepare.validate(args), {})
        report = json.loads((stage / 'report.json').read_text())
        self.assertFalse(report['validated'])
        self.assertFalse(report['original_files_unchanged'])
        self.assertFalse(report['activated'])

    def test_refuses_to_overwrite_any_existing_file(self):
        target = pathlib.Path(self.directory.name) / 'original'
        target.write_text('preserve')
        with self.assertRaises(OSError):
            prepare.write(str(target), 'replacement')
        self.assertEqual(target.read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
