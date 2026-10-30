import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "apps/automation/recipes/files/mysql-backup.sh"
CLIENT = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
with Path(os.environ["TEST_CALLS"]).open("a") as output:
    output.write(json.dumps({"tool": Path(sys.argv[0]).name, "args": sys.argv[1:], "password": os.environ.get("MYSQL_PWD"), "root_present": "MYSQL_ROOT_PASSWORD" in os.environ}) + "\\n")
if Path(sys.argv[0]).name == "mysqldump":
    if os.environ.get("TEST_DUMP_FAIL"):
        print("private database error", file=sys.stderr)
        sys.exit(1)
    print("SQL_BACKUP")
elif os.environ.get("TEST_QUERY_FAIL"):
    print("private database error", file=sys.stderr)
    sys.exit(1)
elif "--execute=SELECT @@version" in sys.argv:
    print(os.environ.get("TEST_VERSION", "5.7.44"))
else:
    print(os.environ.get("TEST_SHAPE", "12:0:0:0:0"))
'''


class Backup(unittest.TestCase):
    def run_backup(self, **settings):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["mysql", "mysqldump"]:
                (root / name).write_text(CLIENT)
                (root / name).chmod(0o700)
            calls = root / "calls"
            result = subprocess.run(
                ["sh", str(SCRIPT)], capture_output=True, text=True,
                env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"],
                     "TEST_CALLS": str(calls), "MYSQL_DATABASE": "wordpress",
                     "MYSQL_ROOT_PASSWORD": "secret-for-test", **settings},
            )
            return result, [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def test_transactional_dump_uses_credentials_without_arguments(self):
        result, calls = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "SQL_BACKUP\n")
        dump = calls[-1]
        self.assertEqual(dump["tool"], "mysqldump")
        self.assertIn("--single-transaction", dump["args"])
        self.assertNotIn("--databases", dump["args"])
        self.assertEqual(dump["args"][-2:], ["--", "wordpress"])
        for call in calls:
            self.assertNotIn("secret-for-test", " ".join(call["args"]))
            self.assertEqual(call["password"], "secret-for-test")
            self.assertFalse(call["root_present"])

    def test_unsupported_schemas_never_start_dump(self):
        for shape in ["0:0:0:0:0", "12:1:0:0:0", "12:0:1:0:0", "12:0:0:1:0", "12:0:0:0:1", "unexpected:0:0:0:0"]:
            with self.subTest(shape=shape):
                result, calls = self.run_backup(TEST_SHAPE=shape)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertFalse(any(call["tool"] == "mysqldump" for call in calls))

    def test_invalid_database_version_and_client_failures(self):
        for settings in [{"MYSQL_DATABASE": "invalid';name"}, {"TEST_VERSION": "8.0.40"}, {"TEST_VERSION": "5.5.5-MariaDB"}, {"TEST_QUERY_FAIL": "1"}, {"TEST_DUMP_FAIL": "1"}]:
            with self.subTest(settings=settings):
                result, _ = self.run_backup(**settings)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("private database error", result.stderr)
                self.assertNotIn("secret-for-test", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
