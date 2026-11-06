import os
from pathlib import Path
import subprocess
import time
import tempfile
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

    def test_memory_dump_timeout_releases_database_lock(self):
        self.sql("CREATE TABLE timeout_fixture (id INT PRIMARY KEY) ENGINE=MEMORY; INSERT INTO timeout_fixture VALUES (1)")
        self.addCleanup(self.sql, "DROP TABLE IF EXISTS timeout_fixture")
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / 'mysqldump'
            fake.write_text("#!/bin/sh\nfor arg in \"$@\"; do case \"$arg\" in --user=*) user=${arg#--user=} ;; esac; done\nexec mysql --no-defaults --protocol=socket --user=\"$user\" --execute=\"FLUSH TABLES WITH READ LOCK; SELECT SLEEP(90)\"\n")
            fake.chmod(0o755)
            subprocess.run(['docker', 'exec', self.container, 'mkdir', '-p', '/tmp/i7y-test-bin'], check=True, capture_output=True)
            subprocess.run(['docker', 'cp', str(fake), self.container + ':/tmp/i7y-test-bin/mysqldump'], check=True, capture_output=True)
            start = time.monotonic()
            result = subprocess.run(['docker', 'exec', '-i', self.container, 'sh', '-c', 'PATH=/tmp/i7y-test-bin:$PATH sh -s'], input=SCRIPT.read_bytes(), capture_output=True, timeout=50)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'I7Y_BACKUP_CLEAN', result.stderr.splitlines())
            self.assertLess(time.monotonic() - start, 45)
            self.assertEqual(self.sql("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE USER LIKE 'i7y\\_%'").stdout.strip(), b'0')
            self.assertEqual(self.sql("SELECT COUNT(*) FROM mysql.user WHERE User LIKE 'i7y\\_%'").stdout.strip(), b'0')
            self.sql('UPDATE timeout_fixture SET id=2 WHERE id=1')

    def test_independent_restore_and_unsupported_schema_rejection(self):
        self.sql("CREATE TABLE wp_options (id INT PRIMARY KEY, value LONGBLOB) ENGINE=InnoDB;"
                 "INSERT INTO wp_options VALUES (1, UNHEX('000102ff'));"
                 "CREATE TABLE transient_cache (id INT PRIMARY KEY) ENGINE=MEMORY;"
                 "INSERT INTO transient_cache VALUES (7);"
                 "CREATE DATABASE destination_site;")
        backup = self.backup()
        self.assertEqual(backup.returncode, 0, backup.stderr.decode())
        self.assertNotIn(b"CREATE DATABASE", backup.stdout)
        self.sql(backup.stdout.decode(), database="destination_site")
        self.assertEqual(self.sql("SELECT HEX(value) FROM wp_options", "destination_site").stdout.strip(), b"000102FF")
        self.assertEqual(self.sql("SELECT id FROM transient_cache", "destination_site").stdout.strip(), b"7")
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
