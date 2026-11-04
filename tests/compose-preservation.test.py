import copy
import importlib.util
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('copy_filter', ROOT / 'apps/automation/ansible/filter_plugins/i7y_copy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ComposePreservation(unittest.TestCase):
    def test_preserves_comments_options_and_environment_references(self):
        source = """version: '3'
# Original infrastructure
networks:
  reverse-proxy:
    external:
      name: reverse-proxy
  internal:
    driver: bridge
    ipam:
      driver: default
      config:
        - subnet: 192.40.40.0/24
volumes:
  source.example.com-data:
    driver: local
services:
  source.example.com-db:
    image: mysql:5.7
    environment:
      - MYSQL_DATABASE=${MYSQL_DATABASE}
      - MYSQL_PASSWORD=${MYSQL_PASSWORD}
    volumes:
      - source.example.com-data:/var/lib/mysql
  source.example.com-web:
    privileged: true
    image: webdevops/php-nginx:8.3
    environment:
      - VIRTUAL_HOST=source.example.com
      - WEB_DOCUMENT_ROOT="/var/www/app/public"
#      - LETSENCRYPT_HOST=source.example.com
    volumes:
      - .:/var/www/app
"""
        desired = yaml.safe_load(source.replace('source.example.com', 'copy.example.com'))
        desired['version'] = '3.5'
        desired['volumes']['copy.example.com-data']['name'] = 'independent-data'
        desired['networks']['internal']['name'] = 'independent-network'
        desired['networks']['internal']['ipam']['config'] = [{'subnet': '10.240.0.0/28'}]
        web = desired['services']['copy.example.com-web']
        web['container_name'] = '${WEB_HOST}'
        web['volumes'].extend(['/private/tools:/opt/i7y/tools:ro', '/private/state:/opt/i7y/state'])
        actual = module.preserve_compose(source, desired, 'source.example.com', 'copy.example.com')
        self.assertEqual(yaml.safe_load(actual), desired)
        self.assertIn('# Original infrastructure', actual)
        self.assertIn('#      - LETSENCRYPT_HOST=copy.example.com', actual)
        self.assertIn('      - WEB_DOCUMENT_ROOT="/var/www/app/public"', actual)
        self.assertIn('      - MYSQL_PASSWORD=${MYSQL_PASSWORD}', actual)
        self.assertIn('    privileged: true', actual)
        self.assertEqual(module.preserve_compose(actual, desired, 'source.example.com', 'copy.example.com'), actual)
        activated = copy.deepcopy(desired)
        activated['services']['copy.example.com-web']['volumes'] = ['.:/var/www/app']
        final = module.preserve_compose(source, activated, 'source.example.com', 'copy.example.com')
        self.assertIn('#      - LETSENCRYPT_HOST=copy.example.com', final)
        self.assertNotIn('/opt/i7y/', final)

    def test_replacing_block_environment_keeps_next_service_separate(self):
        source = "services:\n  database:\n    environment:\n      - MYSQL_DATABASE=${MYSQL_DATABASE}\n  web:\n    image: webdevops/php-nginx:8.3\n"
        desired = yaml.safe_load(source)
        desired['services']['database']['environment'] = {'MYSQL_DATABASE':'${MYSQL_DATABASE}'}
        actual = module.preserve_compose(source, desired, 'source.example', 'copy.example')
        self.assertEqual(yaml.safe_load(actual), desired)
        self.assertIn('\n  web:', actual)


if __name__ == '__main__':
    unittest.main()
