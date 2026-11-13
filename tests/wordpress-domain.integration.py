import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class WordpressDomainCompatibility(unittest.TestCase):
    def test_domain_validation_on_legacy_php(self):
        phar = ROOT / ".local/artifacts/wordpress/wp-cli-2.12.0.phar"
        expected = json.loads((ROOT / "apps/automation/runtime-assets.json").read_text())["wp_cli"]["sha256"]
        self.assertEqual(hashlib.sha256(phar.read_bytes()).hexdigest(), expected)
        with tempfile.TemporaryDirectory(dir=ROOT / ".local/artifacts") as directory:
            tools = Path(directory) / "tools"
            tools.mkdir()
            shutil.copy(phar, tools / "wp-cli.phar")
            shutil.copy(ROOT / "apps/automation/recipes/files/wordpress-common.sh", tools)
            result = subprocess.run([
                "docker", "run", "--rm", "--network=none",
                "-v", str(tools) + ":/opt/i7y/tools:ro",
                "--tmpfs", "/opt/i7y/state",
                "--entrypoint", "sh", os.environ.get("I7Y_TEST_PHP_IMAGE", "php:7.3-cli-alpine"),
                "-c", '''. /opt/i7y/tools/wordpress-common.sh
domain source.example.com
domain destination.example.site
for invalid in localhost Upper.example.com example..com -bad.example.com 'example.com/path'; do
    if domain "$invalid"; then
        exit 1
    fi
done
''',
            ], capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
