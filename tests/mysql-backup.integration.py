import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid


SCRIPT = Path(__file__).resolve().parents[1] / "apps/automation/recipes/files/mysql-backup.sh"


class MysqlBackup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = "i7y-copy-db-test-" + uuid.uuid4().hex[:12]
        result = subprocess.run(
            ["docker", "run", "--detach", "--name", cls.container,
             "--network", "none", "--tmpfs", "/var/lib/mysql:rw,size=512m",
             "-e", "MYSQL_DATABASE", "-e", "MYSQL_ROOT_PASSWORD", "mysql:5.7"],
            capture_output=True, text=True,
            env={**os.environ, "MYSQL_DATABASE": "source_site", "MYSQL_ROOT_PASSWORD": uuid.uuid4().hex},
        )
        if result.returncode:
            raise RuntimeError("Disposable MySQL container could not start: " + result.stderr)
        cls.addClassCleanup(subprocess.run, ["docker", "rm", "--force", cls.container], capture_output=True)
        for _ in range(90):
            if cls.sql("SELECT 1", check=False).returncode == 0:
                return
            time.sleep(1)
        raise RuntimeError("Disposable MySQL did not become ready")

    @classmethod
    def sql(cls, statement, database="source_site", check=True):
        result = subprocess.run(
            ["docker", "exec", "-i", cls.container, "sh", "-c",
             'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --no-defaults --protocol=socket --user=root --batch --skip-column-names "$1"',
             "i7y-test", database], input=statement.encode(), capture_output=True,
        )
        if check and result.returncode:
            raise AssertionError("Disposable SQL operation failed")
        return result

    def backup(self):
        return subprocess.run(["docker", "exec", "-i", self.container, "sh", "-s"],
                              input=SCRIPT.read_bytes(), capture_output=True)

    def test_independent_restore_and_unsupported_schema_rejection(self):
        self.sql("CREATE TABLE wp_options (id INT PRIMARY KEY, value LONGBLOB) ENGINE=InnoDB;"
                 "INSERT INTO wp_options VALUES (1, UNHEX('000102ff'));"
                 "CREATE DATABASE destination_site;")
        backup = self.backup()
        self.assertEqual(backup.returncode, 0, backup.stderr.decode())
        self.assertNotIn(b"CREATE DATABASE", backup.stdout)
        self.sql(backup.stdout.decode(), database="destination_site")
        self.assertEqual(self.sql("SELECT HEX(value) FROM wp_options", "destination_site").stdout.strip(), b"000102FF")
        self.sql("UPDATE wp_options SET value='independent'", "destination_site")
        self.assertEqual(self.sql("SELECT HEX(value) FROM wp_options").stdout.strip(), b"000102FF")
        for create, drop in [
            ("CREATE TABLE legacy (id INT) ENGINE=MyISAM", "DROP TABLE legacy"),
            ("CREATE VIEW alias_options AS SELECT * FROM wp_options", "DROP VIEW alias_options"),
            ("CREATE TRIGGER prevent_copy BEFORE INSERT ON wp_options FOR EACH ROW SET NEW.id=NEW.id", "DROP TRIGGER prevent_copy"),
        ]:
            self.sql(create)
            rejected = self.backup()
            self.assertEqual(rejected.returncode, 68)
            self.assertEqual(rejected.stdout, b"")
            self.sql(drop)


if __name__ == "__main__":
    unittest.main()
