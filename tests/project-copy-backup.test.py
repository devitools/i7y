import http.server
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('project_copy', ROOT / 'apps/automation/ansible/files/project_copy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupExec(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        (self.state / 'tools').mkdir()
        (self.state / 'tools/mysql-backup.sh').write_text('echo fixture')
        self.request = {'attempt_id': 'a' * 32}
        (self.state / 'attempt.active').write_text(json.dumps(self.request))
        self.database = 'b' * 64
        self.exec_id = 'c' * 64
        self.plan = {'source': {'database_id': self.database}}
        self.running = False
        self.exit_code = 0
        self.frames = self.frame(1, b'SQL fixture\n')
        self.calls = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fixture.calls.append((self.path, payload))
                if self.path == '/v1.48/containers/' + fixture.database + '/exec':
                    self.respond(json.dumps({'Id': fixture.exec_id}).encode(), 201)
                elif self.path == '/v1.48/exec/' + fixture.exec_id + '/start':
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.docker.raw-stream')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    self.wfile.write(fixture.frames)
                    self.close_connection = True
                else:
                    self.respond(b'{}', 404)

            def do_GET(self):
                fixture.calls.append((self.path, None))
                if self.path == '/v1.48/exec/' + fixture.exec_id + '/json':
                    self.respond(json.dumps({'ID': fixture.exec_id, 'ContainerID': fixture.database,
                                             'Running': fixture.running, 'ExitCode': fixture.exit_code}).encode())
                else:
                    self.respond(b'{}', 404)

            def respond(self, data, status=200):
                self.send_response(status)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        self.socket_path = self.state / 'docker.sock'
        self.server = socketserver.UnixStreamServer(str(self.socket_path), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.stop_server)
        self.env = patch.dict(os.environ, {'DOCKER_HOST': 'unix://' + str(self.socket_path)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.plan_patch = patch.object(module, 'load_plan', return_value=(self.state, self.plan))
        self.plan_patch.start()
        self.addCleanup(self.plan_patch.stop)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(5)

    def frame(self, channel, payload):
        return bytes([channel, 0, 0, 0]) + len(payload).to_bytes(4, 'big') + payload

    def test_backup_stream_is_separated_and_receipt_tracks_the_exact_exec(self):
        self.frames += self.frame(2, b'private diagnostic\n')
        self.assertEqual(module.backup(self.request), {'rc': 0})
        self.assertEqual((self.state / 'database.sql').read_bytes(), b'SQL fixture\n')
        self.assertEqual((self.state / 'backup.stderr').read_bytes(), b'private diagnostic\n')
        self.assertEqual((self.state / 'database.sha256').read_text(), module.hashlib.sha256(b'SQL fixture\n').hexdigest())
        receipt = json.loads((self.state / 'backup-exec.json').read_text())
        self.assertEqual(receipt, dict(self.request, exec_id=self.exec_id, database_id=self.database))
        self.assertFalse((self.state / 'backup.pending').exists())
        self.assertTrue((self.state / 'attempt.active').exists())
        self.assertEqual(self.calls[0][1]['Cmd'], ['/bin/sh', '-c', 'echo fixture'])

    def test_confirmed_timeout_releases_only_the_stopped_backup_exec(self):
        self.exit_code = 137
        self.frames = self.frame(2, b'I7Y_BACKUP_CLEAN\n')
        self.assertEqual(module.backup(self.request), {'rc': 137})
        self.assertTrue(module.release_backup_attempt(self.request)['released'])
        self.assertFalse((self.state / 'attempt.active').exists())
        self.assertTrue(all('/containers/' not in path or payload is not None for path, payload in self.calls))

    def test_uncertain_cleanup_and_running_exec_preserve_the_reservation(self):
        self.exit_code = 137
        self.frames = self.frame(2, b'cleanup unconfirmed\n')
        self.assertEqual(module.backup(self.request), {'rc': 137})
        with self.assertRaisesRegex(module.CopyError, 'requires reconciliation'):
            module.release_backup_attempt(self.request)
        self.assertTrue((self.state / 'attempt.active').exists())
        (self.state / 'backup.pending').unlink()
        (self.state / 'backup.stderr').write_text('I7Y_BACKUP_CLEAN\n')
        self.running = True
        with self.assertRaisesRegex(module.CopyError, 'backup exec is still running'):
            module.release_backup_attempt(self.request)
        self.assertTrue((self.state / 'attempt.active').exists())

    def test_truncated_stream_keeps_pending_backup_for_reconciliation(self):
        self.frames = self.frame(1, b'partial SQL')[:-3]
        with self.assertRaisesRegex(module.CopyError, 'Incomplete backup exec stream'):
            module.backup(self.request)
        self.assertTrue((self.state / 'backup.pending').exists())
        self.assertTrue((self.state / 'attempt.active').exists())
        self.assertFalse((self.state / 'database.sql').exists())


if __name__ == '__main__':
    unittest.main()
