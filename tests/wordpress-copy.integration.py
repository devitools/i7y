import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[1]
FILES = ROOT / "apps/automation/recipes/files"


class WordpressCopy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assets = ROOT / ".local/artifacts/wordpress"
        phar = assets / "wp-cli-2.12.0.phar"
        archive = assets / "wordpress-6.8.3.tar.gz"
        expected = json.loads((ROOT / "apps/automation/runtime-assets.json").read_text())["wp_cli"]["sha256"]
        if hashlib.sha256(phar.read_bytes()).hexdigest() != expected:
            raise RuntimeError("The WP-CLI fixture checksum does not match")
        if hashlib.sha256(archive.read_bytes()).hexdigest() != "92da34c9960e64d1258652c1ef73c517f7e46ac6dfd2dfc75436d3855af46b0c":
            raise RuntimeError("The WordPress fixture checksum does not match")
        cls.temporary = tempfile.TemporaryDirectory(prefix="i7y-wordpress-", dir=assets)
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.tools = cls.root / "tools"
        cls.tools.mkdir()
        shutil.copy(phar, cls.tools / "wp-cli.phar")
        for file in FILES.glob("wordpress-*"):
            shutil.copy(file, cls.tools / file.name)
        cls.state = cls.root / "state"
        cls.state.mkdir(mode=0o700)
        with tarfile.open(archive) as source:
            source.extractall(cls.root, filter="data")
        cls.site = cls.root / "wordpress"
        cls.network = "i7y-wp-test-" + uuid.uuid4().hex[:12]
        cls.docker(["network", "create", "--internal", cls.network])
        cls.addClassCleanup(cls.docker, ["network", "rm", cls.network], check=False)
        cls.database = cls.docker(["run", "--detach", "--network", cls.network, "--network-alias", "db",
                                   "--tmpfs", "/var/lib/mysql:rw,size=512m", "-e", "MYSQL_DATABASE=source_site",
                                   "-e", "MYSQL_USER=sourceuser", "-e", "MYSQL_PASSWORD=source-fixture-password",
                                   "-e", "MYSQL_ROOT_PASSWORD=disposable-fixture-root-password", "mysql:5.7"]).stdout.decode().strip()
        cls.addClassCleanup(cls.docker, ["rm", "--force", cls.database], check=False)
        for _ in range(90):
            if cls.sql("SELECT 1", check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Disposable MySQL did not become ready")
        (cls.site / "wp-config.php").write_text('''<?php
define('DB_NAME', 'source_site');
define('DB_USER', 'sourceuser');
define('DB_PASSWORD', 'source-fixture-password');
define('DB_HOST', 'db');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
$table_prefix = 'wp_';
if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }
require_once ABSPATH . 'wp-settings.php';
''')

    @classmethod
    def docker(cls, args, data=None, check=True):
        result = subprocess.run(["docker", *args], input=data, capture_output=True, timeout=120)
        if check and result.returncode:
            raise AssertionError("Exit " + str(result.returncode) + ": " + result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace"))
        return result

    @classmethod
    def sql(cls, sql, database="source_site", check=True):
        return cls.docker(["exec", "-i", cls.database, "sh", "-c",
                           'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --no-defaults --protocol=tcp --host=127.0.0.1 --user=root --batch --skip-column-names "$1"',
                           "i7y-test", database], sql.encode(), check)

    @classmethod
    def web(cls, command, check=True):
        return cls.docker(["run", "--rm", "--network", cls.network,
                           "-v", str(cls.tools) + ":/opt/i7y/tools:ro",
                           "-v", str(cls.state) + ":/opt/i7y/state",
                           "-v", str(cls.site) + ":/var/www/html",
                           "-e", "MYSQL_DATABASE=copy_site", "-e", "MYSQL_USER=copyuser",
                           "-e", "MYSQL_PASSWORD=copy-fixture-password",
                           "--entrypoint", "sh", "webdevops/php-nginx:8.3", "-c", command], check=check)

    @classmethod
    def wp(cls, arguments):
        command = '. /opt/i7y/tools/wordpress-common.sh; root=/var/www/html; wp ' + arguments
        return cls.web(command).stdout.decode().strip()

    def test_serialized_replacement_source_preservation_and_quarantine(self):
        self.wp("core install --url=http://source.example.com --title=Fixture --admin_user=fixture --admin_password=disposable-fixture-password --admin_email=admin@example.com --skip-email")
        self.wp('option add nested \'{"url":"http://source.example.com/path","items":["https://source.example.com/long/path","//source.example.com/image","https://source.example.com.evil/keep"]}\' --format=json')
        plugin = self.site / "wp-content/plugins/fixture"
        plugin.mkdir()
        (plugin / "fixture.php").write_text("<?php file_put_contents('/opt/i7y/state/plugin-ran', 'unexpected');")
        self.wp('option update active_plugins \'["fixture/fixture.php"]\' --format=json')
        self.sql("UPDATE wp_posts SET guid='http://source.example.com/original-guid' WHERE ID=1")
        original = self.sql("SELECT option_value FROM wp_options WHERE option_name='nested'").stdout
        self.sql("CREATE DATABASE copy_site; CREATE USER 'copyuser'@'%' IDENTIFIED BY 'copy-fixture-password'; GRANT ALL ON copy_site.* TO 'copyuser'@'%'")
        dump = self.docker(["exec", "-i", self.database, "sh", "-s"], (FILES / "mysql-backup.sh").read_bytes()).stdout
        self.sql(dump.decode(), "copy_site")
        mu = self.site / "wp-content/mu-plugins"
        mu.mkdir()
        (mu / "unsafe.php").write_text("<?php file_put_contents('/opt/i7y/state/mu-ran', 'unexpected');")
        (self.site / "wp-content/db.php").write_text("<?php exit('Source database drop-in executed');")
        (self.site / "wp-cli.yml").write_text("require:\n  - wp-content/mu-plugins/unsafe.php\n")
        config = self.site / "wp-config.php"
        original_config = config.read_text()
        for constant in ["define('MULTISITE', true);", "define('WP_CONTENT_DIR', '/unsupported');"]:
            config.write_text(original_config.replace("<?php", "<?php\n" + constant, 1))
            rejected = self.web("sh /opt/i7y/tools/wordpress-configure.sh /var/www/html db", check=False)
            self.assertEqual(rejected.returncode, 67)
            self.assertFalse((self.state / "quarantine").exists())
        config.write_text(original_config)
        phar = self.tools / "wp-cli.phar"
        original_phar = phar.read_bytes()
        phar.write_bytes(original_phar + b"tampered")
        rejected = self.web("sh /opt/i7y/tools/wordpress-configure.sh /var/www/html db", check=False)
        self.assertEqual(rejected.returncode, 65)
        self.assertEqual(config.read_text(), original_config)
        phar.write_bytes(original_phar)
        self.web("sh /opt/i7y/tools/wordpress-configure.sh /var/www/html db")
        self.assertFalse((self.state / "mu-ran").exists())
        self.assertFalse((self.state / "plugin-ran").exists())
        self.assertTrue((self.state / "quarantine/mu-plugins/unsafe.php").exists())
        self.assertTrue((self.state / "quarantine/db.php").exists())
        self.sql("CREATE TABLE unsupported_table (value TEXT) ENGINE=InnoDB", "copy_site")
        rejected = self.web("sh /opt/i7y/tools/wordpress-finalize.sh /var/www/html source.example.com source.example.com.copy.test db", check=False)
        self.assertEqual(rejected.returncode, 67)
        self.assertEqual(self.sql("SELECT option_value FROM wp_options WHERE option_name='home'", "copy_site").stdout.strip(), b"http://source.example.com")
        self.sql("DROP TABLE unsupported_table", "copy_site")
        self.web("sh /opt/i7y/tools/wordpress-finalize.sh /var/www/html source.example.com source.example.com.copy.test db")
        actual = json.loads(self.wp("option get nested --format=json"))
        self.assertEqual(actual, {"url": "https://source.example.com.copy.test/path", "items": ["https://source.example.com.copy.test/long/path", "https://source.example.com.copy.test/image", "https://source.example.com.evil/keep"]})
        self.assertEqual(self.wp("option get home"), "https://source.example.com.copy.test")
        self.assertEqual(self.wp("option get siteurl"), "https://source.example.com.copy.test")
        self.assertEqual(self.wp("option get active_plugins --format=json"), "[]")
        self.assertEqual(self.sql("SELECT guid FROM wp_posts WHERE ID=1", "copy_site").stdout.strip(), b"http://source.example.com/original-guid")
        self.assertEqual(self.sql("SELECT option_value FROM wp_options WHERE option_name='nested'").stdout, original)
        self.assertEqual(self.sql("SELECT option_value FROM wp_options WHERE option_name='home'").stdout.strip(), b"http://source.example.com")
        self.assertIn(b"fixture/fixture.php", self.sql("SELECT option_value FROM wp_options WHERE option_name='active_plugins'").stdout)
        self.assertEqual(self.wp("eval 'echo apply_filters(\"pre_wp_mail\", null, []) === false && wp_mail(\"test@example.com\", \"fixture\", \"fixture\") === false ? \"blocked\" : \"unexpected\";'"), "blocked")
        self.assertEqual(self.wp("eval '$error=wp_remote_get(\"https://example.com\"); echo is_wp_error($error) && $error->get_error_code() === \"i7y_clone_review_required\" ? \"blocked\" : \"unexpected\";'"), "blocked")
        self.assertEqual(self.wp("config get DISABLE_WP_CRON --format=json"), "true")
        self.assertFalse((self.state / "mu-ran").exists())
        self.assertNotIn("source-fixture-password", (self.site / "wp-config.php").read_text())


if __name__ == "__main__":
    unittest.main()
